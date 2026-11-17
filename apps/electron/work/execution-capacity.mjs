import { randomUUID } from 'node:crypto';

export const createExecutionCapacity = ({ call, workspace, managed }) => {
  const roles = new Map(),
    active = new Map();
  const invoke = (w, p) => call(w, { ...p, operation: 'capacity_' + p.operation });
  const role = (threadId, value, workspaceId) => roles.set(threadId, { role: value, workspaceId });
  const start = async (threadId, send, defaultRole = 'background', kind = 'turn', requestId) => {
    if (managed(threadId)) return send(); // Work dispatch already reserves in SQLite.
    if (active.has(threadId))
      throw Object.assign(Error('旧执行状态尚未核实，输入已保留'), { beforeSend: true });
    const captured = roles.get(threadId) || { role: defaultRole },
      workspaceId = captured.workspaceId || (await workspace());
    const entry = {
      id: randomUUID(),
      threadId,
      workspaceId,
      role: captured.role,
      kind,
      createdAt: Date.now(),
      tail: Promise.resolve(),
    };
    try {
      await invoke(workspaceId, {
        operation: 'acquire',
        id: entry.id,
        threadId,
        role: entry.role,
        kind,
        requestId,
      });
    } catch (error) {
      await invoke(workspaceId, {
        operation: 'release',
        id: entry.id,
        threadId,
        notReceived: true,
      }).catch(() => {});
      error.beforeSend = true;
      throw error;
    }
    active.set(threadId, entry);
    try {
      const result = await send();
      if (kind !== 'turn' && !result?.turn?.id) return result;
      entry.turnId = result.turn.id;
      await invoke(workspaceId, { operation: 'ack', id: entry.id, threadId, turnId: entry.turnId });
      return result;
    } catch (error) {
      if (error.rpcRejected) {
        await invoke(workspaceId, {
          operation: 'release',
          id: entry.id,
          threadId,
          notReceived: true,
        });
        active.delete(threadId);
      } else {
        entry.uncertain = true;
        await invoke(workspaceId, { operation: 'unknown', id: entry.id, threadId });
      }
      throw error;
    }
  };
  const notification = (method, params) => {
    const entry = active.get(params?.threadId);
    if (!entry) return;
    if (entry.kind === 'realtime') {
      if (method === 'thread/realtime/closed')
        entry.tail = entry.tail
          .then(() =>
            invoke(entry.workspaceId, {
              operation: 'release',
              id: entry.id,
              threadId: entry.threadId,
              event: method,
            }),
          )
          .then(() => active.delete(entry.threadId))
          .catch(() => {});
      return;
    }
    if (!['turn/started', 'turn/completed'].includes(method)) return;
    entry.tail = entry.tail
      .then(async () => {
        if (params.turn?.uncertain) {
          await invoke(entry.workspaceId, {
            operation: 'unknown',
            id: entry.id,
            threadId: entry.threadId,
          });
          return;
        }
        if (!params.turn?.id || (entry.turnId && entry.turnId !== params.turn.id)) return;
        entry.turnId = params.turn.id;
        await invoke(entry.workspaceId, {
          operation: 'ack',
          id: entry.id,
          threadId: entry.threadId,
          turnId: entry.turnId,
        });
        if (method === 'turn/completed') {
          await invoke(entry.workspaceId, {
            operation: 'release',
            id: entry.id,
            threadId: entry.threadId,
            turnId: entry.turnId,
            status: params.turn.status,
          });
          if (active.get(entry.threadId) === entry) active.delete(entry.threadId);
        }
      })
      .catch(() => {}); // Durable occupancy survives uncertain transport.
  };
  const restore = async () => {
    const state = await invoke(await workspace(), { operation: 'read' });
    for (const s of state.slots)
      if (s.kind !== 'pool' && !active.has(s.thread_id))
        active.set(s.thread_id, {
          id: s.id,
          threadId: s.thread_id,
          turnId: s.turn_id,
          workspaceId: s.workspace,
          role: s.role,
          kind: s.kind,
          restored: true,
          tail: Promise.resolve(),
        });
    return state;
  };
  const reconcile = async (read) => {
    await restore();
    for (const entry of [...active.values()].filter(
      (e) => e.restored || e.uncertain || Date.now() - (e.createdAt || 0) > 30000,
    )) {
      if (entry.kind === 'realtime') continue;
      try {
        const turn = await read(entry);
        if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
          notification('turn/completed', { threadId: entry.threadId, turn });
          await entry.tail;
        }
      } catch {}
    }
  };
  return {
    role,
    start,
    notification,
    restore,
    reconcile,
    settled: (threadId) => active.get(threadId)?.tail || Promise.resolve(),
    forget: (id) => {
      for (const [thread, entry] of active) if (entry.id === id) active.delete(thread);
    },
    unknown: () => [...active.values()].map(({ tail, ...r }) => r),
  };
};
