export function createWorkflowDelivery({ command, activeThread, send, readHistory, unresolved }) {
  const pending = new Map();

  async function deliver(scope) {
    const { dispatchId } = scope;
    const target = activeThread();
    const read = () => command(scope, { operation: 'host_read', dispatchId });
    const finish = (threadId, outcome, message) =>
      command(scope, { operation: 'host_finish', dispatchId, threadId, outcome, message });
    const record = await read();
    if (record.state === 'sent') return { sent: true, receiptPending: false };
    if (record.state === 'failed') return { sent: false, receiptPending: false, failed: true };
    if (record.state === 'unknown' && record.threadId &&
        await readHistory(record.threadId, dispatchId).catch(() => false)) {
      const receipt = await finish(record.threadId, 'sent');
      if (receipt.state !== 'sent') throw unresolved();
      return { sent: true, receiptPending: false };
    }
    if (record.state !== 'prepared') throw unresolved();

    if (!target || target !== activeThread()) throw unresolved();
    let attemptThread;
    let accepted = false;
    try {
      const result = await send(target, record.content, {
        id: dispatchId,
        async beforeStart(threadId) {
          const start = {
            operation: 'host_start', dispatchId, threadId, requestId: scope.attemptId,
          };
          try {
            await command(scope, start);
          } catch {
            // A lost SQLite reply is safe to re-read with this invocation's receipt.
            await command(scope, start);
          }
          attemptThread = threadId;
        },
        accepted() {
          accepted = true;
        },
      });
      const receipt = await finish(attemptThread, 'sent');
      if (receipt.state !== 'sent') throw unresolved();
      return { ...result, sent: true, receiptPending: false, startedNow: true };
    } catch (error) {
      if (accepted) {
        const saved = await finish(attemptThread, 'sent').catch(() => null);
        return { sent: true, receiptPending: saved?.state !== 'sent', startedNow: true };
      }
      if (attemptThread && (error.rpcRejected || error.beforeSend)) {
        const result = await finish(attemptThread, 'failed', String(error.message).slice(0, 2000));
        return { sent: result.state === 'sent', receiptPending: false, failed: result.state === 'failed' };
      }
      throw error;
    }
  }

  return (scope) => {
    const key = JSON.stringify([scope.workspaceId, scope.credential, scope.dispatchId]);
    const existing = pending.get(key);
    if (existing) return existing.then(({ startedNow, ...receipt }) => receipt);
    const job = deliver(scope).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  };
}

export function hasWorkflowDelivery(turns, dispatchId) {
  return turns.some((turn) =>
    turn.items?.some((item) => {
      const block = item.type === 'userMessage' ? item.content?.[1] : null;
      if (block?.type !== 'text') return false;
      try {
        const context = JSON.parse(block.text);
        return context.type === 'yirang.turn-context' && context.workflowDispatchId === dispatchId;
      } catch {
        return false;
      }
    }),
  );
}
