import { widgetContract } from './light-app-widgets-contract.mjs';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, extname, dirname } from 'node:path';
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import Ajv from 'ajv';
import { createAppDevelopment } from './light-apps-development.mjs';
import { sdkSource } from './light-apps-sdk.mjs';
import { scaffoldFiles } from './light-apps-templates.mjs';
import {
  checkMicroPackage,
  checkCapabilities,
  renderPrompt,
  parseResult,
  finalizeOutputs,
  inspectOutputs,
  hashValue,
  microPage,
  diffValues,
} from '../micro/micro-apps.mjs';

const json = (v) => JSON.stringify(v),
  hash = (v) => createHash('sha256').update(v).digest('hex');
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validators = new Map();
function compile(schema) {
  const key = json(schema);
  let validator = validators.get(key);
  if (!validator) {
    validator = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
    if (validators.size >= 128) validators.delete(validators.keys().next().value);
    validators.set(key, validator);
  }
  return validator;
}
const terminal = ['completed', 'failed', 'cancelled', 'interrupted'];
const MICRO_STORE = ['crystal', 'draft', 'improvement', 'baseline', 'export'];
function inside(root, path) {
  const rel = relative(root, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
}
function file(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw Error('需要项目内的相对路径');
  const path = resolve(root, name);
  if (!inside(root, path) || !inside(root, realpathSync(path))) throw Error('路径超出应用目录');
  return path;
}
function schemaCheck(schema, value) {
  const check = compile(schema || {});
  if (!check(value)) throw Error('数据不符合声明：' + ajv.errorsText(check.errors));
}
const uiTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
function manifestAt(directory, captureUi = false) {
  const root = realpathSync(directory),
    manifest = JSON.parse(readFileSync(file(root, 'yirang.app.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    !/^[-a-z0-9.]{3,80}$/.test(manifest.id) ||
    typeof manifest.name !== 'string' ||
    manifest.name.length > 120
  )
    throw Error('应用描述需要 schemaVersion:1、id、name');
  if (manifest.runtime?.kind === 'micro') {
    if (
      manifest.minHostApi !== undefined &&
      (!Number.isInteger(manifest.minHostApi) || manifest.minHostApi > 3)
    )
      throw Error('应用要求更新的宿主 API');
    for (const c of manifest.capabilities || [])
      (compile(c.inputSchema || {}), compile(c.outputSchema || {}));
    const micro = checkMicroPackage(root, manifest);
    let uiFiles = null,
      uiEntry = 'index.html';
    if (captureUi) {
      uiFiles = new Map();
      if (manifest.ui?.entry) {
        const entryPath = file(root, manifest.ui.entry),
          uiRoot = dirname(entryPath);
        uiEntry = relative(uiRoot, entryPath).replaceAll('\\', '/');
        const walkUi = (p) => {
          for (const e of readdirSync(p, { withFileTypes: true })) {
            const q = join(p, e.name);
            if (e.isDirectory()) walkUi(q);
            else if (uiTypes[extname(q)])
              uiFiles.set(relative(uiRoot, q).replaceAll('\\', '/'), readFileSync(q));
          }
        };
        walkUi(uiRoot);
      } else uiFiles.set(uiEntry, Buffer.from(microPage(manifest, micro.capabilities)));
    }
    return {
      root,
      manifest: { ...manifest, actions: [] },
      digest: micro.digest,
      micro,
      ai: micro,
      ...(uiFiles ? { uiFiles, uiEntry } : {}),
    };
  }
  if (
    manifest.minHostApi !== undefined &&
    (!Number.isInteger(manifest.minHostApi) ||
      manifest.minHostApi > (manifest.capabilities ? 3 : 2))
  )
    throw Error('应用要求更新的宿主 API');
  const ai = manifest.capabilities === undefined ? null : checkCapabilities(root, manifest);
  if (!['node', 'python', 'static'].includes(manifest.runtime?.kind))
    throw Error('runtime.kind 支持 node、python、static');
  if (manifest.runtime.kind !== 'static') file(root, manifest.runtime.entry);
  const uiEntry = file(root, manifest.ui?.entry || 'ui/index.html'),
    uiRoot = dirname(uiEntry),
    uiFiles = captureUi ? new Map() : null;
  let uiBytes = 0;
  if (!Array.isArray(manifest.actions) || manifest.actions.length > 100)
    throw Error('actions 必须是数组，最多 100 项');
  const seen = new Set();
  for (const action of manifest.actions) {
    if (!/^[-a-zA-Z0-9_.]{1,80}$/.test(action.name) || seen.has(action.name))
      throw Error('动作名称无效或重复');
    seen.add(action.name);
    if (!['read', 'write', 'external'].includes(action.effect))
      throw Error('动作必须声明 effect: read / write / external');
    compile(action.inputSchema || {});
    compile(action.outputSchema || {});
  }
  if (manifest.widgets !== undefined) {
    if (!Array.isArray(manifest.widgets) || manifest.widgets.length > 24)
      throw Error('widgets 最多 24 项');
    const ids = new Set();
    for (const w of manifest.widgets) {
      if (
        !/^[-a-z0-9.]{1,80}$/.test(w.id) ||
        ids.has(w.id) ||
        typeof w.name !== 'string' ||
        !w.name ||
        w.name.length > 120
      )
        throw Error('小组件 id/name 无效或重复');
      ids.add(w.id);
      if (
        !Array.isArray(w.sizes) ||
        !w.sizes.length ||
        w.sizes.some((n) => ![1, 2, 4, 8].includes(n))
      )
        throw Error('小组件仅支持 1、2、4、8 格');
      const path = file(root, w.entry);
      if (!inside(uiRoot, path) || extname(path) !== '.html')
        throw Error('小组件入口必须是 ui 目录内的 HTML');
    }
  }
  compile(manifest.configSchema || {});
  // Trust covers all executable project content, not only the manifest.
  const digest = createHash('sha256');
  let count = 0,
    total = 0;
  const walk = (path) => {
    for (const e of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (['.git', 'node_modules', '.venv', '__pycache__'].includes(e.name)) continue;
      const p = join(path, e.name),
        s = lstatSync(p);
      if (s.isSymbolicLink()) throw Error('应用项目不能包含符号链接');
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) {
        if (++count > 2000 || (total += s.size) > 32 * 1024 * 1024)
          throw Error('应用源码超过 2000 文件或 32 MiB，请分离数据与源码');
        const bytes = readFileSync(p);
        digest.update(relative(root, p));
        digest.update(bytes);
        if (uiFiles && inside(uiRoot, p) && uiTypes[extname(p)]) {
          if ((uiBytes += bytes.length) > 8 * 1024 * 1024)
            throw Error('页面静态资源超过 8 MiB，请缩减资源');
          uiFiles.set(relative(uiRoot, p).replaceAll('\\', '/'), bytes);
        }
      }
    }
  };
  walk(root);
  return {
    root,
    manifest,
    digest: digest.digest('hex'),
    ...(ai ? { ai } : {}),
    ...(uiFiles ? { uiFiles, uiEntry: relative(uiRoot, uiEntry).replaceAll('\\', '/') } : {}),
  };
}

export function createLightAppsCore({ directory, node = process.execPath, onChange = () => {} }) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'registry.sqlite'));
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,body TEXT,PRIMARY KEY(kind,id));',
  );
  const readRecord = db.prepare('SELECT body FROM records WHERE kind=? AND id=?'),
    readKind = db.prepare('SELECT body FROM records WHERE kind=?'),
    writeRecord = db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)');
  const get = (kind, id) => {
    if (id === undefined || id === null || id === '') return null;
    if (typeof id !== 'string') throw Error('记录 ID 必须是字符串');
    const row = readRecord.get(kind, id);
    return row ? JSON.parse(row.body) : null;
  };
  db.exec(
    "CREATE INDEX IF NOT EXISTS runs_by_instance ON records(kind,json_extract(body,'$.instanceId'),json_extract(body,'$.startedAt') DESC)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS active_runs ON records(json_extract(body,'$.state')) WHERE kind='run'; CREATE INDEX IF NOT EXISTS due_schedules ON records(json_extract(body,'$.enabled'),json_extract(body,'$.nextAt')) WHERE kind='schedule'; CREATE INDEX IF NOT EXISTS by_workspace ON records(kind,json_extract(body,'$.workspaceId'));",
  );
  const readRuns = db.prepare(
    "SELECT body FROM records WHERE kind='run' AND json_extract(body,'$.instanceId')=? AND COALESCE(json_extract(body,'$.action'),'')!='get_state' ORDER BY CASE WHEN json_extract(body,'$.state') IN ('running','starting','queued') THEN 0 ELSE 1 END, COALESCE(json_extract(body,'$.createdAt'),json_extract(body,'$.startedAt')) DESC LIMIT 100",
  );
  const runsFor = (id) => readRuns.all(id).map((r) => JSON.parse(r.body));
  const readRunSummaries = db.prepare(
    "SELECT json_remove(body,'$.input','$.result') AS body FROM records WHERE kind='run' AND json_extract(body,'$.instanceId')=? AND COALESCE(json_extract(body,'$.action'),'')!='get_state' ORDER BY CASE WHEN json_extract(body,'$.state') IN ('running','starting','queued') THEN 0 ELSE 1 END, COALESCE(json_extract(body,'$.createdAt'),json_extract(body,'$.startedAt')) DESC LIMIT 100",
  );
  const runSummaries = (id) => readRunSummaries.all(id).map((r) => JSON.parse(r.body));
  const all = (kind) => readKind.all(kind).map((row) => JSON.parse(row.body));
  const readWorkspace = db.prepare(
    "SELECT body FROM records WHERE kind=? AND json_extract(body,'$.workspaceId')=?",
  );
  const inWorkspace = (kind, id) => readWorkspace.all(kind, id).map((r) => JSON.parse(r.body));
  const epoch = randomUUID(),
    runVersions = new Map();
  const changedRun = (id) => {
    runVersions.set(id, (runVersions.get(id) || 0) + 1);
    onChange();
  };
  const put = (kind, item) => {
    if (kind === 'page-state') item = { ...item, updatedAt: Date.now() };
    writeRecord.run(kind, item.id, json(item));
    if (kind === 'run') changedRun(item.instanceId);
    else onChange();
    return item;
  };
  const children = new Map(),
    pages = new Map(),
    dispatching = new Set(),
    statePending = new Map(),
    stateFlights = new Map(),
    stateResults = new Map();
  const stateResult = (id) => stateResults.get(id);
  function keepState(r) {
    stateResults.set(r.id, r);
    while (stateResults.size > 128) stateResults.delete(stateResults.keys().next().value);
    return r;
  }
  function rejectState(id, message) {
    for (const [key, p] of statePending)
      if (p.instanceId === id) {
        clearTimeout(p.timer);
        statePending.delete(key);
        p.reject(Error(message));
      }
  }
  async function readState(v, p = {}) {
    const m = trusted(v),
      action = m.manifest.actions.find((a) => a.name === 'get_state');
    if (!action || action.effect !== 'read')
      throw Error('get_state 必须声明为只读动作，不能作为状态同步执行');
    schemaCheck(action.inputSchema, p.input || {});
    schemaCheck(m.manifest.configSchema, v.config || {});
    const key = json([v.id, m.digest, p.input || {}]);
    if (stateFlights.has(key)) return stateFlights.get(key);
    const job = (async () => {
      await start(v, m);
      const c = children.get(v.id);
      if (!c) throw Error('状态后端不可用');
      const id = 'state:' + randomUUID(),
        credentials = secrets(v.id);
      if (statePending.size >= 32) throw Error('状态同步繁忙，请稍后重试');
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            statePending.delete(id);
            reject(Error('状态同步超时，执行任务未被停止'));
          }, 8000);
          statePending.set(id, { instanceId: v.id, resolve, reject, timer, action });
          c.process.stdin.write(
            json({
              id,
              action: 'get_state',
              input: p.input || {},
              context: {
                instanceId: v.id,
                workspaceId: v.workspaceId,
                config: v.config || {},
                secrets: credentials,
                dataDir: development.dataPath(v),
                outputDir: join(development.dataPath(v), 'outputs'),
              },
            }) + '\n',
            (error) => {
              if (error) {
                clearTimeout(timer);
                statePending.delete(id);
                reject(error);
              }
            },
          );
        });
        return keepState({
          id,
          instanceId: v.id,
          action: 'get_state',
          state: 'completed',
          result,
          transient: true,
        });
      } catch (error) {
        log(v.id, '状态同步失败：' + error.message + '\n');
        throw error;
      }
    })().finally(() => stateFlights.delete(key));
    stateFlights.set(key, job);
    return job;
  }
  const readQueued = db.prepare(
    "SELECT body FROM records WHERE kind='run' AND json_extract(body,'$.instanceId')=? AND COALESCE(json_extract(body,'$.kind'),'')!='micro' AND json_extract(body,'$.state') IN ('queued','starting') ORDER BY json_extract(body,'$.createdAt'),rowid",
  );
  const queuedFor = (id) => readQueued.all(id).map((r) => JSON.parse(r.body));
  let stopped = false,
    attached = true,
    vaultKey = null;
  const closePage = (id) => {
    const page = pages.get(id);
    if (page) {
      page.server.closeAllConnections();
      page.server.close();
      pages.delete(id);
    }
  };
  const secretNames = (id) => Object.keys(get('secrets', id)?.values || {});
  const secrets = (id) => {
    const values = get('secrets', id)?.values || {},
      out = {};
    for (const [name, value] of Object.entries(values)) {
      if (!vaultKey) throw Error('请打开一壤解锁本机凭据');
      const packed = Buffer.from(value, 'base64'),
        decipher = createDecipheriv('aes-256-gcm', vaultKey, packed.subarray(0, 12));
      decipher.setAAD(Buffer.from(id + ':' + name));
      decipher.setAuthTag(packed.subarray(12, 28));
      out[name] = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    }
    return out;
  };
  db.prepare(
    "UPDATE records SET body=json_set(body,'$.state','interrupted','$.error',?,'$.endedAt',?) WHERE kind='run' AND COALESCE(json_extract(body,'$.kind'),'')!='micro' AND json_extract(body,'$.state') IN ('running','queued','starting')",
  ).run('后台服务已重启；不会自动重放可能有副作用的动作', Date.now());
  db.prepare(
    "UPDATE records SET body=json_set(body,'$.state','interrupted','$.error',?) WHERE kind='devjob' AND json_extract(body,'$.state')='running'",
  ).run('宿主重启，安装任务未确认完成，请重新安装');
  const instance = (workspaceId, id) => {
    const v = get('instance', id);
    if (!v || v.workspaceId !== workspaceId || v.deletedAt) throw Error('实例不属于当前工作区');
    return v;
  };
  const registered = (id) => {
    const v = get('app', id);
    if (!v) throw Error('应用未注册');
    return v;
  };
  const current = (v, captureUi = false) =>
    manifestAt(v.sourceRoot || registered(v.appId).root, captureUi);
  const trusted = (v, captureUi = false) => {
    const m = current(v, captureUi);
    if (m.micro) return m;
    if (v.approvedDigest !== m.digest) throw Error('应用源码已改变，请在轻应用面板重新授权');
    return m;
  };
  const unreadCount = db.prepare(
    "SELECT count(*) AS count FROM records WHERE kind='notification' AND json_extract(body,'$.instanceId')=? AND json_extract(body,'$.read')=0",
  );
  const instanceManifest = (v) =>
    v.sourceRoot
      ? JSON.parse(readFileSync(join(v.sourceRoot, 'yirang.app.json'), 'utf8'))
      : registered(v.appId).manifest;
  const describeInstance = (v) => {
    const manifest = instanceManifest(v);
    return {
      ...v,
      manifest,
      approvedDigest: undefined,
      unread: unreadCount.get(v.id).count,
      runtime:
        manifest.runtime.kind === 'micro'
          ? 'micro'
          : children.has(v.id)
            ? 'running'
            : manifest.runtime.kind === 'static'
              ? pages.has(v.id)
                ? 'page-open'
                : 'static'
              : 'stopped',
      pageOpen: pages.has(v.id),
      runtimeKind: manifest.runtime.kind,
      busy: children.get(v.id)?.runId || null,
    };
  };
  const pendingLogs = new Map(),
    pendingProgress = new Map();
  let bufferTimer = null;
  const writeProgress = db.prepare(
    "UPDATE records SET body=json_set(body,'$.progress',?) WHERE kind='run' AND id=? AND json_extract(body,'$.state')='running'",
  );
  function flushBuffers() {
    clearTimeout(bufferTimer);
    bufferTimer = null;
    for (const [id, text] of pendingLogs) {
      const v = get('log', id) || { id, text: '' };
      put('log', { id, text: (v.text + text).slice(-65536) });
    }
    pendingLogs.clear();
    for (const [id, value] of pendingProgress) {
      writeProgress.run(value.text, id);
      changedRun(value.instanceId);
    }
    pendingProgress.clear();
  }
  function scheduleFlush() {
    if (!bufferTimer) {
      bufferTimer = setTimeout(flushBuffers, 500);
      bufferTimer.unref();
    }
  }
  function notify(v, title, body = '', level = 'info', runId) {
    if (v.notificationsEnabled === false || !get('instance', v.id)) return;
    title = String(title);
    body = String(body);
    try {
      for (const value of Object.values(secrets(v.id)))
        if (value) {
          title = title.split(value).join('[REDACTED]');
          body = body.split(value).join('[REDACTED]');
        }
    } catch {}
    put('notification', {
      id: randomUUID(),
      workspaceId: v.workspaceId,
      instanceId: v.id,
      appName: v.name,
      title: String(title).slice(0, 160),
      body: String(body).slice(0, 2000),
      level,
      runId,
      createdAt: Date.now(),
      read: false,
    });
    db.prepare(
      "DELETE FROM records WHERE kind='notification' AND id NOT IN (SELECT id FROM records WHERE kind='notification' ORDER BY json_extract(body,'$.createdAt') DESC LIMIT 500)",
    ).run();
  }
  function finish(run, state, extra = {}) {
    const old = get('run', run.id);
    if (!old || terminal.includes(old.state)) return;
    const progress = pendingProgress.get(run.id);
    pendingProgress.delete(run.id);
    put('run', {
      ...old,
      ...(progress !== undefined ? { progress: progress.text } : {}),
      ...extra,
      state,
      endedAt: Date.now(),
    });
    const owner = get('instance', run.instanceId);
    if (owner && !owner.deletedAt)
      notify(
        owner,
        run.action +
          ' · ' +
          ({ completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }[
            state
          ] || state),
        extra.error || '',
        state === 'failed' ? 'error' : 'info',
        run.id,
      );
    const c = children.get(run.instanceId);
    if (c?.runId === run.id) {
      clearTimeout(c.timer);
      c.runId = null;
    }
    if (!stopped) queueMicrotask(() => void drain(run.instanceId));
  }
  function stop(id) {
    rejectState(id, '应用已停止');
    for (const r of queuedFor(id))
      finish(r, 'cancelled', { error: '后端已停止，等待任务已取消；不会自动重放' });
    const child = children.get(id);
    if (child) {
      if (child.runId) finish(get('run', child.runId), 'cancelled');
      children.delete(id);
      child.process.kill();
      if (process.platform === 'win32' && child.process.pid)
        spawn('taskkill', ['/pid', String(child.process.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => {});
    }
    return { stopped: true };
  }
  function protocolFailure(c, message) {
    if (children.get(c.instanceId) !== c || !c.runId) return;
    log(c.instanceId, message + '\n');
    finish(get('run', c.runId), 'failed', { error: message });
    stop(c.instanceId);
  }
  function log(id, text) {
    if (stopped || !get('instance', id)) return;
    try {
      for (const value of Object.values(secrets(id)))
        if (value) text = text.split(value).join('[REDACTED]');
    } catch {}
    pendingLogs.set(id, ((pendingLogs.get(id) || '') + text).slice(-65536));
    scheduleFlush();
  }
  async function start(v, verified) {
    if (development.isBusy(v)) throw Error('应用正在更新、备份或安装依赖，请稍后启动');
    const m = verified || trusted(v);
    if (children.has(v.id)) return describeInstance(v);
    if (['static', 'micro'].includes(m.manifest.runtime.kind)) return describeInstance(v);
    if (children.size >= 8) throw Error('最多同时运行 8 个应用实例');
    const dataDir = development.dataPath(v),
      outputDir = join(dataDir, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    const localPython = join(
      m.root,
      '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
    const program =
      m.manifest.runtime.kind === 'python'
        ? existsSync(localPython)
          ? localPython
          : v.pythonProgram
        : node;
    if (!program) throw Error('未配置 Python 环境，请从面板启动一次');
    const child = spawn(
      program,
      [
        ...(m.manifest.runtime.kind === 'python' ? ['-u'] : []),
        file(m.root, m.manifest.runtime.entry),
      ],
      {
        cwd: m.root,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          PYTHONIOENCODING: 'utf-8',
          YIRANG_INSTANCE_ID: v.id,
          YIRANG_DATA_DIR: dataDir,
          YIRANG_OUTPUT_DIR: outputDir,
        },
      },
    );
    const c = { process: child, instanceId: v.id, runId: null, timer: null };
    children.set(v.id, c);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => log(v.id, text));
    child.stdin.on('error', (error) => log(v.id, error.message));
    child.stdout.on('data', (text) => {
      if (stopped || children.get(v.id) !== c) return;
      buffer += text;
      if (buffer.length > 2 * 1024 * 1024) {
        log(v.id, '协议行超过 2 MiB，已停止');
        stop(v.id);
        return;
      }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          log(v.id, line + '\n');
          continue;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          if (c.runId)
            protocolFailure(c, '后端返回了无效 JSON 消息；需要 {id,result} 或 {id,error}');
          continue;
        }
        if (event.event === 'state') {
          if (
            event.value &&
            typeof event.value === 'object' &&
            !Array.isArray(event.value) &&
            json(event.value).length <= 64000
          )
            put('page-state', { id: v.id, value: event.value });
          else log(v.id, '共享状态必须是小于 64 KiB 的 JSON 对象\n');
          continue;
        }
        if (event.event === 'notification') {
          const fresh = get('instance', v.id);
          if (fresh && !fresh.deletedAt && Date.now() - (c.lastNotice || 0) > 2000) {
            c.lastNotice = Date.now();
            notify(fresh, event.title || '应用通知', event.message || '');
          }
          continue;
        }
        if (typeof event.id === 'string' && event.id.startsWith('state:')) {
          const pending = statePending.get(event.id);
          if (
            pending &&
            pending.instanceId === v.id &&
            (Object.hasOwn(event, 'result') || event.error)
          ) {
            clearTimeout(pending.timer);
            statePending.delete(event.id);
            try {
              if (event.error) throw Error(String(event.error));
              schemaCheck(pending.action.outputSchema, event.result);
              pending.resolve(event.result);
            } catch (error) {
              pending.reject(error);
            }
          }
          continue;
        }
        if (!c.runId) continue;
        const terminalMessage =
          Object.hasOwn(event, 'result') ||
          Object.hasOwn(event, 'error') ||
          event.type === 'action_result';
        if (event.id !== c.runId) {
          if (
            terminalMessage &&
            (!event.id ||
              !get('run', String(event.id)) ||
              get('run', String(event.id)).instanceId !== v.id)
          )
            protocolFailure(
              c,
              '任务协议不匹配：返回必须包含当前请求的 id，不能使用 requestId 代替；动作已停止',
            );
          continue;
        }
        if (terminalMessage && !Object.hasOwn(event, 'result') && !event.error) {
          protocolFailure(c, '任务响应缺少 result 或有效 error；动作已停止');
          continue;
        }
        if (event.event === 'progress') {
          pendingProgress.set(c.runId, {
            instanceId: v.id,
            text: String(event.message || '').slice(0, 2000),
          });
          scheduleFlush();
          continue;
        }
        const run = get('run', c.runId);
        if (!run || terminal.includes(run.state)) continue;
        if (event.error) {
          finish(run, 'failed', { error: String(event.error).slice(0, 4000) });
          continue;
        }
        if (Object.hasOwn(event, 'result')) {
          try {
            const action = m.manifest.actions.find((a) => a.name === run.action);
            schemaCheck(action.outputSchema, event.result);
            const outputs = [];
            for (const out of (event.outputs || []).slice(0, 30)) {
              const p = file(outputDir, out.path),
                s = lstatSync(p);
              if (!s.isFile() || s.size > 50 * 1024 * 1024)
                throw Error('产出不是普通文件或超过 50 MiB');
              outputs.push({
                path: out.path,
                name: out.name || out.path.split(/[\\/]/).pop(),
                size: s.size,
                sha256: hash(readFileSync(p)),
              });
            }
            finish(run, 'completed', { result: event.result, outputs });
          } catch (error) {
            finish(run, 'failed', { error: error.message });
          }
        }
      }
    });
    child.on('error', (error) => {
      if (children.get(v.id) !== c) return;
      rejectState(v.id, error.message);
      log(v.id, error.message);
      if (!c.runId) notify(v, '后台启动失败', error.message, 'error');
      if (c.runId) finish(get('run', c.runId), 'failed', { error: error.message });
      if (children.get(v.id) === c) children.delete(v.id);
      for (const r of queuedFor(v.id))
        finish(r, 'interrupted', { error: '后端退出，等待任务未执行' });
    });
    child.on('exit', (code) => {
      if (children.get(v.id) !== c) return;
      rejectState(v.id, '状态后端已退出');
      if (c.runId) finish(get('run', c.runId), 'failed', { error: `后端退出 (${code})` });
      if (children.get(v.id) === c) children.delete(v.id);
      for (const r of queuedFor(v.id))
        finish(r, 'interrupted', { error: '后端退出，等待任务未执行' });
    });
    await new Promise((yes, no) => {
      child.once('spawn', yes);
      child.once('error', no);
    });
    return describeInstance(v);
  }
  async function invoke(v, p) {
    if (p.action === 'get_state') {
      if (p.__fromModel && !v.aiEnabled) throw Error('AI 接管未开启');
      return readState(v, p);
    }
    if (typeof p.requestId !== 'string' || p.requestId.length > 160 || !p.requestId)
      throw Error('调用必须提供 requestId');
    const fingerprint = hash(json([v.id, p.action, p.input || {}]));
    const prior = get('run', hash(v.id + ':' + p.requestId));
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw Error('requestId 已被不同输入使用');
      return prior;
    }
    const m = trusted(v),
      action = m.manifest.actions.find((a) => a.name === p.action);
    if (!action) throw Error('未声明的动作');
    schemaCheck(action.inputSchema, p.input || {});
    schemaCheck(m.manifest.configSchema, v.config || {});
    if (m.manifest.runtime.kind === 'static') throw Error('静态应用没有后端动作');
    if (m.micro) throw Error('微应用没有后端动作，请使用 yirang.ai.run');
    if (p.__fromModel && !instance(v.workspaceId, v.id).aiEnabled) throw Error('AI 接管已撤回');
    if (queuedFor(v.id).length >= 50) throw Error('等待队列已满（50 项），请取消不需要的任务');
    const run = put('run', {
      id: hash(v.id + ':' + p.requestId),
      requestId: p.requestId,
      fingerprint,
      instanceId: v.id,
      workspaceId: v.workspaceId,
      action: p.action,
      actionTitle: action.title || p.action,
      input: p.input || {},
      fromModel: p.__fromModel === true,
      source: p.requestId.startsWith('schedule:') ? 'schedule' : p.__fromModel ? 'ai' : 'page',
      approvedDigest: m.digest,
      state: 'queued',
      createdAt: Date.now(),
      outputs: [],
    });
    void drain(v.id);
    return get('run', run.id);
  }
  async function drain(id) {
    if (stopped || dispatching.has(id) || children.get(id)?.runId) return;
    const next = queuedFor(id).find((r) => r.state === 'queued');
    if (!next) return;
    dispatching.add(id);
    put('run', { ...next, state: 'starting' });
    try {
      const v = instance(next.workspaceId, id),
        m = trusted(v),
        action = m.manifest.actions.find((a) => a.name === next.action);
      if (m.digest !== next.approvedDigest) throw Error('应用版本已改变，请重新提交任务');
      if (next.fromModel && !v.aiEnabled) throw Error('AI 接管已撤回');
      if (!action) throw Error('动作已不存在');
      schemaCheck(action.inputSchema, next.input);
      schemaCheck(m.manifest.configSchema, v.config || {});
      await start(v, m);
      if (stopped) return;
      if (get('run', next.id)?.state !== 'starting') return;
      const fresh = instance(next.workspaceId, id);
      if (next.fromModel && !fresh.aiEnabled) throw Error('AI 接管已撤回');
      const c = children.get(id);
      if (!c || c.runId) throw Error('后端尚未就绪');
      const credentials = secrets(id),
        timeoutMs = Math.min(3600000, Math.max(1000, action.timeoutMs || 120000));
      const run = put('run', {
        ...next,
        state: 'running',
        startedAt: Date.now(),
        timeoutMs,
        outputDir: join(development.dataPath(fresh), 'outputs'),
      });
      c.runId = run.id;
      c.timer = setTimeout(() => {
        finish(run, 'failed', { error: '动作超时，已停止后端；等待任务已取消' });
        stop(id);
      }, timeoutMs);
      c.process.stdin.write(
        json({
          id: run.id,
          action: run.action,
          input: run.input,
          context: {
            instanceId: id,
            workspaceId: fresh.workspaceId,
            config: fresh.config || {},
            secrets: credentials,
            dataDir: development.dataPath(fresh),
            outputDir: run.outputDir,
          },
        }) + '\n',
        (error) => {
          if (error && children.get(id) === c && c.runId === run.id) {
            finish(run, 'failed', { error: error.message });
            stop(id);
          }
        },
      );
    } catch (error) {
      if (!stopped) finish(next, 'failed', { error: error.message });
    } finally {
      dispatching.delete(id);
      if (!stopped && !children.get(id)?.runId) queueMicrotask(() => void drain(id));
    }
  }
  function cancelRun(v, r) {
    if (!r || r.instanceId !== v.id) throw Error('运行记录不属于实例');
    if (r.kind === 'micro') {
      if (r.state === 'queued') finish(r, 'cancelled');
      else if (!terminal.includes(r.state)) put('run', { ...r, cancelRequested: true });
      return get('run', r.id);
    }
    if (r.state === 'queued') finish(r, 'cancelled');
    else if (!terminal.includes(r.state)) stop(v.id);
    return get('run', r.id);
  }

  // Micro apps: the host owns run snapshots and outputs; Electron main owns model execution.
  const execActive = ['sending', 'running', 'stopping', 'unknown'];
  const microRuns = db.prepare(
    "SELECT body FROM records WHERE kind='run' AND json_extract(body,'$.kind')='micro' AND json_extract(body,'$.workspaceId')=? ORDER BY json_extract(body,'$.createdAt'),rowid",
  );
  const microFor = (w) => microRuns.all(w).map((r) => JSON.parse(r.body));
  const microCapability = (m, name) => {
    const c = m.ai?.capabilities.find((x) => x.name === name);
    if (!c) throw Error('未声明的 AI 能力');
    return c;
  };
  const instanceOutputs = (v) => join(development.dataPath(v), 'outputs');
  // 9.1 signals stay local and are filed under the app version that produced the run.
  const signal = (run, type, extra = {}) =>
    put('signal', {
      id: randomUUID(),
      workspaceId: run.workspaceId,
      instanceId: run.instanceId,
      runId: run.id,
      appVersion: run.snapshot?.appVersion ?? null,
      capability: run.capability,
      type,
      ...extra,
      createdAt: Date.now(),
    });
  function editSignal(run, output) {
    const before = run.editedResult?.output ?? run.result;
    if (hashValue(before) === hashValue(output)) return null;
    return signal(run, 'edit', {
      beforeHash: hashValue(run.result),
      afterHash: hashValue(output),
      changes: diffValues(run.result, output),
    });
  }
  // Same text typed into the same field across runs is a requirement the prompt should carry.
  function repeatSignals(run) {
    const earlier = microFor(run.workspaceId).filter(
      (r) =>
        r.id !== run.id &&
        r.instanceId === run.instanceId &&
        r.capability === run.capability &&
        r.snapshot?.appVersion === run.snapshot.appVersion,
    );
    const known = inWorkspace('signal', run.workspaceId).filter(
      (x) =>
        x.instanceId === run.instanceId &&
        x.type === 'repeat-note' &&
        x.appVersion === run.snapshot.appVersion,
    );
    for (const [field, value] of Object.entries(run.input || {})) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text.length < 4) continue;
      const textHash = hashValue(text);
      if (known.some((x) => x.field === field && x.textHash === textHash)) continue;
      if (
        earlier.filter(
          (r) => typeof r.input?.[field] === 'string' && r.input[field].trim() === text,
        ).length >= 2
      )
        signal(run, 'repeat-note', { field, textHash, note: text.slice(0, 2000) });
    }
  }
  const finalizing = new Set();
  async function finalizeMicro(id) {
    if (finalizing.has(id)) return get('run', id);
    finalizing.add(id);
    try {
      const run = get('run', id);
      if (!run || run.state !== 'finalizing') return run;
      const v = get('instance', run.instanceId);
      if (!v || v.deletedAt) return run;
      const result = await finalizeOutputs({
        outputDir: instanceOutputs(v),
        run,
        capability: run.snapshot.capability,
        registered: run.outputs || [],
      });
      const fresh = get('run', id);
      if (!fresh || fresh.state !== 'finalizing') return fresh;
      const diagnostics = [
        ...(fresh.diagnostics || []),
        ...result.diagnostics.map((d) => ({ ...d, at: Date.now() })),
      ].slice(-50);
      if (result.complete) {
        finish(fresh, 'completed', {
          outputs: result.outputs,
          diagnostics,
          outputDir: instanceOutputs(v),
        });
        return get('run', id);
      }
      return put('run', {
        ...fresh,
        outputs: result.outputs,
        diagnostics,
        outputDir: instanceOutputs(v),
        error: '文件生成失败，可重试',
      });
    } finally {
      finalizing.delete(id);
    }
  }
  function microSubmit(v, p) {
    const m = current(v),
      c = microCapability(m, p.capability);
    if (typeof p.requestId !== 'string' || !p.requestId || p.requestId.length > 160)
      throw Error('调用必须提供 requestId');
    if (v.aiGrant !== m.ai.aiGrantDigest) throw Error('需要先授权该应用把所选材料发送给 AI 模型');
    const materials = (p.materials || []).map((x) => ({
      id: String(x.id),
      title: String(x.title || '').slice(0, 200),
      sha256: hashValue(String(x.text ?? '')),
      text: String(x.text ?? ''),
    }));
    const fingerprint = hashValue([
        c.name,
        p.input || {},
        materials.map((x) => [x.id, x.sha256]),
        c.definitionHash,
      ]),
      id = hash(v.id + ':' + p.requestId),
      prior = get('run', id);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw Error('请求参数已改变：同一 requestId 不能用于不同能力、输入或材料');
      return prior;
    }
    schemaCheck(c.inputSchema, p.input || {});
    if (materials.length < c.materials.min || materials.length > c.materials.max)
      throw Error(`该能力需要 ${c.materials.min}–${c.materials.max} 份材料`);
    const prompt = renderPrompt(c, p.input || {}, materials);
    const snapshot = {
      appVersion: m.manifest.version || null,
      digest: m.digest,
      capability: {
        name: c.name,
        title: c.title,
        definitionHash: c.definitionHash,
        wireHash: c.wireHash,
        outputSchema: c.outputSchema,
        wire: c.wire,
        outputs: c.outputs,
        timeoutMs: c.timeoutMs,
      },
      input: p.input || {},
      materials: materials.map(({ text, ...x }) => x),
      model: p.model || null,
    };
    put('micro-prompt', { id, prompt });
    const run = put('run', {
      id,
      kind: 'micro',
      requestId: p.requestId,
      fingerprint,
      instanceId: v.id,
      workspaceId: v.workspaceId,
      action: c.name,
      actionTitle: c.title,
      capability: c.name,
      input: p.input || {},
      snapshot,
      source: p.__fromModel ? 'ai' : 'page',
      state: 'queued',
      exec: { state: 'queued' },
      createdAt: Date.now(),
      outputs: [],
    });
    repeatSignals(run);
    return run;
  }
  const readMicroBusy = db.prepare(
    "SELECT 1 FROM records WHERE kind='run' AND json_extract(body,'$.kind')='micro' AND json_extract(body,'$.instanceId')=? AND json_extract(body,'$.exec.state') IN ('sending','running','stopping','unknown') LIMIT 1",
  );
  const microExecBusy = (instanceId) => !!readMicroBusy.get(instanceId);
  function microClaim(workspaceId) {
    for (const run of microFor(workspaceId)) {
      if (run.state !== 'queued' || microExecBusy(run.instanceId)) continue;
      const claimed = put('run', {
        ...run,
        state: 'running',
        startedAt: Date.now(),
        exec: { state: 'sending', claimedAt: Date.now() },
      });
      return {
        run: claimed,
        prompt: get('micro-prompt', run.id)?.prompt,
        wire: run.snapshot.capability.wire,
        timeoutMs: run.snapshot.capability.timeoutMs,
        model: run.snapshot.model,
      };
    }
    return null;
  }
  async function microResult(p) {
    const run = get('run', p.runId);
    if (!run || run.kind !== 'micro') throw Error('微应用运行不存在');
    const exec = {
      ...run.exec,
      state: 'ended',
      endedAt: Date.now(),
      endReason: p.notStarted ? 'not_started' : p.status || 'completed',
      usage: p.usage || run.exec?.usage || null,
    };
    if (p.requeue && run.state === 'running') {
      return put('run', { ...run, state: 'queued', exec: { state: 'queued' } });
    }
    if (terminal.includes(run.state) || !['running', 'verifying', 'unknown'].includes(run.state)) {
      put('run', {
        ...run,
        exec,
        lateResult:
          p.text === undefined
            ? run.lateResult
            : { text: String(p.text).slice(0, 262144), at: Date.now() },
      });
      return get('run', run.id);
    }
    // Cancellation keeps the real execution outcome but never delivers it.
    if (run.cancelRequested) {
      finish(run, 'cancelled', {
        exec,
        error: '已取消；模型结果只记录，不生成产出',
        lateResult:
          p.text === undefined
            ? undefined
            : { text: String(p.text).slice(0, 262144), status: p.status, at: Date.now() },
      });
      return get('run', run.id);
    }
    if (p.notStarted || p.status !== 'completed') {
      const error = String(p.error || '模型回合未完成').slice(0, 4000);
      finish(run, 'failed', {
        exec,
        error,
        raw: p.text === undefined ? undefined : String(p.text).slice(0, 262144),
      });
      signal(run, 'failure', {
        category: p.notStarted ? 'not-started' : 'execution',
        error: error.slice(0, 500),
      });
      return get('run', run.id);
    }
    let result;
    try {
      result = parseResult(
        p.text,
        (() => {
          const check = compile(run.snapshot.capability.outputSchema);
          return Object.assign((value) => check(value), {
            errorsText: () => ajv.errorsText(check.errors),
          });
        })(),
      );
    } catch (error) {
      finish(run, 'failed', {
        exec,
        error: error.message,
        raw: String(p.text ?? '').slice(0, 262144),
      });
      signal(run, 'failure', { category: 'schema', error: error.message.slice(0, 500) });
      return get('run', run.id);
    }
    put('run', {
      ...run,
      exec,
      result,
      resultHash: hashValue(result),
      state: 'finalizing',
      verifiedAt: Date.now(),
    });
    return finalizeMicro(run.id);
  }
  function microRecover() {
    for (const run of all('run').filter((r) => r.kind === 'micro')) {
      if (run.state === 'running' && execActive.includes(run.exec?.state))
        put('run', {
          ...run,
          state: 'verifying',
          verifyingSince: Date.now(),
          exec: { ...run.exec, state: 'unknown' },
        });
      else if (execActive.includes(run.exec?.state) && run.exec.state !== 'unknown')
        put('run', { ...run, exec: { ...run.exec, state: 'unknown' } });
      else if (run.state === 'finalizing')
        queueMicrotask(() => void finalizeMicro(run.id).catch(() => {}));
    }
  }
  async function openPage(v) {
    if (pages.has(v.id)) {
      trusted(v);
      return { url: pages.get(v.id).url };
    }
    if (pages.size >= 4) throw Error('最多同时打开 4 个应用页面，请先关闭其他页面');
    // Serve an immutable, approved snapshot. Asset requests never execute newly edited source.
    const m = trusted(v, true),
      assets = m.uiFiles,
      entry = m.uiEntry,
      token = randomBytes(24).toString('hex');
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost'),
          prefix = '/' + token + '/';
        if (!url.pathname.startsWith(prefix)) {
          res.writeHead(404).end();
          return;
        }
        const route = decodeURIComponent(url.pathname.slice(prefix.length));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', 'null');
        // Sandboxed app frames have an opaque origin. JSON action requests need
        // a CORS preflight even though their assets come from this page server.
        if (req.method === 'OPTIONS' && route === 'api') {
          res.setHeader('Access-Control-Allow-Methods', 'POST');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.writeHead(204).end();
          return;
        }
        if (req.method === 'POST' && route === 'api') {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 128000) throw Error('请求过大');
          }
          const p = JSON.parse(body),
            fresh = instance(v.workspaceId, v.id);
          let result;
          if (p.operation === 'storage_mutate') {
            const values = new Map(Object.entries(get('page-storage', v.id)?.value || {}));
            if (p.action === 'clear') values.clear();
            else if (p.action === 'remove' && typeof p.key === 'string') values.delete(p.key);
            else if (p.action === 'set' && typeof p.key === 'string' && typeof p.value === 'string')
              values.set(p.key, p.value);
            else throw Error('无效的页面存储操作');
            const value = Object.fromEntries(values);
            if (json(value).length > 48000) throw Error('页面存储超过 48 KiB');
            put('page-storage', { id: v.id, value });
            result = { saved: true };
          } else if (p.operation === 'state_get') result = get('page-state', v.id)?.value || {};
          else if (p.operation === 'state_set') {
            if (json(p.value).length > 64000) throw Error('页面状态超过 64 KiB');
            put('page-state', { id: v.id, value: p.value });
            result = { saved: true };
          } else if (p.operation === 'cancel') {
            const r = get('run', p.runId);
            if (!r || r.instanceId !== v.id) throw Error('运行不属于当前应用');
            result = cancelRun(v, r);
          } else if (p.operation === 'outputs_list')
            result = runSummaries(v.id).flatMap((r) =>
              (r.outputs || []).map((o) => ({ ...o, runId: r.id })),
            );
          else if (p.operation === 'action_call') result = await invoke(fresh, p);
          else if (p.operation === 'feedback')
            result = await command(v.workspaceId, 'feedback', { ...p, instanceId: v.id });
          else if (p.operation === 'result_edit')
            result = await command(v.workspaceId, 'result_edit', {
              runId: p.runId,
              output: p.output,
              instanceId: v.id,
            });
          else if (p.operation === 'runs_get') {
            if (p.runId) {
              const r = stateResult(p.runId) || get('run', p.runId);
              result = r?.instanceId === v.id ? [r] : [];
            } else result = runsFor(v.id);
          } else throw Error('页面只开放 action_call / runs_get');
          res.setHeader('Content-Type', 'application/json');
          res.end(json(result));
          return;
        }
        if (req.method !== 'GET') throw Error('不支持的请求');
        if (route === '__yirang_sdk.js' || route === 'yirang.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(
            sdkSource.replace('/*YIRANG_STORAGE_SEED*/{}', () =>
              json(get('page-storage', v.id)?.value || {}),
            ),
          );
          return;
        }
        const path = route || entry,
          bytes = assets.get(path);
        if (!bytes) throw Error('静态资源不在已授权页面快照中');
        res.setHeader('Content-Type', uiTypes[extname(path)]);
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",
        );
        const html = extname(path) === '.html' ? bytes.toString('utf8') : null,
          loader = '<script src="/' + token + '/__yirang_sdk.js"></script>';
        res.end(
          html === null
            ? bytes
            : /<script\b/i.test(html)
              ? html.replace(/<script\b/i, loader + '<script')
              : html + loader,
        );
      } catch (error) {
        res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(json({ error: error.message }));
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    await new Promise((yes, no) => {
      server.once('error', no);
      server.listen(0, '127.0.0.1', yes);
    });
    try {
      instance(v.workspaceId, v.id);
    } catch (error) {
      server.closeAllConnections();
      server.close();
      throw error;
    }
    const url = `http://127.0.0.1:${server.address().port}/${token}/`;
    pages.set(v.id, { server, url });
    return { url };
  }
  const development = createAppDevelopment({
    directory,
    get,
    put,
    all,
    instance,
    registered,
    current,
    manifestAt,
    stop,
    closePage,
    children,
    notify,
    node,
    schemaCheck,
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  });
  microRecover();
  async function command(workspaceId, operation, p = {}) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw Error('缺少工作区');
    if (operation === 'remote_snapshot')
      return {
        instances: inWorkspace('instance', workspaceId)
          .filter((v) => !v.deletedAt)
          .map((v) => {
            const d = describeInstance(v);
            return {
              id: v.id,
              appId: v.appId,
              name: v.name,
              uiRevision: v.approvedDigest,
              manifest: d.manifest,
              runtime: d.runtime,
              runtimeKind: d.runtimeKind,
              busy: d.busy,
              unread: d.unread,
              state: get('page-state', v.id)?.value ?? null,
              stateAt: get('page-state', v.id)?.updatedAt ?? null,
            };
          }),
        notifications: inWorkspace('notification', workspaceId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 200),
      };
    if (
      /^(development_|draft_|release_|data_|dependencies_|package_)/.test(operation) ||
      operation === 'diagnostics' ||
      operation === 'files_import'
    ) {
      const result = await development.command(workspaceId, operation, p);
      if (result !== undefined) return result;
    }
    if (operation === 'list')
      return {
        apps: inWorkspace('app', workspaceId).filter((a) => !a.deletedAt),
        instances: inWorkspace('instance', workspaceId)
          .filter((v) => !v.deletedAt)
          .map(describeInstance),
      };
    if (operation === 'widgets_contract') return widgetContract;
    if (operation === 'widgets_list')
      return {
        items: inWorkspace('widget', workspaceId).filter((w) => {
          const v = get('instance', w.instanceId);
          return v && !v.deletedAt;
        }),
        catalog: inWorkspace('instance', workspaceId)
          .filter((v) => !v.deletedAt)
          .flatMap((v) => {
            try {
              const m = {
                manifest: instanceManifest(v),
                root: v.sourceRoot || registered(v.appId).root,
              };
              return (m.manifest.widgets || []).map((w) => ({
                ...w,
                entry: relative(
                  dirname(file(m.root, m.manifest.ui?.entry || 'ui/index.html')),
                  file(m.root, w.entry),
                ).replaceAll('\\', '/'),
                instanceId: v.id,
                appName: v.name,
              }));
            } catch {
              return [];
            }
          }),
      };
    if (operation === 'deleted_list') return [];
    if (operation === 'instance_restore')
      throw Error('应用已删除，不支持恢复；需要时请重新注册项目');
    if (operation === 'unregister') {
      const a = registered(p.appId);
      if (a.workspaceId !== workspaceId) throw Error('应用不属于工作区');
      if (inWorkspace('instance', workspaceId).some((v) => v.appId === a.id && !v.deletedAt))
        throw Error('请先删除该应用的所有实例');
      put('app', { ...a, deletedAt: Date.now() });
      return { removed: true, sourcePreserved: true };
    }
    if (operation === 'notifications_list')
      return inWorkspace('notification', workspaceId)
        .filter((n) => !p.instanceId || n.instanceId === p.instanceId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200);
    if (operation === 'notifications_update') {
      for (const n of inWorkspace('notification', workspaceId)) {
        if (p.instanceId && n.instanceId !== p.instanceId) continue;
        if (p.id && n.id !== p.id) continue;
        if (p.clear) db.prepare("DELETE FROM records WHERE kind='notification' AND id=?").run(n.id);
        else put('notification', { ...n, read: true });
      }
      return { updated: true };
    }
    if (operation === 'validate') return manifestAt(p.path);
    if (operation === 'scaffold') {
      if (!/^[-a-z0-9.]{3,80}$/.test(p.appId || ''))
        throw Error('应用 id 需要 3–80 位小写字母、数字、点或横线');
      if (existsSync(p.path)) throw Error('目标目录已经存在，不覆盖已有项目');
      for (const [name, content] of Object.entries(
        scaffoldFiles(p.appId, p.name || p.appId, p.runtime || 'node'),
      )) {
        const path = join(resolve(p.path), name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, { flag: 'wx' });
      }
      return { path: resolve(p.path) };
    }
    if (operation === 'register') {
      const m = manifestAt(p.path),
        id = hash(workspaceId + ':' + m.manifest.id),
        previous = get('app', id);
      if (previous && previous.root !== m.root) throw Error('同名应用已注册在其他路径');
      return put('app', { id, workspaceId, ...m });
    }
    if (operation === 'describe') {
      if (p.instanceId) {
        const v = instance(workspaceId, p.instanceId);
        return { ...describeInstance(v), ...current(v) };
      }
      const a = registered(p.appId);
      if (a.workspaceId !== workspaceId) throw Error('应用不属于当前工作区');
      return { ...a, ...manifestAt(a.root) };
    }
    if (operation === 'instance_create') {
      const a = registered(p.appId);
      if (a.deletedAt) throw Error('应用已移除注册，请重新注册');
      if (a.workspaceId !== workspaceId) throw Error('应用不属于当前工作区');
      schemaCheck(a.manifest.configSchema, p.config || {});
      const id = randomUUID();
      mkdirSync(join(directory, 'instances', id, 'outputs'), { recursive: true });
      return put('instance', {
        id,
        workspaceId,
        appId: a.id,
        name: String(p.name || a.manifest.name).slice(0, 120),
        config: p.config || {},
        background: false,
        createdAt: Date.now(),
      });
    }
    if (operation === 'micro_store_list') {
      if (!MICRO_STORE.includes(p.kind)) throw Error('无效记录类型');
      return inWorkspace('micro-' + p.kind, workspaceId);
    }
    if (operation === 'micro_store_put') {
      if (!MICRO_STORE.includes(p.kind) || !p.value?.id || p.value.workspaceId !== workspaceId)
        throw Error('无效记录');
      return put('micro-' + p.kind, p.value);
    }
    if (operation === 'micro_claim') return microClaim(workspaceId);
    if (operation === 'micro_result') {
      const r = get('run', p.runId);
      if (!r || r.workspaceId !== workspaceId) throw Error('运行不属于当前工作区');
      return microResult(p);
    }
    if (operation === 'micro_exec') {
      const r = get('run', p.runId);
      if (!r || r.workspaceId !== workspaceId || r.kind !== 'micro')
        throw Error('运行不属于当前工作区');
      const exec = { ...r.exec, ...p.exec };
      const state =
        p.verifying && r.state === 'running'
          ? 'verifying'
          : p.unknown && ['running', 'verifying'].includes(r.state)
            ? 'unknown'
            : r.state;
      return put('run', {
        ...r,
        exec,
        state,
        ...(state === 'verifying' && r.state !== 'verifying' ? { verifyingSince: Date.now() } : {}),
      });
    }
    if (operation === 'micro_active')
      return microFor(workspaceId)
        .filter((r) => execActive.includes(r.exec?.state) || r.state === 'finalizing')
        .map(({ input, result, ...r }) => r);
    const v = instance(workspaceId, p.instanceId);
    if (operation === 'micro_info') {
      const m = current(v);
      if (!m.ai) throw Error('应用没有声明 AI 能力');
      return {
        instanceId: v.id,
        name: v.name,
        aliases: m.manifest.aliases || [],
        version: m.manifest.version || null,
        micro: !!m.micro,
        autoPropose: m.manifest.evolution?.autoPropose !== false && v.autoPropose !== false,
        aiGrantDigest: m.ai.aiGrantDigest,
        granted: v.aiGrant === m.ai.aiGrantDigest,
        capabilities: m.ai.capabilities.map((c) => ({
          name: c.name,
          title: c.title,
          inputSchema: c.inputSchema,
          outputSchema: c.outputSchema,
          materials: c.materials,
          outputs: c.outputs,
          definitionHash: c.definitionHash,
        })),
      };
    }
    if (operation === 'ai_grant') {
      const m = current(v);
      if (!m.ai || p.digest !== m.ai.aiGrantDigest) throw Error('授权时能力定义发生变化');
      return describeInstance(
        put('instance', { ...v, aiGrant: p.digest, aiGrantedAt: Date.now() }),
      );
    }
    if (operation === 'micro_submit') return microSubmit(v, p);
    if (operation === 'micro_abandon') {
      const r = get('run', p.runId);
      if (!r || r.instanceId !== v.id || r.kind !== 'micro') throw Error('运行不属于实例');
      if (!['verifying', 'unknown'].includes(r.state))
        throw Error('只有正在核实或结果未知的运行可以放弃');
      finish(r, 'cancelled', {
        abandoned: true,
        error: '用户放弃了这次运行；旧执行核实结束前仍占用槽位，晚到结果只记录',
      });
      return get('run', r.id);
    }
    if (operation === 'micro_outputs_retry') {
      const r = get('run', p.runId);
      if (!r || r.instanceId !== v.id || r.kind !== 'micro') throw Error('运行不属于实例');
      if (r.state === 'finalizing') return finalizeMicro(r.id);
      if (r.state !== 'completed' || !p.regenerate) throw Error('运行不在文件生成阶段');
      const result = await finalizeOutputs({
        outputDir: instanceOutputs(v),
        run: r,
        capability: r.snapshot.capability,
        registered: r.outputs || [],
      });
      return put('run', {
        ...r,
        outputs: result.outputs,
        diagnostics: [...(r.diagnostics || []), ...result.diagnostics].slice(-50),
      });
    }
    if (operation === 'micro_outputs_drop') {
      const r = get('run', p.runId);
      if (!r || r.instanceId !== v.id || r.state !== 'finalizing')
        throw Error('运行不在文件生成阶段');
      const missing = inspectOutputs(instanceOutputs(v), r.outputs)
        .filter((o) => o.status !== 'valid')
        .map((o) => o.index);
      finish(r, 'completed', {
        outputs: (r.outputs || []).filter((o) => !missing.includes(o.index)),
        missingOutputs: r.snapshot.capability.outputs
          .map((_, i) => i)
          .filter((i) => missing.includes(i) || !(r.outputs || []).some((o) => o.index === i)),
        error: undefined,
      });
      return get('run', r.id);
    }
    if (operation === 'micro_outputs_inspect') {
      const r = get('run', p.runId);
      if (!r || r.instanceId !== v.id) throw Error('运行不属于实例');
      return inspectOutputs(r.outputDir || instanceOutputs(v), r.outputs || []);
    }
    if (operation === 'example_candidate') {
      const r = get('run', p.runId);
      if (!r || r.instanceId !== v.id || r.kind !== 'micro' || !r.result)
        throw Error('只有已得到结构化结果的运行可以提议样例');
      const output = p.output === undefined ? (r.editedResult?.output ?? r.result) : p.output;
      schemaCheck(r.snapshot.capability.outputSchema, output);
      if (p.output !== undefined) editSignal(r, output);
      return put('example', {
        id: randomUUID(),
        workspaceId,
        instanceId: v.id,
        appVersion: r.snapshot.appVersion,
        capability: r.capability,
        runId: r.id,
        snapshot: {
          input: r.snapshot.input,
          materials: r.snapshot.materials,
          definitionHash: r.snapshot.capability.definitionHash,
          model: r.snapshot.model,
        },
        output,
        outputHash: hashValue(output),
        source: 'page-proposal',
        status: 'candidate',
        createdAt: Date.now(),
      });
    }
    if (operation === 'example_confirm') {
      const e = get('example', p.id);
      if (!e || e.instanceId !== v.id || e.status !== 'candidate')
        throw Error('候选样例不存在或已处理');
      return put('example', {
        ...e,
        status: p.accepted === false ? 'rejected' : 'user-confirmed',
        source: p.accepted === false ? e.source : 'user-confirmed',
        confirmedAt: Date.now(),
        confirmedVia: 'host-ui',
      });
    }
    if (operation === 'examples_list')
      return inWorkspace('example', workspaceId).filter((e) => e.instanceId === v.id);
    if (operation === 'feedback') {
      const r = get('run', p.runId);
      if (!r || r.instanceId !== v.id) throw Error('运行不属于实例');
      return signal(r, 'feedback', {
        verdict: String(p.verdict || 'wrong').slice(0, 40),
        note: String(p.note || '').slice(0, 2000),
      });
    }
    if (operation === 'result_edit') {
      const r = get('run', p.runId);
      if (!r || r.instanceId !== v.id || r.kind !== 'micro' || !r.result)
        throw Error('只有已得到结构化结果的运行可以修改结果');
      schemaCheck(r.snapshot.capability.outputSchema, p.output);
      const s = editSignal(r, p.output);
      if (s)
        put('run', { ...get('run', r.id), editedResult: { output: p.output, at: Date.now() } });
      return { saved: true, signalId: s?.id || null };
    }
    if (operation === 'signals_list')
      return inWorkspace('signal', workspaceId)
        .filter((x) => x.instanceId === v.id)
        .sort((a, b) => a.createdAt - b.createdAt);
    if (operation === 'evolution_settings') {
      if (typeof p.autoPropose !== 'boolean') throw Error('autoPropose 需要 true 或 false');
      return describeInstance(put('instance', { ...v, autoPropose: p.autoPropose }));
    }
    if (operation === 'state_snapshot')
      return {
        value: get('page-state', v.id)?.value ?? null,
        updatedAt: get('page-state', v.id)?.updatedAt ?? null,
      };
    if (operation === 'shared_state_update') {
      if (
        !p.value ||
        typeof p.value !== 'object' ||
        Array.isArray(p.value) ||
        json(p.value).length > 64000
      )
        throw Error('共享状态必须是小于 64 KiB 的对象');
      put('page-state', { id: v.id, value: p.value });
      return { saved: true };
    }
    if (operation === 'ui_bundle') {
      const m = trusted(v, true);
      return {
        digest: m.digest,
        entry: m.uiEntry,
        assets: [...m.uiFiles].map(([path, data]) => ({ path, data: data.toString('base64') })),
      };
    }
    if (
      development.isLocked(v.id) &&
      ['instance_delete', 'authorize', 'config_update', 'schedules_update'].includes(operation)
    )
      throw Error('应用正在更新或备份，请稍后重试');
    if (operation === 'instance_delete') {
      if (development.isBusy(v)) throw Error('应用正在更新、备份或安装依赖，请稍后删除');
      for (const item of all('instance').filter((i) => i.id === v.id || i.previewOf === v.id)) {
        stop(item.id);
        closePage(item.id);
        pendingLogs.delete(item.id);
        db.prepare(
          "DELETE FROM records WHERE (kind IN ('instance','secrets','page-storage','log') AND id=?) OR json_extract(body,'$.instanceId')=?",
        ).run(item.id, item.id);
        runVersions.delete(item.id);
      }
      if (!all('instance').some((i) => i.appId === v.appId && !i.deletedAt))
        db.prepare("DELETE FROM records WHERE kind='app' AND id=?").run(v.appId);
      return { deleted: true, recoverable: false, sourcePreserved: true };
    }
    if (operation === 'ai_control') {
      const enabled = p.enabled === true;
      if (!enabled) {
        stop(v.id);
        for (const item of all('schedule'))
          if (item.instanceId === v.id && item.aiOwned)
            put('schedule', { ...item, enabled: false });
      }
      return describeInstance(put('instance', { ...v, aiEnabled: enabled }));
    }
    if (operation === 'notification_settings')
      return describeInstance(put('instance', { ...v, notificationsEnabled: p.enabled === true }));
    if (
      p.__fromModel &&
      ['start', 'action_call', 'config_update', 'schedules_update'].includes(operation) &&
      !v.aiEnabled
    )
      throw Error('AI 接管未开启或已撤回');
    if (operation === 'trust_info') return { instance: v, ...current(v) };
    if (operation === 'authorize') {
      const m = current(v);
      if (p.digest !== m.digest) throw Error('授权时源码发生变化');
      stop(v.id);
      closePage(v.id);
      return put('instance', {
        ...v,
        approvedDigest: p.digest,
        pythonProgram: p.pythonProgram,
        background: p.background === true,
      });
    }
    if (operation === 'widget_save') {
      const old = p.id ? get('widget', p.id) : null;
      if (p.id && (!old || old.instanceId !== v.id || old.workspaceId !== workspaceId))
        throw Error('小组件不属于此实例');
      const definition = current(v).manifest.widgets?.find(
        (w) => w.id === (p.widgetId || old?.widgetId),
      );
      if (!definition) throw Error('应用未声明此小组件');
      const size = p.size ?? old?.size ?? definition.sizes[0],
        x = p.x ?? old?.x ?? 0,
        y = p.y ?? old?.y ?? 0;
      if (
        !definition.sizes.includes(size) ||
        ![x, y].every((n) => Number.isFinite(n) && Math.abs(n) <= 1000000)
      )
        throw Error('小组件尺寸或位置无效');
      if (!old && inWorkspace('widget', workspaceId).length >= 64)
        throw Error('当前工作区最多 64 个小组件');
      const width = p.width ?? old?.width,
        height = p.height ?? old?.height,
        pinned = p.pinned ?? old?.pinned ?? false;
      if (
        typeof pinned !== 'boolean' ||
        (width !== undefined && (!Number.isFinite(width) || width < 220 || width > 1920)) ||
        (height !== undefined && (!Number.isFinite(height) || height < 160 || height > 1200))
      )
        throw Error('小组件显示尺寸或固定状态无效');
      const surface = p.surface ?? old?.surface ?? 'canvas',
        order = p.order ?? old?.order ?? Date.now();
      if (!['canvas', 'dashboard'].includes(surface) || !Number.isFinite(order))
        throw Error('组件显示位置无效');
      return put('widget', {
        id: old?.id || randomUUID(),
        workspaceId,
        instanceId: v.id,
        widgetId: definition.id,
        size,
        x,
        y,
        width,
        height,
        pinned,
        surface,
        order,
      });
    }
    if (operation === 'widget_context') {
      const w = get('widget', p.id);
      if (!w || w.instanceId !== v.id || w.workspaceId !== workspaceId)
        throw Error('小组件不属于当前工作区或应用');
      const m = instanceManifest(v),
        definition = m.widgets?.find((item) => item.id === w.widgetId);
      if (!definition) throw Error('小组件声明已移除');
      return {
        workspaceId,
        instanceId: v.id,
        app: { name: v.name, version: m.version, aiEnabled: !!v.aiEnabled },
        widget: {
          id: w.id,
          definitionId: w.widgetId,
          name: definition.name,
          entry: definition.entry,
          size: w.size,
        },
        capturedAt: new Date().toISOString(),
        state: get('page-state', v.id)?.value ?? null,
        stateNote:
          '已保存的公开共享状态快照，可能滞后；null 表示应用尚未发布共享状态，不代表数值为零。未执行查询或监控任务。',
      };
    }
    if (operation === 'widget_remove') {
      const w = get('widget', p.id);
      if (!w || w.instanceId !== v.id || w.workspaceId !== workspaceId) throw Error('小组件不存在');
      db.prepare("DELETE FROM records WHERE kind='widget' AND id=?").run(w.id);
      return { removed: true };
    }
    if (operation === 'start') return start(v);
    if (operation === 'stop') {
      closePage(v.id);
      for (const s of all('schedule'))
        if (s.instanceId === v.id) put('schedule', { ...s, enabled: false });
      return stop(v.id);
    }
    if (operation === 'open') return openPage(v);
    if (operation === 'close_page') {
      closePage(v.id);
      return { closed: true };
    }
    if (operation === 'action_call') return invoke(v, p);
    if (operation === 'cancel') {
      const r = get('run', p.runId);
      if (!r || r.instanceId !== v.id) throw Error('运行记录不属于实例');
      return cancelRun(v, r);
    }
    if (operation === 'runs_poll') {
      const cursor = epoch + ':' + (runVersions.get(v.id) || 0),
        running = !!children.get(v.id)?.runId || queuedFor(v.id).length > 0;
      return p.cursor === cursor
        ? { cursor, unchanged: true, running }
        : { cursor, running, items: runSummaries(v.id) };
    }
    if (operation === 'state_read') {
      if (p.__fromModel && !v.aiEnabled) throw Error('AI 接管未开启');
      return readState(v, p);
    }
    if (operation === 'runs_get') {
      if (p.runId) {
        const r = stateResult(p.runId) || get('run', p.runId);
        return r?.instanceId === v.id ? [r] : [];
      }
      return runsFor(v.id);
    }
    if (operation === 'logs_read') {
      const stored = get('log', v.id) || { id: v.id, text: '' };
      return { ...stored, text: (stored.text + (pendingLogs.get(v.id) || '')).slice(-65536) };
    }
    if (operation === 'config_get')
      return { config: v.config || {}, secretNames: secretNames(v.id) };
    if (operation === 'secret_set') {
      if (!vaultKey) throw Error('本机凭据尚未解锁');
      if (
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(p.name) ||
        typeof p.value !== 'string' ||
        p.value.length > 16000
      )
        throw Error('凭据名称使用大写字母、数字、下划线；值最多 16000 字');
      const values = get('secrets', v.id)?.values || {};
      if (p.value) {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
        cipher.setAAD(Buffer.from(v.id + ':' + p.name));
        const bytes = Buffer.concat([cipher.update(p.value, 'utf8'), cipher.final()]);
        values[p.name] = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
      } else delete values[p.name];
      put('secrets', { id: v.id, values });
      return { secretNames: secretNames(v.id) };
    }
    if (operation === 'config_update') {
      schemaCheck(current(v).manifest.configSchema, p.config);
      if (children.get(v.id)?.runId) throw Error('运行中不能修改配置');
      stop(v.id);
      return describeInstance(put('instance', { ...v, config: p.config }));
    }
    if (operation === 'schedules_list') return all('schedule').filter((s) => s.instanceId === v.id);
    if (operation === 'schedules_update') {
      const action = trusted(v).manifest.actions.find((a) => a.name === p.action);
      if (!action) throw Error('未声明的动作');
      schemaCheck(action.inputSchema, p.input || {});
      if (
        !Number.isInteger(p.intervalSeconds) ||
        p.intervalSeconds < 60 ||
        p.intervalSeconds > 86400 * 30
      )
        throw Error('定时间隔应为 60 秒至 30 天');
      const id = p.scheduleId || randomUUID(),
        old = get('schedule', id);
      if (old && old.instanceId !== v.id) throw Error('定时任务不属于实例');
      return put('schedule', {
        id,
        instanceId: v.id,
        workspaceId,
        action: p.action,
        input: p.input || {},
        intervalSeconds: p.intervalSeconds,
        enabled: p.enabled === true,
        aiOwned: p.__fromModel === true || old?.aiOwned === true,
        nextAt: Date.now() + p.intervalSeconds * 1000,
      });
    }
    if (operation === 'outputs_list')
      return runSummaries(v.id).flatMap((r) =>
        (r.outputs || []).map((o) => ({ ...o, runId: r.id })),
      );
    if (operation === 'output_read') {
      const r = get('run', p.runId),
        out = r?.instanceId === v.id ? r.outputs?.find((o) => o.path === p.path) : null;
      if (!out) throw Error('未登记的产出');
      const path = file(r.outputDir || join(directory, 'instances', v.id, 'outputs'), out.path),
        data = readFileSync(path);
      if (hash(data) !== out.sha256) throw Error('产出已变化，请重新运行后收回');
      return { fileName: out.name, data: data.toString('base64'), sha256: out.sha256 };
    }
    throw Error('不支持的轻应用操作');
  }
  const dueSchedules = db.prepare(
    "SELECT body FROM records WHERE kind='schedule' AND json_extract(body,'$.enabled')=1 AND json_extract(body,'$.nextAt')<=?",
  );
  const backgroundSchedule = db.prepare(
    "SELECT 1 FROM records WHERE kind='schedule' AND json_extract(body,'$.instanceId')=? AND json_extract(body,'$.enabled')=1 LIMIT 1",
  );
  const backgroundInstances = db.prepare(
    "SELECT body FROM records WHERE kind='instance' AND json_extract(body,'$.background')=1",
  );
  const tick = setInterval(async () => {
    if (stopped) return;
    for (const row of dueSchedules.all(Date.now())) {
      const schedule = JSON.parse(row.body);
      if (!attached && !get('instance', schedule.instanceId)?.background) continue;
      if (
        !schedule.enabled ||
        schedule.nextAt > Date.now() ||
        children.get(schedule.instanceId)?.runId
      )
        continue;
      put('schedule', { ...schedule, nextAt: Date.now() + schedule.intervalSeconds * 1000 });
      try {
        await command(schedule.workspaceId, 'action_call', {
          ...schedule,
          __fromModel: schedule.aiOwned === true,
          requestId: 'schedule:' + schedule.id + ':' + schedule.nextAt,
        });
      } catch (error) {
        put('schedule', { ...get('schedule', schedule.id), enabled: false, error: error.message });
        const owner = get('instance', schedule.instanceId);
        if (owner && !owner.deletedAt) notify(owner, '定时任务已暂停', error.message, 'error');
      }
    }
  }, 5000);
  tick.unref();
  return {
    command,
    attach(key) {
      attached = true;
      if (key) {
        const bytes = Buffer.from(key, 'hex');
        if (bytes.length !== 32) throw Error('凭据密钥无效');
        vaultKey = bytes;
      }
    },
    detach() {
      attached = false;
      for (const v of all('instance')) if (!v.background) stop(v.id);
      for (const id of pages.keys()) closePage(id);
    },
    hasBackground: () =>
      backgroundInstances.all().some((row) => {
        const v = JSON.parse(row.body);
        return children.has(v.id) || !!backgroundSchedule.get(v.id);
      }),
    close() {
      stopped = true;
      development.close();
      clearInterval(tick);
      for (const id of children.keys()) stop(id);
      for (const id of pages.keys()) closePage(id);
      flushBuffers();
      db.close();
    },
  };
}
