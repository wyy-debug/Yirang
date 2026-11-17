// Portable service entry. This process owns tasks; clients own presentation only.
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createLightAppsCore } from '../light-apps/light-apps-core.mjs';
import {
  remoteProtocol,
  remoteContract,
  remoteReadOperations,
  remoteControlOperations,
  mappedInstanceId,
} from './remote-app-protocol.mjs';

const args = process.argv.slice(2),
  arg = (name) => args[args.indexOf(name) + 1];
if (args.includes('--init')) {
  const directory = resolve(arg('--init'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'service.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        name: '我的 Mac 服务',
        host: '127.0.0.1',
        port: 41870,
        workspaceId: 'remote-apps',
        dataDir: './data',
        readToken: randomBytes(32).toString('hex'),
        controlToken: randomBytes(32).toString('hex'),
        apps: [],
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    '已创建服务配置：' + path + '\n填写 apps 后，使用 --config <此文件> --approve-code 启动。',
  );
} else if (!args.includes('--config')) {
  console.log(
    'Yirang remote service\n  --init <directory>\n  --config <service.json> [--approve-code]\nRequires Node.js 24. Credentials remain in the server configuration.',
  );
} else {
  const configPath = resolve(arg('--config')),
    base = dirname(configPath),
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  const localPath = (p) => resolve(base, p),
    directory = localPath(config.dataDir || './data'),
    workspaceId = String(config.workspaceId || 'remote-apps');
  if (
    ![config.readToken, config.controlToken].every(
      (t) => typeof t === 'string' && t.length >= 32,
    ) ||
    config.readToken === config.controlToken
  )
    throw Error('需要两个不同的、至少 32 字符的 readToken / controlToken');
  const host = config.host || '127.0.0.1',
    tls = config.tls;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !tls)
    throw Error('非回环监听必须配置 TLS；也可在回环端口前使用 HTTPS 反向代理或 SSH 隧道');
  if (!Array.isArray(config.apps) || config.apps.length > 32)
    throw Error('apps 必须是最多 32 项的数组');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const vaultPath = join(directory, 'vault-key');
  if (!existsSync(vaultPath))
    writeFileSync(vaultPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const clients = new Set(),
    allowed = new Set(),
    stateReaders = new Map();
  let revision = 0,
    dirty = null,
    closed = false,
    publishing = false,
    lastSnapshot = '';
  const core = createLightAppsCore({
    directory,
    onChange() {
      if (!closed && !dirty)
        dirty = setTimeout(() => {
          dirty = null;
          void publish();
        }, 250);
    },
  });
  core.attach(readFileSync(vaultPath, 'utf8').trim());
  const command = (operation, payload = {}) => core.command(workspaceId, operation, payload);
  try {
    for (const entry of config.apps) {
      const app = await command('register', { path: localPath(entry.path) }),
        list = await command('list');
      let instance = list.instances.find(
        (v) => v.appId === app.id && v.name === (entry.name || app.manifest.name),
      );
      const settings = entry.configFile
        ? JSON.parse(readFileSync(localPath(entry.configFile), 'utf8'))
        : entry.config;
      if (!instance)
        instance = await command('instance_create', {
          appId: app.id,
          name: entry.name,
          config: settings || {},
        });
      allowed.add(instance.id);
      if (settings) await command('config_update', { instanceId: instance.id, config: settings });
      if (entry.secretsFile) {
        const secrets = JSON.parse(readFileSync(localPath(entry.secretsFile), 'utf8'));
        for (const [name, value] of Object.entries(secrets))
          await command('secret_set', { instanceId: instance.id, name, value });
      }
      const trust = await command('trust_info', { instanceId: instance.id });
      if (trust.instance.approvedDigest !== trust.digest) {
        if (!args.includes('--approve-code'))
          throw Error(
            '应用源码需要服务拥有者授权：' + instance.name + '；审阅源码后使用 --approve-code 启动',
          );
        await command('authorize', {
          instanceId: instance.id,
          digest: trust.digest,
          pythonProgram: entry.pythonProgram,
          background: true,
        });
      }
      if (entry.start === true) await command('start', { instanceId: instance.id });
      for (const schedule of entry.schedules || [])
        await command('schedules_update', {
          ...schedule,
          instanceId: instance.id,
          scheduleId: mappedInstanceId(instance.id, schedule.key || schedule.action),
        });
      // Legacy get_state is read once per service interval, outside the action queue.
      // It only runs while this backend is already running; it never restarts a stopped app.
      if (
        entry.stateIntervalSeconds !== 0 &&
        app.manifest.actions.some((a) => a.name === 'get_state' && a.effect === 'read')
      )
        stateReaders.set(instance.id, {
          interval: Math.max(10, Number(entry.stateIntervalSeconds) || 15) * 1000,
          nextAt: 0,
          busy: false,
        });
    }
  } catch (error) {
    closed = true;
    clearTimeout(dirty);
    core.close();
    throw error;
  }
  function role(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const equal = (other) => {
      const a = Buffer.from(token),
        b = Buffer.from(other);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    return equal(config.controlToken) ? 'control' : equal(config.readToken) ? 'read' : null;
  }
  async function snapshot() {
    const s = await command('remote_snapshot');
    return {
      protocol: remoteProtocol,
      revision,
      at: Date.now(),
      instances: s.instances.filter((v) => allowed.has(v.id)),
      notifications: s.notifications.filter((n) => allowed.has(n.instanceId)),
    };
  }
  async function publish() {
    if (publishing || closed || !clients.size) return;
    publishing = true;
    try {
      const value = await snapshot(),
        content = JSON.stringify([value.instances, value.notifications]);
      if (content === lastSnapshot) return;
      lastSnapshot = content;
      value.revision = ++revision;
      const data = 'event: snapshot\nid: ' + revision + '\ndata: ' + JSON.stringify(value) + '\n\n';
      for (const client of clients)
        if (!client.write(data)) {
          client.end();
          clients.delete(client);
        }
    } catch (error) {
      console.error('Snapshot unavailable:', error.message);
    } finally {
      publishing = false;
    }
  }
  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const access = role(req);
    if (!access) {
      res.writeHead(401).end();
      return;
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      let result;
      if (req.method === 'GET' && url.pathname === '/v1/manifest')
        result = {
          protocol: remoteProtocol,
          name: config.name || 'Yirang service',
          access,
          contract: remoteContract,
        };
      else if (req.method === 'GET' && url.pathname === '/v1/snapshot') result = await snapshot();
      else if (req.method === 'GET' && url.pathname === '/v1/events') {
        if (clients.size >= 32) throw Error('连接数量达到上限');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        clients.add(res);
        res.on('close', () => clients.delete(res));
        res.write(
          'retry: 5000\nevent: snapshot\ndata: ' + JSON.stringify(await snapshot()) + '\n\n',
        );
        return;
      } else if (req.method === 'POST' && url.pathname === '/v1/command') {
        let body = '';
        for await (const part of req) {
          body += part;
          if (body.length > 256000) throw Error('请求超过限制');
        }
        const p = JSON.parse(body),
          operation = p.operation,
          payload = p.payload || {};
        if (!allowed.has(payload.instanceId)) throw Error('此服务未开放该实例');
        if (
          operation !== 'ui_bundle' &&
          !remoteReadOperations.has(operation) &&
          !remoteControlOperations.has(operation)
        )
          throw Error('远程服务未开放此操作');
        if (remoteControlOperations.has(operation) && access !== 'control')
          throw Error('此连接仅可查看，执行动作需要控制令牌');
        // Never trust a client-supplied workspace, source path or internal authorization flag.
        const keys = [
          'instanceId',
          'action',
          'input',
          'requestId',
          'runId',
          'cursor',
          'path',
          'scheduleId',
          'intervalSeconds',
          'enabled',
          'id',
          'clear',
        ];
        result = await command(
          operation,
          Object.fromEntries(
            keys.filter((k) => Object.hasOwn(payload, k)).map((k) => [k, payload[k]]),
          ),
        );
        if (operation === 'start')
          result = (await snapshot()).instances.find((v) => v.id === payload.instanceId);
        if (remoteControlOperations.has(operation)) void publish();
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message).slice(0, 1000) }));
    }
  }
  const server = tls
    ? httpsServer(
        { key: readFileSync(localPath(tls.key)), cert: readFileSync(localPath(tls.cert)) },
        handler,
      )
    : httpServer(handler);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': heartbeat ' + Date.now() + '\n\n');
  }, 15000);
  const refreshStates = setInterval(async () => {
    if (closed) return;
    const list = await command('remote_snapshot');
    for (const v of list.instances) {
      const reader = stateReaders.get(v.id);
      if (!reader || reader.busy || v.runtime !== 'running' || Date.now() < reader.nextAt) continue;
      reader.busy = true;
      reader.nextAt = Date.now() + reader.interval;
      void command('state_read', { instanceId: v.id })
        .then((result) =>
          command('shared_state_update', { instanceId: v.id, value: result.result }),
        )
        .catch((error) => console.error('State unavailable for ' + v.name + ': ' + error.message))
        .finally(() => (reader.busy = false));
    }
  }, 5000);
  server.listen(Number(config.port || 41870), host, () =>
    console.log(
      'Yirang service listening on ' +
        host +
        ':' +
        server.address().port +
        '; ' +
        allowed.size +
        ' application(s)',
    ),
  );
  const shutdown = () => {
    if (closed) return;
    closed = true;
    clearTimeout(dirty);
    clearInterval(heartbeat);
    clearInterval(refreshStates);
    for (const client of clients) client.end();
    server.close();
    server.closeAllConnections();
    core.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
