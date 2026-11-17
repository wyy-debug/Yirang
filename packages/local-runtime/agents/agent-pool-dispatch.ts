// Queue admission and dispatch for the agent pool: queue rows, dependency-
// driven node refresh, capacity counting, account pacing and the ranked
// claim loop that acquires leases.
import type { DatabaseSync } from 'node:sqlite';
import { dependencyState, finished, type NodeState, type Plan } from './agent-plan.js';
import { priorityRank } from './agent-queue.js';
import type { AgentPoolRecordsMethods } from './agent-pool-records.js';
import type { AgentPoolContext, AgentPoolMaterialsMethods } from './agent-pool-materials.js';
import type { AgentPoolResultsMethods } from './agent-pool-results.js';
import type { Lease, NodeRecord, PlanRecord } from './agent-pool.js';

const queueable = new Set<NodeState>([
  'ready',
  'retry_wait',
  'waiting_rate_limit',
  'waiting_resource',
  'admission_pending',
]);
const keyOf = (w: string, p: PlanRecord, n: NodeRecord) =>
  `${w}/${p.spec.id}/${p.spec.planRevision}/${n.spec.id}/${n.attempt}/${n.segment}`;

/** The AgentPoolStore surface the dispatch cluster relies on. */
export type AgentPoolDispatchHost = {
  db: DatabaseSync;
  clock: () => number;
  list(w: string): { spec: Plan }[];
} & Pick<AgentPoolRecordsMethods, 'tx' | 'dropQueue' | 'queueCount' | 'saveNode' | 'nodes' | 'plan' | 'node' | 'leases' | 'saveLease' | 'save' | 'event'> &
  Pick<AgentPoolMaterialsMethods, 'reserve' | 'context'> &
  Pick<AgentPoolResultsMethods, 'resultFor'>;

export interface AgentPoolDispatchMethods {
  enqueue(w: string, p: PlanRecord, n: NodeRecord): void;
  canRun(p: PlanRecord): boolean;
  refresh(w: string, p: PlanRecord): void;
  counts(): { total: number; background: number };
  account(id: string): { nextStart: number; cooldown: number };
  saveAccount(id: string, account: { nextStart: number; cooldown: number }): void;
  claim(w: string): { lease: Lease; context: AgentPoolContext } | null;
}

