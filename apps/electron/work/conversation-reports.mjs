import { projectWorkReport } from './work-report-journal.mjs';

// Reports derive from the durable task ledger; no model summary gates delivery.
export function attachConversationReports(page, snapshot) {
  if (page.workspaceId !== snapshot.workspaceId) return page;
  const requests = new Map(page.requests.map(request => [request.id, { ...request, reports: [] }]));
  const origins = new Map();
  for (const request of requests.values()) {
    origins.set(request.id, request);
    for (const id of request.workRequestIds || []) origins.set(id, request);
  }
  for (const task of snapshot.tasks || []) {
    const m = task.management;
    if (!m || m.legacy || m.parentTaskId || task.archived) continue;
    const requirement = (m.requirements || []).find(r => r.revision === m.currentRequirementsRevision);
    const request = origins.get(requirement?.sourceRequestId);
    if (request) request.reports.push(projectWorkReport(task, snapshot));
  }
  return { ...page, requests: [...requests.values()] };
}
