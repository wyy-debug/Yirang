import { canRestartUnexecutedTurn } from './restart-evidence.mjs';
import { executionEvidence } from './execution-evidence.mjs';
// Observe first. Never infer permission to replay from a lost connection.
export function createWorkRecovery({ readRun, recoverRun, reattach, invoke, changed, reserveBudget, settleBudget, readTimeoutMs = 15000, operationTimeoutMs = 90000 }) {
  const pending = new Set(), nextCheck = new Map(), completed = new Set();
  const observe = async (run, task, allowanceMs = readTimeoutMs) => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => readRun(run, task)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('recovery_read_timeout')), Math.min(readTimeoutMs, allowanceMs)); })]);
    } finally { clearTimeout(timer); }
  };
  return async snapshot => {
    for (const task of snapshot.tasks) {
      if (task.management.responsibilityVersion !== 6 || task.management.legacy || task.management.restoredHistory) continue;
      for (const old of task.management.runs.filter(r => r.state === 'unknown')) {
        const key = `${snapshot.workspaceId}:${old.id}`;
        if (completed.has(key) || pending.has(key) || Date.now() < (nextCheck.get(key) || 0)) continue;
        pending.add(key);
        nextCheck.set(key, Date.now() + 30000);
        // A deadline releases the scheduler, not ownership of an in-flight collection.
        // Keep the claim until the actual operation settles so a slow response cannot
        // trigger duplicate collection or reconciliation on the next observation.
        let budget, started;
        const operation = (async () => { try {
          if (reserveBudget) {
            budget = await reserveBudget(snapshot.workspaceId, task, old);
            if (!budget) return;
          }
          started = performance.now();
          const actual = await observe(old, task, budget?.allowanceMs);
          if (budget && performance.now() - started >= budget.allowanceMs) return;
          let observed = old;
          if (!old.turnId && actual?.id && actual.matchedWorkRun === old.id) {
            await invoke(snapshot.workspaceId, 'ack', task.id, {
              runId: old.id, threadId: old.threadId, turnId: actual.id,
              requirementsRevision: old.requirementsRevision, recovered: true,
            });
            observed = { ...old, turnId: actual.id };
          }
          if (actual?.status === 'inProgress' && actual.id === observed.turnId && reattach) {
            await reattach(snapshot.workspaceId, task, observed);
            completed.add(key);
            while (completed.size > 1000) completed.delete(completed.values().next().value);
            nextCheck.delete(key);
            changed();
            return;
          }
          if (!actual || actual.id !== observed.turnId || !['completed', 'failed', 'interrupted'].includes(actual.status)) return;
          const batch = await recoverRun?.(observed, actual);
          await invoke(snapshot.workspaceId, 'reconcile', task.id, {
            runId: old.id, state: actual.status === 'completed' ? 'succeeded' : actual.status,
            batchId: batch?.id,
            restartSafe: canRestartUnexecutedTurn(observed, actual),
            executionEvidence: executionEvidence(actual, observed.turnId),
            artifacts: (batch?.files || []).filter(f => f.objectId && f.revision)
              .map(f => ({ objectId: f.objectId, revision: f.revision })),
            resultText: (actual.items || []).filter(i => i.type === 'agentMessage')
              .map(i => i.text || '').join('\n').slice(0, 100000),
          });
          nextCheck.delete(key);
          completed.add(key);
          while (completed.size > 1000) completed.delete(completed.values().next().value);
          changed();
        } catch {
          // Keep the original claim. A read or collection failure is not a new execution.
        } finally {
          if (budget && started !== undefined) {
            try { await settleBudget?.(snapshot.workspaceId, task, old, budget,
              Math.max(0, performance.now() - started)); } catch { /* Reservation remains charged. */ }
          }
          pending.delete(key);
        } })();
        let timer;
        try {
          await Promise.race([operation, new Promise(resolve => { timer = setTimeout(resolve, operationTimeoutMs); })]);
        } finally { clearTimeout(timer); }
      }
    }
    const live = new Set(snapshot.tasks.flatMap(t => t.management.runs.filter(r => r.state === 'unknown')
      .map(r => `${snapshot.workspaceId}:${r.id}`)));
    for (const key of nextCheck.keys())
      if (key.startsWith(snapshot.workspaceId + ':') && !live.has(key) && !pending.has(key)) nextCheck.delete(key);
  };
}
