// Serialize delivery per work, not globally: unrelated conversations keep running.
export function createFollowupDelivery({ invoke, steer, reconcileEnded, changed }) {
  const pending = new Map();
  async function deliver(workspaceId, taskId) {
    const task = await invoke(workspaceId, 'detail', taskId);
    const run = task.management.runs.find(r => r.state === 'running' &&
      r.requirementsRevision === task.management.currentRequirementsRevision &&
      r.submittedRequirementsRevision !== r.requirementsRevision);
    if (!run) return;
    let revision = run.requirementsRevision;
    try {
      const context = await invoke(workspaceId, 'orchestration', undefined, {
        operation: 'context_read', taskId, runId: run.id,
      });
      const prepared = await invoke(workspaceId, 'prepare', taskId);
      revision = prepared.context?.requirementsRevision || context.requirementsRevision;
      if (!steer) throw Error('当前执行器不支持追加输入');
      await steer(run, prepared.context || context, prepared.content || []);
      await invoke(workspaceId, 'ack', taskId, {
        runId: run.id, threadId: run.threadId, turnId: run.turnId,
        requirementsRevision: revision,
      });
    } catch (error) {
      const current = await invoke(workspaceId, 'detail', taskId);
      if (!current.management.runs.some(r => r.id === run.id && r.state === 'running')) return;
      const inactive = error.code === 'TURN_NOT_ACTIVE' ||
        (error.code === -32600 && /no active turn to steer/i.test(error.message));
      let reconciled = false;
      if (inactive) {
        try { reconciled = !!(await reconcileEnded?.(run)); }
        catch { /* Keep the original run unknown when terminal reconciliation fails. */ }
      }
      if (reconciled) return;
      const latest = await invoke(workspaceId, 'detail', taskId);
      if (!latest.management.runs.some(r => r.id === run.id && r.state === 'running')) return;
      await invoke(workspaceId, 'finish', taskId, {
        runId: run.id, state: 'unknown',
        reason: inactive
          ? '原回合已结束，但原结果尚未核实；不自动重放补充要求'
          : '补充发送结果待核实：' + error.message,
      });
      // A definitive terminal is settled from the original turn. Otherwise the
      // delivery remains unknown and cannot be replayed as a new run.
    } finally {
      changed();
    }
  }
  return (workspaceId, taskId) => {
    const key = workspaceId + ':' + taskId;
    const next = (pending.get(key) || Promise.resolve()).catch(() => {}).then(() => deliver(workspaceId, taskId));
    pending.set(key, next);
    return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
  };
}
