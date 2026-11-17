import type { CompletionEvidence } from '../../contracts/work-completion.js';
import type { ReviewCriterion } from '../../components/work-review-criteria.mjs';

// The host checks that the independent review refers to the exact inspected revision.
// Model conclusions without matching content evidence remain unknown.
export function semanticEvidence(files: CompletionEvidence[], review: any, revision: number, criteria: ReviewCriterion[] = []): CompletionEvidence[] {
  const result: CompletionEvidence[] = files.filter(f => f.status === 'passed').map(f => {
    const matches = review?.requirementsRevision === revision && Array.isArray(review?.files)
      ? review.files.filter((r: any) => r.objectId === f.objectId && r.revision === f.revision && r.hash === f.hash)
      : [];
    const match = matches.length === 1 ? matches[0] : undefined;
    const cited = typeof match?.quote === 'string' && match.quote.trim().length > 0 && f.text?.includes(match.quote);
    const valid = cited && ['passed', 'failed'].includes(match?.status) && typeof match?.reason === 'string';
    return { objectId: f.objectId, revision: f.revision, hash: f.hash,
      status: valid ? match.status : 'unknown', code: valid ? 'semantic_' + match.status : 'semantic_unverified',
      detail: valid || (match?.status === 'unknown' && typeof match.reason === 'string')
        ? match.reason.slice(0, 1500) : '内容要求尚未独立核实，文件已保留' };
  });
  const anchor = files.find(f => f.status === 'passed');
  if (!anchor) return result; // Structural failure is handled before semantic inspection.
  for (const criterion of criteria) {
    const matches = review?.requirementsRevision === revision && Array.isArray(review.criteria)
      ? review.criteria.filter((item: any) => item.id === criterion.id) : [];
    const match = matches.length === 1 ? matches[0] : undefined;
    const citations = Array.isArray(match?.evidence) ? match.evidence : [];
    const valid = citations.length > 0 && citations.every((citation: any) => files.some(file =>
      file.status === 'passed' && file.objectId === citation.objectId && file.revision === citation.revision &&
      file.hash === citation.hash && typeof citation.quote === 'string' && citation.quote.trim() && file.text?.includes(citation.quote)));
    const status = valid && ['passed', 'failed'].includes(match?.status) && typeof match?.reason === 'string'
      ? match.status : 'unknown';
    // Persist every cited object so later revision checks also cover multi-file conclusions.
    const citedFiles = valid ? files.filter(file => citations.some((c: any) => c.objectId === file.objectId)) : [anchor];
    for (const file of citedFiles) result.push({ objectId: file.objectId, revision: file.revision, hash: file.hash,
      criterion, status, code: `semantic_criterion_${status}`,
      detail: typeof match?.reason === 'string' ? match.reason.slice(0, 1500) : '此项要求尚未独立核实' });
  }
  return result;
}
