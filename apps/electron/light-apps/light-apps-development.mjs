import { widgetContract } from './light-app-widgets-contract.mjs';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  existsSync,
  realpathSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, delimiter } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const excluded = new Set([
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  '.env',
  'credentials.json',
  '.npmrc',
  '.pypirc',
  'secrets.json',
  'auth.json',
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function entries(root) {
  const out = [];
  let bytes = 0;
  function walk(path) {
    for (const name of readdirSync(path).sort()) {
      if (excluded.has(name) || name.startsWith('.env.')) continue;
      const p = join(path, name),
        s = lstatSync(p);
      if (s.isSymbolicLink()) throw Error('不能打包符号链接');
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) {
        if (out.length >= 2000 || (bytes += s.size) > 32 * 1024 * 1024)
          throw Error('源码超过 2000 文件或 32 MiB');
        out.push({ path: relative(root, p).replaceAll('\\', '/'), data: readFileSync(p) });
      }
    }
  }
  walk(root);
  return out;
}
function target(root, path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    path.split('/').some((x) => !x || x === '.' || x === '..' || x.includes(':')) ||
    isAbsolute(path)
  )
    throw Error('文件名必须是项目内相对路径');
  const result = resolve(root, path),
    rel = relative(root, result);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('路径越界');
  if (existsSync(root)) {
    let cursor = result;
    while (!existsSync(cursor)) cursor = dirname(cursor);
    const real = relative(realpathSync(root), realpathSync(cursor));
    if (real.startsWith('..') || isAbsolute(real)) throw Error('符号链接越界');
  }
  return result;
}
function writeTree(root, files) {
  mkdirSync(root, { recursive: true });
  for (const f of files) {
    const p = target(root, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.data, { flag: 'wx' });
  }
}
function snapshotData(source, destination) {
  mkdirSync(destination, { recursive: true });
  let total = 0,
    count = 0;
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('-wal') || name.endsWith('-shm')) continue;
      const src = join(dir, name),
        st = lstatSync(src);
      if (st.isSymbolicLink()) throw Error('数据目录含符号链接');
      const dst = join(destination, relative(source, src));
      if (st.isDirectory()) {
        mkdirSync(dst, { recursive: true });
        walk(src);
      } else if (st.isFile()) {
        if (++count > 10000 || (total += st.size) > 512 * 1024 * 1024)
          throw Error('数据备份超过 10000 文件或 512 MiB，请先清理历史产出');
        mkdirSync(dirname(dst), { recursive: true });
        const fd = openSync(src, 'r'),
          head = Buffer.alloc(16);
        try {
          readSync(fd, head, 0, 16, 0);
        } finally {
          closeSync(fd);
        }
        const header = head.toString();
        if (header === 'SQLite format 3\0') {
          const db = new DatabaseSync(src);
          try {
            db.exec("VACUUM INTO '" + dst.replaceAll("'", "''") + "'");
          } finally {
            db.close();
          }
        } else copyFileSync(src, dst);
      }
    }
  }
  walk(source);
}
export function createAppDevelopment(api) {
  const {
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
  } = api;
  const jobs = new Map(),
    locks = new Set();
  const dataPath = (v) => v.dataRoot || join(directory, 'instances', v.id);
  const sourcePath = (v) => v.sourceRoot || registered(v.appId).root;
  const draftFor = (v, id) => {
    const d = get('draft', id);
    if (!d || d.instanceId !== v.id || d.workspaceId !== v.workspaceId)
      throw Error('草稿不属于应用');
    return d;
  };
  const idle = (v) => {
    if (children.get(v.id)?.runId) throw Error('应用有运行中的任务，请先完成或取消');
    if ([...jobs.values()].some((j) => j.instanceId === v.id))
      throw Error('请先完成或取消依赖安装');
  };
  const quiesce = async (v) => {
    const child = children.get(v.id)?.process;
    if (!child) {
      stop(v.id);
      return;
    }
    await new Promise((yes, no) => {
      const timer = setTimeout(() => no(Error('后端仍未退出，请稍后重试')), 10000);
      child.once('exit', () => {
        clearTimeout(timer);
        yes();
      });
      stop(v.id);
    });
  };
  const backup = async (v) => {
    idle(v);
    await quiesce(v);
    const id = randomUUID(),
      path = join(directory, 'backups', id);
    snapshotData(dataPath(v), path);
    return put('backup', {
      id,
      instanceId: v.id,
      workspaceId: v.workspaceId,
      path,
      createdAt: Date.now(),
      version: current(v).manifest.version,
    });
  };
  const migrations = (m, from) => {
    const list = m.manifest.migrations || [];
    if (!Array.isArray(list) || list.length > 30) throw Error('migrations 应为数组，最多 30 项');
    return list.filter((x) => x.from === from && x.to === m.manifest.version);
  };
  function migrate(m, from, data) {
    for (const step of migrations(m, from)) {
      const sqlPath = target(m.root, step.sql),
        database = target(data, step.database);
      if (!existsSync(sqlPath) || !existsSync(database)) throw Error('迁移 SQL 或数据库不存在');
      const text = readFileSync(sqlPath, 'utf8');
      if (
        text.length > 256000 ||
        /\b(ATTACH|DETACH|VACUUM|PRAGMA|load_extension|BEGIN|COMMIT|ROLLBACK)\b/i.test(text)
      )
        throw Error('迁移仅支持事务内表结构及数据 SQL');
      const db = new DatabaseSync(database);
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(text);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw error;
      } finally {
        db.close();
      }
    }
  }
  function killJob(job) {
    job.cancelled = true;
    const child = job.process;
    if (child && child.exitCode === null) {
      child.kill();
      if (process.platform === 'win32' && child.pid)
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => {});
    }
  }
  function launchJob(v, kind, steps) {
    const id = randomUUID(),
      job = {
        id,
        instanceId: v.id,
        workspaceId: v.workspaceId,
        kind,
        state: 'running',
        createdAt: Date.now(),
        log: '',
      };
    put('devjob', job);
    const live = { instanceId: v.id, root: steps[0]?.cwd, cancelled: false, process: null };
    jobs.set(id, live);
    void (async () => {
      try {
        for (const step of steps) {
          if (live.cancelled) throw Error('已取消');
          await new Promise((yes, no) => {
            const child = spawn(step.program, step.args, {
              cwd: step.cwd,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
            });
            live.process = child;
            const timer = setTimeout(() => {
              killJob(live);
              no(Error('依赖安装超时'));
            }, 600000);
            const log = (b) => {
              job.log = (
                job.log + String(b).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
              ).slice(-16000);
              put('devjob', job);
            };
            child.stdout.on('data', log);
            child.stderr.on('data', log);
            child.once('error', (e) => {
              clearTimeout(timer);
              no(e);
            });
            child.once('exit', (code) => {
              clearTimeout(timer);
              code === 0 ? yes() : no(Error('依赖安装退出 ' + code));
            });
          });
        }
        job.state = 'completed';
      } catch (e) {
        job.state = live.cancelled ? 'cancelled' : 'failed';
        job.error = e.message;
      } finally {
        job.endedAt = Date.now();
        put('devjob', job);
        jobs.delete(id);
        notify(v, '依赖环境 · ' + job.state, job.error || '安装完成');
      }
    })();
    return job;
  }
  const publicContext = (v) => {
    const m = current(v);
    return {
      instanceId: v.id,
      name: v.name,
      sourceRoot: sourcePath(v),
      version: m.manifest.version,
      manifest: m.manifest,
      widgetContract,
      aiEnabled: !!v.aiEnabled,
      developmentEnabled: !!v.developmentEnabled,
      draft: get('draft', v.draftId),
      releases: all('release').filter((r) => r.instanceId === v.id),
      backups: all('backup').filter((b) => b.instanceId === v.id),
      jobs: all('devjob')
        .filter((j) => j.instanceId === v.id)
        .slice(-10),
      rules:
        '修改仅写入 draft.root；不得修改一壤源码、正式源码或实例凭据。更新、回退和依赖安装由用户在应用面板确认。',
    };
  };
  async function execute(workspaceId, operation, p) {
    if (operation === 'package_import') {
      const raw = readFileSync(p.path);
      if (raw.length > 48 * 1024 * 1024) throw Error('应用包超过 48 MiB');
      const bundle = JSON.parse(raw);
      // format "micro" is the whitelisted micro-app export (micro-share.mjs); it is still checked as a micro package below.
      const micro = bundle.format === 'micro';
      if (
        !(micro || bundle.format === 'yirang-app-package') ||
        bundle.schemaVersion !== 1 ||
        bundle.minHostApi > 3 ||
        !Array.isArray(bundle.files) ||
        bundle.files.length > (micro ? 200 : 2000)
      )
        throw Error('应用包格式或宿主版本不兼容');
      const root = join(directory, 'imports', randomUUID());
      let total = 0;
      const seen = new Set();
      const files = bundle.files.map((f) => {
        target(root, f.path);
        if (seen.has(f.path)) throw Error('应用包有重复路径');
        seen.add(f.path);
        if (f.path.split('/').some((n) => excluded.has(n) || n.startsWith('.env.')))
          throw Error('应用包不能包含凭据或依赖目录');
        const data = Buffer.from(f.data, 'base64');
        if ((total += data.length) > 32 * 1024 * 1024 || digest(data) !== f.sha256)
          throw Error('文件大小或摘要不符');
        return { path: f.path, data };
      });
      writeTree(root, files);
      const m = manifestAt(root);
      if (micro && !m.micro) throw Error('微应用包里的应用不是微应用');
      const id = digest(workspaceId + ':' + m.manifest.id);
      if (get('app', id)) throw Error('该应用已注册；请通过草稿更新现有应用');
      put('app', { id, workspaceId, ...m });
      return { appId: id, name: m.manifest.name, path: root, micro: !!m.micro };
    }
    const v = instance(workspaceId, p.instanceId);
    if (
      p.__fromModel &&
      [
        'draft_create',
        'draft_write',
        'draft_preview',
        'draft_discard',
        'release_publish',
        'release_rollback',
      ].includes(operation) &&
      !v.developmentEnabled
    )
      throw Error('请用户先点击“修改应用”或“修复应用”授权草稿开发');
    if (operation === 'files_import') {
      if (!Array.isArray(p.paths) || p.paths.length > 30) throw Error('一次最多 30 个文件');
      const out = [];
      let total = 0;
      for (const source of p.paths) {
        const stat = lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || (total += stat.size) > 32 * 1024 * 1024)
          throw Error('仅支持普通文件，总计最多 32 MiB');
        const name = source.split(/[\\/]/).pop(),
          path = 'uploads/' + randomUUID() + '/' + name,
          dst = target(dataPath(v), path);
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(source, dst);
        out.push({ name, path, size: stat.size });
      }
      return out;
    }
    if (operation === 'development_control')
      return put('instance', { ...v, developmentEnabled: p.enabled === true });
    if (operation === 'development_context') return publicContext(v);
    if (operation === 'diagnostics')
      return {
        instanceId: v.id,
        version: current(v).manifest.version,
        manifest: current(v).manifest,
        log: get('log', v.id)?.text || '',
        failures: all('run')
          .filter((r) => r.instanceId === v.id && ['failed', 'interrupted'].includes(r.state))
          .slice(-5)
          .map((r) => ({ id: r.id, action: r.action, error: r.error })),
        jobs: all('devjob')
          .filter((j) => j.instanceId === v.id)
          .slice(-5),
      };
    if (operation === 'draft_create') {
      const existing = get('draft', v.draftId);
      if (existing && existing.state === 'editing') return existing;
      const m = current(v),
        id = randomUUID(),
        root = join(directory, 'drafts', id);
      writeTree(root, entries(m.root));
      const baseRoot = join(directory, 'baselines', id);
      writeTree(baseRoot, entries(m.root));
      const d = put('draft', {
        id,
        instanceId: v.id,
        workspaceId,
        root,
        baseRoot,
        baseDigest: m.digest,
        baseVersion: m.manifest.version,
        state: 'editing',
        createdAt: Date.now(),
      });
      put('instance', { ...v, draftId: id });
      return d;
    }
    if (operation === 'draft_changes') {
      const d = draftFor(v, p.draftId),
        old = new Map(entries(d.baseRoot).map((f) => [f.path, digest(f.data)])),
        files = entries(d.root),
        changes = [];
      for (const f of files) {
        const sha = digest(f.data),
          before = old.get(f.path);
        if (before !== sha)
          changes.push({ path: f.path, kind: before ? 'modified' : 'added', sha256: sha });
        old.delete(f.path);
      }
      for (const path of old.keys()) changes.push({ path, kind: 'deleted' });
      const m = manifestAt(d.root);
      return {
        draftId: d.id,
        version: m.manifest.version,
        digest: m.digest,
        changes,
        manifest: m.manifest,
      };
    }
    if (operation === 'draft_read' || operation === 'draft_write') {
      const d = draftFor(v, p.draftId);
      if (d.state !== 'editing') throw Error('草稿已结束');
      const path = target(d.root, p.path);
      if (p.path.split('/').some((x) => excluded.has(x) || x.startsWith('.env.')))
        throw Error('请勿通过源码接口修改凭据或依赖目录');
      const bytes = existsSync(path) ? readFileSync(path) : null,
        sha = bytes ? digest(bytes) : null;
      if (operation === 'draft_read') {
        if (bytes && bytes.length > 256000) throw Error('文本文件超过 256 KiB');
        return { path: p.path, content: bytes?.toString('utf8') ?? null, sha256: sha };
      }
      if (sha !== (p.expectedSha256 ?? null)) throw Error('文件已变化，重新读取后再修改');
      if (p.remove) {
        if (bytes) unlinkSync(path);
        return { removed: true };
      }
      if (typeof p.content !== 'string' || Buffer.byteLength(p.content) > 256000)
        throw Error('内容应为不超过 256 KiB 的文本');
      mkdirSync(dirname(path), { recursive: true });
      const temp = path + '.' + randomUUID() + '.tmp';
      writeFileSync(temp, p.content, { flag: 'wx' });
      renameSync(temp, path);
      return { path: p.path, sha256: digest(Buffer.from(p.content)) };
    }
    if (operation === 'draft_preview') {
      const d = draftFor(v, p.draftId);
      if (d.state !== 'editing') throw Error('草稿已结束');
      const m = manifestAt(d.root);
      let preview = d.previewId && get('instance', d.previewId);
      if (!preview || preview.deletedAt) {
        const id = randomUUID();
        preview = {
          id,
          workspaceId,
          appId: v.appId,
          name: v.name + ' · 草稿预览',
          sourceRoot: d.root,
          config: v.config,
          previewOf: v.id,
          background: false,
          aiEnabled: false,
          createdAt: Date.now(),
        };
        put('draft', { ...d, previewId: id });
        put('instance', preview);
      }
      // Preview has a separate empty data directory and no production secrets/schedules.
      return { instanceId: preview.id, name: preview.name, digest: m.digest, isolated: true };
    }
    if (operation === 'draft_discard') {
      const d = draftFor(v, p.draftId);
      if (d.previewId) {
        stop(d.previewId);
        closePage(d.previewId);
        const preview = get('instance', d.previewId);
        if (preview) put('instance', { ...preview, deletedAt: Date.now() });
      }
      put('draft', { ...d, state: 'discarded' });
      return { discarded: true, sourcePreserved: true };
    }
    if (operation === 'release_publish') {
      idle(v);
      const d = draftFor(v, p.draftId);
      if (d.state !== 'editing') throw Error('草稿已经发布或放弃');
      const m = manifestAt(d.root);
      if (m.digest !== p.expectedDigest) throw Error('草稿已变更，请重新查看变更再发布');
      if (current(v).digest !== d.baseDigest) throw Error('正式源码已变化，请先重新建立草稿');
      if (m.manifest.id !== current(v).manifest.id) throw Error('更新不能改变应用 id');
      api.schemaCheck(m.manifest.configSchema, v.config || {});
      const saved = await backup(v);
      locks.add(v.id);
      try {
        const id = randomUUID(),
          root = join(directory, 'releases', id);
        writeTree(root, entries(d.root));
        const release = manifestAt(root);
        if (
          release.digest !== m.digest ||
          current(instance(workspaceId, v.id)).digest !== d.baseDigest
        )
          throw Error('复制期间源码发生变化，请重新查看变更');
        const dataRoot = join(directory, 'data-versions', id);
        snapshotData(saved.path, dataRoot);
        migrate(release, d.baseVersion, dataRoot);
        const record = {
          id,
          instanceId: v.id,
          workspaceId,
          root,
          version: release.manifest.version,
          digest: release.digest,
          previousRoot: d.baseRoot,
          previousVersion: d.baseVersion,
          backupId: saved.id,
          createdAt: Date.now(),
        };
        closePage(v.id);
        api.transaction(() => {
          put('release', record);
          put('instance', {
            ...instance(workspaceId, v.id),
            sourceRoot: root,
            dataRoot,
            releaseId: id,
            approvedDigest: null,
          });
          put('draft', { ...d, state: 'published', releaseId: id });
          for (const s of all('schedule'))
            if (s.instanceId === v.id) put('schedule', { ...s, enabled: false });
        });
        if (d.previewId) {
          stop(d.previewId);
          closePage(d.previewId);
          const prev = get('instance', d.previewId);
          if (prev) put('instance', { ...prev, deletedAt: Date.now() });
        }
        notify(
          v,
          '应用已更新',
          release.manifest.version + '；重新打开时授权新版本，定时任务已暂停',
        );
        return record;
      } finally {
        locks.delete(v.id);
      }
    }
    if (operation === 'release_rollback') {
      idle(v);
      const r = get('release', p.releaseId);
      if (!r || r.instanceId !== v.id) throw Error('版本不属于当前实例');
      const saved = await backup(v);
      const root = p.previous ? r.previousRoot : r.root,
        m = manifestAt(root);
      api.schemaCheck(m.manifest.configSchema, v.config || {});
      closePage(v.id);
      put('instance', {
        ...instance(workspaceId, v.id),
        sourceRoot: root,
        releaseId: p.previous ? null : r.id,
        approvedDigest: null,
      });
      for (const s of all('schedule'))
        if (s.instanceId === v.id) put('schedule', { ...s, enabled: false });
      return { version: m.manifest.version, backupId: saved.id, dataPreserved: true };
    }
    if (operation === 'data_backup') return backup(v);
    if (operation === 'data_restore') {
      const b = get('backup', p.backupId);
      if (!b || b.instanceId !== v.id) throw Error('备份不属于当前实例');
      const safety = await backup(v),
        root = join(directory, 'data-versions', randomUUID());
      snapshotData(b.path, root);
      put('instance', { ...instance(workspaceId, v.id), dataRoot: root });
      return { restored: true, safetyBackupId: safety.id };
    }
    if (operation === 'dependencies_status') {
      const root = p.draftId ? draftFor(v, p.draftId).root : sourcePath(v),
        m = manifestAt(root);
      return {
        runtime: m.manifest.runtime.kind,
        root,
        requirements: existsSync(join(root, 'requirements.txt'))
          ? readFileSync(join(root, 'requirements.txt'), 'utf8')
          : null,
        package: existsSync(join(root, 'package.json'))
          ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
          : null,
        lockfile: existsSync(join(root, 'package-lock.json')),
        pythonEnvironment: existsSync(
          join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        ),
        nodeEnvironment: existsSync(join(root, 'node_modules')),
        jobs: all('devjob')
          .filter((j) => j.instanceId === v.id)
          .slice(-10),
      };
    }
    if (operation === 'dependencies_install') {
      idle(v);
      if ([...jobs.values()].some((j) => j.instanceId === v.id)) throw Error('依赖安装进行中');
      const root = p.draftId ? draftFor(v, p.draftId).root : sourcePath(v),
        m = manifestAt(root),
        steps = [];
      if (m.manifest.runtime.kind === 'python') {
        const python = p.pythonProgram || v.pythonProgram;
        if (!python) throw Error('请先在设置中选择 Python 环境');
        if (!existsSync(join(root, 'requirements.txt'))) throw Error('缺少 requirements.txt');
        steps.push(
          { program: python, args: ['-m', 'venv', join(root, '.venv')], cwd: root },
          {
            program: join(
              root,
              '.venv',
              process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
            ),
            args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
            cwd: root,
          },
        );
      } else if (m.manifest.runtime.kind === 'node') {
        if (!existsSync(join(root, 'package-lock.json')))
          throw Error('需要 package-lock.json 锁定依赖版本');
        const npm = [dirname(node), ...(process.env.PATH || '').split(delimiter)]
          .map((p) => join(p, 'node_modules/npm/bin/npm-cli.js'))
          .find(existsSync);
        if (!npm) throw Error('本机缺少 npm，请安装 Node.js 后重试');
        steps.push({
          program: node,
          args: [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
          cwd: root,
        });
      } else throw Error('静态应用不需要后端依赖');
      stop(v.id);
      return launchJob(v, 'dependencies', steps);
    }
    if (operation === 'dependencies_cancel') {
      const job = get('devjob', p.jobId);
      if (!job || job.instanceId !== v.id) throw Error('安装任务不存在');
      const live = jobs.get(job.id);
      if (live) killJob(live);
      return { cancelled: true };
    }
    if (operation === 'package_export') {
      const m = current(v),
        files = entries(m.root).map((f) => ({
          path: f.path,
          data: f.data.toString('base64'),
          sha256: digest(f.data),
        })),
        path = join(directory, 'exports', randomUUID() + '.yirang-app');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          format: 'yirang-app-package',
          schemaVersion: 1,
          minHostApi: 2,
          name: m.manifest.name,
          version: m.manifest.version,
          files,
        }),
      );
      return { path, sourceOnly: true };
    }
    return undefined;
  }
  async function command(workspaceId, operation, p) {
    if (
      p.instanceId &&
      locks.has(p.instanceId) &&
      ['draft_create', 'draft_write', 'draft_discard', 'draft_preview'].includes(operation)
    )
      throw Error('正在应用更新，请稍后修改草稿');
    if (
      ![
        'release_publish',
        'release_rollback',
        'data_backup',
        'data_restore',
        'dependencies_install',
      ].includes(operation)
    )
      return execute(workspaceId, operation, p);
    const v = instance(workspaceId, p.instanceId);
    if (locks.has(v.id)) throw Error('应用正在更新或备份');
    locks.add(v.id);
    try {
      return await execute(workspaceId, operation, p);
    } finally {
      locks.delete(v.id);
    }
  }
  return {
    command,
    dataPath,
    sourcePath,
    isLocked: (id) => locks.has(id),
    isBusy: (v) =>
      locks.has(v.id) ||
      [...jobs.values()].some((j) => j.instanceId === v.id || j.root === sourcePath(v)),
    close() {
      for (const job of jobs.values()) killJob(job);
    },
  };
}
