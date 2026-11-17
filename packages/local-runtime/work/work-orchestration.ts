// Supervisor surface of WorkManagementStore: child-plan control, review
// bundles, context assembly and the dispatch of orchestration and pool commands.
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { fail, type WorkTask } from '../../contracts/index.js';
import { buildWorkContext } from '../bot/bot-work-context.js';
import { active, id } from './work-conventions.js';
import type { AgentPoolStore } from '../agents/agent-pool.js';
import type { BotCapacityStore } from '../bot/bot-capacity.js';
import type { BotIntakeStore } from '../bot/bot-intake.js';
import type { Api } from './work-management.js';
import type { TaskStoreMethods } from './work-task-store.js';
import type { WorkViewsMethods } from './work-views.js';

type StoreSurface = Pick<TaskStoreMethods, 'get' | 'put' | 'task' | 'save'> &
  Pick<WorkViewsMethods, 'sourceCheck' | 'refreshArtifacts' | 'resultReady'>;

/** The WorkManagementStore surface the supervisor cluster relies on. */
export type WorkOrchestrationHost = {
  db: DatabaseSync;
  api: Pick<Api, 'object'>;
  pool: AgentPoolStore;
  capacity: BotCapacityStore;
  intake: BotIntakeStore;
  command(w: string, input: unknown, host?: boolean, inTransaction?: boolean): any;
} & StoreSurface;

/** Acceptance review bundle for one task: criteria plus before/after file text. */
export type WorkReview = {
  requirementsRevision: number;
  criteria: string[];
  files: unknown[];
  comparisonLimit: number;
};

/** Recorded origin of one user input that shaped the current requirements. */
export type WorkInputOrigin = {
  requestId: string;
  text: string;
  assignedSpans: unknown[];
  sourceRequestId: string;
};

export interface WorkOrchestrationMethods {
  stopChildren(w: string, t: WorkTask, action: string): void;
  review(w: string, t: WorkTask): WorkReview;
  dailyOnly(w: string, t: WorkTask): boolean;
  inputOrigins(w: string, t: WorkTask): WorkInputOrigin[];
  returnAssignment(w: string, payload: Record<string, unknown>): unknown;
  context(w: string, t: WorkTask): ReturnType<typeof buildWorkContext>;
  poolPendingMaterials(w: string): { objectId: string; revision: number }[];
  poolCommand(w: string, v: Record<string, any>): unknown;
  orchestrate(w: string, payload: Record<string, unknown>): unknown;
}

