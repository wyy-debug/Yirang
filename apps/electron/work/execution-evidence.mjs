// Exact-turn CLI receipts, not an agent's prose. No stdout, environment or
// arbitrary tool payload is forwarded to the independent reviewer.
export function executionEvidence(turn, expectedTurnId) {
  if (!turn || turn.id !== expectedTurnId || !Array.isArray(turn.items)) return null;
  const commands = turn.items.filter(item => item.type === 'commandExecution');
  return { turnId: turn.id, status: turn.status, truncated: commands.length > 20,
    commands: commands.slice(0, 20).map(item => ({
      id: item.id, status: item.status,
      command: typeof item.command === 'string' ? item.command.slice(0, 2000) : null,
      exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
      durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    })) };
}
