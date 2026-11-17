// Material context and budget accounting for the agent pool: input text
// extraction, pending materials, context fitting under the token limit,
// capacity reservations and ledger settlement.
import type { DatabaseSync } from 'node:sqlite';
import { finished, timeLimits, type Node, type NodeState, type Plan } from './agent-plan.js';
import type { Usage } from './agent-queue.js';
import { check, type AgentPoolRecordsMethods } from './agent-pool-records.js';
import type { ResultEnvelope, AgentPoolResultsMethods } from './agent-pool-results.js';
import type { Api, Lease, NodeRecord, PlanRecord } from './agent-pool.js';

const CONTEXT_LIMIT = 96000,
  jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
function fitText(s: string, max: number) {
  if (jsonBytes(s) <= max) return s;
  let lo = 0,
    hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** Assembled execution context for one node, fitted to the context limit. */
export type AgentPoolContext = {
  planId: string;
  revision: number;
  goal: Plan['goal'];
  scope: Plan['scope'];
  node: Node;
  question?: NodeRecord['question'];
  inputs: {
    objectId: string;
    revision: number;
    title: string;
    text: string;
    truncated: boolean;
    totalChars: number;
    includedChars: number;
  }[];
  dependencies: {
    nodeId: string;
    state: NodeState;
    reason: string;
    result?: ResultEnvelope;
    truncated: boolean;
  }[];
  messages: { messageId: string; questionId?: string; text: string }[];
  materialNote?: string;
};

/** The AgentPoolStore surface the material cluster relies on. */
export type AgentPoolMaterialsHost = {
  db: DatabaseSync;
  clock: () => number;
  api: Pick<Api, 'object' | 'text'>;
} & Pick<AgentPoolRecordsMethods, 'plan' | 'node' | 'inbox' | 'leases' | 'save'> &
  Pick<AgentPoolResultsMethods, 'resultFor'>;

export interface AgentPoolMaterialsMethods {
  reservations(p: PlanRecord, w: string): Lease['reservation'][];
  reserve(w: string, p: PlanRecord, n: NodeRecord): Lease['reservation'] | null;
  inputText(
    w: string,
    r: { objectId: string; revision: number },
  ): { objectId: string; revision: number; title: string; text: string } | null;
  pendingMaterials(w: string): { objectId: string; revision: number }[];
  context(w: string, p: PlanRecord, n: NodeRecord): AgentPoolContext;
  settle(p: PlanRecord, l: Lease, usage: Usage | null): void;
  overBudget(p: PlanRecord): boolean;
}

export const agentPoolMaterials: AgentPoolMaterialsMethods &
  ThisType<AgentPoolMaterialsHost & AgentPoolMaterialsMethods> = {
  reservations(p: PlanRecord, w: string) {
    return this.leases()
      .filter((l) => l.workspace === w && l.planId === p.spec.id)
      .map((l) => l.reservation);
  },
  reserve(w: string, p: PlanRecord, n: NodeRecord): Lease['reservation'] | null {
    const followup = !!n.followupId,
      pool: 'S' | 'R' | 'H' = followup ? 'H' : n.attempt > 0 ? 'R' : 'S',
      limits = timeLimits(p.spec),
      others = this.reservations(p, w);
    const firstAnswer = followup && !!n.question && !p.ledger.firstAnswers.includes(n.spec.id);
    const minutes = n.spec.budget.maxMinutes,
      inputTokens = Buffer.byteLength(JSON.stringify(this.context(w, p, n)), 'utf8') * 2 + 16000,
      outputTokens = 4000;
    const reserved = (field: 'inputTokens' | 'outputTokens') =>
      others.reduce((sum, r) => sum + r[field], 0);
    const explicit = p.spec.budget;
    // Unused first-answer reservations stay protected from other continuations.
    const protectedMinutes =
      pool === 'H' && !firstAnswer
        ? Math.max(
            0,
            limits.Q - p.ledger.firstAnswers.length - others.filter((r) => r.firstAnswer).length,
          ) * 10
        : 0;
    if (
      p.ledger[pool] +
        others.filter((r) => r.pool === pool).reduce((s, r) => s + r.minutes, 0) +
        minutes >
        limits[pool] - protectedMinutes ||
      (explicit.totalMinutes !== undefined &&
        p.ledger.S + p.ledger.R + p.ledger.H + others.reduce((s, r) => s + r.minutes, 0) + minutes >
          explicit.totalMinutes) ||
      (p.spec.budgetMode === 'enforce' &&
        ((explicit.inputTokens !== undefined &&
          p.ledger.inputTokens + reserved('inputTokens') + inputTokens > explicit.inputTokens) ||
          (explicit.outputTokens !== undefined &&
            p.ledger.outputTokens + reserved('outputTokens') + outputTokens >
              explicit.outputTokens) ||
          (n.spec.budget.inputTokens !== undefined && inputTokens > n.spec.budget.inputTokens) ||
          (n.spec.budget.outputTokens !== undefined && outputTokens > n.spec.budget.outputTokens)))
    ) {
      p.state = 'needs_input';
      p.frozen = true;
      p.reason = '预算不足，请缩小范围、扩大对应预算或取消';
      this.save(w, p);
      return null;
    }
    return { inputTokens, outputTokens, minutes, pool, firstAnswer };
  },
  inputText(w: string, r: { objectId: string; revision: number }) {
    check(this.api.object, 'MATERIAL_READER_UNAVAILABLE');
    const o = this.api.object(w, r.objectId);
    check(!o.archived && !o.policy?.private && o.revision === r.revision, 'STALE_INPUT');
    const text = this.api.text
      ? this.api.text(w, r.objectId, r.revision)
      : typeof o.content === 'string'
        ? o.content
        : JSON.stringify(o.content);
    return text === null
      ? null
      : { objectId: r.objectId, revision: r.revision, title: o.title || r.objectId, text };
  },
  /** Inputs of queued nodes whose current-revision text the host still has to extract. */
  pendingMaterials(w: string) {
    const out = new Map<string, { objectId: string; revision: number }>();
    for (const q of this.db
      .prepare('SELECT plan_id,revision,node_id FROM agent_queue WHERE workspace=?')
      .all(w) as { plan_id: string; revision: number; node_id: string }[]) {
      const p = this.plan(w, q.plan_id, q.revision),
        n = this.node(w, p, q.node_id);
      for (const r of n.spec.inputRefs) {
        try {
          if (this.inputText(w, r) === null)
            out.set(r.objectId + '@' + r.revision, { objectId: r.objectId, revision: r.revision });
        } catch {}
      }
    }
    return [...out.values()];
  },
  context(w: string, p: PlanRecord, n: NodeRecord) {
    const texts = n.spec.inputRefs.map((r) => this.inputText(w, r));
    check(
      texts.every((t) => t !== null),
      'MATERIAL_NOT_READY',
    );
    const dependencies = p.spec.edges
      .filter((e) => e.to === n.spec.id)
      .map((e) => this.node(w, p, e.from))
      .filter((n) => finished.has(n.state))
      .map((n) => ({
        nodeId: n.spec.id,
        state: n.state,
        reason: n.reason,
        result: this.resultFor(w, p, n),
      }));
    const messages = this.inbox(w, p.spec.id)
      .filter((m) => m.planRevision === p.spec.planRevision && m.nodeId === n.spec.id && !m.handled)
      .map((m) => ({ messageId: m.messageId, questionId: m.questionId, text: m.text }));
    // Material text and dependency summaries share what is left after the fixed parts; the smallest pieces stay whole and the rest are cut evenly.
    const pieces = [
      ...texts.map((t) => t!.text),
      ...dependencies.map((d) => d.result?.summary ?? ''),
    ];
    const shell = {
      planId: p.spec.id,
      revision: p.spec.planRevision,
      goal: p.spec.goal,
      scope: p.spec.scope,
      node: n.spec,
      question: n.question,
      inputs: texts.map((t) => ({
        ...t!,
        text: '',
        truncated: false,
        totalChars: 0,
        includedChars: 0,
      })),
      dependencies: dependencies.map((d) => ({
        ...d,
        result: d.result && { ...d.result, summary: '' },
        truncated: false,
      })),
      messages,
      materialNote: 'x'.repeat(200),
    };
    let remaining = CONTEXT_LIMIT - jsonBytes(shell) - 512;
    check(remaining >= 0, 'CONTEXT_TOO_LARGE');
    const fitted: string[] = new Array(pieces.length);
    pieces
      .map((s, i) => ({ i, size: jsonBytes(s) }))
      .sort((a, b) => a.size - b.size)
      .forEach(({ i }, k, all) => {
        fitted[i] = fitText(pieces[i]!, Math.floor(remaining / (all.length - k)));
        remaining -= jsonBytes(fitted[i]);
      });
    const inputs = texts.map((t, i) => ({
      ...t!,
      text: fitted[i]!,
      truncated: fitted[i]!.length < t!.text.length,
      totalChars: t!.text.length,
      includedChars: fitted[i]!.length,
    }));
    const deps = dependencies.map((d, i) => {
      const s = fitted[texts.length + i]!;
      return {
        ...d,
        result: d.result && { ...d.result, summary: s },
        truncated: !!d.result && s.length < d.result.summary.length,
      };
    });
    const cut = inputs.some((i) => i.truncated) || deps.some((d) => d.truncated);
    return {
      planId: p.spec.id,
      revision: p.spec.planRevision,
      goal: p.spec.goal,
      scope: p.spec.scope,
      node: n.spec,
      question: n.question,
      inputs,
      dependencies: deps,
      messages,
      ...(cut
        ? {
            materialNote:
              '部分材料或前序结果因上下文上限只给出开头（truncated=true，includedChars/totalChars 为已给/全部字数）。只依据已给内容作答并在 warnings 注明；若缺少的部分会改变结论，请在 question 中说明需要哪一部分。',
          }
        : {}),
    };
  },
  settle(p: PlanRecord, l: Lease, usage: Usage | null) {
    if (l.sentAt !== null) p.ledger[l.reservation.pool] += (this.clock() - l.sentAt) / 60000;
    if (l.reservation.firstAnswer && !p.ledger.firstAnswers.includes(l.nodeId))
      p.ledger.firstAnswers.push(l.nodeId);
    if (usage?.inputTokens != null) p.ledger.inputTokens += usage.inputTokens;
    else p.ledger.missingUsage = true;
    if (usage?.outputTokens != null) p.ledger.outputTokens += usage.outputTokens;
    else p.ledger.missingUsage = true;
  },
  overBudget(p: PlanRecord) {
    return (
      p.spec.budgetMode === 'enforce' &&
      ((p.spec.budget.inputTokens !== undefined &&
        p.ledger.inputTokens > p.spec.budget.inputTokens) ||
        (p.spec.budget.outputTokens !== undefined &&
          p.ledger.outputTokens > p.spec.budget.outputTokens))
    );
  }
};
