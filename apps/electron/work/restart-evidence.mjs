// Only a complete, terminal transcript with no executable items proves that
// resubmission cannot repeat a side effect. Unknown item types fail closed.
export function canRestartUnexecutedTurn(run, turn) {
  return !!run.restartRequestedAt && turn?.id === run.turnId &&
    turn.status === 'interrupted' && Array.isArray(turn.items) &&
    turn.items.every(item => ['userMessage', 'agentMessage', 'reasoning',
      'plan', 'contextCompaction'].includes(item.type));
}
