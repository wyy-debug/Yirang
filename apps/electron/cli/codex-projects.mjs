import { t as uiText } from '../platform/native-ui-language.mjs';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const id = (value) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f]/.test(value)
  )
    throw Error(uiText('项目或对话标识无效'));
  return value;
};
const name = (value) => {
  const text = String(value || '').trim();
  if (!text || text.length > 120) throw Error(uiText('名称需要 1–120 个字'));
  return text;
};
const key = (projectId) => projectId || 'unassigned';

// Project identities and membership belong to Codex, not to the desktop canvas.
// Only each project's last-opened thread is kept in this client's profile.
export async function createCodexProjects({ directory, request, switchThread, emit, pickFolder }) {
  const file = join(directory, 'codex-project-navigation.json');
  let saved = { lastThreads: Object.create(null) },
    current = { threadId: null, projectId: null, name: null, cwd: null },
    queue = Promise.resolve();
  const projectCache = new Map();
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data?.lastThreads && typeof data.lastThreads === 'object')
      saved.lastThreads = Object.assign(Object.create(null), data.lastThreads);
  } catch (error) {
    if (error.code !== 'ENOENT')
      emit('notice', uiText('项目最近对话记录无法读取，将从 Codex 历史恢复。'));
  }
  const persist = () => {
    const snapshot = JSON.stringify(saved);
    queue = queue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, snapshot);
        await rename(temp, file);
      });
    return queue;
  };
  async function call(method, params) {
    try {
      return await request(method, params);
    } catch (error) {
      if (
        /method not found|unknown method|experimental.*(disabled|not enabled)|unsupported.*method/i.test(
          error.message,
        )
      )
        throw Error(
          uiText(
            '当前 Codex CLI 尚未开放项目管理，请在设置中更新或选择支持项目接口的 CLI；原有对话仍可使用。',
          ),
        );
      throw error;
    }
  }
  async function project(projectId) {
    const value = (await call('project/read', { projectId: id(projectId) })).project;
    projectCache.set(projectId, value);
    return value;
  }
  async function observe(thread) {
    current = {
      threadId: thread.id,
      projectId: thread.projectId || null,
      name: thread.name || thread.preview?.slice(0, 80) || null,
      cwd: thread.cwd || null,
    };
    saved.lastThreads[key(current.projectId)] = thread.id;
    await persist().catch((error) =>
      emit('notice', uiText('对话已打开，但最近项目记录未保存：{0}', { 0: error.message })),
    );
  }
  async function refresh() {
    const threadId = current.threadId;
    if (!threadId || current.local) return;
    const { thread } = await call('thread/read', { threadId, includeTurns: false });
    if (current.threadId !== threadId) return;
    const next = {
      threadId,
      projectId: thread.projectId || null,
      name: thread.name || thread.preview?.slice(0, 80) || null,
      cwd: thread.cwd || null,
    };
    if (next.projectId !== current.projectId) await observe(thread);
    else current = next;
  }
  async function select(projectId) {
    const scope = projectId === null ? null : id(projectId),
      selected = scope ? await project(scope) : null;
    const prior = saved.lastThreads[key(scope)];
    let target = null;
    if (prior) {
      // Do not silently create a replacement on network/server errors.
      try {
        const result = await call('thread/read', { threadId: id(prior), includeTurns: false });
        if (!result.thread.archived && (result.thread.projectId || null) === scope)
          target = result.thread.id;
      } catch (error) {
        if (!/not found|does not exist|archived|未找到|不存在/i.test(error.message)) throw error;
      }
    }
    if (!target) {
      const page = await call('thread/list', {
        projectId: scope,
        limit: 1,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
      });
      target = page.data[0]?.id;
    }
    return switchThread(target || 'new', { projectId: scope, project: selected });
  }
  return {
    observe,
    observeLocal: (thread) => {
      current = {
        threadId: thread.id,
        projectId: thread.projectId || null,
        name: '新对话',
        cwd: null,
        local: true,
      };
    },
    read: project,
    snapshot: () => ({ ...current }),
    async executionCwd() {
      await refresh();
      if (!current.projectId) return null;
      const selected = await project(current.projectId),
        path = selected.roots?.[0]?.path;
      if (!path) throw Error(uiText('这个 Codex 项目没有工作目录，请先在 Codex 中添加目录。'));
      if (!(await stat(path).catch(() => null))?.isDirectory())
        throw Error(uiText('项目目录不可用：{0}', { 0: path }));
      return path;
    },
    async handle(action, payload = {}) {
      if (action === 'current') {
        if (!payload.observed) await refresh();
        const snapshot = { ...current };
        let selected = null,
          error = null;
        if (snapshot.projectId)
          try {
            selected = snapshot.local
              ? projectCache.get(snapshot.projectId) || null
              : await project(snapshot.projectId);
          } catch (e) {
            error = e.message;
          }
        return { ...snapshot, project: selected, error };
      }
      if (action === 'list')
        return call('project/list', {
          limit: 50,
          sortKey: 'position',
          sortDirection: 'asc',
          ...(payload.cursor ? { cursor: String(payload.cursor) } : {}),
        });
      if (action === 'threads') {
        const scope = payload.scope;
        if (scope !== 'all' && scope !== null) id(scope);
        return call('thread/list', {
          limit: 40,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          archived: false,
          ...(scope !== 'all' ? { projectId: scope } : {}),
          ...(payload.cursor ? { cursor: String(payload.cursor) } : {}),
          ...(payload.search ? { searchTerm: String(payload.search).slice(0, 200) } : {}),
        });
      }
      if (action === 'choose-root') return pickFolder();
      if (action === 'select')
        return select(payload.projectId === null ? null : id(payload.projectId));
      if (action === 'new-thread') {
        const projectId = payload.projectId === null ? null : id(payload.projectId);
        return switchThread('new', { projectId, project: null });
      }
      if (action === 'create') {
        const path = String(payload.path || '');
        if (!isAbsolute(path) || !(await stat(path).catch(() => null))?.isDirectory())
          throw Error(uiText('请选择一个存在的项目文件夹'));
        const result = await call('project/create', {
          name: name(payload.name),
          roots: [{ path: resolve(path) }],
          idempotencyKey: id(payload.requestId),
        });
        emit('projects-changed', {});
        return result;
      }
      if (action === 'rename') {
        const result = await call('project/update', {
          projectId: id(payload.projectId),
          name: name(payload.name),
        });
        emit('projects-changed', {});
        return result;
      }
      if (action === 'assign') {
        const projectId = payload.projectId === null ? null : id(payload.projectId);
        if (projectId) await project(projectId);
        const target = id(payload.threadId),
          before = (await call('thread/read', { threadId: target, includeTurns: false })).thread;
        if (before.status?.type === 'active')
          throw Error(uiText('这条对话正在运行，请完成后再调整项目归属'));
        const result = await call('thread/metadata/update', {
          threadId: target,
          projectId: projectId || '',
        });
        for (const [scope, last] of Object.entries(saved.lastThreads))
          if (last === target) delete saved.lastThreads[scope];
        if (target === current.threadId) await observe(result.thread);
        else await persist().catch((error) => emit('notice', error.message));
        emit('projects-changed', {});
        return result;
      }
      throw Error(uiText('不支持的 Codex 项目操作'));
    },
  };
}
