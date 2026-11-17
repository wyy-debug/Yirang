// Results for the agent pool: result envelope lookup by node, the durable
// result commit path (finish) and followup inbox messages. Owns the result
// schemas shared with callers.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ArtifactRef, finished, hash, occupying } from './agent-plan.js';
import type { Usage } from './agent-queue.js';
import { check, type AgentPoolRecordsMethods, type Inbox } from './agent-pool-records.js';
import type { AgentPoolMaterialsMethods } from './agent-pool-materials.js';
import type { AgentPoolLeaseMethods } from './agent-pool-leases.js';
import type { AgentPoolDispatchMethods } from './agent-pool-dispatch.js';
import type { Api, Lease, NodeRecord, PlanRecord } from './agent-pool.js';

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const ResultCandidate = z
  .object({
    summary: z.string().max(50000),
    evidence: z.array(ArtifactRef).max(128).default([]),
    warnings: z.array(z.string().max(2000)).max(64).default([]),
    conflicts: z.array(z.string().max(2000)).max(64).default([]),
    next: z.array(z.string().max(2000)).max(64).default([]),
    question: z
      .object({ text: z.string().trim().min(1).max(1200) })
      .strict()
      .nullable()
      .default(null),
    handled: z
      .array(
        z
          .object({
            messageId: z.string(),
            outcome: z.enum(['acted', 'answered', 'no_action', 'returned']),
            reason: z.string().max(2000),
          })
          .strict(),
      )
      .max(128)
      .default([]),
  })
  .strict();
export type ResultEnvelope = {
  planId: string;
  planRevision: number;
  nodeId: string;
  attempt: number;
  dispatchKey: string;
  state: string;
  resultHash: string;
  summary: string;
  evidence: z.infer<typeof ArtifactRef>[];
  artifacts: z.infer<typeof ArtifactRef>[];
  warnings: string[];
  conflicts: string[];
  next: string[];
  usage: Usage | null;
  durationMs: number;
  participants: string[];
  failed: string[];
  skipped: string[];
};

/** The AgentPoolStore surface the result cluster relies on. */
export type AgentPoolResultsHost = {
  db: DatabaseSync;
  clock: () => number;
  api: Pick<Api, 'object'>;
  stop(w: string, p: PlanRecord): void;
} & Pick<AgentPoolRecordsMethods, 'tx' | 'lease' | 'plan' | 'node' | 'inbox' | 'saveMessage' | 'saveNode' | 'save' | 'event' | 'leases' | 'current'> &
  Pick<AgentPoolMaterialsMethods, 'settle' | 'overBudget'> &
  Pick<AgentPoolDispatchMethods, 'enqueue' | 'refresh'> &
  Pick<AgentPoolLeaseMethods, 'release'>;

export interface AgentPoolResultsMethods {
  resultFor(w: string, p: PlanRecord, n: NodeRecord): ResultEnvelope | undefined;
  finish(
    key: string,
    turnId: string,
    status: 'completed' | 'failed' | 'interrupted',
    candidate: unknown,
    usage?: Usage | null,
    retryable?: boolean,
  ): any;
  followup(
    w: string,
    id: string,
    input: {
      messageId: string;
      nodeId: string;
      questionId?: string;
      text: string;
      structuredChange?: boolean;
    },
  ): Inbox;
}

