// Lease lifecycle for the agent pool: send/ack boundaries, heartbeats,
// rejection handling, unknown outcomes, interrupts, host-restart recovery
// and the guard/tick sweeps.
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { hash } from './agent-plan.js';
import { classifyError, type ErrorEvidence } from './agent-queue.js';
import { check, type AgentPoolRecordsMethods } from './agent-pool-records.js';
import type { AgentPoolMaterialsMethods } from './agent-pool-materials.js';
import type { AgentPoolDispatchMethods } from './agent-pool-dispatch.js';
import type { Lease, NodeRecord, PlanRecord } from './agent-pool.js';

/** The AgentPoolStore surface the lease cluster relies on. */
export type AgentPoolLeaseHost = {
  db: DatabaseSync;
  clock: () => number;
} & Pick<AgentPoolRecordsMethods, 'tx' | 'lease' | 'plan' | 'node' | 'saveLease' | 'saveNode' | 'save' | 'event' | 'inbox' | 'saveMessage' | 'leases' | 'current'> &
  Pick<AgentPoolMaterialsMethods, 'settle'> &
  Pick<AgentPoolDispatchMethods, 'canRun' | 'account' | 'saveAccount' | 'enqueue'>;

export interface AgentPoolLeaseMethods {
  sending(key: string, threadId: string): Lease;
  ack(key: string, turnId: string): Lease;
  release(l: Lease): void;
  heartbeat(key: string): void;
  unknown(key: string, reason: string, turnId?: string): void;
  rejected(key: string, evidence: ErrorEvidence): string;
  interrupts(w: string, id: string): { dispatchKey: string; threadId: string; turnId: string }[];
  recover(): void;
  resolve(key: string, confirmedStopped: boolean, note: string, observedRunning: boolean): PlanRecord;
  guard(
    key: string,
    progress: { toolActive: boolean; thinking: boolean; progress: boolean; failureHash?: string },
  ): NodeRecord['guard'];
  tick(): void;
}

