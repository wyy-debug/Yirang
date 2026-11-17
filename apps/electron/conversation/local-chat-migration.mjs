import { mainText } from '../main-text.mjs';

export async function migrateLocalChatForTurn({
  sendId,
  work,
  consult,
  consultationConfig,
  capturedSelection,
  sendReview,
  preparation,
  assertActive,
  state,
}) {
  if (!state.localChats.has(sendId)) return sendId;

  const oldId = sendId;
  const draft = state.localChats.get(oldId);
  const project = draft.projectId ? await state.projects.read(draft.projectId) : null;
  const cwd = project?.roots?.[0]?.path || state.outputRoot;
  if (project && !project.roots?.length) throw Error(mainText('sendTurn.007'));
  if (!(await state.stat(cwd).catch(() => null))?.isDirectory())
    throw Error(mainText('sendTurn.008') + cwd);
  assertActive();

  const target =
    draft.created ||
    (
      await state.request('thread/start', {
        ...state.permissions.startOptions(oldId),
        ...(!work
          ? { dynamicTools: [state.recallTool] }
          : work.run.controlled && !work.task.management.parentTaskId
            ? { dynamicTools: [state.workDelegationTool, state.workStatusTool] }
            : { dynamicTools: [state.workStatusTool] }),
        cwd,
        projectId: draft.projectId,
        ...(work || consult
          ? {
              config: consultationConfig || {},
              ...(consult ? { sandbox: 'read-only', approvalPolicy: 'never' } : {}),
            }
          : {}),
      })
    ).thread;

  draft.created = target;
  // An execution conversation is named after its work. Otherwise the CLI names
  // it from the first message, which is the internal context prompt.
  if (work?.task?.title)
    await state
      .request('thread/name/set', { threadId: target.id, name: work.task.title.slice(0, 60) })
      .catch(() => {});
  await state.permissions.migrate(oldId, target.id);
  await state.conversations.migrate(oldId, target.id);
  state.continuousContext.migrate(oldId, target.id);
  sendId = target.id;
  state.turnReviews.delete(oldId);
  state.turnReviews.set(sendId, sendReview);
  state.preparations.delete(oldId);
  if (preparation) state.preparations.set(sendId, preparation);
  state.knownThreads.delete(oldId);
  state.knownThreads.set(sendId, work?.task?.title || mainText('host.021'));
  state.threadSelections.set(sendId, capturedSelection);
  state.threadSelections.delete(oldId);
  state.localChats.delete(oldId);
  if (state.getThreadId() === oldId) {
    state.setThreadId(sendId);
    await state.threadSessionFiles.saveThreadId(sendId);
    await state.projects.observe(target);
    if (state.getThreadId() === sendId)
      state.emit('thread-created', { threadId: sendId, previousThreadId: oldId });
  }
  state.sessions();
  return sendId;
}