export const workOrchestration: WorkOrchestrationMethods &
  ThisType<WorkOrchestrationHost & WorkOrchestrationMethods> = {
  stopChildren(w: string, t: WorkTask, action: string) {
    const planId = t.management!.delegation?.poolPlanId;
    if (planId) {
      const plan = this.pool.detail(w, planId),
        poolAction = action === 'resume' ? 'resume' : action === 'pause' ? 'pause' : 'cancel';
      if (!['completed', 'cancelled', 'failed'].includes(plan.state))
        try {
          this.pool.control(w, planId, poolAction);
        } catch {}
    }
    for (const key of t.management!.delegation?.children || []) {
      const child = this.task(w, key),
        m = child.management!;
      if (action === 'resume') {
        if (['paused', 'attention'].includes(m.state) && !m.runs.some(active)) {
          m.state = 'queued';
          m.reason = '继续处理';
          this.save(w, child, 'child_resumed');
        }
        continue;
      }
      if (action !== 'pause' && action !== 'cancel') continue;
      if (action === 'pause' && this.resultReady(child)) continue;
      m.generation++;
      m.state = m.runs.some(active)
        ? action === 'pause'
          ? 'pausing'
          : 'cancelling'
        : action === 'pause'
          ? 'paused'
          : 'cancelled';
      m.reason = action === 'pause' ? '所属工作已暂停' : '所属要求已更新或取消';
      for (const r of m.runs)
        if (active(r) && r.state !== 'unknown') {
          r.state = 'stopping';
          this.db
            .prepare('UPDATE work_runs SET state=? WHERE workspace=? AND id=?')
            .run(r.state, w, r.id);
        }
      this.save(w, child, 'parent_control', m.reason);
    }
  },
  review(w: string, t: WorkTask) {
    const m = t.management!;
    this.refreshArtifacts(w, t);
    const files = m.artifacts
      .filter((a) => a.validity === 'current')
      .slice(0, 50)
      .map((a) => {
        const previous =
          m.artifacts
            .filter((b) => b.objectId === a.objectId && b.revision < a.revision)
            .sort((a, b) => b.revision - a.revision)[0]?.revision ??
          t.sources.find((s) => s.objectId === a.objectId)?.revision;
        const read = (revision: number | undefined) => {
          if (!revision) return null;
          const o = this.api.object(w, a.objectId);
          if (o.archived || o.policy?.private) return null;
          const r = this.db
            .prepare(
              'SELECT content FROM revisions WHERE workspace=? AND object_id=? AND revision=?',
            )
            .get(w, a.objectId, revision) as any;
          if (!r) return null;
          const c = JSON.parse(r.content);
          return typeof c === 'string'
            ? c.slice(0, 24000)
            : typeof c?.text === 'string'
              ? c.text.slice(0, 24000)
              : typeof c?.code === 'string'
                ? c.code.slice(0, 24000)
                : Array.isArray(c?.blocks)
                  ? c.blocks
                      .map((b: any) => (typeof b.text === 'string' ? b.text : ''))
                      .join('\n')
                      .slice(0, 24000)
                  : null;
        };
        return { ...a, previous, before: read(previous), after: read(a.revision) };
      });
    return {
      requirementsRevision: m.currentRequirementsRevision,
      criteria: m.requirements
        .at(-1)!
        .acceptanceCriteria.split(/\n|[；;]/)
        .map((s) => s.trim())
        .filter(Boolean),
      files,
      comparisonLimit: 24000,
    };
  },
  // Mode is frozen at submission; professional work and work without a recorded mode keep the original Codex delegation.
  dailyOnly(w: string, t: WorkTask) {
    const modes = t.management!.requestIds.map((requestId) => {
      const row = this.db
        .prepare(
          'SELECT r.body AS input FROM work_requests q JOIN bot_effects e ON e.workspace=q.workspace AND e.id=q.idempotency_key JOIN bot_requests r ON r.workspace=e.workspace AND r.id=e.request_id WHERE q.workspace=? AND q.id=?',
        )
        .get(w, requestId) as { input: string } | undefined;
      return row ? JSON.parse(row.input).mode : undefined;
    });
    return modes.length > 0 && modes.every((m) => m === 'daily');
  },
  inputOrigins(w: string, t: WorkTask) {
    const values: any[] = [];
    for (const requestId of t.management!.requestIds) {
      const row = this.db
        .prepare(
          'SELECT e.body AS effect,r.body AS input FROM work_requests q JOIN bot_effects e ON e.workspace=q.workspace AND e.id=q.idempotency_key JOIN bot_requests r ON r.workspace=e.workspace AND r.id=e.request_id WHERE q.workspace=? AND q.id=?',
        )
        .get(w, requestId) as { effect: string; input: string } | undefined;
      if (!row) continue;
      const request = JSON.parse(row.input),
        effect = JSON.parse(row.effect);
      if (t.management!.requirements.at(-1)!.goal.includes(request.text)) continue;
      values.push({
        requestId: request.id,
        text: request.text,
        assignedSpans: [],
        sourceRequestId: requestId,
      });
    }
    return values;
  },
  // A delegated run may hand its assignment back; the work pauses and the
  // original input asks the user to confirm the owner again.
  returnAssignment(w: string, p: Record<string, unknown>) {
    const task = this.task(w, id.parse(p.taskId)),
      source = id.parse(p.sourceRequestId),
      run = task.management!.runs.find((r) => r.id === p.runId),
      reason = z.string().trim().min(1).max(2000).parse(p.reason);
    if (
      !run ||
      !active(run) ||
      run.generation !== task.management!.generation ||
      !task.management!.requestIds.includes(source)
    )
      fail('STALE_RUN', '只有本工作的当前执行可退回其要求');
    const row = this.db
      .prepare(
        'SELECT q.body AS input,e.request_id AS origin FROM work_requests q LEFT JOIN bot_effects e ON e.workspace=q.workspace AND e.id=q.idempotency_key WHERE q.workspace=? AND q.id=?',
      )
      .get(w, source) as { input: string; origin: string | null } | undefined;
    if (!row) fail('REQUEST_NOT_FOUND', '原要求不存在');
    const requestId = JSON.parse(row!.input).originInputId || row!.origin || source;
    const returned = this.get<any[]>(w, 'bot-returns:' + requestId) || [],
      limit = returned.length >= 2 || returned.some((r: any) => r.taskId === task.id);
    const command = {
        operation: 'control',
        requestId: 'return:' + run!.id,
        taskId: task.id,
        expectedRevision: task.revision,
        payload: { action: 'pause', reason: '归属需要确认：' + reason },
      },
      result = this.command(w, command, true, true);
    if (!limit) {
      returned.push({
        taskId: task.id,
        sourceRequestId: source,
        runId: run!.id,
        reason,
        at: Date.now(),
      });
      this.put(w, 'bot-returns:' + requestId, returned);
    }
    this.put(w, 'bot-last-return:' + task.id, { requestId, sourceRequestId: source });
    const saved = this.db
      .prepare('SELECT body FROM bot_requests WHERE workspace=? AND id=?')
      .get(w, requestId) as { body: string } | undefined;
    if (saved) {
      const input = JSON.parse(saved.body);
      input.state = 'needs_input';
      input.reason = limit ? '退回次数已达上限，请核实原工作再交接' : reason;
      input.returned = {
        taskId: task.id,
        sourceRequestId: source,
        limit,
        externalEffectsRequireReconciliation: true,
      };
      this.db
        .prepare('UPDATE bot_requests SET body=? WHERE workspace=? AND id=?')
        .run(JSON.stringify(input), w, requestId);
    }
    return {
      requestId,
      needsInput: true,
      limit,
      actions: [{ state: 'acknowledged', command, result }],
      receipt: '原工作已暂停；先核实终态和产物，再由用户明确交接。不会自动改投或撤销文件。',
    };
  },
  context(w: string, t: WorkTask) {
    // Tasks created before context v2 keep the context they were started with.
    const legacy = this.get(w, 'bot-context-version:' + t.id) === 1;
    return buildWorkContext(
      t,
      legacy ? [] : this.inputOrigins(w, t),
      [...new Map(t.management!.artifacts.map(a => [a.objectId, a])).values()].flatMap(a => {
        try {
          const object = this.api.object(w, a.objectId);
          return object.archived || object.policy?.private ? [] : [{
            objectId: a.objectId, revision: object.revision,
            sourceRunId: a.runId, priorRequirementsRevision: t.management!.runs.find(r => r.id === a.runId)?.requirementsRevision,
          }];
        } catch { return []; }
      }),
    );
  },
  poolPendingMaterials(w: string) {
    return process.env.YIRANG_AGENT_POOL === '1' ? this.pool.pendingMaterials(w) : [];
  },
  poolCommand(w: string, v: Record<string, any>): unknown {
    // Agent Pool stays behind the existing feature gate until M0 capacity and budget sign-off.
    if (
      process.env.YIRANG_AGENT_POOL !== '1' &&
      !['pool_list', 'pool_detail', 'pool_interrupts', 'pool_leases'].includes(v.operation)
    )
      fail('POOL_DISABLED', 'Agent Pool 尚未放行；M0 实测通过前不改变默认分派');
    const pool = this.pool;
    switch (v.operation) {
      case 'pool_list':
        return pool.list(w);
      case 'pool_detail':
        return pool.detail(w, id.parse(v.planId));
      case 'pool_create':
        return pool.create(w, v.plan, id.parse(v.requestId));
      case 'pool_confirm':
        return pool.confirm(w, id.parse(v.planId), z.string().parse(v.confirmationHash));
      case 'pool_claim':
        return pool.claim(w);
      case 'pool_sending':
        return pool.sending(id.parse(v.dispatchKey), id.parse(v.threadId));
      case 'pool_ack':
        return pool.ack(id.parse(v.dispatchKey), id.parse(v.turnId));
      case 'pool_heartbeat':
        return pool.heartbeat(id.parse(v.dispatchKey));
      case 'pool_rejected':
        return pool.rejected(id.parse(v.dispatchKey), v.evidence);
      case 'pool_unknown':
        return pool.unknown(
          id.parse(v.dispatchKey),
          z.string().max(2000).parse(v.reason),
          v.turnId === undefined ? undefined : id.parse(v.turnId),
        );
      case 'pool_finish':
        return pool.finish(
          id.parse(v.dispatchKey),
          id.parse(v.turnId),
          v.status,
          v.result,
          v.usage ?? null,
          v.retryable === true,
        );
      case 'pool_followup':
        return pool.followup(w, id.parse(v.planId), v.message);
      case 'pool_control':
        return {
          plan: pool.control(
            w,
            id.parse(v.planId),
            z.enum(['pause', 'resume', 'cancel', 'accept']).parse(v.action),
          ),
          interrupts: pool.interrupts(w, v.planId),
        };
      case 'pool_revise':
        return pool.revise(w, id.parse(v.planId), v.plan);
      case 'pool_recover':
        return pool.recover();
      case 'pool_interrupts':
        return pool.interrupts(w, id.parse(v.planId));
      case 'pool_leases':
        return pool.leases().filter((l) => l.workspace === w && l.planId === v.planId);
      case 'pool_tick':
        return pool.tick();
      case 'pool_guard':
        return pool.guard(id.parse(v.dispatchKey), v.progress);
      case 'pool_resolve':
        return pool.resolve(
          id.parse(v.dispatchKey),
          v.confirmedStopped === true,
          z.string().parse(v.note),
          v.observedRunning === true,
        );
    }
    fail('UNKNOWN_OPERATION', '不支持的 Pool 操作');
  },
  orchestrate(w: string, payload: Record<string, unknown>): unknown {
    if (payload.operation === 'context_read') {
      const task = this.task(w, id.parse(payload.taskId)),
        run = task.management!.runs.find((r) => r.id === payload.runId);
      if (
        !run ||
        !active(run) ||
        run.generation !== task.management!.generation ||
        run.requirementsRevision !== task.management!.currentRequirementsRevision
      )
        fail('STALE_RUN', '要求已变化，旧上下文不能发送');
      this.sourceCheck(w, task);
      return this.context(w, task);
    }
    if (payload.operation === 'context_original') {
      const task = this.task(w, id.parse(payload.taskId)),
        request = id.parse(payload.requestId);
      if (!task.management!.requestIds.includes(request)) fail('SOURCE_SCOPE', '原文不属于此工作');
      const row = this.db
        .prepare('SELECT body FROM work_requests WHERE workspace=? AND id=?')
        .get(w, request) as { body: string } | undefined;
      return row ? JSON.parse(row.body) : null;
    }
    if (String(payload.operation).startsWith('pool_')) return this.poolCommand(w, payload);
    if (payload.operation === 'return_assignment') return this.returnAssignment(w, payload);
    return String(payload.operation).startsWith('capacity_')
      ? this.capacity.command(w, payload)
      : this.intake.command(w, payload);
  }
};
