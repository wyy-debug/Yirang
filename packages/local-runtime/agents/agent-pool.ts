import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentEvents } from './agent-events.js';
import {
  ArtifactRef,
  dependencyState,
  finished,
  hash,
  occupying,
  timeLimits,
  validatePlan,
  estimateSchedule,
  type Plan,
  type Node,
  type NodeState,
  type PlanState,
} from './agent-plan.js';
import {
  classifyError,
  priorityRank,
  userPhase,
  type ErrorEvidence,
  type Usage,
} from './agent-queue.js';

import {
  agentPoolRecords,
  check,
  type AgentPoolRecordsMethods,
} from './agent-pool-records.js';
import { agentPoolMaterials, type AgentPoolMaterialsMethods } from './agent-pool-materials.js';
import { agentPoolDispatch, type AgentPoolDispatchMethods } from './agent-pool-dispatch.js';
import { agentPoolLeases, type AgentPoolLeaseMethods } from './agent-pool-leases.js';
import { agentPoolResults, type AgentPoolResultsMethods } from './agent-pool-results.js';
export { ResultCandidate } from './agent-pool-results.js';
export type { ResultEnvelope } from './agent-pool-results.js';

type Ledger = {
  S: number;
  R: number;
  H: number;
  inputTokens: number;
  outputTokens: number;
  missingUsage: boolean;
  firstAnswers: string[];
};
export type PlanRecord = {
  spec: Plan;
  state: PlanState;
  generation: number;
  frozen: boolean;
  reason: string;
  createdAt: number;
  updatedAt: number;
  confirmationHash: string;
  confirmedHash: string | null;
  ledger: Ledger;
};
export type NodeRecord = {
  spec: Node;
  state: NodeState;
  attempt: number;
  segment: number;
  executionRetryCount: number;
  rateLimitRejectCount: number;
  createdAt: number;
  notBefore: number;
  reason: string;
  attention?: string;
  question?: { id: string; text: string };
  followupId?: string;
  resultHash?: string;
  guard?: {
    activityAt: number;
    progressAt: number;
    toolActive: boolean;
    thinking: boolean;
    failureHash?: string;
    failures: number;
    uncertain: boolean;
  };
};
export type Lease = {
  dispatchKey: string;
  workspace: string;
  planId: string;
  revision: number;
  nodeId: string;
  attempt: number;
  segment: number;
  generation: number;
  state: 'leased' | 'sending' | 'running' | 'stopping' | 'unknown';
  threadId: string | null;
  turnId: string | null;
  createdAt: number;
  sentAt: number | null;
  expires: number;
  stopAt: number | null;
  followupId?: string;
  reservation: {
    inputTokens: number;
    outputTokens: number;
    minutes: number;
    pool: 'S' | 'R' | 'H';
    firstAnswer: boolean;
  };
  usage: Usage | null;
};
export type Api = {
  object?: (
    w: string,
    id: string,
  ) => {
    revision: number;
    title?: string;
    archived?: boolean;
    policy?: { private?: boolean };
    content: unknown;
  };
  text?: (w: string, id: string, revision: number) => string | null;
  now?: () => number;
};

const emptyLedger = (): Ledger => ({
  S: 0,
  R: 0,
  H: 0,
  inputTokens: 0,
  outputTokens: 0,
  missingUsage: false,
  firstAnswers: [],
});

