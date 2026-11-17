import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const toolTypes = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageGeneration',
  'imageView',
  'collabAgentToolCall',
  'toolCall',
]);
const toolLabel = (item) =>
  ({
    commandExecution: '执行命令',
    fileChange: '修改文件',
    webSearch: '搜索资料',
    imageGeneration: '生成图片',
    imageView: '查看图片',
    collabAgentToolCall: '安排子任务',
  })[item.type] || '调用工具';
const monotonicClock = () => {
  const wall = Date.now(),
    start = performance.now();
  return () => Math.round(wall + performance.now() - start);
};

// Host timestamps measure elapsed response time, not server inference time.
// The exclusive phase track counts concurrent tools only once; individual calls
// retain their own intervals for inspection. No content, commands or arguments are saved.
export function createExecutionTimings({ path, emit = () => {}, now = monotonicClock() }) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS execution_timings(id TEXT PRIMARY KEY,thread_id TEXT,workspace_id TEXT,task_id TEXT,started_at INTEGER,ended_at INTEGER,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS timing_thread ON execution_timings(thread_id,started_at); CREATE INDEX IF NOT EXISTS timing_task ON execution_timings(workspace_id,task_id);',
  );
  const active = new Map();
  let closed = false,
    notification = null,
    storageError = false;
  const save = (record) =>
    db
      .prepare('INSERT OR REPLACE INTO execution_timings VALUES(?,?,?,?,?,?,?)')
      .run(
        record.id,
        record.threadId,
        record.workspaceId || null,
        record.taskId || null,
        record.startedAt,
        record.endedAt ?? null,
        JSON.stringify(record),
      );
  // A restart is not evidence that work continued for the whole offline interval.
  for (const row of db.prepare('SELECT body FROM execution_timings WHERE ended_at IS NULL').all()) {
    const record = JSON.parse(row.body);
    record.endedAt = record.observedAt;
    record.status = 'unknown';
    record.incomplete = true;
    if (record.spans.at(-1)?.end == null) record.spans.at(-1).end = record.endedAt;
    for (const tool of record.tools)
      if (tool.end == null) {
        tool.end = record.endedAt;
        tool.incomplete = true;
      }
    save(record);
  }
  const closedTurns = new Set(
    db
      .prepare(
        "SELECT json_extract(body,'$.turnId') AS turnId FROM execution_timings WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 1000",
      )
      .all()
      .map((row) => row.turnId)
      .filter(Boolean),
  );
  function changed(record) {
    record.observedAt = Math.max(record.observedAt, now());
    try {
      save(record);
      storageError = false;
    } catch {
      storageError = true;
    }
    if (!notification) {
      notification = setTimeout(() => {
        notification = null;
        if (!closed) emit('timings-changed', {});
      }, 100);
      notification.unref();
    }
  }
  function phase(entry) {
    return entry.approvals.size ? 'approval' : entry.tools.size ? 'tool' : 'model';
  }
  function transition(entry) {
    const record = entry.record,
      kind = phase(entry),
      last = record.spans.at(-1),
      stamp = Math.max(record.observedAt, now());
    if (last?.kind === kind) return;
    if (last) last.end = stamp;
    record.spans.push({ kind, start: stamp, end: null });
  }
  function finish(entry, status, incomplete = false) {
    const record = entry.record,
      stamp = Math.max(record.observedAt, now());
    record.endedAt = stamp;
    record.status = status;
    record.incomplete ||= incomplete;
    record.spans.at(-1).end = stamp;
    for (const tool of record.tools)
      if (tool.end == null) {
        tool.end = stamp;
        tool.incomplete = true;
        record.incomplete = true;
      }
    if (record.turnId) {
      closedTurns.add(record.turnId);
      if (closedTurns.size > 2000) closedTurns.delete(closedTurns.values().next().value);
    }
    active.delete(record.threadId);
    changed(record);
  }
  function matching(params) {
    const entry = active.get(params.threadId);
    return entry &&
      (!params.turnId || !entry.record.turnId || params.turnId === entry.record.turnId)
      ? entry
      : null;
  }
  function toolStart(entry, id, item) {
    if (!id || entry.record.tools.some((tool) => tool.id === id)) return;
    const stamp = Math.max(entry.record.observedAt, now());
    entry.tools.add(id);
    entry.record.tools.push({
      id,
      label: toolLabel(item),
      type: item.type,
      start: stamp,
      end: null,
    });
    transition(entry);
    changed(entry.record);
  }
  function toolEnd(entry, id) {
    const tool = entry.record.tools.find((tool) => tool.id === id);
    if (!tool || tool.end != null) return;
    tool.end = Math.max(entry.record.observedAt, now());
    entry.tools.delete(id);
    transition(entry);
    changed(entry.record);
  }
  const heartbeat = setInterval(() => {
    for (const entry of active.values()) changed(entry.record);
  }, 5000);
  heartbeat.unref();
  return {
    prepare(threadId, metadata = {}) {
      if (active.has(threadId)) finish(active.get(threadId), 'unknown', true);
      const stamp = now(),
        record = {
          ...metadata,
          id: metadata.runId || randomUUID(),
          threadId,
          turnId: null,
          startedAt: stamp,
          observedAt: stamp,
          endedAt: null,
          status: 'running',
          spans: [{ kind: 'model', start: stamp, end: null }],
          tools: [],
        };
      active.set(threadId, { record, tools: new Set(), approvals: new Set() });
      changed(record);
      return record.id;
    },
    bind(threadId, turnId) {
      const entry = active.get(threadId);
      if (entry && !entry.record.turnId) {
        entry.record.turnId = turnId;
        changed(entry.record);
      }
    },
    failed(threadId, uncertain = false) {
      const entry = active.get(threadId);
      if (entry) finish(entry, uncertain ? 'unknown' : 'failed', uncertain);
    },
    handle(method, params = {}, requestId) {
      const eventTurn = params.turnId || params.turn?.id;
      if (eventTurn && closedTurns.has(eventTurn)) return;
      const entry = matching(params);
      if (!entry) return;
      if (method === 'turn/started') {
        if (!entry.record.turnId) {
          entry.record.turnId = params.turn?.id;
          changed(entry.record);
        }
        return;
      }
      if (method === 'turn/completed') {
        if (entry.record.turnId && entry.record.turnId !== params.turn?.id) return;
        entry.record.turnId ||= params.turn?.id;
        finish(
          entry,
          params.turn?.uncertain ? 'unknown' : params.turn?.status || 'failed',
          !!params.turn?.uncertain,
        );
        return;
      }
      if (method === 'item/started' && toolTypes.has(params.item?.type))
        toolStart(entry, params.item.id, params.item);
      if (method === 'item/completed') {
        if (
          toolTypes.has(params.item?.type) &&
          !entry.record.tools.some((tool) => tool.id === params.item.id)
        ) {
          entry.record.incomplete = true;
          const last = entry.record.spans.at(-1);
          if (last?.kind === 'model') last.kind = 'unknown';
          transition(entry);
          changed(entry.record);
        } else toolEnd(entry, params.item?.id);
      }
      if (method === 'item/tool/call')
        toolStart(entry, params.callId || params.itemId || String(requestId), {
          type: 'dynamicToolCall',
        });
      if (
        method.endsWith('/requestApproval') ||
        method === 'item/tool/requestUserInput' ||
        method === 'mcpServer/elicitation/request'
      ) {
        entry.approvals.add(String(requestId));
        transition(entry);
        changed(entry.record);
      }
    },
    toolReply(threadId, id) {
      const entry = active.get(threadId);
      if (entry) toolEnd(entry, id);
    },
    approvalReply(threadId, id) {
      const entry = active.get(threadId);
      if (entry) {
        entry.approvals.delete(String(id));
        transition(entry);
        changed(entry.record);
      }
    },
    read({ threadIds = [], workspaceId, taskIds = [] } = {}) {
      if (storageError) throw Error('耗时记录暂不可用');
      let rows = [];
      if (taskIds.length && workspaceId) {
        const ids = taskIds.slice(0, 100);
        rows = db
          .prepare(
            `SELECT body FROM execution_timings WHERE workspace_id=? AND task_id IN (${ids.map(() => '?').join(',')}) ORDER BY started_at`,
          )
          .all(workspaceId, ...ids);
      } else if (threadIds.length) {
        const ids = threadIds.slice(0, 100);
        rows = db
          .prepare(
            `SELECT body FROM execution_timings WHERE thread_id IN (${ids.map(() => '?').join(',')}) ORDER BY started_at DESC LIMIT 60`,
          )
          .all(...ids)
          .reverse();
      }
      return { observedAt: now(), runs: rows.map((row) => JSON.parse(row.body)) };
    },
    close() {
      if (closed) return;
      try {
        for (const entry of active.values()) {
          entry.record.observedAt = Math.max(entry.record.observedAt, now());
          save(entry.record);
        }
      } finally {
        closed = true;
        clearTimeout(notification);
        clearInterval(heartbeat);
        db.close();
      }
    },
  };
}
