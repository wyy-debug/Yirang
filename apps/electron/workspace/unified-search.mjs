import { t as uiText } from '../platform/native-ui-language.mjs';
import { randomUUID } from 'node:crypto';
import { readChatHistory } from '../conversation/chat-manager.mjs';
export function createUnifiedSearch({ request, retrieve, state, emit }) {
  let active = null;
  const contexts = new Map();
  function publish(job, extra = {}) {
    if (active === job) emit('search-progress', { id: job.id, hits: [], ...extra });
  }
  async function run(job) {
    const stopped = () => active !== job || job.cancelled,
      issues = [];
    let truncated = false;
    const append = (hits, phase) => {
      if (stopped()) return;
      const remaining = Math.max(0, 300 - job.count);
      if (hits.length > remaining) truncated = true;
      const visible = hits.slice(0, remaining);
      job.count += visible.length;
      publish(job, { hits: visible, phase, issues });
    };
    try {
      const input = {
        query: job.query,
        limit: 30,
        ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
        ...(job.regionId ? { regionId: job.regionId } : {}),
      };
      const first = await retrieve({ operation: 'search', payload: { ...input, mode: 'keyword' } });
      if (stopped()) return;
      job.count = first.hits.length;
      publish(job, {
        hits: first.hits,
        replace: true,
        phase: '关键词结果已就绪',
        indexStatus: first.status,
      });
      let note = '';
      if (job.mode === 'hybrid' && first.status.semantic) {
        publish(job, { phase: '关键词结果已就绪 · 正在补充语义匹配' });
        const hybrid = await retrieve({
          operation: 'search',
          payload: { ...input, mode: 'hybrid' },
        });
        if (stopped()) return;
        job.count = hybrid.hits.length;
        note = hybrid.note;
        publish(job, {
          hits: hybrid.hits,
          replace: true,
          phase: hybrid.semanticUsed ? '混合检索完成' : '关键词检索完成',
          indexStatus: hybrid.status,
        });
      } else if (job.mode === 'hybrid') note = '尚未启用向量服务，当前使用关键词检索';
      if (!job.includeHistory) {
        publish(job, { done: true, phase: note || '搜索完成', indexStatus: first.status });
        return;
      }
      if (!state().ready) {
        publish(job, {
          done: true,
          phase: uiText('材料搜索完成；AI 未连接，对话历史未读取'),
          issues,
        });
        return;
      }
      for (const archived of job.scope === 'all' ? [false, true] : [false]) {
        let threadCursor;
        const seenThreads = new Set();
        do {
          if (stopped() || job.count >= 300) break;
          const list =
            job.scope === 'current'
              ? {
                  data: state().threadId
                    ? [{ id: state().threadId, name: uiText('当前对话') }]
                    : [],
                }
              : await request('thread/list', {
                  limit: 40,
                  archived,
                  ...(threadCursor ? { cursor: threadCursor } : {}),
                });
          if (stopped()) return;
          threadCursor = list.nextCursor;
          for (const thread of list.data) {
            if (stopped() || job.count >= 300) break;
            try {
              let cursor = null;
              const seen = new Set();
              do {
                if (stopped() || job.count >= 300) break;
                const page = await readChatHistory(request, thread.id, 40, cursor);
                if (stopped()) return;
                cursor = page.nextCursor;
                const hits = [];
                for (const turn of page.data)
                  for (const item of turn.items || []) {
                    if (job.count + hits.length >= 300) {
                      truncated = true;
                      break;
                    }
                    const text =
                      item.type === 'agentMessage'
                        ? item.text
                        : item.type === 'userMessage'
                          ? (item.content || [])
                              .filter((block) => block.type === 'text')
                              .map(
                                (block) =>
                                  block.text
                                    .split('\n\n[工作桌面连接说明]')[0]
                                    .split('\n\n工作桌面材料引用：')[0],
                              )
                              .join('\n')
                          : '';
                    const index = (text || '')
                      .toLocaleLowerCase()
                      .indexOf(job.query.toLocaleLowerCase());
                    if (index < 0) continue;
                    const id = randomUUID();
                    contexts.set(id, { threadId: thread.id, turn, archived });
                    hits.push({
                      kind: 'chat',
                      id,
                      archived,
                      threadId: thread.id,
                      turnId: turn.id,
                      title: thread.name || thread.preview?.slice(0, 60) || thread.id.slice(0, 8),
                      location:
                        item.type === 'agentMessage' ? uiText('AI 回复') : uiText('你的消息'),
                      text: text.slice(Math.max(0, index - 65), index + 180),
                    });
                  }
                append(hits, uiText('搜索对话：{0}', { 0: thread.name || thread.id.slice(0, 8) }));
                if (cursor && seen.has(cursor)) throw Error(uiText('历史分页重复'));
                seen.add(cursor);
              } while (cursor);
            } catch (error) {
              issues.push(
                uiText('对话 {0}：{1}', {
                  0: thread.name || thread.id.slice(0, 8),
                  1: error.message,
                }),
              );
              publish(job, { issues, phase: uiText('继续搜索其他对话') });
            }
          }
          if (threadCursor && seenThreads.has(threadCursor))
            throw Error(uiText('对话列表分页重复，请稍后重试'));
          seenThreads.add(threadCursor);
        } while (threadCursor);
      }
      publish(job, {
        done: true,
        phase:
          truncated || job.count >= 300
            ? uiText('已显示前 300 项，请缩小关键词范围')
            : uiText('搜索完成'),
        issues,
      });
    } catch (error) {
      publish(job, { done: true, error: error.message, issues });
    }
  }
  return {
    start(payload) {
      const query = String(payload.query || '').trim();
      if (!query || query.length > 200) throw Error(uiText('请输入不超过 200 字的关键词'));
      if (active) active.cancelled = true;
      contexts.clear();
      const job = {
        id: randomUUID(),
        query,
        scope: payload.scope === 'all' ? 'all' : 'current',
        workspaceId: payload.workspaceId,
        regionId: payload.regionId,
        mode: payload.mode === 'keyword' ? 'keyword' : 'hybrid',
        includeHistory: payload.includeHistory === true,
        count: 0,
        cancelled: false,
      };
      active = job;
      setTimeout(() => void run(job), 0);
      return { id: job.id };
    },
    cancel() {
      if (active) active.cancelled = true;
    },
    context(id) {
      const value = contexts.get(id);
      if (!value) throw Error(uiText('搜索结果已过期，请重新搜索'));
      return value;
    },
  };
}
