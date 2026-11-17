import { TaskBudget, fail, type WorkTask } from '../../contracts/index.js';

export function normalizeTask(task: WorkTask): WorkTask {
  return {
    ...task,
    budget: task.budget ?? TaskBudget.parse({}),
    writeObjectIds: task.writeObjectIds ?? [],
    usage: task.usage ?? { demoSteps: 0, modelTokens: null, executionMs: null },
    retries: task.retries ?? 0,
  };
}
export const terminalTask = (task: WorkTask) =>
  task.status === 'completed' || task.status === 'cancelled';
export const stepStatus = (task: WorkTask): WorkTask['status'] =>
  task.step === 0 ? 'queued' : task.step === 1 ? 'working' : task.step === 2 ? 'review' : 'ready';
export function taskGate(
  task: WorkTask,
  kind: NonNullable<WorkTask['gate']>['kind'],
  reason: string,
  at: string,
) {
  task.resumeStatus = stepStatus(task);
  task.gate = { kind, reason, at };
  task.status =
    kind === 'input'
      ? 'waiting_input'
      : kind === 'permission'
        ? 'waiting_permission'
        : kind === 'conflict'
          ? 'conflict'
          : 'failed';
}
export function clearGate(task: WorkTask) {
  task.gate = undefined;
  task.status = stepStatus(task);
  task.resumeStatus = undefined;
}
export function assertActive(task: WorkTask) {
  if (terminalTask(task)) fail('TASK_FINISHED', '任务已结束，可保存已有草稿或创建后续任务。');
}
