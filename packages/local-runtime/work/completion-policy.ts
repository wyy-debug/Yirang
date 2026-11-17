import { createHash } from 'node:crypto';
import type { WorkManagement, WorkRun } from '../../contracts/work-management.js';

import type { CompletionEvidence, Continuation } from '../../contracts/work-completion.js';
export type { CompletionEvidence } from '../../contracts/work-completion.js';
import { continuationLimits } from '../../components/work-continuation-config.mjs';
import { completionConditions } from './completion-conditions.js';
import { completionBlocker } from './completion-blocker.js';
export { continuationLimits };

/** Only completed, controlled file-producing turns may be repaired automatically.
 * Unknown transport outcomes, denied actions and cancellation never imply retry permission. */
export function decideContinuation(m: WorkManagement, run: WorkRun, missing: string[], evidence: CompletionEvidence[]): Continuation {
  const blocker = completionBlocker(run.resultText);
  if (blocker) missing = [...new Set([...missing, blocker])];
  const noEvidence = m.responsibilityVersion === 6 && missing.length === 0 && evidence.length === 0;
  if (noEvidence) missing = ['缺少可核验成果证据'];
  const old = m.continuation?.revision === m.currentRequirementsRevision ? m.continuation : undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify({ missing,
    evidence: evidence.filter(e => e.status !== 'passed').map(e => [e.objectId, e.hash, e.code, e.criterion?.id]),
  })).digest('hex');
  const failures = missing.length > 0 || evidence.some(e => e.status !== 'passed');
  // An unavailable semantic reviewer cannot certify delivery, but must not
  // prevent fixing a separately proven missing/corrupt local file. Unknown
  // object identity, bytes, or execution outcome remain a hard stop.
  const knownDefect = (missing.length > 0 && !noEvidence) || evidence.some(e => e.status === 'failed');
  const unsafeUnknown = evidence.some(e => e.status === 'unknown' &&
    !(knownDefect && (e.code.startsWith('review_') || e.code.startsWith('semantic_'))));
  // Wall time includes shutdown/offline periods. Legacy runs without samples
  // stay unknown and consume the conservative limit instead of guessing.
  const elapsed = run.activeMs ?? Number.NaN;
  const spentMs = (old?.spentMs || 0) + (old?.next === 'repair'
    ? Number.isFinite(elapsed) ? Math.max(0, elapsed) : continuationLimits.activeMs : 0);
  const repeats = old?.fingerprint === fingerprint ? old.repeats + 1 : 1;
  const grants = old?.grants || [];
  const allowedAttempts = continuationLimits.attempts + grants.reduce((n, g) => n + g.attempts, 0);
  const allowedMs = continuationLimits.activeMs + grants.reduce((n, g) => n + g.activeMs, 0);
  const safe = !blocker && run.controlled && run.state === 'succeeded' && !m.question &&
    !['paused', 'cancelled', 'pausing', 'cancelling'].includes(m.state) &&
    !unsafeUnknown && knownDefect &&
    (old?.attempts || 0) < allowedAttempts && spentMs < allowedMs &&
    repeats < continuationLimits.repeatedFailures;
  return { revision: m.currentRequirementsRevision, attempts: (old?.attempts || 0) + (failures && safe ? 1 : 0),
    spentMs, fingerprint, repeats, checkedRunId: run.id, evidence, missing, grants,
    next: failures ? safe ? 'repair' : 'blocked' : 'done',
    conditions: completionConditions({ ...m, requirements: m.requirements || [], artifacts: m.artifacts || [] }, evidence) };
}
