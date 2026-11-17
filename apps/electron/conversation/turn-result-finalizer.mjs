import { randomUUID } from 'node:crypto';

/**
 * Binds a started turn to the desktop lifecycle and persists the user-visible
 * attachment/result state. Keeping this after dispatch makes request failure
 * handling independent from result recovery and selection cleanup.
 */
export async function finalizeTurnResult({
  sendId,
  result,
  attached,
  extra,
  queued,
  work,
  consult,
  batch,
  preparation,
  state,
}) {
  const resultTurnId = result.turn.id;
  state.recordTiming('bind', sendId, resultTurnId);
  if (!work) state.context.seeded(sendId);
  if (consult?.sourceKey)
    state.context.tagReferences(sendId, consult.sourceKey, { consultTurn: resultTurnId });
  if (state.delivery)
    await state.orchestration(state.delivery.workspaceId, {
      operation: 'send_ack',
      id: state.delivery.intakeId,
      threadId: sendId,
      turnId: resultTurnId,
    });
  if (work) await state.workManager.ack(work.task.id, sendId, resultTurnId, state.modelSettings);
  if (consult)
    await state.desktopValue('desktop_work_host', {
      command: {
        operation: 'consult_bind',
        requestId: randomUUID(),
        payload: { threadId: sendId, requestId: consult.requestId, turnId: resultTurnId },
      },
    });
  const attachments = state.describeAttachments([...attached, ...extra]);
  await state.messageAttachments
    .save(sendId, resultTurnId, attachments)
    .catch((error) => state.emit('notice', state.mainText('sendTurn.016') + error.message));
  state.emit('message-attachments', { threadId: sendId, turnId: resultTurnId, attachments });
  if (!queued) {
    state.threadSelections.delete(sendId);
    if (state.getThreadId() === sendId) {
      state.setSelection([]);
      state.emit('selection', []);
    }
  }
  const sentTurnId = state.completedTurns.has(resultTurnId) ? null : resultTurnId;
  if (sentTurnId) state.liveTurns.set(sendId, sentTurnId);
  if (state.getThreadId() === sendId) state.setTurnId(sentTurnId);
  state.sessions();
  await (consult ? Promise.resolve() : state.outputs.bind(batch, resultTurnId)).catch((error) =>
    state.emit('notice', state.mainText('sendTurn.017') + error.message),
  );
  if (preparation.cancelled && state.liveTurns.has(sendId))
    await state.request('turn/interrupt', { threadId: sendId, turnId: resultTurnId });
  return { turnId: state.completedTurns.has(resultTurnId) ? null : sentTurnId, threadId: sendId };
}