export const agentPoolLeases: AgentPoolLeaseMethods &
  ThisType<AgentPoolLeaseHost & AgentPoolLeaseMethods> = {
  sending(key: string, threadId: string) {
    return this.tx(() => {
      const l = this.lease(key),
        p = this.plan(l.workspace, l.planId, l.revision),
        n = this.node(l.workspace, p, l.nodeId);
      check(l.state === 'leased' && this.current(l) && this.canRun(p), 'STALE_DISPATCH');
      const account = this.account(n.spec.modelProfile.account);
      check(Math.max(account.cooldown, account.nextStart) <= this.clock(), 'LOCAL_RATE_LIMIT');
      account.nextStart = this.clock() + 2000;
      this.saveAccount(n.spec.modelProfile.account, account);
      l.threadId = z.string().min(1).max(200).parse(threadId);
      l.state = 'sending';
      l.sentAt = this.clock();
      l.expires = this.clock() + 60000;
      this.saveLease(l);
      this.db
        .prepare("UPDATE bot_slots SET thread_id=?,state='sending' WHERE id=?")
        .run(threadId, key);
      n.state = 'starting';
      this.saveNode(l.workspace, p, n);
      this.event(l.workspace, p, 'sending', { dispatchKey: key, threadId });
      return l;
    });
  },
  ack(key: string, turnId: string) {
    return this.tx(() => {
      const l = this.lease(key);
      check(l.sentAt !== null, 'NOT_SENT');
      check(!l.turnId || l.turnId === turnId, 'TURN_MISMATCH');
      l.turnId = z.string().min(1).max(200).parse(turnId);
      if (l.state !== 'stopping' && l.state !== 'unknown') l.state = 'running';
      l.expires = this.clock() + 60000;
      this.saveLease(l);
      this.db
        .prepare('UPDATE bot_slots SET turn_id=?,state=? WHERE id=?')
        .run(turnId, l.state, key);
      const p = this.plan(l.workspace, l.planId, l.revision),
        n = this.node(l.workspace, p, l.nodeId);
      n.state = l.state === 'running' ? 'running' : l.state;
      this.saveNode(l.workspace, p, n);
      // Every unhandled message is in this turn's context, so each actual delivery is recorded and the receipt binds to the latest one.
      for (const m of this.inbox(l.workspace, p.spec.id).filter(
        (m) =>
          m.planRevision === l.revision &&
          m.nodeId === l.nodeId &&
          !m.handled &&
          !(m.submitted?.dispatchKey === key && m.submitted.turnId === turnId),
      )) {
        const delivery = { turnId, dispatchKey: key, payloadHash: hash(m.text) };
        m.submitted = delivery;
        m.deliveries = [...(m.deliveries || []), { ...delivery, at: this.clock() }];
        this.saveMessage(l.workspace, p.spec.id, m);
      }
      this.event(l.workspace, p, 'acknowledged', { dispatchKey: key, turnId });
      return l;
    });
  },
  release(l: Lease) {
    this.db.prepare('DELETE FROM agent_resources WHERE dispatch_key=?').run(l.dispatchKey);
    this.db.prepare('DELETE FROM bot_slots WHERE id=?').run(l.dispatchKey);
    this.db.prepare('DELETE FROM agent_leases WHERE dispatch_key=?').run(l.dispatchKey);
  },
  heartbeat(key: string) {
    return this.tx(() => {
      const l = this.lease(key);
      l.expires = this.clock() + 60000;
      this.saveLease(l);
    });
  },
  unknown(key: string, reason: string, turnId?: string) {
    return this.tx(() => {
      const l = this.lease(key),
        p = this.plan(l.workspace, l.planId, l.revision),
        n = this.node(l.workspace, p, l.nodeId);
      if (turnId && l.sentAt !== null) {
        check(!l.turnId || l.turnId === turnId, 'TURN_MISMATCH');
        l.turnId = z.string().min(1).max(200).parse(turnId);
        this.db.prepare('UPDATE bot_slots SET turn_id=? WHERE id=?').run(l.turnId, key);
      }
      l.state = 'unknown';
      n.state = 'unknown';
      n.reason = reason;
      this.saveLease(l);
      this.saveNode(l.workspace, p, n);
      this.db.prepare("UPDATE bot_slots SET state='unknown' WHERE id=?").run(key);
      this.event(l.workspace, p, 'unknown', { dispatchKey: key, reason });
    });
  },
  rejected(key: string, evidence: ErrorEvidence) {
    return this.tx(() => {
      const l = this.lease(key);
      check(!l.turnId, 'ALREADY_RECEIVED');
      const p = this.plan(l.workspace, l.planId, l.revision),
        n = this.node(l.workspace, p, l.nodeId),
        kind = classifyError(evidence);
      if (kind === 'unknown') {
        this.unknown(key, '发送是否成功未知，不自动重发');
        return kind;
      }
      this.release(l);
      if (!this.current(l)) {
        n.state = 'cancelled';
        this.saveNode(l.workspace, p, n);
        return kind;
      }
      if (kind === 'rate_limit') {
        n.rateLimitRejectCount++;
        n.notBefore =
          this.clock() +
          (evidence.retryAfterMs ??
            5000 * 2 ** (n.rateLimitRejectCount - 1) + Math.floor(Math.random() * 1000));
        const a = this.account(n.spec.modelProfile.account);
        a.cooldown = Math.max(a.cooldown, n.notBefore);
        this.saveAccount(n.spec.modelProfile.account, a);
        if (n.rateLimitRejectCount < 3) {
          n.state = 'waiting_rate_limit';
          n.reason = '账户冷却中';
          this.saveNode(l.workspace, p, n);
          this.enqueue(l.workspace, p, n);
        } else {
          p.state = 'needs_input';
          p.reason = '账户连续三次拒绝请求';
          n.state = 'paused';
        }
      } else {
        n.state = 'paused';
        n.attention =
          kind === 'quota'
            ? '使用额度耗尽，不自动轮询'
            : kind === 'permission'
              ? '权限或连接错误'
              : '执行请求被拒绝';
        p.state = 'needs_input';
        p.reason = n.attention;
      }
      this.saveNode(l.workspace, p, n);
      this.save(l.workspace, p);
      this.event(l.workspace, p, 'dispatch_rejected', { dispatchKey: key, kind, evidence });
      return kind;
    });
  },
  /** Active turns the host must interrupt for a plan. */
  interrupts(w: string, id: string) {
    return this.leases()
      .filter(
        (l) =>
          l.workspace === w &&
          l.planId === id &&
          (l.state === 'stopping' || (l.state === 'unknown' && l.stopAt !== null)) &&
          l.threadId &&
          l.turnId,
      )
      .map((l) => ({ dispatchKey: l.dispatchKey, threadId: l.threadId!, turnId: l.turnId! }));
  },
  recover() {
    return this.tx(() => {
      for (const l of this.leases()) {
        const p = this.plan(l.workspace, l.planId, l.revision),
          n = this.node(l.workspace, p, l.nodeId);
        if (l.state === 'unknown') continue;
        if (l.sentAt === null) {
          this.release(l);
          n.state = 'ready';
          this.saveNode(l.workspace, p, n);
          if (this.current(l) && this.canRun(p)) this.enqueue(l.workspace, p, n);
        } else this.unknown(l.dispatchKey, '宿主重启，核实原 thread/turn，不重放');
      }
    });
  },
  resolve(key: string, confirmedStopped: boolean, note: string, observedRunning: boolean) {
    return this.tx(() => {
      const l = this.lease(key);
      check(
        l.state === 'unknown' && confirmedStopped && !observedRunning && note.trim(),
        'STOP_EVIDENCE_REQUIRED',
      );
      const p = this.plan(l.workspace, l.planId),
        old = this.plan(l.workspace, l.planId, l.revision),
        n = this.node(l.workspace, old, l.nodeId);
      p.generation++;
      p.frozen = true;
      p.reason = '已人工确认停止，不代表外部动作未发生';
      this.settle(p, l, l.usage);
      this.release(l);
      n.state = 'paused';
      n.reason = p.reason;
      this.saveNode(l.workspace, old, n);
      if (!this.leases().some((a) => a.workspace === l.workspace && a.planId === l.planId))
        p.state = p.state === 'cancel_requested' ? 'cancelled' : 'paused';
      this.save(l.workspace, p);
      this.event(l.workspace, old, 'manually_stopped', { dispatchKey: key, note });
      return p;
    });
  },
  guard(
    key: string,
    progress: { toolActive: boolean; thinking: boolean; progress: boolean; failureHash?: string },
  ) {
    return this.tx(() => {
      const l = this.lease(key),
        p = this.plan(l.workspace, l.planId, l.revision),
        n = this.node(l.workspace, p, l.nodeId),
        now = this.clock();
      const previous = n.guard || {
        activityAt: now,
        progressAt: now,
        toolActive: false,
        thinking: false,
        failures: 0,
        uncertain: false,
      };
      const failures = progress.failureHash
        ? previous.failureHash === progress.failureHash
          ? previous.failures + 1
          : 1
        : 0;
      const progressAt =
        progress.progress || progress.toolActive || progress.thinking ? now : previous.progressAt;
      n.guard = {
        activityAt: now,
        progressAt,
        toolActive: progress.toolActive,
        thinking: progress.thinking,
        failureHash: progress.failureHash,
        failures,
        uncertain: now - progressAt >= 180000,
      };
      if (failures === 3) {
        n.attention = '同一步骤连续失败，可能卡住';
        this.event(l.workspace, p, 'progress_attention', { nodeId: n.spec.id });
      } else if (progress.progress) n.attention = undefined;
      this.saveNode(l.workspace, p, n);
      return n.guard;
    });
  },
  tick() {
    return this.tx(() => {
      for (const l of this.leases()) {
        const p = this.plan(l.workspace, l.planId, l.revision),
          n = this.node(l.workspace, p, l.nodeId);
        if (l.state === 'unknown') continue;
        if (l.sentAt === null && l.expires < this.clock()) {
          this.release(l);
          n.state = 'ready';
          this.saveNode(l.workspace, p, n);
          if (this.current(l) && this.canRun(p)) this.enqueue(l.workspace, p, n);
        } else if (
          l.sentAt !== null &&
          l.stopAt === null &&
          this.clock() - l.sentAt >= l.reservation.minutes * 60000
        ) {
          l.state = 'stopping';
          l.stopAt = this.clock();
          l.expires = this.clock() + 30000;
          this.saveLease(l);
          n.state = 'stopping';
          n.attention = '本段执行超时';
          this.saveNode(l.workspace, p, n);
        } else if (
          (l.stopAt !== null && this.clock() - l.stopAt >= 30000) ||
          (l.sentAt !== null && l.expires < this.clock())
        )
          this.unknown(l.dispatchKey, '执行终态待核实');
      }
    });
  }
};
