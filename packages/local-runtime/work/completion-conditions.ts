import { missingDeliveries } from '../../components/work-delivery.mjs';
import type { WorkManagement } from '../../contracts/work-management.js';
import type { CompletionEvidence, CompletionCondition } from '../../contracts/work-completion.js';

// Stable condition identities are independent of a CLI turn. The requirement
// revision identifies which user request these observations actually establish.
export function completionConditions(m: WorkManagement, evidence: CompletionEvidence[]): CompletionCondition[] {
  const requirement = m.requirements.at(-1);
  const revision = m.currentRequirementsRevision;
  const conditions: CompletionCondition[] = (requirement?.delivery?.formats || []).map(format => {
    const missing = missingDeliveries({ requirements: [{ ...requirement, delivery: { formats: [format] } }] }, m.artifacts);
    return { id: `delivery:${format}`, requirementsRevision: revision, source: 'requirements.delivery',
      method: 'delivery', status: missing.length ? 'failed' : 'passed',
      description: missing.length ? missing.join('、') : format,
      evidence: m.artifacts.filter(a => a.validity === 'current').map(a => ({ objectId: a.objectId, revision: a.revision })) };
  });
  for (const item of evidence) {
    const semantic = item.code.startsWith('semantic_') || item.code.startsWith('review_');
    conditions.push({ id: item.criterion ? `criterion:${item.criterion.id}:${item.objectId}` : `${semantic ? 'content' : 'structure'}:${item.objectId}`,
      requirementsRevision: revision, source: item.criterion?.source || (semantic ? 'requirements.goal/constraints/acceptanceCriteria' : 'requirements.delivery'),
      method: semantic ? 'semantic' : 'structure', status: item.status, description: item.criterion?.description || item.detail,
      evidence: [{ objectId: item.objectId, revision: item.revision, hash: item.hash }] });
  }
  return conditions;
}
