import { requiresDeliveryConfirmation } from '../../../packages/components/work-confirmation.mjs';
import { missingDeliveries } from '../../../packages/components/work-delivery.mjs';
// Read-only projection shared by IPC and the visible conversation.
const FAILED = new Set(['failed', 'cancelled', 'interrupted', 'unknown']);
export function projectWorkReport(task, snapshot = {}) {
  const m = task.management || {};
  const currentRun = (m.runs || []).filter(run =>
    run.requirementsRevision === m.currentRequirementsRevision &&
    (m.generation == null || run.generation == null || run.generation === m.generation)).at(-1);
  const artifacts = [...new Map((m.artifacts || []).filter(file => file.validity === 'current')
    .map(file => [file.objectId, file])).values()];
  const children = (snapshot.tasks || []).filter(child => child.management?.parentTaskId === task.id &&
    child.management.parentRequirementsRevision === m.currentRequirementsRevision).map(child => ({
      taskId: child.id, title: child.title, state: child.management.state,
      reason: child.management.reason || '',
    }));
  const failed = FAILED.has(currentRun?.state);
  const missing = missingDeliveries(m, artifacts);
  const issues = [...new Set([failed ? '执行没有正常结束。已有文件保留，可以检查后要求重做。' : '',
    currentRun?.reason || '', m.reason || '',
    ...children.filter(child => ['attention', 'cancelled'].includes(child.state))
      .map(child => `${child.title}：${child.reason || '尚未完成'}`)].filter(Boolean))];
  const delivered = m.state === 'review' && currentRun?.state === 'succeeded' &&
    !missing.length && (artifacts.length > 0 || currentRun.resultHash || currentRun.resultText) && !requiresDeliveryConfirmation(m);
  const incomplete = ['review', 'completed'].includes(m.state) && missing.length > 0;
  const state = incomplete || m.state === 'review' && failed ? 'attention' : delivered ? 'completed' : m.state;
  const resultText = currentRun?.resultText || '';
  const reason = incomplete ? `尚未交付：${missing.join('、').toUpperCase()}。已有成果保留，可以继续。` : state === 'completed' ? (artifacts.length ? '文件已保存到桌面' : '已回复') : m.state === 'review'
    ? issues.join('；') || (artifacts.length ? '文件已放回桌面，确认内容后即可验收。'
      : resultText || currentRun?.resultHash ? '这次只有文字结论，没有文件。确认结论后即可验收。'
        : '尚无可确认的成果，请检查执行过程。')
    : m.reason || '';
  return {
    id: `${snapshot.workspaceId}:${task.id}:${task.revision}`, workspaceId: snapshot.workspaceId,
    taskId: task.id, title: task.title, generation: m.generation,
    requirementsRevision: m.currentRequirementsRevision, state, reason,
    runId: currentRun?.id, resultText, artifacts, children, issues, at: task.updatedAt,
  };
}
export function projectWorkReports(snapshot) {
  return (snapshot.tasks || []).filter(task => task.management && !task.management.legacy &&
    !task.management.parentTaskId).map(task => projectWorkReport(task, snapshot));
}
