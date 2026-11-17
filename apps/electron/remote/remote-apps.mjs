import { mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, extname, posix } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { safeStorage } from 'electron';
import { sdkSource } from '../light-apps/light-apps-sdk.mjs';
import {
  remoteProtocol,
  remoteContract,
  remoteReadOperations,
  remoteControlOperations,
  mappedInstanceId,
  serviceEndpoint,
  assetPath,
} from './remote-app-protocol.mjs';

const json = JSON.stringify,
  types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
  };
export function createRemoteApps({ directory, onChanged }) {
  directory = join(directory, 'remote');
  mkdirSync(directory, { recursive: true });
  const statePath = join(directory, 'connections.json');
  let state = { connections: [], widgets: [], ai: {}, storage: {} },
    closed = false,
    saveTimer,
    writeTail = Promise.resolve();
  try {
    const raw = readFileSync(statePath, 'utf8');
    if (raw.length > 40 * 1024 * 1024) throw Error('远程连接缓存超过限制');
    state = { ...state, ...JSON.parse(raw) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw Error('无法读取远程连接配置：' + e.message);
  }
  const live = new Map(),
    pages = new Map(),
    opening = new Map(),
    pageGeneration = new Map(),
    transientStates = new Map();
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const data = json(state);
    writeTail = writeTail
      .catch(() => {})
      .then(async () => {
        await writeFile(statePath + '.tmp', data, { mode: 0o600 });
        await rename(statePath + '.tmp', statePath);
      });
    return writeTail;
  }
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      void flush().catch((e) => console.error('Remote settings save failed:', e.message));
    }, 500);
  }
  const changed = (workspaceId) => {
    persist();
    onChanged?.({ workspaceId, operation: 'remote-state' });
  };
  const status = (c) => {
    const s = live.get(c.id);
    return {
      online: !!s?.online && Date.now() - s.lastSeen < 45000,
      lastSeen: s?.lastSeen || c.snapshot?.at || null,
      error: s?.error || '',
      connecting: !!s?.connecting,
    };
  };
  const publicConnection = (c) => ({
    id: c.id,
    name: c.name,
    endpoint: c.endpoint,
    access: c.access || 'read',
    allowActions: c.allowActions === true,
    apps: c.snapshot?.instances?.length || 0,
    ...status(c),
  });
  const connections = (w) => state.connections.filter((c) => c.workspaceId === w);
  function find(w, id) {
    for (const c of connections(w)) {
      const v = c.snapshot?.instances?.find((v) => mappedInstanceId(c.id, v.id) === id);
      if (v) return { c, v };
    }
    return null;
  }
  const publicInstance = (c, v) => ({
    id: mappedInstanceId(c.id, v.id),
    appId: v.appId,
    name: v.name,
    manifest: v.manifest,
    runtime: v.runtime,
    runtimeKind: v.runtimeKind,
    busy: v.busy,
    unread: (c.snapshot?.notifications || []).filter(
      (n) => n.instanceId === v.id && !n.read && n.createdAt > (c.notificationsClearedThrough || 0),
    ).length,
    remote: true,
    connectionId: c.id,
    connectionName: c.name,
    connection: publicConnection(c),
    stateAt: v.stateAt,
    aiEnabled: state.ai[mappedInstanceId(c.id, v.id)] === true,
    background: true,
  });
  function snapshot(c, value) {
    if (
      value.protocol !== remoteProtocol ||
      !Array.isArray(value.instances) ||
      value.instances.length > 32 ||
      json(value).length > 4 * 1024 * 1024
    )
      throw Error('远程状态格式不兼容');
    const ids = new Set();
    for (const v of value.instances) {
      if (
        typeof v.id !== 'string' ||
        ids.has(v.id) ||
        typeof v.name !== 'string' ||
        !v.manifest ||
        !Array.isArray(v.manifest.actions) ||
        !['node', 'python', 'static'].includes(v.manifest.runtime?.kind)
      )
        throw Error('远程应用声明无效');
      ids.add(v.id);
    }
    const previous = c.snapshot?.instances || [];
    c.snapshot = {
      ...value,
      notifications: Array.isArray(value.notifications) ? value.notifications.slice(0, 200) : [],
    };
    for (const v of value.instances) {
      const old = previous.find((item) => item.id === v.id);
      if (old && old.uiRevision !== v.uiRevision) {
        const id = mappedInstanceId(c.id, v.id);
        closePage(id);
        onChanged?.({ workspaceId: c.workspaceId, instanceId: id, operation: 'remote-ui-changed' });
      }
    }
    for (const old of previous)
      if (!value.instances.some((v) => v.id === old.id)) closePage(mappedInstanceId(c.id, old.id));
    changed(c.workspaceId);
  }
  function token(c) {
    if (!safeStorage.isEncryptionAvailable()) throw Error('系统凭据存储不可用');
    return safeStorage.decryptString(Buffer.from(c.token, 'base64'));
  }
  async function fetchService(c, path, options = {}) {
    const headers = {
      Authorization: 'Bearer ' + token(c),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    };
    const r = await fetch(c.endpoint + path, {
      ...options,
      headers,
      redirect: 'error',
      signal: options.signal || AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 1000);
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {}
      throw Error(r.status === 401 ? '连接令牌无效或已撤销' : message || '远程服务暂不可用');
    }
    return r;
  }
  async function readJson(response, limit = 4 * 1024 * 1024) {
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) {
        await response.body.cancel().catch(() => {});
        throw Error('远程响应超过限制');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const request = async (c, operation, payload) =>
    readJson(
      await fetchService(c, '/v1/command', { method: 'POST', body: json({ operation, payload }) }),
      operation === 'output_read'
        ? 72 * 1024 * 1024
        : operation === 'ui_bundle'
          ? 12 * 1024 * 1024
          : 4 * 1024 * 1024,
    );
  function disconnect(c) {
    const s = live.get(c.id);
    if (s) {
      s.stopped = true;
      clearTimeout(s.retry);
      s.controller?.abort();
      live.delete(c.id);
    }
  }
  function connect(c) {
    if (closed || live.has(c.id)) return;
    const s = {
      online: false,
      connecting: false,
      lastSeen: 0,
      error: '',
      delay: 2000,
      stopped: false,
    };
    live.set(c.id, s);
    async function stream() {
      if (s.stopped || closed) return;
      s.connecting = true;
      const controller = new AbortController();
      s.controller = controller;
      let watchdog;
      try {
        const meta = await readJson(
          await fetchService(c, '/v1/manifest', {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          }),
        );
        if (meta.protocol !== remoteProtocol || !['read', 'control'].includes(meta.access))
          throw Error('远程协议版本不支持');
        if (s.stopped) return;
        c.access = meta.access;
        const response = await fetchService(c, '/v1/events', { signal: controller.signal });
        if (!response.headers.get('content-type')?.includes('text/event-stream'))
          throw Error('服务未返回状态事件流');
        s.lastSeen = Date.now();
        watchdog = setInterval(() => {
          if (Date.now() - s.lastSeen > 45000) controller.abort();
        }, 10000);
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const bytes of response.body) {
          if (s.stopped || closed) break;
          s.lastSeen = Date.now();
          buffer += decoder.decode(bytes, { stream: true }).replaceAll('\r', '');
          if (buffer.length > 5 * 1024 * 1024) throw Error('远程事件过大');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = event
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (data) {
              snapshot(c, JSON.parse(data));
              s.online = true;
              s.connecting = false;
              s.error = '';
              s.delay = 2000;
            }
          }
        }
        if (!s.stopped) throw Error('状态连接已断开');
      } catch (e) {
        if (!s.stopped) {
          s.online = false;
          s.connecting = false;
          s.error =
            e.name === 'AbortError' ? '连接超时，正在重连' : String(e.message).slice(0, 300);
          onChanged?.({ workspaceId: c.workspaceId, operation: 'remote-state' });
        }
      } finally {
        clearInterval(watchdog);
        controller.abort();
        if (!s.stopped && !closed) {
          s.retry = setTimeout(stream, s.delay);
          s.retry.unref?.();
          s.delay = Math.min(30000, s.delay * 2);
        }
      }
    }
    void stream();
  }
  // Connections are lazy: opening the workspace starts one stream, never one per widget.
  const ensure = (w) => connections(w).forEach(connect);
  function closePage(id) {
    pageGeneration.set(id, (pageGeneration.get(id) || 0) + 1);
    const page = pages.get(id);
    if (page) {
      page.server.closeAllConnections();
      page.server.close();
      pages.delete(id);
    }
  }
  function catalogue(w) {
    return connections(w).flatMap((c) =>
      (c.snapshot?.instances || []).flatMap((v) =>
        (v.manifest.widgets || []).map((widget) => ({
          ...widget,
          entry: posix.relative(
            posix.dirname(v.manifest.ui?.entry || 'ui/index.html'),
            widget.entry,
          ),
          instanceId: mappedInstanceId(c.id, v.id),
          appName: v.name,
          stateAt: v.stateAt,
          connection: publicConnection(c),
        })),
      ),
    );
  }
  async function openPage(w, id) {
    if (pages.has(id)) return { url: pages.get(id).url };
    if (opening.has(id)) return opening.get(id);
    const generation = pageGeneration.get(id) || 0;
    const pending = (async () => {
      const match = find(w, id);
      if (!match) throw Error('远程应用不存在');
      const { c, v } = match,
        cache = join(directory, id + '.ui.json');
      let bundle;
      if (status(c).online) {
        bundle = await request(c, 'ui_bundle', { instanceId: v.id });
      } else {
        try {
          bundle = JSON.parse(await readFile(cache, 'utf8'));
        } catch {
          throw Error('服务离线，且没有缓存页面。连接服务后首次打开即可保存页面。');
        }
      }
      if (!Array.isArray(bundle.assets) || bundle.assets.length > 2000 || !assetPath(bundle.entry))
        throw Error('页面资源包无效');
      const assets = new Map();
      let bytes = 0;
      for (const a of bundle.assets) {
        if (!assetPath(a.path) || typeof a.data !== 'string') throw Error('页面资源路径无效');
        const data = Buffer.from(a.data, 'base64');
        if ((bytes += data.length) > 8 * 1024 * 1024) throw Error('应用页面超过 8 MiB');
        assets.set(a.path, data);
      }
      if (!assets.has(bundle.entry)) throw Error('应用页面入口缺失');
      if (status(c).online) await writeFile(cache, json(bundle), { mode: 0o600 });
      if (pages.size >= 8) throw Error('同时打开的远程应用已达到 8 个，请关闭部分页面');
      const key = randomBytes(24).toString('hex');
      const server = createServer(async (req, res) => {
        try {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'no-store');
          if (req.headers.host !== `127.0.0.1:${server.address().port}`)
            throw Error('无效页面来源');
          const url = new URL(req.url, 'http://localhost');
          if (!url.pathname.startsWith('/' + key + '/')) throw Error('页面已过期');
          const path = decodeURIComponent(url.pathname.slice(key.length + 2));
          if (req.headers.origin && req.headers.origin !== 'null') throw Error('页面来源无效');
          res.setHeader('Access-Control-Allow-Origin', 'null');
          if (req.method === 'POST' && path === 'api') {
            let body = '';
            for await (const part of req) {
              body += part;
              if (body.length > 128000) throw Error('页面请求过大');
            }
            const p = JSON.parse(body);
            let result;
            if (p.operation === 'state_get') result = find(w, id)?.v.state ?? {};
            else if (p.operation === 'connection_status')
              result = {
                ...status(c),
                name: c.name,
                stateAt: find(w, id)?.v.stateAt,
                remote: true,
              };
            else if (p.operation === 'storage_mutate') {
              const values = new Map(Object.entries(state.storage[id] || {}));
              if (p.action === 'clear') values.clear();
              else if (p.action === 'remove') values.delete(String(p.key));
              else if (p.action === 'set' && typeof p.value === 'string')
                values.set(String(p.key), p.value);
              else throw Error('页面存储请求无效');
              const value = Object.fromEntries(values);
              if (json(value).length > 48000) throw Error('页面存储超过限制');
              state.storage[id] = value;
              persist();
              result = { saved: true };
            } else if (['action_call', 'runs_get', 'cancel', 'outputs_list'].includes(p.operation))
              result = await instanceCommand(w, id, p.operation, p, false);
            else throw Error('远程页面只读取服务状态；更改状态请调用服务声明的动作');
            res.setHeader('Content-Type', 'application/json');
            res.end(json(result));
            return;
          }
          if (req.method !== 'GET') throw Error('页面请求无效');
          if (path === '__yirang_sdk.js' || path === 'yirang.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(
              sdkSource
                .replace('/*YIRANG_REMOTE*/false', 'true')
                .replace('/*YIRANG_STORAGE_SEED*/{}', () =>
                  json(state.storage[id] || {}).replaceAll('<', '\\u003c'),
                ),
            );
            return;
          }
          const name = path || bundle.entry,
            data = assets.get(name);
          if (!data) throw Error('资源不存在');
          res.setHeader('Content-Type', types[extname(name)] || 'application/octet-stream');
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
          );
          const html = extname(name) === '.html' ? data.toString('utf8') : null,
            loader = '<script src="/' + key + '/__yirang_sdk.js"></script>';
          res.end(
            html === null
              ? data
              : /<script\b/i.test(html)
                ? html.replace(/<script\b/i, loader + '<script')
                : html + loader,
          );
        } catch (e) {
          if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(json({ error: e.message }));
        }
      });
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;
      await new Promise((yes, no) => {
        server.once('error', no);
        server.listen(0, '127.0.0.1', yes);
      });
      if (closed || !find(w, id) || generation !== (pageGeneration.get(id) || 0)) {
        server.close();
        throw Error('页面打开已取消');
      }
      const page = { server, url: `http://127.0.0.1:${server.address().port}/${key}/` };
      pages.set(id, page);
      return { url: page.url };
    })().finally(() => opening.delete(id));
    opening.set(id, pending);
    return pending;
  }
  async function instanceCommand(w, id, operation, p = {}, fromModel = false) {
    const match = find(w, id);
    if (!match) throw Error('远程应用已移除或不属于当前工作区');
    const { c, v } = match;
    ensure(w);
    if (operation === 'describe') return { ...publicInstance(c, v), contract: remoteContract };
    if (operation === 'open') return openPage(w, id);
    if (operation === 'close_page') {
      closePage(id);
      return { closed: true, backendContinues: true };
    }
    if (operation === 'ai_control') {
      if (fromModel) throw Error('AI 不能自行开启远程执行权限');
      state.ai[id] = p.enabled === true;
      changed(w);
      await flush();
      return publicInstance(c, v);
    }
    if (operation === 'state_read' || operation === 'state_snapshot')
      return {
        value: v.state ?? {},
        result: v.state ?? {},
        updatedAt: v.stateAt,
        connection: publicConnection(c),
        cached: true,
      };
    if (operation === 'action_call' && p.action === 'get_state') {
      const result = {
        id: 'remote-state:' + randomUUID(),
        instanceId: id,
        action: 'get_state',
        state: 'completed',
        result: v.state ?? {},
        transient: true,
        cached: true,
        updatedAt: v.stateAt,
        connection: publicConnection(c),
      };
      transientStates.set(result.id, result);
      while (transientStates.size > 128)
        transientStates.delete(transientStates.keys().next().value);
      return result;
    }
    if (operation === 'runs_get' && String(p.runId || '').startsWith('remote-state:')) {
      const result = transientStates.get(p.runId);
      return result?.instanceId === id ? [result] : [];
    }
    if (operation === 'notifications_list')
      return (c.snapshot?.notifications || [])
        .filter((n) => n.createdAt > (c.notificationsClearedThrough || 0) && n.instanceId === v.id)
        .map((n) => ({ ...n, instanceId: id }));
    if (operation === 'widget_context') {
      const widget = state.widgets.find((x) => x.instanceId === id && x.id === p.id),
        definition = v.manifest.widgets?.find((d) => d.id === widget?.widgetId);
      if (!widget || !definition) throw Error('小组件不存在');
      return {
        workspaceId: w,
        instanceId: id,
        app: {
          name: v.name,
          version: v.manifest.version,
          aiEnabled: state.ai[id] === true,
          remote: true,
        },
        widget: {
          id: widget.id,
          definitionId: definition.id,
          name: definition.name,
          entry: definition.entry,
          size: widget.size,
        },
        capturedAt: new Date().toISOString(),
        state: v.state ?? null,
        stateAt: v.stateAt,
        connection: publicConnection(c),
        stateNote: '远程服务共享状态；离线数据为最后一次快照，不代表实时值。未执行查询任务。',
      };
    }
    if (operation === 'widget_save') {
      const old = p.id ? state.widgets.find((x) => x.id === p.id && x.instanceId === id) : null;
      if (p.id && !old) throw Error('小组件不存在');
      const def = catalogue(w).find(
        (x) => x.instanceId === id && x.id === (p.widgetId || old?.widgetId),
      );
      if (!def) throw Error('组件未在应用清单中声明');
      const next = {
        id: old?.id || randomUUID(),
        workspaceId: w,
        instanceId: id,
        widgetId: def.id,
        size: p.size ?? old?.size ?? def.sizes[0],
        x: p.x ?? old?.x ?? 0,
        y: p.y ?? old?.y ?? 0,
        width: p.width ?? old?.width,
        height: p.height ?? old?.height,
        pinned: p.pinned ?? old?.pinned ?? false,
        surface: p.surface ?? old?.surface ?? 'canvas',
        order: p.order ?? old?.order ?? Date.now(),
      };
      if (
        !def.sizes.includes(next.size) ||
        !['canvas', 'dashboard'].includes(next.surface) ||
        typeof next.pinned !== 'boolean' ||
        ![next.x, next.y, next.order].every(Number.isFinite) ||
        Math.abs(next.x) > 1e6 ||
        Math.abs(next.y) > 1e6 ||
        (next.width !== undefined &&
          (!Number.isFinite(next.width) || next.width < 220 || next.width > 1920)) ||
        (next.height !== undefined &&
          (!Number.isFinite(next.height) || next.height < 160 || next.height > 1200))
      )
        throw Error('组件尺寸或位置无效');
      if (!old && state.widgets.filter((x) => x.workspaceId === w).length >= 64)
        throw Error('远程组件最多 64 个');
      state.widgets = [...state.widgets.filter((x) => x.id !== next.id), next];
      changed(w);
      await flush();
      return next;
    }
    if (operation === 'widget_remove') {
      state.widgets = state.widgets.filter((x) => x.id !== p.id || x.instanceId !== id);
      changed(w);
      await flush();
      return { removed: true };
    }
    if (!remoteReadOperations.has(operation) && !remoteControlOperations.has(operation))
      throw Error(
        '此应用在远程服务运行。源码、配置与凭据请在服务所在主机管理；本机提供查看和已授权动作。',
      );
    if (!status(c).online) throw Error('服务离线，操作尚未发送；不会自动重放');
    if (remoteControlOperations.has(operation)) {
      if (c.access !== 'control' || !c.allowActions)
        throw Error('此连接仅供查看，请先在远程服务设置中允许执行动作');
      if (fromModel && !state.ai[id]) throw Error('请先在应用管理中允许 AI 操作该远程应用');
    }
    const result = await request(c, operation, { ...p, instanceId: v.id });
    const map = (r) =>
      r && typeof r === 'object' ? { ...r, ...(r.instanceId ? { instanceId: id } : {}) } : r;
    return Array.isArray(result)
      ? result.map(map)
      : result?.items
        ? { ...result, items: result.items.map(map) }
        : map(result);
  }
  return {
    owns: (w, id) => !!find(w, id),
    ensure,
    instances(w) {
      ensure(w);
      return connections(w).flatMap((c) =>
        (c.snapshot?.instances || []).map((v) => publicInstance(c, v)),
      );
    },
    widgets(w) {
      ensure(w);
      return {
        items: state.widgets.filter((x) => x.workspaceId === w && find(w, x.instanceId)),
        catalog: catalogue(w),
      };
    },
    async clearNotifications(w) {
      for (const c of connections(w))
        c.notificationsClearedThrough = Math.max(
          c.notificationsClearedThrough || 0,
          ...(c.snapshot?.notifications || []).map((n) => Number(n.createdAt) || 0),
        );
      await flush();
      changed(w);
    },
    notifications(w) {
      return connections(w).flatMap((c) =>
        (c.snapshot?.notifications || [])
          .filter((n) => n.createdAt > (c.notificationsClearedThrough || 0))
          .map((n) => ({ ...n, instanceId: mappedInstanceId(c.id, n.instanceId) })),
      );
    },
    async command(w, op, p = {}, fromModel = false) {
      if (op === 'remote_contract') return remoteContract;
      if (op === 'connections_list') {
        ensure(w);
        return connections(w).map(publicConnection);
      }
      if (op.startsWith('connections_')) {
        if (fromModel) throw Error('远程服务连接仅能由用户在设置中管理');
        const old = connections(w).find((c) => c.id === p.id);
        if (op === 'connections_save') {
          if (p.id && !old) throw Error('连接不存在');
          if (!old && connections(w).length >= 8) throw Error('最多连接 8 个远程服务');
          const endpoint = serviceEndpoint(String(p.endpoint || '')),
            name = String(p.name || '远程服务')
              .trim()
              .slice(0, 120);
          if (connections(w).some((c) => c.id !== old?.id && c.endpoint === endpoint))
            throw Error('此服务已连接，请编辑现有连接；同一工作区共用一个服务连接');
          if (!old && !p.token) throw Error('请输入连接令牌');
          if (!safeStorage.isEncryptionAvailable()) throw Error('系统凭据存储不可用');
          if (
            p.token &&
            (typeof p.token !== 'string' || p.token.length < 32 || p.token.length > 4096)
          )
            throw Error('连接令牌长度无效');
          const c = {
            ...old,
            id: old?.id || randomUUID(),
            workspaceId: w,
            name,
            endpoint,
            token: p.token ? safeStorage.encryptString(p.token).toString('base64') : old.token,
            allowActions: p.allowActions === true,
            access: 'read',
          };
          // Replacing an endpoint creates a new identity. Old widget/source IDs never bind to another server.
          if (old && old.endpoint !== endpoint)
            throw Error('请新增连接以更换服务地址，避免原组件错误绑定到其他服务');
          if (old) disconnect(old);
          state.connections = [...state.connections.filter((x) => x.id !== c.id), c];
          changed(w);
          await flush();
          connect(c);
          return publicConnection(c);
        }
        if (!old) throw Error('连接不存在');
        if (op === 'connections_retry') {
          disconnect(old);
          connect(old);
          return publicConnection(old);
        }
        if (op === 'connections_remove') {
          const ids = new Set(
            (old.snapshot?.instances || []).map((v) => mappedInstanceId(old.id, v.id)),
          );
          disconnect(old);
          for (const id of ids) {
            closePage(id);
            delete state.ai[id];
            delete state.storage[id];
          }
          state.widgets = state.widgets.filter((x) => !ids.has(x.instanceId));
          state.connections = state.connections.filter((x) => x.id !== old.id);
          changed(w);
          await flush();
          return { removed: true, backendContinues: true };
        }
        throw Error('未知远程连接操作');
      }
      return instanceCommand(w, p.instanceId, op, p, fromModel);
    },
    async output(w, p) {
      const r = await instanceCommand(w, p.instanceId, 'output_read', p);
      if (
        typeof r.data !== 'string' ||
        createHash('sha256').update(Buffer.from(r.data, 'base64')).digest('hex') !== r.sha256
      )
        throw Error('远程产出校验失败');
      return r;
    },
    close() {
      if (closed) return writeTail;
      closed = true;
      for (const c of state.connections) disconnect(c);
      for (const id of pages.keys()) closePage(id);
      return saveTimer ? flush() : writeTail;
    },
  };
}
