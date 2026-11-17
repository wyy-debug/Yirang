import { t as uiText } from '../platform/native-ui-language.mjs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const isWorkResultQueueItem = (item) =>
  /^followup-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
    .test(item?.requestId || '') &&
  item.route === 'consult' && typeof item.consultTaskId === 'string' &&
  item.consultTaskId.length > 0;

export const isSystemResultQueueItem = (item) =>
  isWorkResultQueueItem(item) ||
  (item?.route === 'native-result' &&
    /^native-result-[0-9a-f-]{36}$/i.test(item.requestId || ''));

// Persist before dispatch. An uncertain send is never replayed automatically.
export async function createConversationState({ path, emit, resolveThread = (id) => id }) {
  let data = { version: 1, threads: {} },
    chain = Promise.resolve();
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.version !== 1 || !saved.threads) throw Error(uiText('对话草稿格式不受支持'));
    data = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const thread of Object.values(data.threads)) {
    thread.paused = true;
    for (const item of thread.queue || [])
      if (item.state === 'sending') {
        item.state = 'uncertain';
        item.error = uiText('上次发送被中断，请查看历史后决定是否重发。');
      }
  }
  const key = (id) => {
    if (typeof id !== 'string' || !/^[-a-zA-Z0-9_:]{1,160}$/.test(id))
      throw Error(uiText('对话标识无效'));
    return resolveThread(id);
  };
  const state = (value, id) => (value.threads[key(id)] ??= { draft: '', queue: [], paused: false });
  const view = (id) => structuredClone(state(data, id));
  async function persist(value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  }
  const change = (id, fn) => {
    const job = chain
      .catch(() => {})
      .then(async () => {
        const next = structuredClone(data);
        await fn(state(next, id), next);
        await persist(next);
        data = next;
        const result = view(id);
        emit('conversation-state', { threadId: key(id), ...result });
        return result;
      });
    chain = job;
    return job;
  };
  await persist(data);
  return {
    get: view,
    primaryThread: (workspaceId) => {
      const id = data.primaryThreads?.[workspaceId];
      return id ? key(id) : null;
    },
    bindPrimary(workspaceId, id) {
      if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 160)
        throw Error(uiText('工作区标识无效'));
      const target = key(id);
      return change(target, (_s, next) => {
        next.primaryThreads ??= {};
        if (Object.entries(next.primaryThreads).some(
          ([otherWorkspace, primary]) => otherWorkspace !== workspaceId && key(primary) === target,
        ))
          throw Error(uiText('该对话已绑定其他工作区，不能作为当前工作区主会话'));
        next.primaryThreads[workspaceId] = target;
      });
    },
    flush: () => chain,
    queues: () =>
      Object.entries(data.threads).map(([threadId, value]) => ({
        threadId,
        ...structuredClone(value),
      })),
    locals: () =>
      Object.entries(data.threads)
        .filter(([, s]) => s.local)
        .map(([id, s]) => ({ id, ...s.local })),
    local: (id, meta) =>
      change(id, (s) => {
        s.local = meta;
      }),
    draft(id, text) {
      if (typeof text !== 'string' || text.length > 50000) throw Error(uiText('草稿超过 5 万字'));
      return change(id, (s) => {
        s.draft = text;
      });
    },
    migrate(from, to) {
      return change(to, (s, next) => {
        const owners = Object.entries(next.primaryThreads || {})
          .filter(([, primary]) => primary === from)
          .map(([workspaceId]) => workspaceId);
        if (owners.length && Object.entries(next.primaryThreads || {}).some(
          ([workspaceId, primary]) => primary === to && !owners.includes(workspaceId),
        ))
          throw Error(uiText('目标对话已绑定其他工作区，不能迁移主会话'));
        const old = next.threads[from];
        if (!old || from === to) return;
        if (!s.draft) s.draft = old.draft;
        s.paused = s.paused || old.paused;
        s.queue = [
          ...new Map([...(old.queue || []), ...s.queue].map((item) => [item.id, item])).values(),
        ];
        delete next.threads[from];
        for (const workspaceId of Object.keys(next.primaryThreads || {}))
          if (next.primaryThreads[workspaceId] === from) next.primaryThreads[workspaceId] = to;
      });
    },
    enqueue(
      id,
      {
        text,
        blocks,
        workspaceId,
        review,
        model,
        effort,
        modelSettings,
        requestId,
        route,
        consultTaskId,
      },
    ) {
      if (typeof text !== 'string' || !text.trim() || text.length > 50000)
        throw Error(uiText('请输入不超过 5 万字的消息'));
      if (JSON.stringify(blocks || []).length > 12000000)
        throw Error(uiText('排队材料过大，请直接引用桌面文件'));
      return change(id, (s, next) => {
        if (route === 'native-result') {
          if (!/^native-result-[0-9a-f-]{36}$/i.test(requestId || ''))
            throw Error('invalid native result event ID');
          next.deliveredRequestIds ??= {};
          if (next.deliveredRequestIds[requestId]) return;
          next.deliveredRequestIds[requestId] = true;
        }
        if (requestId && s.queue.some((i) => i.requestId === requestId)) return;
        if (s.queue.filter((i) => !['sent', 'dismissed'].includes(i.state)).length >= 30)
          throw Error(uiText('最多排队 30 条消息'));
        s.queue = s.queue
          .filter((i) => !['sent', 'dismissed'].includes(i.state))
          .concat({
            id: randomUUID(),
            requestId,
            route,
            consultTaskId,
            text: requestId ? text : text.trim(),
            blocks: blocks || [],
            workspaceId,
            review,
            model,
            effort,
            modelSettings,
            state: 'queued',
            createdAt: new Date().toISOString(),
          });
        if (route !== 'native-result') s.draft = '';
      });
    },
    pause(id, paused) {
      return change(id, (s) => {
        s.paused = paused;
      });
    },
    claim(id, itemId, { systemResult = false } = {}) {
      return change(id, (s) => {
        const first = s.queue.find((item) => item.state === 'queued');
        const result = s.queue.find((item) => item.id === itemId);
        if (systemResult) {
          const firstResult = s.queue.find((item) =>
            item.state === 'queued' && isSystemResultQueueItem(item));
          if (!isSystemResultQueueItem(result) || result.state !== 'queued' ||
              firstResult?.id !== itemId)
            throw Error(uiText('队列已变化，消息尚未发送'));
        } else if (s.paused || first?.id !== itemId)
          throw Error(uiText('队列已变化，消息尚未发送'));
        result.state = 'sending';
      });
    },
    edit(id, itemId, text) {
      return change(id, (s) => {
        const item = s.queue.find((i) => i.id === itemId);
        if (!item || item.state !== 'queued') throw Error(uiText('只能编辑尚未发送的消息'));
        if (typeof text !== 'string' || !text.trim() || text.length > 50000)
          throw Error(uiText('消息为空或过长'));
        item.text = text;
      });
    },
    remove(id, itemId) {
      return change(id, (s) => {
        const item = s.queue.find((i) => i.id === itemId);
        if (item?.state === 'sending') throw Error(uiText('发送状态尚未确定，请稍后处理'));
        s.queue = s.queue.filter((i) => i.id !== itemId);
      });
    },
    move(id, itemId, delta) {
      return change(id, (s) => {
        const index = s.queue.findIndex((i) => i.id === itemId);
        if (index < 0 || s.queue[index].state !== 'queued') return;
        const target = Math.max(0, Math.min(s.queue.length - 1, index + (delta < 0 ? -1 : 1)));
        if (s.queue[target]?.state !== 'queued') return;
        [s.queue[index], s.queue[target]] = [s.queue[target], s.queue[index]];
      });
    },
    retry(id, itemId) {
      return change(id, (s) => {
        const item = s.queue.find((i) => i.id === itemId);
        if (!item || !['uncertain', 'failed'].includes(item.state))
          throw Error(uiText('该消息不需要重试'));
        item.state = 'queued';
        delete item.error;
        s.paused = true;
      });
    },
    mark(id, itemId, stateName, extra = {}) {
      return change(id, (s) => {
        const item = s.queue.find((i) => i.id === itemId);
        if (!item) return;
        Object.assign(item, { state: stateName, ...extra });
        if (['failed', 'uncertain'].includes(stateName)) s.paused = true;
      });
    },
  };
}