// All mutations (queue admission, slot acquisition, outbox) share the host
// SQLite transaction. Sending is a separate durable boundary.
export class AgentPoolStore {
  readonly events: AgentEvents;
  clock: () => number;
  constructor(
    public readonly db: DatabaseSync,
    public readonly api: Api = {},
  ) {
    this.clock = api.now || Date.now;
    db.exec(`
   CREATE TABLE IF NOT EXISTS agent_plans(workspace TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,id,revision));
   CREATE TABLE IF NOT EXISTS agent_nodes(workspace TEXT NOT NULL,plan_id TEXT NOT NULL,revision INTEGER NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,plan_id,revision,id));
   CREATE TABLE IF NOT EXISTS agent_queue(dispatch_key TEXT PRIMARY KEY,workspace TEXT NOT NULL,plan_id TEXT NOT NULL,revision INTEGER NOT NULL,node_id TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_leases(dispatch_key TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_results(commit_key TEXT PRIMARY KEY,result_hash TEXT NOT NULL,body TEXT NOT NULL,adopted INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_inbox(workspace TEXT NOT NULL,plan_id TEXT NOT NULL,message_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,plan_id,message_id),UNIQUE(workspace,plan_id,sequence));
   CREATE TABLE IF NOT EXISTS agent_resources(resource TEXT PRIMARY KEY,dispatch_key TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_accounts(id TEXT PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_requests(workspace TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,id));
   CREATE TABLE IF NOT EXISTS bot_slots(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,role TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'turn',request_id TEXT);
   CREATE TABLE IF NOT EXISTS work_runs(workspace TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT,state TEXT NOT NULL,PRIMARY KEY(workspace,id));
   CREATE INDEX IF NOT EXISTS agent_queue_plan ON agent_queue(workspace,plan_id,revision);
  `);
    if (
      (db.prepare('PRAGMA table_info(bot_slots)').all() as { name: string }[]).some(
        (c) => c.name === 'kind',
      )
    )
      db.exec(
        "UPDATE bot_slots SET kind='pool' WHERE kind<>'pool' AND id IN (SELECT dispatch_key FROM agent_leases)",
      );
    this.events = new AgentEvents(db);
  }
  list(w: string) {
    const rows = this.db
      .prepare(
        'SELECT p.body FROM agent_plans p WHERE workspace=? AND revision=(SELECT MAX(revision) FROM agent_plans q WHERE q.workspace=p.workspace AND q.id=p.id)',
      )
      .all(w) as { body: string }[];
    return rows.map((r) => {
      const p = JSON.parse(r.body) as PlanRecord,
        nodes = this.nodes(w, p);
      return {
        ...p,
        phase: userPhase(
          {
            state: p.state,
            confirmationRequired: p.spec.nodes.length > 8,
            confirmed: p.confirmedHash === p.confirmationHash,
          },
          nodes,
        ),
        nodes,
        limits: timeLimits(p.spec),
        estimateMinutes: estimateSchedule(p.spec),
      };
    });
  }
  create(w: string, input: unknown, requestId: string) {
    return this.tx(() => {
      const spec = validatePlan(input),
        old = this.db
          .prepare('SELECT body FROM agent_requests WHERE workspace=? AND id=?')
          .get(w, requestId) as { body: string } | undefined;
      if (old) {
        const previous = JSON.parse(old.body);
        check(previous.hash === hash(spec), 'REQUEST_REUSED');
        return previous.result;
      }
      check(
        !this.db.prepare('SELECT 1 FROM agent_plans WHERE workspace=? AND id=?').get(w, spec.id),
        'PLAN_EXISTS',
      );
      check(spec.planRevision === 1, 'INITIAL_REVISION_REQUIRED');
      const unfinished = (
        this.db.prepare('SELECT body FROM agent_nodes').all() as { body: string }[]
      ).filter((r) => !finished.has(JSON.parse(r.body).state)).length;
      if (unfinished + spec.nodes.length > 1024) {
        const result = { admitted: false, reason: '尚未安排：未结束节点已到上限', planId: null };
        this.db
          .prepare('INSERT INTO agent_requests VALUES(?,?,?)')
          .run(w, requestId, JSON.stringify({ hash: hash(spec), input: spec, result }));
        return result;
      }
      const large = spec.nodes.length > 8;
      const p: PlanRecord = {
        spec,
        state: large ? 'draft' : 'queued',
        generation: 1,
        frozen: false,
        reason: large ? '请确认计划规模与用量不确定性' : '已保存，等待执行',
        createdAt: this.clock(),
        updatedAt: this.clock(),
        confirmationHash: hash(spec),
        confirmedHash: null,
        ledger: emptyLedger(),
      };
      if (spec.nodes.some((n) => n.networkRequired)) {
        p.state = 'needs_input';
        p.reason = '联网研究尚未放行，请提供本地材料';
      }
      this.save(w, p);
      for (const n of spec.nodes)
        this.saveNode(w, p, {
          spec: n,
          state: 'blocked',
          attempt: 0,
          segment: 0,
          executionRetryCount: 0,
          rateLimitRejectCount: 0,
          createdAt: this.clock(),
          notBefore: 0,
          reason: '等待依赖',
        });
      this.event(w, p, 'plan_created', { requestId, hash: p.confirmationHash });
      this.refresh(w, p);
      const result = { admitted: true, planId: spec.id };
      this.db
        .prepare('INSERT INTO agent_requests VALUES(?,?,?)')
        .run(w, requestId, JSON.stringify({ hash: hash(spec), result }));
      return result;
    });
  }
  confirm(w: string, id: string, confirmationHash: string) {
    return this.tx(() => {
      const p = this.plan(w, id);
      check(p.confirmationHash === confirmationHash, 'CONFIRMATION_STALE');
      check(!p.spec.nodes.some((n) => n.networkRequired), 'NETWORK_UNAVAILABLE');
      p.confirmedHash = confirmationHash;
      p.state = 'queued';
      p.frozen = false;
      p.reason = '计划已确认';
      this.save(w, p);
      this.event(w, p, 'plan_confirmed', { confirmationHash });
      this.refresh(w, p);
      return p;
    });
  }
  stop(w: string, p: PlanRecord) {
    p.frozen = true;
    for (const n of this.nodes(w, p)) {
      this.dropQueue(w, p, n);
      if (occupying.has(n.state) && n.state !== 'unknown') {
        n.state = 'stopping';
        this.saveNode(w, p, n);
      }
    }
    for (const l of this.leases().filter((l) => l.workspace === w && l.planId === p.spec.id)) {
      // Unknown leases stay unknown (never re-queued), but a known turn is still asked to stop.
      if (l.state === 'unknown') {
        if (l.turnId && l.stopAt === null) {
          l.stopAt = this.clock();
          this.saveLease(l);
        }
        continue;
      }
      if (l.sentAt === null) {
        this.release(l);
        const old = this.plan(w, l.planId, l.revision),
          n = this.node(w, old, l.nodeId);
        n.state = 'paused';
        this.saveNode(w, old, n);
      } else {
        l.state = 'stopping';
        l.stopAt ??= this.clock();
        this.saveLease(l);
      }
    }
    this.save(w, p);
  }
  control(w: string, id: string, action: 'pause' | 'resume' | 'cancel' | 'accept') {
    return this.tx(() => {
      const p = this.plan(w, id);
      if (action === 'accept') {
        check(
          p.state === 'review' &&
            !this.inbox(w, id).some((m) => !m.handled && m.planRevision === p.spec.planRevision),
          'REVIEW_NOT_READY',
        );
        p.state = 'completed';
        p.frozen = true;
        this.save(w, p);
      } else if (action === 'resume') {
        check(['paused', 'needs_input', 'interrupted'].includes(p.state), 'NOT_PAUSED');
        check(
          !this.leases().some((l) => l.workspace === w && l.planId === id),
          'EXECUTION_NOT_STOPPED',
        );
        check(
          p.spec.nodes.length <= 8 || p.confirmedHash === p.confirmationHash,
          'CONFIRMATION_REQUIRED',
        );
        p.frozen = false;
        p.state = 'queued';
        p.reason = '继续处理';
        this.save(w, p);
        for (const n of this.nodes(w, p).filter((n) => n.state === 'paused')) {
          n.state = 'blocked';
          n.segment++;
          n.attention = undefined;
          this.saveNode(w, p, n);
        }
        this.refresh(w, p);
      } else {
        check(!['completed', 'cancelled'].includes(p.state), 'PLAN_ENDED');
        p.generation++;
        p.state = action === 'pause' ? 'pausing' : 'cancel_requested';
        p.reason = action === 'pause' ? '已暂停' : '已取消';
        this.stop(w, p);
        for (const n of this.nodes(w, p).filter(
          (n) => !occupying.has(n.state) && !finished.has(n.state),
        )) {
          n.state = action === 'pause' ? 'paused' : 'cancelled';
          this.dropQueue(w, p, n);
          this.saveNode(w, p, n);
        }
        if (!this.leases().some((l) => l.workspace === w && l.planId === id)) {
          p.state = action === 'pause' ? 'paused' : 'cancelled';
          this.save(w, p);
        }
      }
      this.event(w, p, 'control', { action });
      return p;
    });
  }
  revise(w: string, id: string, input: unknown) {
    return this.tx(() => {
      const old = this.plan(w, id),
        spec = validatePlan(input);
      check(
        spec.id === id &&
          spec.workId === old.spec.workId &&
          spec.planRevision === old.spec.planRevision + 1,
        'REVISION_IDENTITY',
      );
      check(this.queueCount() < 256, 'EXPANSION_BACKPRESSURE');
      old.generation++;
      old.reason = '要求已修订';
      this.stop(w, old);
      const p: PlanRecord = {
        ...old,
        spec,
        state: spec.nodes.length > 8 ? 'draft' : 'queued',
        frozen: false,
        reason: '新版本已保存',
        confirmationHash: hash(spec),
        confirmedHash: null,
        ledger: structuredClone(old.ledger),
      };
      // Revisions share the original ledger; incrementing planRevision never resets budget.
      this.save(w, p);
      for (const specNode of spec.nodes) {
        const n: NodeRecord = {
          spec: specNode,
          state: 'blocked',
          attempt: 0,
          segment: 0,
          executionRetryCount: 0,
          rateLimitRejectCount: 0,
          createdAt: this.clock(),
          notBefore: 0,
          reason: '等待依赖',
        };
        if (specNode.reuseFrom) {
          const source = this.plan(w, id, specNode.reuseFrom.revision),
            sn = this.node(w, source, specNode.reuseFrom.nodeId);
          const fingerprint = (
            plan: PlanRecord,
            node: Node,
            deps: (from: string) => string | undefined,
          ) =>
            hash({
              spec: { ...node, reuseFrom: undefined },
              scope: plan.spec.scope,
              permissions: plan.spec.permissions,
              dependencies: plan.spec.edges
                .filter((e) => e.to === node.id)
                .map((e) => ({ edge: e, result: deps(e.from) })),
            });
          const sourceDeps = (from: string) => this.node(w, source, from).resultHash;
          const newDeps = (from: string) => {
            const reused = spec.nodes.find((x) => x.id === from)?.reuseFrom;
            return reused
              ? this.node(w, this.plan(w, id, reused.revision), reused.nodeId).resultHash
              : undefined;
          };
          check(
            sn.state === 'succeeded' &&
              sn.resultHash === specNode.reuseFrom.resultHash &&
              fingerprint(source, sn.spec, sourceDeps) === fingerprint(p, specNode, newDeps),
            'REUSE_FINGERPRINT_MISMATCH',
          );
          const original = this.resultFor(w, source, sn);
          check(original, 'REUSE_RESULT_MISSING');
          n.state = 'succeeded';
          n.resultHash = sn.resultHash;
          this.db
            .prepare('INSERT INTO agent_results VALUES(?,?,?,1)')
            .run(
              `${w}/${id}/${spec.planRevision}/${specNode.id}/reuse`,
              n.resultHash!,
              JSON.stringify({ ...original, planRevision: spec.planRevision, nodeId: specNode.id }),
            );
        }
        this.saveNode(w, p, n);
      }
      this.event(w, p, 'plan_revised', { previous: old.spec.planRevision });
      this.refresh(w, p);
      return p;
    });
  }
  detail(w: string, id: string) {
    const p = this.plan(w, id),
      nodes = this.nodes(w, p);
    return {
      ...p,
      phase: userPhase(
        {
          state: p.state,
          confirmationRequired: p.spec.nodes.length > 8,
          confirmed: p.confirmedHash === p.confirmationHash,
        },
        nodes,
      ),
      nodes,
      inbox: this.inbox(w, id),
      results: nodes.map((n) => this.resultFor(w, p, n)).filter(Boolean),
      events: this.events.read(w, id),
      limits: timeLimits(p.spec),
      estimateMinutes: estimateSchedule(p.spec),
    };
  }
}

// Record persistence lives in agent-pool-records.ts, material context and
// budget settlement in agent-pool-materials.ts, queue admission and dispatch
// in agent-pool-dispatch.ts, lease lifecycle in agent-pool-leases.ts, and
// result commit in agent-pool-results.ts; all share the class db/clock/api
// plumbing via these mixins.
export interface AgentPoolStore
  extends AgentPoolRecordsMethods,
    AgentPoolMaterialsMethods,
    AgentPoolDispatchMethods,
    AgentPoolLeaseMethods,
    AgentPoolResultsMethods {}
Object.assign(AgentPoolStore.prototype, agentPoolRecords);
Object.assign(AgentPoolStore.prototype, agentPoolMaterials);
Object.assign(AgentPoolStore.prototype, agentPoolDispatch);
Object.assign(AgentPoolStore.prototype, agentPoolLeases);
Object.assign(AgentPoolStore.prototype, agentPoolResults);
