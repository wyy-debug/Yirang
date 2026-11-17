import { mainText } from '../main-text.mjs';
import { t as uiText } from '../platform/native-ui-language.mjs';

export async function readExecutionTimings(
  payload = {},
  { executionTimings, workManager, currentThreadId, knownThreads, continuousContext },
) {
  if (!executionTimings) throw Error(uiText(mainText('readExecutionTimings.001')));
  if (payload.taskId) {
    if (typeof payload.taskId !== 'string' || payload.taskId.length > 160)
      throw Error(mainText('readExecutionTimings.002'));
    const snapshot = await workManager.command({
      workspaceId: payload.workspaceId,
      command: { operation: 'list', payload: { compact: true } },
    });
    const root = snapshot.tasks.find((task) => task.id === payload.taskId);
    if (!root) throw Error(mainText('readExecutionTimings.003'));
    const tasks = snapshot.tasks.filter(
      (task) =>
        task.id === root.id ||
        (task.management.parentTaskId === root.id &&
          task.management.parentRequirementsRevision ===
            root.management.currentRequirementsRevision),
    );
    const value = executionTimings.read({
      workspaceId: snapshot.workspaceId,
      taskIds: tasks.map((task) => task.id),
    });
    value.runs = value.runs.filter(
      (run) =>
        run.requirementsRevision ===
        tasks.find((task) => task.id === run.taskId)?.management.currentRequirementsRevision,
    );
    return {
      ...value,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        state: task.management.state,
        parentTaskId: task.management.parentTaskId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        question: !!task.management.question,
        delegation: task.management.delegation,
        runs: task.management.runs
          .filter((run) => run.requirementsRevision === task.management.currentRequirementsRevision)
          .map((run) => ({
            id: run.id,
            createdAt: run.createdAt,
            endedAt: run.endedAt,
            state: run.state,
          })),
      })),
    };
  }
  const id = payload.threadId || currentThreadId;
  if (typeof id !== 'string' || !knownThreads.has(continuousContext.resolve(id)))
    throw Error(mainText('readExecutionTimings.004'));
  return executionTimings.read({ threadIds: continuousContext.parts(id) });
}
