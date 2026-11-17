// Only the host-created second userMessage block can identify a Work run.
// A model message or a user's plain text mentioning the same ID is not proof.
export function matchesWorkTurn(turn, taskId, runId) {
  if (!turn?.id || !taskId || !runId) return false;
  return (turn.items || []).some(item => {
    if (item.type !== 'userMessage' || !Array.isArray(item.content)) return false;
    const block = item.content[1];
    if (block?.type !== 'text' || typeof block.text !== 'string') return false;
    try {
      const context = JSON.parse(block.text);
      return context?.type === 'yirang.turn-context' &&
        context.taskId === taskId && context.runId === runId &&
        context.consultation === false;
    } catch { return false; }
  });
}
