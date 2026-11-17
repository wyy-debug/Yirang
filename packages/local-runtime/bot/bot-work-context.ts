import { createHash } from 'node:crypto';
import type { WorkTask } from '../../contracts/index.js';
import { fail } from '../../contracts/index.js';
import { continuationInstructions, nativeFileInstructions } from '../../components/work-continuation-config.mjs';

// Effective requirements are not reconstructed from the previous summary.
// Original revision anchors remain available even when the chat changes segment.
export const buildWorkContext = (
  task: WorkTask,
  inputOrigins: unknown[] = [],
  existingArtifacts: unknown[] = [],
) => {
  const m = task.management!;
  const latest = m.requirements.at(-1)!;
  const context = {
    version: 2,
    taskId: task.id,
    requirementsRevision: m.currentRequirementsRevision,
    generation: m.generation,
    requirements: {
      goal: latest.goal,
      constraints: latest.constraints,
      deliverables: latest.deliverables,
      acceptanceCriteria: latest.acceptanceCriteria,
    },
    sources: task.sources,
    existingArtifacts,
    nativeFileInstructions,
    completionCheck: m.continuation?.revision === m.currentRequirementsRevision ? m.continuation : null,
    continuationInstructions: m.continuation?.revision === m.currentRequirementsRevision && m.continuation.next === 'repair'
      ? continuationInstructions : undefined,
    previousResults: m.runs.filter(r => r.resultText).slice(-3).map(r => ({
      runId: r.id, state: r.state, requirementsRevision: r.requirementsRevision,
      excerpt: r.resultText!.slice(0, 2000), truncated: r.resultText!.length > 2000,
    })),
    answers: m.answeredQuestions || [],
    dependencies: m.dependencies,
    originals: m.requirements.map((r) => ({
      requestId: r.sourceRequestId,
      revision: r.revision,
      at: r.at,
      sha256: createHash('sha256').update(JSON.stringify(r)).digest('hex'),
    })),
    inputOrigins,
    modelSettings: m.modelSettings || null,
    results: m.runs
      .filter(
        (r) => r.state === 'succeeded' && r.requirementsRevision === m.currentRequirementsRevision,
      )
      .map((r) => ({ runId: r.id, hash: r.resultHash || null })),
    instructions:
      '仅执行此工作的已分配范围。inputOrigins 的其他片段只用于理解共同限制，不代表分配给你；不得执行其他工作。当前有效要求优先于历史摘要；原文锚点可回查。历史文件引用不扩大当前授权。结果和已提交输入不代表要求已验证。',
  };
  const json = JSON.stringify(context),
    bytes = Buffer.byteLength(json);
  // A tokenizer-independent upper bound, not a claimed exact token count.
  if (bytes > 24000)
    fail(
      'CONTEXT_TOO_LARGE',
      '完整有效要求超过上下文预算，请缩小材料或拆分工作；必要限制没有被截断',
    );
  return {
    ...context,
    stamp: createHash('sha256').update(json).digest('hex'),
    measurement: {
      utf8Bytes: bytes,
      estimatedTokens: bytes,
      method: 'utf8-upper-bound',
      tokenLimit: 24000,
      byteLimit: 98304,
    },
  };
};
