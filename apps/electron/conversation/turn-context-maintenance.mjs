import { mainText } from '../main-text.mjs';

export async function maintainTurnContext({
  sendId,
  text,
  extra,
  consult,
  projectId,
  model,
  preparation,
  sendReview,
  capturedSelection,
  assertActive,
  state,
}) {
  const incoming = text.length + extra.reduce((n, block) => n + (block.type === 'text' ? block.text.length : 0), 0) + 20000;
  let plan = null;
  let runtime = null;
  const rolloverRequested = state.context.wantsRollover(sendId, incoming);
  if (state.context.needsMaintenance(sendId, incoming)) {
    runtime = await state.contextRuntime(sendId);
    plan = await state.context.assess(sendId, {
      runtime,
      assertActive,
      incomingKey: consult?.sourceKey,
      incomingText: text,
    });
    assertActive();
    const refreshed = await state.contextRuntime(sendId);
    if (JSON.stringify(refreshed) !== JSON.stringify(runtime))
      plan = { ...plan, boundary: { ...plan.boundary, safeToSwitch: false } };
    runtime = refreshed;
  }
  const canRoll =
    consult &&
    !state.voiceOwns(sendId) &&
    !state.hasApproval(sendId) &&
    state.context.safeBoundary(plan, runtime);
  if (canRoll && rolloverRequested) {
    const previous = sendId;
    try {
      sendId = await state.context.rollover(previous, {
        assertActive,
        plan,
        create: async () => {
          assertActive();
          const current = await state.request('thread/read', { threadId: previous });
          return (
            await state.request('thread/start', {
              ...state.permissions.startOptions(previous),
              cwd: current.thread.cwd || state.outputRoot,
              projectId,
              dynamicTools: [state.recallTool],
              ...(model ? { model } : {}),
              multiAgentMode: 'explicitRequestOnly',
              config: state.consultationConfig,
              sandbox: 'read-only',
              approvalPolicy: 'never',
            })
          ).thread;
        },
        adopt: async (target) => {
          await state.permissions.migrate(previous, target);
          await state.conversations.migrate(previous, target);
        },
      });
      state.emit('context-maintenance', { threadId: previous, state: 'completed' });
      state.preparations.delete(previous);
      state.preparations.set(sendId, preparation);
      state.turnReviews.delete(previous);
      state.turnReviews.set(sendId, sendReview);
      state.knownThreads.set(sendId, state.knownThreads.get(previous) || mainText('emit.001'));
      state.knownThreads.delete(previous);
      state.threadSelections.set(sendId, state.threadSelections.get(previous) || capturedSelection);
      state.threadSelections.delete(previous);
      if (state.getThreadId() === previous) {
        state.setThreadId(sendId);
        state.emit('thread-created', { threadId: sendId, previousThreadId: previous, background: true });
        await state.threadSessionFiles.saveThreadId(sendId);
      }
      state.sessions();
    } catch (error) {
      state.emit('context-maintenance', { threadId: sendId, state: 'failed', message: error.message });
      throw error;
    }
  } else await state.context.beforeTurn(sendId, incoming, plan, assertActive);

  assertActive();
  if (runtime)
    extra = [...extra, { type: 'text', text: mainText('sendTurn.009') + JSON.stringify(await state.contextRuntime(sendId)) }];
  const remembered = state.context.recall(sendId, state.context.scope(sendId), text);
  const handoff = state.context.seed(sendId);
  if (remembered || handoff) extra = [...extra, { type: 'text', text: handoff + remembered }];
  return { sendId, extra };
}
