import { z } from 'zod';
import type { NodeState, PlanState } from './agent-plan.js';
export const QueueEntry = z
  .object({
    entryId: z.string(),
    planId: z.string(),
    planRevision: z.number().int().positive(),
    nodeId: z.string(),
    priority: z.enum(['interactive', 'user-blocking', 'normal', 'background']),
    createdAt: z.number(),
    notBefore: z.number(),
    deadline: z.number().nullable(),
    attempt: z.number().int().nonnegative(),
    segment: z.number().int().nonnegative(),
    dispatchKey: z.string(),
    rateLimitRejectCount: z.number().int().nonnegative(),
    executionRetryCount: z.number().int().min(0).max(2),
    requiredResources: z.array(z.string()),
    state: z.enum([
      'ready',
      'leased',
      'waiting_rate_limit',
      'waiting_resource',
      'retry_wait',
      'done',
    ]),
  })
  .strict();
export function priorityRank(priority: string, createdAt: number, now: number) {
  return priority === 'interactive'
    ? 0
    : priority === 'user-blocking'
      ? 1
      : priority === 'normal' || now - createdAt >= 30000
        ? 2
        : 3;
}
export type ErrorEvidence = {
  version: 1;
  rpcRejected: boolean;
  status?: number;
  code?: string;
  retryAfterMs?: number;
};
export function classifyError(
  e: ErrorEvidence,
): 'rate_limit' | 'quota' | 'permission' | 'rejected' | 'unknown' {
  if (e.version !== 1 || !e.rpcRejected) return 'unknown';
  if (e.status === 401 || e.status === 403) return 'permission';
  if (['usageLimitExceeded', 'insufficient_quota'].includes(e.code || '')) return 'quota';
  if (e.status === 429 || e.code === 'rateLimitExceeded') return 'rate_limit';
  return 'rejected';
}
export function userPhase(
  plan: { state: PlanState; confirmationRequired?: boolean; confirmed?: boolean; reason?: string },
  nodes: { state: NodeState; question?: unknown; attention?: string }[],
) {
  if (nodes.some((n) => n.state === 'unknown')) return { label: '需要处理', rank: 0 };
  if (nodes.some((n) => n.question && n.state === 'waiting_user'))
    return { label: '等你回答', rank: 1 };
  if ((plan.confirmationRequired && !plan.confirmed) || plan.state === 'review')
    return { label: '等你确认', rank: 2 };
  if (
    ['needs_input', 'failed', 'unknown', 'interrupted'].includes(plan.state) ||
    nodes.some((n) => n.attention || n.state === 'failed')
  )
    return { label: '需要处理', rank: 3 };
  if (['completed', 'cancelled'].includes(plan.state)) return { label: '已结束', rank: 6 };
  if (
    nodes.some((n) => ['leased', 'starting', 'running', 'stopping'].includes(n.state)) ||
    ['paused', 'pausing', 'cancel_requested'].includes(plan.state)
  )
    return { label: '进行中', rank: 4 };
  return { label: '等待执行', rank: 5 };
}
export type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};
export class UsageWatermark {
  private last: Usage | undefined;
  update(value: Usage): Usage | null {
    if (value.inputTokens === null || value.outputTokens === null) return null;
    if (
      this.last &&
      (value.inputTokens < this.last.inputTokens! || value.outputTokens < this.last.outputTokens!)
    )
      return null;
    const delta = {
      inputTokens: value.inputTokens - (this.last?.inputTokens || 0),
      outputTokens: value.outputTokens - (this.last?.outputTokens || 0),
      cachedInputTokens:
        value.cachedInputTokens === null
          ? null
          : value.cachedInputTokens - (this.last?.cachedInputTokens || 0),
    };
    this.last = value;
    return delta;
  }
}
