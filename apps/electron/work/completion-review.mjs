import { completionReviewInstructions, executionReviewInstructions } from '../../../packages/components/work-continuation-config.mjs';
import { reviewCriteria, criteriaReviewInstructions } from '../../../packages/components/work-review-criteria.mjs';

export async function reviewCompletion(evaluator, workspaceId, input) {
  if (!input?.profile?.model || !input.files?.length) return null;
  input = { ...input, criteria: reviewCriteria(input.requirements), files: input.files.filter(f => f.status === 'passed') };
  if (!input.files.length) return null;
  // Bounded payload; absent source content is explicitly unknown, never inferred from the generator.
  if (Buffer.byteLength(JSON.stringify(input)) > 48000) return null;
  const result = await evaluator(workspaceId, {
    profile: input.profile, timeoutMs: 60000, instructions: completionReviewInstructions + '\n' + executionReviewInstructions + '\n' + criteriaReviewInstructions, input,
    wireSchema: { type: 'object', additionalProperties: false,
      required: ['requirementsRevision', 'files', 'criteria'], properties: {
        requirementsRevision: { type: 'integer' },
        criteria: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['id', 'status', 'reason', 'evidence'], properties: {
            id: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'unknown'] }, reason: { type: 'string' },
            evidence: { type: 'array', items: { type: 'object', additionalProperties: false,
              required: ['objectId', 'revision', 'hash', 'quote'], properties: {
                objectId: { type: 'string' }, revision: { type: 'integer' }, hash: { type: 'string' }, quote: { type: 'string' },
              } } },
          } } },
        files: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['objectId', 'revision', 'hash', 'status', 'quote', 'reason'], properties: {
            objectId: { type: 'string' }, revision: { type: 'integer' }, hash: { type: 'string' },
            status: { type: 'string', enum: ['passed', 'failed', 'unknown'] },
            quote: { type: 'string' }, reason: { type: 'string' },
          } } },
      } },
  });
  return JSON.parse(result.text);
}
