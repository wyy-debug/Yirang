// Identity belongs to the desktop; CLI thread/turn identities are only origins.
export function createMainConversation({ orchestration, readHistory }) {
  const inFlight = new Map();
  async function record(workspaceId, threadId, turn) {
    if (!workspaceId || !turn || !['completed', 'failed', 'interrupted'].includes(turn.status))
      return;
    return orchestration(workspaceId, {
      operation: 'consult_result',
      threadId,
      turnId: turn.id,
      status: turn.status,
      text: (turn.items || [])
        .filter((item) => item.type === 'agentMessage')
        .map((item) => item.text || '')
        .join('\n\n')
        .slice(0, 200000),
    });
  }
  async function page(workspaceId, before) {
    const result = await orchestration(workspaceId, { operation: 'transcript', before });
    return { ...result, workspaceId, conversationId: `desktop:${workspaceId}:main` };
  }
  // Recovery is read-only against the CLI. Unknown sends are never dispatched here.
  async function recover(workspaceId, requests) {
    // Serialize pages without dropping requests from a second history page.
    const previous = inFlight.get(workspaceId) || Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        const byThread = new Map();
        for (const request of requests) {
          if (request.response || request.delivery?.state !== 'acknowledged') continue;
          const id = request.delivery.threadId;
          if (!byThread.has(id)) byThread.set(id, new Set());
          byThread.get(id).add(request.delivery.turnId);
        }
        for (const [threadId, ids] of byThread) {
          let cursor = null;
          const visited = new Set();
          while (ids.size) {
            const history = await readHistory(threadId, cursor);
            for (const turn of history.data || [])
              if (ids.has(turn.id)) {
                await record(workspaceId, threadId, turn);
                ids.delete(turn.id);
              }
            if (!history.nextCursor || visited.has(history.nextCursor)) break;
            cursor = history.nextCursor;
            visited.add(cursor);
          }
        }
      });
    inFlight.set(workspaceId, job);
    try {
      await job;
    } finally {
      if (inFlight.get(workspaceId) === job) inFlight.delete(workspaceId);
    }
  }
  return { page, record, recover };
}
