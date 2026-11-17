import { request } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { safeStorage } from 'electron';
import { createRemoteApps } from '../remote/remote-apps.mjs';

export function createLightApps({
  directory,
  root,
  node,
  python,
  confirm,
  pickFolder,
  confirmOperation,
  onChanged,
}) {
  directory = join(directory, 'light-apps');
  mkdirSync(directory, { recursive: true });
  const remote = createRemoteApps({ directory, onChanged });
  const tokenPath = join(directory, 'host-token');
  try {
    writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const token = readFileSync(tokenPath, 'utf8'),
    pipe =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\yirang-apps-' +
          createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 20)
        : join(directory, 'host.sock');
  let connecting = null,
    connected = false,
    closing = false;
  let key;
  function unlock() {
    if (key) return key;
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    const path = join(directory, 'vault-key');
    try {
      key = safeStorage.decryptString(readFileSync(path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      key = randomBytes(32).toString('hex');
      writeFileSync(path, safeStorage.encryptString(key), { flag: 'wx' });
    }
    return key;
  }
  const send = (workspaceId, operation, payload = {}) =>
    new Promise((yes, no) => {
      const req = request(
        {
          socketPath: pipe,
          path: '/',
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (part) => {
            text += part;
            if (text.length > 75 * 1024 * 1024) req.destroy(Error('响应超过限制'));
          });
          res.on('end', () => {
            try {
              const v = JSON.parse(text);
              if (res.statusCode !== 200) no(Error(v.error));
              else yes(v);
            } catch (error) {
              no(error);
            }
          });
        },
      );
      req.setTimeout(30000, () => req.destroy(Error('轻应用后台响应超时')));
      req.on('error', no);
      req.end(JSON.stringify({ workspaceId, operation, payload }));
    });
  async function connect() {
    if (connected) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const payload = { key: unlock() };
      let needsLaunch = false;
      try {
        const state = await send('', 'attach', payload);
        if (state.protocol !== 15) {
          await send('', 'detach');
          let exited = false;
          for (let i = 0; i < 24; i++) {
            await new Promise((r) => setTimeout(r, 500));
            try {
              await send('', 'protocol');
            } catch (e) {
              if (['ECONNREFUSED', 'ENOENT', 'ECONNRESET'].includes(e.code)) {
                exited = true;
                break;
              }
            }
          }
          if (!exited)
            throw Error(
              '旧版轻应用后台仍有常驻任务，请在旧版停止应用并退出后重试；不会强制中断后台任务',
            );
          needsLaunch = true;
        }
      } catch (error) {
        if (!['ECONNREFUSED', 'ENOENT', 'ECONNRESET'].includes(error.code)) throw error;
        needsLaunch = true;
      }
      if (needsLaunch) {
        const program = await node();
        const child = spawn(
          program,
          [join(root, 'dist/electron/light-apps/light-apps-host.mjs'), directory, pipe],
          { windowsHide: true, detached: true, stdio: 'ignore' },
        );
        child.on('error', () => {});
        child.unref();
        let last;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 150));
          try {
            await send('', 'attach', payload);
            last = null;
            break;
          } catch (e) {
            last = e;
          }
        }
        if (last) throw last;
      }
      connected = true;
    })().finally(() => (connecting = null));
    return connecting;
  }
  const heartbeat = setInterval(() => {
    if (connected && !closing)
      void send('', 'heartbeat').catch(() => {
        connected = false;
      });
  }, 15000);
  heartbeat.unref();
  const approvals = new Map();
  async function ensureTrust(workspaceId, p) {
    const key = workspaceId + ':' + p.instanceId;
    if (approvals.has(key)) return approvals.get(key);
    const job = (async () => {
      const info = await send(workspaceId, 'trust_info', p);
      if (info.instance.approvedDigest === info.digest || info.manifest.runtime.kind === 'micro')
        return;
      const approved = await confirm(info);
      if (!approved) throw Error('用户未授权运行此轻应用');
      const environment = info.manifest.runtime.kind === 'python' ? await python() : null;
      await send(workspaceId, 'authorize', {
        instanceId: p.instanceId,
        digest: info.digest,
        pythonProgram: environment?.program,
        background: approved.background === true,
      });
    })();
    approvals.set(key, job);
    try {
      await job;
    } finally {
      approvals.delete(key);
    }
  }
  return {
    async command(workspaceId, operation, payload = {}, fromModel = false) {
      if (closing) throw Error('轻应用服务正在关闭');
      if (
        [
          'authorize',
          'trust_info',
          'attach',
          'detach',
          'heartbeat',
          'output_read',
          'remote_snapshot',
          'ui_bundle',
          'state_snapshot',
          'shared_state_update',
          'ai_grant',
          'micro_submit',
          'micro_claim',
          'micro_exec',
          'micro_result',
          'micro_active',
          'example_candidate',
          'example_confirm',
          'micro_store_list',
          'micro_store_put',
        ].includes(operation)
      )
        throw Error('内部操作不能由页面或 MCP 调用');
      if (
        operation.startsWith('connections_') ||
        operation === 'remote_contract' ||
        remote.owns(workspaceId, payload.instanceId)
      )
        return remote.command(workspaceId, operation, payload, fromModel);
      if (
        fromModel &&
        [
          'evolution_settings',
          'result_edit',
          'files_import',
          'development_control',
          'dependencies_cancel',
          'package_import',
          'ai_control',
          'notification_settings',
          'instance_delete',
          'instance_restore',
          'unregister',
          'secret_set',
        ].includes(operation)
      )
        throw Error('凭据仅能由用户在本机界面设置，MCP 不开放写入或读取凭据');
      if (operation === 'choose_folder') {
        if (fromModel) throw Error('MCP 不能打开目录选择器');
        return pickFolder();
      }
      await connect();
      if (operation === 'notifications_clear') {
        if (fromModel) throw Error('清空全部通知仅能由用户操作');
        await send(workspaceId, 'notifications_update', { clear: true });
        await remote.clearNotifications(workspaceId);
        onChanged?.({ workspaceId, operation });
        return { cleared: true };
      }
      if (['list', 'widgets_list', 'notifications_list'].includes(operation)) {
        const result = await send(workspaceId, operation, payload);
        if (operation === 'list')
          return { ...result, instances: [...result.instances, ...remote.instances(workspaceId)] };
        if (operation === 'widgets_list') {
          const r = remote.widgets(workspaceId);
          return {
            items: [...result.items, ...r.items],
            catalog: [...result.catalog, ...r.catalog],
          };
        }
        return payload.instanceId
          ? result
          : [...result, ...remote.notifications(workspaceId)]
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, 200);
      }
      if (
        fromModel &&
        ['start', 'state_read', 'action_call', 'config_update', 'schedules_update'].includes(
          operation,
        )
      ) {
        const info = await send(workspaceId, 'trust_info', payload);
        if (!info.instance.aiEnabled)
          throw Error('请用户先在该应用中开启 AI 接管；AI 不能自行开启');
      }
      if (
        fromModel &&
        ['release_publish', 'release_rollback', 'data_restore', 'dependencies_install'].includes(
          operation,
        )
      ) {
        const context = await send(workspaceId, 'development_context', payload);
        if (!confirmOperation) throw Error('发布确认服务不可用，请更新一壤后重试');
        if (!(await confirmOperation(operation, context, payload)))
          throw Error('本次应用操作已取消，尚未执行');
      }
      payload = { ...payload, __fromModel: fromModel };
      if (
        [
          'start',
          'open',
          'state_read',
          'action_call',
          'schedules_update',
          'dependencies_install',
        ].includes(operation)
      )
        await ensureTrust(workspaceId, payload);
      if (operation === 'dependencies_install') {
        const info = await send(workspaceId, 'dependencies_status', payload);
        if (info.runtime === 'python') {
          const environment = await python();
          payload.pythonProgram = environment?.program;
        }
      }
      if (operation === 'runs_poll') {
        try {
          return await send(workspaceId, operation, payload);
        } catch (error) {
          if (!String(error.message).includes('不支持的轻应用操作')) throw error;
          const items = await send(workspaceId, 'runs_get', { instanceId: payload.instanceId }),
            cursor = createHash('sha256').update(JSON.stringify(items)).digest('hex');
          return {
            cursor,
            unchanged: payload.cursor === cursor,
            ...(payload.cursor === cursor ? {} : { items }),
            running: items.some((r) => r.state === 'running'),
          };
        }
      }
      const result = await send(workspaceId, operation, payload);
      if (['release_publish', 'release_rollback', 'data_restore'].includes(operation))
        onChanged?.({ workspaceId, instanceId: payload.instanceId, operation });
      return result;
    },
    async internal(workspaceId, operation, payload = {}) {
      if (closing) throw Error('轻应用服务正在关闭');
      await connect();
      return send(workspaceId, operation, payload);
    },
    async output(workspaceId, payload) {
      if (remote.owns(workspaceId, payload.instanceId)) return remote.output(workspaceId, payload);
      await connect();
      return send(workspaceId, 'output_read', payload);
    },
    close() {
      if (closing) return remote.close();
      closing = true;
      clearInterval(heartbeat);
      if (connected) void send('', 'detach').catch(() => {});
      return remote.close();
    },
  };
}
