// The Work Host owns the durable event. The Electron process only claims,
// persists delivery in the conversation queue, then acknowledges the claim.
export function createBotEventPump({ call, followup, emit }) {
  const running = new Map();
  const command = (workspaceId, payload) => call({ workspaceId,
    command: { operation: 'bot_events', payload } });
  async function drain(workspaceId) {
    if (running.has(workspaceId)) return running.get(workspaceId);
    const job = (async () => {
      const pending = await command(workspaceId, { operation: 'pending' });
      for (const event of pending) {
        const claimed = await command(workspaceId, { operation: 'claim', id: event.id });
        if (!claimed) continue;
        let delivered;
        try {
          delivered = await followup(claimed);
        } catch (error) {
          // A rejected promise may still follow a durable queue write. Keep the
          // event unknown until the original conversation can be inspected.
          await command(workspaceId, { operation: 'uncertain', id: event.id,
            token: claimed.delivery.token, reason: String(error.message).slice(0, 500) });
          emit('notice', error.message);
          continue;
        }
        await command(workspaceId, { operation: 'ack', id: event.id,
          token: claimed.delivery.token, reason: delivered ? 'conversation_queued' : 'not_primary' });
      }
    })();
    running.set(workspaceId, job);
    try { await job; }
    finally { running.delete(workspaceId); }
  }
  async function recover() {
    const result = await call({ command: { operation: 'orchestration',
      payload: { operation: 'host_workspaces' } } });
    for (const entry of result.workspaces || []) await drain(entry.id);
  }
  return { drain, recover };
}
