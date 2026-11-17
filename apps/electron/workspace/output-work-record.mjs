export function outputWorkRecord(batch, { liveTurnId, starting }) {
  const orphaned =
    batch.state === 'running' &&
    (batch.turnId ? batch.turnId !== liveTurnId : !starting);
  return {
    requestId: batch.id,
    threadId: batch.threadId,
    turnId: batch.turnId || null,
    title: batch.title,
    state: orphaned ? 'unknown' : batch.state === 'ready' ? 'completed' : batch.state,
    updatedAt: batch.updatedAt,
  };
}