export const agentPoolResults: AgentPoolResultsMethods &
  ThisType<AgentPoolResultsHost & AgentPoolResultsMethods> = {
  resultFor(w: string, p: PlanRecord, n: NodeRecord): ResultEnvelope | undefined {
    if (!n.resultHash) return;
    const r = this.db
      .prepare('SELECT body FROM agent_results WHERE result_hash=? AND adopted=1')
      .all(n.resultHash) as { body: string }[];
    return r
      .map((r) => JSON.parse(r.body) as ResultEnvelope)
      .find(
        (r) =>
          r.planId === p.spec.id &&
          r.planRevision === p.spec.planRevision &&
          r.nodeId === n.spec.id,
      );
  },
  finish(
    key: string,
    turnId: string,
    status: 'completed' | 'failed' | 'interrupted',
    candidate: unknown,
    usage: Usage | null = null,
    retryable = false,
  ) {
    return this.tx(() => {
      check(['completed', 'failed', 'interrupted'].includes(status), 'TERMINAL_REQUIRED');
      const parsed = status === 'completed' ? ResultCandidate.parse(candidate) : null;
      const resultHash = hash({ status, candidate: parsed }),
        commitKey = key + '/result-v1';
      const previous = this.db
        .prepare('SELECT * FROM agent_results WHERE commit_key=?')
        .get(commitKey) as { result_hash: string; body: string } | undefined;
      if (previous) {
        if (previous.result_hash !== resultHash) return { conflict: true, commitKey };
        return JSON.parse(previous.body);
      }
      const l = this.lease(key);
      check(l.turnId === turnId, 'TERMINAL_IDENTITY_REQUIRED');
      const p = this.plan(l.workspace, l.planId, l.revision),
        latest = this.plan(l.workspace, l.planId),
        n = this.node(l.workspace, p, l.nodeId);
      const measured = usage === null ? null : usageSchema.parse(usage);
      check(
        !measured ||
          measured.inputTokens === null ||
          measured.cachedInputTokens === null ||
          measured.cachedInputTokens <= measured.inputTokens,
        'INVALID_CACHE_USAGE',
      );
      this.settle(latest, l, measured);
      if (this.overBudget(latest)) {
        latest.state = 'needs_input';
        latest.reason = '实际用量超出预算，全部回合停止，产物隔离';
        this.stop(l.workspace, latest);
      }
      let adopted = this.current(l) && !latest.frozen;
      if (parsed && adopted)
        for (const r of parsed.evidence) {
          const allowed =
            n.spec.inputRefs.some((a) => a.objectId === r.objectId && a.revision === r.revision) ||
            p.spec.edges
              .filter((e) => e.to === n.spec.id)
              .some((e) =>
                this.resultFor(l.workspace, p, this.node(l.workspace, p, e.from))?.evidence.some(
                  (a) => a.objectId === r.objectId && a.revision === r.revision,
                ),
              );
          check(allowed && this.api.object, 'EVIDENCE_OUT_OF_SCOPE');
          const o = this.api.object(l.workspace, r.objectId);
          check(!o.archived && !o.policy?.private && o.revision === r.revision, 'INVALID_EVIDENCE');
        }
      const sources = p.spec.edges
        .filter((e) => e.to === n.spec.id)
        .map((e) => this.node(l.workspace, p, e.from));
      const envelope: ResultEnvelope = {
        planId: l.planId,
        planRevision: l.revision,
        nodeId: l.nodeId,
        attempt: l.attempt,
        dispatchKey: key,
        state: status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : 'cancelled',
        resultHash,
        summary: parsed?.summary || '',
        evidence: parsed?.evidence || [],
        artifacts: [],
        warnings: parsed?.warnings || [],
        conflicts: parsed?.conflicts || [],
        next: parsed?.next || [],
        usage: measured,
        durationMs: l.sentAt === null ? 0 : this.clock() - l.sentAt,
        participants: [
          ...new Set(sources.filter((n) => n.state === 'succeeded').map((n) => n.spec.id)),
        ],
        failed: [...new Set(sources.filter((n) => n.state === 'failed').map((n) => n.spec.id))],
        skipped: [
          ...new Set(
            sources
              .filter((n) => n.state === 'skipped' || n.state === 'cancelled')
              .map((n) => n.spec.id),
          ),
        ],
      };
      this.release(l);
      if (adopted && parsed) {
        for (const receipt of parsed.handled) {
          const m = this.inbox(l.workspace, l.planId).find(
            (m) => m.messageId === receipt.messageId,
          );
          check(
            m &&
              m.ownerGeneration <= l.generation &&
              m.planRevision === l.revision &&
              m.submitted?.dispatchKey === key &&
              m.submitted.turnId === turnId,
            'MESSAGE_NOT_SUBMITTED',
          );
          check(
            !m.structuredChange || receipt.outcome === 'returned',
            'REQUIREMENTS_REVISION_REQUIRED',
          );
          m.handled = { ...receipt, resultHash };
          this.saveMessage(l.workspace, l.planId, m);
        }
        const missing = this.inbox(l.workspace, l.planId).filter(
          (m) => m.planRevision === l.revision && m.nodeId === l.nodeId && !m.handled,
        );
        if (missing.length) {
          adopted = false;
          if (missing.every((m) => m.autoContinues < 1)) {
            for (const m of missing) {
              m.autoContinues++;
              this.saveMessage(l.workspace, l.planId, m);
            }
            n.segment++;
            n.followupId = missing[0]!.messageId;
            n.state = 'ready';
            this.saveNode(l.workspace, p, n);
            this.enqueue(l.workspace, p, n);
          } else {
            n.state = 'paused';
            n.attention = '这条补充尚未处理';
            latest.state = 'needs_input';
            latest.reason = n.attention;
          }
        } else if (parsed.question) {
          n.question = { id: randomUUID(), text: parsed.question.text };
          n.state = 'waiting_user';
          n.reason = parsed.question.text;
          n.followupId = undefined;
        } else {
          n.state = 'succeeded';
          n.resultHash = resultHash;
          n.followupId = undefined;
          n.question = undefined;
        }
      } else if (adopted) {
        if (status === 'failed' && retryable && n.executionRetryCount < 2) {
          n.executionRetryCount++;
          n.attempt++;
          n.segment = 0;
          n.state = 'retry_wait';
          n.notBefore = this.clock() + 5000;
          this.saveNode(l.workspace, p, n);
          this.enqueue(l.workspace, p, n);
        } else {
          n.state = status === 'interrupted' ? 'paused' : 'failed';
          n.reason = '执行未完成';
        }
      } else if (!['ready', 'paused'].includes(n.state))
        n.state = latest.state === 'cancel_requested' ? 'cancelled' : 'paused';
      this.db
        .prepare('INSERT INTO agent_results VALUES(?,?,?,?)')
        .run(
          commitKey,
          resultHash,
          JSON.stringify(envelope),
          adopted && n.state === 'succeeded' ? 1 : 0,
        );
      this.saveNode(l.workspace, p, n);
      if (!this.leases().some((a) => a.workspace === l.workspace && a.planId === l.planId)) {
        if (latest.state === 'pausing') latest.state = 'paused';
        if (latest.state === 'cancel_requested') latest.state = 'cancelled';
      }
      if (['running', 'reducing'].includes(latest.state)) latest.state = 'queued';
      this.save(l.workspace, latest);
      this.event(l.workspace, p, 'result_committed', {
        commitKey,
        resultHash,
        adopted,
        state: n.state,
      });
      this.refresh(l.workspace, latest);
      return envelope;
    });
  },
  followup(
    w: string,
    id: string,
    input: {
      messageId: string;
      nodeId: string;
      questionId?: string;
      text: string;
      structuredChange?: boolean;
    },
  ) {
    return this.tx(() => {
      const p = this.plan(w, id),
        n = this.node(w, p, input.nodeId),
        existing = this.inbox(w, id).find((m) => m.messageId === input.messageId);
      if (existing) {
        check(existing.text === input.text && existing.nodeId === input.nodeId, 'MESSAGE_REUSED');
        return existing;
      }
      check(!['completed', 'cancelled'].includes(p.state), 'NEW_REVISION_REQUIRED');
      check(!input.questionId || n.question?.id === input.questionId, 'QUESTION_STALE');
      const text = z.string().trim().min(1).max(12000).parse(input.text);
      const m: Inbox = {
        messageId: z.string().min(1).max(160).parse(input.messageId),
        sequence: (this.inbox(w, id).at(-1)?.sequence || 0) + 1,
        workId: p.spec.workId,
        planRevision: p.spec.planRevision,
        nodeId: input.nodeId,
        questionId: input.questionId,
        ownerGeneration: p.generation,
        text,
        savedAt: this.clock(),
        autoContinues: 0,
        structuredChange: input.structuredChange === true,
      };
      this.saveMessage(w, id, m);
      // An active segment ends before the answer gets a new dispatch identity;
      // nothing is replayed to guess delivery.
      if (!occupying.has(n.state) && !finished.has(n.state)) {
        n.followupId = m.messageId;
        n.segment++;
        n.state = 'ready';
        this.saveNode(w, p, n);
        this.enqueue(w, p, n);
      }
      this.event(w, p, 'followup_saved', { messageId: m.messageId, sequence: m.sequence });
      return m;
    });
  }
};
