import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[\w.-]{1,160}$/);
const tokens = z.number().int().nonnegative();
export const ArtifactRef = z
  .object({
    objectId: id,
    revision: z.number().int().positive(),
    anchorId: z.string().max(200).optional(),
  })
  .strict();
export const AgentNode = z
  .object({
    id,
    type: z.enum(['research', 'transform', 'review', 'reduce']),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(12000),
    acceptance: z.string().trim().min(1).max(6000),
    inputRefs: z.array(ArtifactRef).max(64).default([]),
    outputRefs: z.array(id).max(64).default([]),
    modelProfile: z
      .object({
        provider: id.default('codex'),
        account: id.default('default'),
        model: id,
        effort: z.string().max(80).nullable().default(null),
      })
      .strict(),
    budget: z
      .object({
        inputTokens: tokens.optional(),
        outputTokens: tokens.optional(),
        maxMinutes: z.number().positive().max(10).default(10),
      })
      .strict()
      .default({ maxMinutes: 10 }),
    priority: z.enum(['interactive', 'user-blocking', 'normal', 'background']).default('normal'),
    requiredResources: z.array(id).max(64).default([]),
    mayAskUser: z.boolean().default(true),
    networkRequired: z.boolean().default(false),
    approvalPolicy: z.literal('host').default('host'),
    reuseFrom: z
      .object({
        revision: z.number().int().positive(),
        nodeId: id,
        resultHash: z.string().length(64),
      })
      .strict()
      .optional(),
  })
  .strict();
export const DependencyEdge = z
  .object({
    from: id,
    to: id,
    condition: z.enum(['success', 'completed', 'artifact']),
    groupId: id,
    mode: z.enum(['all', 'any']).default('all'),
    artifactRefs: z.array(ArtifactRef).max(64).default([]),
  })
  .strict();
export const AgentPlan = z
  .object({
    id,
    workId: id,
    planRevision: z.number().int().positive().default(1),
    goal: z.string().trim().min(1).max(12000),
    scope: z.string().max(6000).default(''),
    nodes: z.array(AgentNode).min(1).max(64),
    edges: z.array(DependencyEdge).max(256).default([]),
    budgetMode: z.enum(['observe', 'enforce']).default('observe'),
    budget: z
      .object({
        inputTokens: tokens.optional(),
        outputTokens: tokens.optional(),
        totalMinutes: z.number().positive().optional(),
      })
      .strict()
      .default({}),
    deadline: z.number().int().positive().nullable().default(null),
    permissions: z.array(z.string().max(200)).max(64).default([]),
  })
  .strict();
export type Plan = z.infer<typeof AgentPlan>;
export type Node = z.infer<typeof AgentNode>;
export type Edge = z.infer<typeof DependencyEdge>;
export type NodeState =
  | 'blocked'
  | 'ready'
  | 'leased'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'admission_pending'
  | 'waiting_rate_limit'
  | 'waiting_resource'
  | 'waiting_user'
  | 'retry_wait'
  | 'stopping'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'skipped';
export type PlanState =
  | 'draft'
  | 'validated'
  | 'queued'
  | 'running'
  | 'reducing'
  | 'review'
  | 'completed'
  | 'needs_input'
  | 'pausing'
  | 'paused'
  | 'cancel_requested'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'unknown';
export const finished = new Set<NodeState>(['succeeded', 'failed', 'cancelled', 'skipped']);
export const occupying = new Set<NodeState>([
  'leased',
  'starting',
  'running',
  'stopping',
  'unknown',
]);

