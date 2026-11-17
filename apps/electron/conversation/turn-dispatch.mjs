export async function dispatchTurn({
  sendId,
  blocks,
  delivery,
  work,
  consult,
  batch,
  projectCwd,
  model,
  effort,
  assertActive,
  request,
  workManager,
  cliAdapters,
  recordTiming,
  orchestration,
  outputs,
  executionPermissions = {},
  workflowDelivery,
}) {
  if (delivery) {
    try {
      await orchestration(delivery.workspaceId, {
        operation: 'send_prepare',
        id: delivery.intakeId,
        threadId: sendId,
      });
    } catch (error) {
      if (!consult) await outputs.failedStart(batch).catch(() => {});
      throw error;
    }
  }
  return Promise.resolve()
    .then(async () => {
      assertActive();
      if (work) await workManager.starting(work.task.id);
      assertActive();
      if (workflowDelivery) {
        await workflowDelivery.beforeStart(sendId);
        try {
          assertActive();
        } catch (error) {
          error.beforeSend = true;
          throw error;
        }
      }
      return request('turn/start', {
        threadId: sendId,
        input: blocks,
        ...executionPermissions,
        ...(delivery || workflowDelivery
          ? { clientUserMessageId: delivery?.intakeId ?? workflowDelivery.id }
          : {}),
        cwd: work ? batch.directory : projectCwd || batch.directory,
        ...(work?.run.controlled
          ? {
              sandboxPolicy: work.task.management.parentTaskId || executionPermissions.sandboxPolicy?.type === 'readOnly'
                ? { type: 'readOnly', networkAccess: false }
                : {
                    type: 'workspaceWrite',
                    writableRoots: [batch.directory],
                    networkAccess: false,
                    excludeTmpdirEnvVar: true,
                    excludeSlashTmp: true,
                  },
              approvalPolicy: work.task.management.parentTaskId ? 'never' : executionPermissions.approvalPolicy,
            }
          : {}),
        ...(consult
          ? { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never', summary: 'concise' }
          : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
    })
    .catch(async (error) => {
      recordTiming('failed', sendId, !error.rpcRejected);
      if (delivery)
        await orchestration(delivery.workspaceId, {
          operation: 'send_failed',
          id: delivery.intakeId,
          threadId: sendId,
          notReceived: !!(error.rpcRejected || error.beforeSend),
        }).catch(() => {});
      await (consult ? Promise.resolve() : outputs.failedStart(batch)).catch(() => {});
      throw error;
    });
}