export const agentPoolDispatch: AgentPoolDispatchMethods &
  ThisType<AgentPoolDispatchHost & AgentPoolDispatchMethods> = {
  enqueue(w: string, p: PlanRecord, n: NodeRecord) {
    const key = keyOf(w, p, n);
    if (this.db.prepare('SELECT 1 FROM agent_queue WHERE dispatch_key=?').get(key)) return;
    // A node has at most one queue entry: its current attempt/segment.
    this.dropQueue(w, p, n);
    if (this.queueCount() >= 256) {
      n.state = 'admission_pending';
      n.reason = '已保存，等待入队';
      this.saveNode(w, p, n);
      return;
    }
    this.db
      .prepare('INSERT INTO agent_queue VALUES(?,?,?,?,?,?)')
      .run(key, w, p.spec.id, p.spec.planRevision, n.spec.id, this.clock());
  },
  canRun(p: PlanRecord) {
    return (
      !p.frozen &&
      ![
        'draft',
        'needs_input',
        'paused',
        'pausing',
        'cancel_requested',
        'cancelled',
        'completed',
        'review',
        'failed',
      ].includes(p.state)
    );
  },
  refresh(w: string, p: PlanRecord) {
    if (!this.canRun(p)) return;
    let nodes = this.nodes(w, p),
      changed = true;
    while (changed) {
      changed = false;
      const states = new Map(
        nodes.map((n) => [
          n.spec.id,
          { state: n.state, artifacts: this.resultFor(w, p, n)?.artifacts },
        ]),
      );
      for (const n of nodes.filter((n) =>
        ['blocked', 'ready', 'admission_pending'].includes(n.state),
      )) {
        const state = dependencyState(n.spec.id, p.spec.edges, states);
        if (state === 'skipped') {
          n.state = 'skipped';
          n.reason = 'dependency_failed';
          this.dropQueue(w, p, n);
          this.saveNode(w, p, n);
          changed = true;
          this.event(w, p, 'dependency_failed', { nodeId: n.spec.id });
        } else if (state === 'ready' && n.state !== 'ready') {
          n.state = 'ready';
          n.reason = '等待执行';
          this.enqueue(w, p, n);
          if (n.state === 'ready') this.saveNode(w, p, n);
        }
      }
      if (changed) nodes = this.nodes(w, p);
    }
    if (nodes.every((n) => finished.has(n.state))) {
      p.state = nodes.some((n) => n.state === 'succeeded') ? 'review' : 'failed';
      p.reason = '请检查交付、失败项和冲突';
      this.save(w, p);
    }
  },
  counts() {
    const runs = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM work_runs WHERE state IN ('starting','running','waiting','stopping','unknown')",
          )
          .get() as { n: number }
      ).n,
    );
    const slots = this.db.prepare('SELECT role FROM bot_slots').all() as { role: string }[];
    return {
      total: runs + slots.length,
      background: runs + slots.filter((s) => s.role === 'background').length,
    };
  },
  claim(w: string) {
    return this.tx(() => {
      for (const item of this.list(w)) this.refresh(w, this.plan(w, item.spec.id));
      const candidates = (
        this.db.prepare('SELECT * FROM agent_queue WHERE workspace=?').all(w) as {
          dispatch_key: string;
          plan_id: string;
          revision: number;
          node_id: string;
          created_at: number;
        }[]
      ).map((q) => {
        const p = this.plan(w, q.plan_id, q.revision);
        return { q, p, n: this.node(w, p, q.node_id) };
      });
      const all = this.leases(),
        now = this.clock();
      const count = (p: PlanRecord) =>
        all.filter((l) => l.workspace === w && l.planId === p.spec.id).length;
      const rank = (c: (typeof candidates)[number]) =>
        priorityRank(c.n.followupId ? 'user-blocking' : c.n.spec.priority, c.q.created_at, now);
      candidates.sort(
        (a, b) => rank(a) - rank(b) || count(a.p) - count(b.p) || a.q.created_at - b.q.created_at,
      );
      for (const { q, p, n } of candidates) {
        if (q.dispatch_key !== keyOf(w, p, n) || !queueable.has(n.state)) {
          this.db.prepare('DELETE FROM agent_queue WHERE dispatch_key=?').run(q.dispatch_key);
          continue;
        }
        if (
          !this.canRun(p) ||
          p.spec.planRevision !== this.plan(w, p.spec.id).spec.planRevision ||
          n.notBefore > now
        )
          continue;
        if (p.spec.deadline !== null && p.spec.deadline <= now) {
          p.state = 'needs_input';
          p.reason = '交付期限已到';
          this.save(w, p);
          continue;
        }
        const planActive = count(p),
          ordinary = all.filter(
            (l) => l.workspace === w && l.planId === p.spec.id && !l.followupId,
          ).length;
        if (
          planActive >= 4 ||
          (!n.followupId && ordinary >= 3) ||
          all.some((l) => l.workspace === w && l.planId === p.spec.id && l.nodeId === n.spec.id)
        )
          continue;
        const counts = this.counts();
        if (
          counts.total >= 7 ||
          counts.background >= 5 ||
          (!n.followupId && counts.background >= 4)
        )
          continue;
        if (
          n.spec.requiredResources.some((resource) =>
            this.db
              .prepare('SELECT 1 FROM agent_resources WHERE resource=?')
              .get(w + ':' + resource),
          )
        ) {
          n.state = 'waiting_resource';
          n.reason = '等待材料写入名额';
          this.saveNode(w, p, n);
          continue;
        }
        const account = this.account(n.spec.modelProfile.account);
        if (account.nextStart > now || account.cooldown > now) {
          n.state = 'waiting_rate_limit';
          n.notBefore = Math.max(account.nextStart, account.cooldown);
          n.reason = '等待账户冷却';
          this.saveNode(w, p, n);
          continue;
        }
        let reservation: Lease['reservation'] | null;
        try {
          reservation = this.reserve(w, p, n);
        } catch (error) {
          const code = (error as Error).message;
          if (code === 'MATERIAL_NOT_READY') {
            n.reason = '正在准备材料正文';
            this.saveNode(w, p, n);
            continue;
          }
          p.state = 'needs_input';
          p.frozen = true;
          p.reason =
            code === 'CONTEXT_TOO_LARGE'
              ? '这一分工的补充内容过长，放不进一次执行；请缩短或撤回补充，或取消该计划'
              : code === 'STALE_INPUT'
                ? '材料已更新或不可读，请修订要求后重新安排'
                : code;
          this.save(w, p);
          continue;
        }
        if (!reservation) continue;
        const l: Lease = {
          dispatchKey: q.dispatch_key,
          workspace: w,
          planId: p.spec.id,
          revision: p.spec.planRevision,
          nodeId: n.spec.id,
          attempt: n.attempt,
          segment: n.segment,
          generation: p.generation,
          state: 'leased',
          threadId: null,
          turnId: null,
          createdAt: now,
          sentAt: null,
          expires: now + 60000,
          stopAt: null,
          followupId: n.followupId,
          reservation,
          usage: null,
        };
        this.saveLease(l);
        // The shared capacity ledger also counts router, consultation and micro runs.
        this.db
          .prepare(
            'INSERT INTO bot_slots(id,workspace,role,thread_id,turn_id,state,created_at,kind,request_id) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            l.dispatchKey,
            w,
            'background',
            'pool:' + l.dispatchKey,
            null,
            'leased',
            now,
            'pool',
            null,
          );
        for (const resource of n.spec.requiredResources)
          this.db
            .prepare('INSERT INTO agent_resources VALUES(?,?)')
            .run(w + ':' + resource, l.dispatchKey);
        n.state = 'leased';
        n.reason = '等待执行器';
        this.saveNode(w, p, n);
        this.db.prepare('DELETE FROM agent_queue WHERE dispatch_key=?').run(q.dispatch_key);
        p.state = n.spec.type === 'reduce' ? 'reducing' : 'running';
        this.save(w, p);
        this.event(w, p, 'leased', { dispatchKey: l.dispatchKey, reservation });
        return { lease: l, context: this.context(w, p, n) };
      }
      return null;
    });
  },
  account(id: string): { nextStart: number; cooldown: number } {
    const row = this.db.prepare('SELECT body FROM agent_accounts WHERE id=?').get(id) as
      | { body: string }
      | undefined;
    return row ? JSON.parse(row.body) : { nextStart: 0, cooldown: 0 };
  },
  saveAccount(id: string, account: { nextStart: number; cooldown: number }) {
    this.db
      .prepare('INSERT OR REPLACE INTO agent_accounts VALUES(?,?)')
      .run(id, JSON.stringify(account));
  }
};