// Canonical hashes bind confirmation and reuse to content, not object key order.
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
export function validatePlan(input: unknown): Plan {
  const p = AgentPlan.parse(input),
    nodes = new Map(p.nodes.map((n) => [n.id, n]));
  if (nodes.size !== p.nodes.length) throw Error('DUPLICATE_NODE');
  const incoming = new Map<string, number>(),
    outgoing = new Map<string, string[]>(),
    groups = new Map<string, string>(),
    seen = new Set<string>();
  for (const e of p.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to) throw Error('INVALID_EDGE');
    const key = stable(e);
    if (seen.has(key)) throw Error('DUPLICATE_EDGE');
    seen.add(key);
    if (e.condition === 'artifact' && !e.artifactRefs.length) throw Error('ARTIFACT_REQUIRED');
    const group = e.to + '/' + e.groupId;
    if (groups.has(group) && groups.get(group) !== e.mode) throw Error('GROUP_MODE_MISMATCH');
    groups.set(group, e.mode);
    incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
    outgoing.set(e.from, [...(outgoing.get(e.from) || []), e.to]);
    if (incoming.get(e.to)! > 32 || outgoing.get(e.from)!.length > 16) throw Error('EDGE_LIMIT');
  }
  const roots = p.nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  let count = 0;
  while (roots.length) {
    const n = roots.shift()!;
    count++;
    for (const to of outgoing.get(n) || []) {
      incoming.set(to, incoming.get(to)! - 1);
      if (!incoming.get(to)) roots.push(to);
    }
  }
  if (count !== nodes.size) throw Error('DEPENDENCY_CYCLE');
  return p;
}
export type DependencyResult = { state: NodeState; artifacts?: z.infer<typeof ArtifactRef>[] };
export function dependencyState(
  nodeId: string,
  edges: Edge[],
  states: Map<string, DependencyResult>,
): 'ready' | 'blocked' | 'skipped' {
  const groups = new Map<string, { mode: Edge['mode']; values: ('yes' | 'no' | 'wait')[] }>();
  for (const e of edges.filter((e) => e.to === nodeId)) {
    const source = states.get(e.from);
    let value: 'yes' | 'no' | 'wait' = 'wait';
    if (source && finished.has(source.state)) {
      value =
        e.condition === 'completed'
          ? 'yes'
          : source.state !== 'succeeded'
            ? 'no'
            : e.condition === 'success'
              ? 'yes'
              : e.artifactRefs.every((r) =>
                    source.artifacts?.some(
                      (a) => a.objectId === r.objectId && a.revision === r.revision,
                    ),
                  )
                ? 'yes'
                : 'no';
    }
    const group = groups.get(e.groupId) || { mode: e.mode, values: [] };
    group.values.push(value);
    groups.set(e.groupId, group);
  }
  let waiting = false;
  for (const { mode, values } of groups.values()) {
    if (
      (mode === 'all' && values.includes('no')) ||
      (mode === 'any' && values.every((v) => v === 'no'))
    )
      return 'skipped';
    if (
      (mode === 'all' && values.some((v) => v !== 'yes')) ||
      (mode === 'any' && !values.includes('yes'))
    )
      waiting = true;
  }
  return waiting ? 'blocked' : 'ready';
}
export function timeLimits(p: Plan) {
  const S = p.nodes.reduce((s, n) => s + n.budget.maxMinutes, 10),
    Q = p.nodes.filter((n) => n.mayAskUser).length;
  return { S, R: Math.max(Math.ceil(0.2 * S), 20), H: 10 * Q + 20, Q };
}
export function estimateSchedule(p: Plan): number | null {
  // Unknown conditional/failed branches have no honest finish-time estimate.
  if (p.edges.some((e) => e.mode === 'any' || e.condition !== 'success')) return null;
  const done = new Set<string>(),
    running: { id: string; end: number; resources: string[] }[] = [];
  let time = 0;
  while (done.size < p.nodes.length) {
    const held = new Set(running.flatMap((n) => n.resources));
    for (const n of p.nodes) {
      if (running.length >= 3) break;
      if (
        done.has(n.id) ||
        running.some((r) => r.id === n.id) ||
        p.edges.some((e) => e.to === n.id && !done.has(e.from)) ||
        n.requiredResources.some((r) => held.has(r))
      )
        continue;
      running.push({ id: n.id, end: time + n.budget.maxMinutes, resources: n.requiredResources });
      n.requiredResources.forEach((r) => held.add(r));
    }
    if (!running.length) return null;
    time = Math.min(...running.map((n) => n.end));
    for (let i = running.length - 1; i >= 0; i--)
      if (running[i]!.end === time) {
        done.add(running[i]!.id);
        running.splice(i, 1);
      }
  }
  return 10 + time;
}
export function legacyPlan({
  id: planId,
  workId,
  goal,
  jobs,
  model,
}: {
  id: string;
  workId: string;
  goal: string;
  jobs: { title: string; instructions: string; after: number[] }[];
  model: Node['modelProfile'];
}): Plan {
  if (
    jobs.length < 2 ||
    jobs.length > 4 ||
    jobs.some((j, i) => j.after.some((n) => n < 0 || n >= i))
  )
    throw Error('INVALID_LEGACY_JOBS');
  return validatePlan({
    id: planId,
    workId,
    goal,
    budgetMode: 'observe',
    nodes: [
      ...jobs.map((j, i) => ({
        id: 'worker-' + i,
        type: 'research',
        title: j.title,
        instructions: j.instructions,
        acceptance: '提供来源和完整分析',
        modelProfile: model,
      })),
      {
        id: 'reduce',
        type: 'reduce',
        title: '汇总',
        instructions: goal,
        acceptance: '列明参与、失败、跳过的节点及来源、冲突和下一步',
        modelProfile: model,
      },
    ],
    edges: [
      ...jobs.flatMap((j, i) =>
        j.after.map((n) => ({
          from: 'worker-' + n,
          to: 'worker-' + i,
          condition: 'success',
          groupId: 'inputs',
        })),
      ),
      ...jobs.map((_, i) => ({
        from: 'worker-' + i,
        to: 'reduce',
        condition: 'completed',
        groupId: 'results',
      })),
    ],
  });
}
