// Record persistence and lookup for the agent pool: transactions, event
// appends, plan/node/lease save helpers and readers, queue-row deletion,
// inbox records and the shared assert helper.
import type { DatabaseSync } from 'node:sqlite';
import type { AgentEvents } from './agent-events.js';
import type { Lease, NodeRecord, PlanRecord } from './agent-pool.js';

/** The shared assert helper for pool invariants. */
export const check: (ok: unknown, code: string) => asserts ok = (ok, code) => {
  if (!ok) throw Error(code);
};


/** One queued user answer routed to a node. */
export type Inbox = {
  messageId: string;
  sequence: number;
  workId: string;
  planRevision: number;
  nodeId: string;
  questionId?: string;
  ownerGeneration: number;
  text: string;
  savedAt: number;
  submitted?: { turnId: string; dispatchKey: string; payloadHash: string };
  deliveries?: { turnId: string; dispatchKey: string; payloadHash: string; at: number }[];
  handled?: {
    outcome: 'acted' | 'answered' | 'no_action' | 'returned';
    reason: string;
    resultHash: string;
  };
  autoContinues: number;
  structuredChange: boolean;
};

/** The AgentPoolStore surface the record cluster relies on. */
export type AgentPoolRecordsHost = {
  db: DatabaseSync;
  events: AgentEvents;
  clock: () => number;
};

export interface AgentPoolRecordsMethods {
  tx<T>(fn: () => T): T;
  event(w: string, p: PlanRecord, type: string, body: unknown): void;
  save(w: string, p: PlanRecord): void;
  saveNode(w: string, p: PlanRecord, n: NodeRecord): void;
  saveLease(l: Lease): void;
  plan(w: string, id: string, revision?: number): PlanRecord;
  nodes(w: string, p: PlanRecord): NodeRecord[];
  leases(): Lease[];
  node(w: string, p: PlanRecord, id: string): NodeRecord;
  lease(key: string): Lease;
  current(l: Lease): boolean;
  queueCount(): number;
  dropQueue(w: string, p: PlanRecord, n: NodeRecord): void;
  inbox(w: string, id: string): Inbox[];
  saveMessage(w: string, id: string, m: Inbox): void;
}

export const agentPoolRecords: AgentPoolRecordsMethods &
  ThisType<AgentPoolRecordsHost & AgentPoolRecordsMethods> = {
  tx<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT agent_pool_command');
    try {
      const value = fn();
      this.db.exec('RELEASE agent_pool_command');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK TO agent_pool_command; RELEASE agent_pool_command');
      throw e;
    }
  },
  event(w: string, p: PlanRecord, type: string, body: unknown) {
    this.events.append(w, p.spec.id, p.spec.planRevision, type, body, this.clock());
  },
  save(w: string, p: PlanRecord) {
    p.updatedAt = this.clock();
    this.db
      .prepare('INSERT OR REPLACE INTO agent_plans VALUES(?,?,?,?)')
      .run(w, p.spec.id, p.spec.planRevision, JSON.stringify(p));
  },
  saveNode(w: string, p: PlanRecord, n: NodeRecord) {
    this.db
      .prepare('INSERT OR REPLACE INTO agent_nodes VALUES(?,?,?,?,?)')
      .run(w, p.spec.id, p.spec.planRevision, n.spec.id, JSON.stringify(n));
  },
  saveLease(l: Lease) {
    this.db
      .prepare('INSERT OR REPLACE INTO agent_leases VALUES(?,?)')
      .run(l.dispatchKey, JSON.stringify(l));
  },
  plan(w: string, id: string, revision?: number): PlanRecord {
    const r = (
      revision
        ? this.db
            .prepare('SELECT body FROM agent_plans WHERE workspace=? AND id=? AND revision=?')
            .get(w, id, revision)
        : this.db
            .prepare(
              'SELECT body FROM agent_plans WHERE workspace=? AND id=? ORDER BY revision DESC LIMIT 1',
            )
            .get(w, id)
    ) as { body: string } | undefined;
    check(r, 'PLAN_NOT_FOUND');
    return JSON.parse(r.body);
  },
  nodes(w: string, p: PlanRecord): NodeRecord[] {
    return (
      this.db
        .prepare(
          'SELECT body FROM agent_nodes WHERE workspace=? AND plan_id=? AND revision=? ORDER BY rowid',
        )
        .all(w, p.spec.id, p.spec.planRevision) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  },
  leases(): Lease[] {
    return (this.db.prepare('SELECT body FROM agent_leases').all() as { body: string }[]).map((r) =>
      JSON.parse(r.body),
    );
  },
  node(w: string, p: PlanRecord, id: string) {
    const n = this.nodes(w, p).find((n) => n.spec.id === id);
    check(n, 'NODE_NOT_FOUND');
    return n;
  },
  lease(key: string) {
    const l = this.leases().find((l) => l.dispatchKey === key);
    check(l, 'LEASE_NOT_FOUND');
    return l;
  },
  current(l: Lease) {
    const p = this.plan(l.workspace, l.planId);
    return p.spec.planRevision === l.revision && p.generation === l.generation;
  },
  queueCount() {
    return Number((this.db.prepare('SELECT COUNT(*) n FROM agent_queue').get() as { n: number }).n);
  },
  dropQueue(w: string, p: PlanRecord, n: NodeRecord) {
    this.db
      .prepare(
        'DELETE FROM agent_queue WHERE workspace=? AND plan_id=? AND revision=? AND node_id=?',
      )
      .run(w, p.spec.id, p.spec.planRevision, n.spec.id);
  },
  inbox(w: string, id: string): Inbox[] {
    return (
      this.db
        .prepare('SELECT body FROM agent_inbox WHERE workspace=? AND plan_id=? ORDER BY sequence')
        .all(w, id) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  },
  saveMessage(w: string, id: string, m: Inbox) {
    this.db
      .prepare('INSERT OR REPLACE INTO agent_inbox VALUES(?,?,?,?,?)')
      .run(w, id, m.messageId, m.sequence, JSON.stringify(m));
  }
};
