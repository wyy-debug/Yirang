import { confirmationPolicy, requiresDeliveryConfirmation } from '../../components/work-confirmation.mjs';
import { expectedDeliveryFormats, reviseDeliveryFormats, missingDeliveries } from '../../components/work-delivery.mjs';
import { BotCapacityStore } from '../bot/bot-capacity.js';
import { BotIntakeStore } from '../bot/bot-intake.js';
import { BotEventStore } from '../bot/bot-events.js';
import { AgentPoolStore } from '../agents/agent-pool.js';
import { legacyPlan } from '../agents/agent-plan.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fail, type WorkTask, type DesktopObject } from '../../contracts/index.js';
import {
  WorkCommand,
  WorkSchedule,
  WorkModelSettings,
  type WorkManagement,
  type WorkRun,
  type WorkGoal,
} from '../../contracts/work-management.js';
import { active, attachment, at, id, terminal, text, uid } from './work-conventions.js';
import { threadGuards, type ThreadGuardMethods } from './work-thread-guards.js';
import { taskStore, type TaskStoreMethods } from './work-task-store.js';
import { workViews, type WorkViewsMethods } from './work-views.js';
import { workOrchestration, type WorkOrchestrationMethods } from './work-orchestration.js';
import { decideContinuation } from './completion-policy.js';
import { continuationLimits } from '../../components/work-continuation-config.mjs';
import { retryDelayMs } from '../../components/work-retry.mjs';
import { completionObject } from './completion-object.js';
import { RepairBudgetStore } from './repair-budget.js';
export type Api = {
  tx: <T>(f: () => T) => T;
  once: <T>(w: string, id: string, p: unknown, f: () => T) => T;
  object: (w: string, id: string) => DesktopObject;
  event: (w: string, type: string) => void;
  materialText?: (w: string, id: string, revision: number) => string | null;
};
export class WorkManagementStore {
  readonly intake: BotIntakeStore;
  readonly botEvents: BotEventStore;
  readonly capacity: BotCapacityStore;
  readonly pool: AgentPoolStore;
  readonly repairBudget: RepairBudgetStore;
  constructor(
    public readonly db: DatabaseSync,
    public readonly api: Api,
  ) {
    this.repairBudget = new RepairBudgetStore(db);
    this.capacity = new BotCapacityStore(db);
    this.pool = new AgentPoolStore(db, {
      object: (w, id) => this.api.object(w, id) as any,
      ...(this.api.materialText ? { text: this.api.materialText } : {}),
    });
    this.intake = new BotIntakeStore(db, (w, c) => this.command(w, c, true, true));
    this.botEvents = new BotEventStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS work_requests(workspace TEXT NOT NULL,id TEXT NOT NULL,idempotency_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,id),UNIQUE(workspace,idempotency_key));
   CREATE TABLE IF NOT EXISTS work_claims(workspace TEXT NOT NULL,resource TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,generation INTEGER NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(workspace,resource));
   CREATE TABLE IF NOT EXISTS work_artifact_receipts(workspace TEXT NOT NULL,run_id TEXT NOT NULL,object_id TEXT NOT NULL,revision INTEGER NOT NULL,type TEXT NOT NULL,PRIMARY KEY(workspace,run_id,object_id,revision));
   CREATE TABLE IF NOT EXISTS work_runs(workspace TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT,state TEXT NOT NULL,PRIMARY KEY(workspace,id)); CREATE TABLE IF NOT EXISTS work_consultations(workspace TEXT NOT NULL,thread_id TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(workspace,thread_id));`);
    db.exec(
      'CREATE TABLE IF NOT EXISTS work_voice_coordinators(workspace TEXT NOT NULL,thread_id TEXT NOT NULL PRIMARY KEY)',
    );
    const columns = this.db.prepare('PRAGMA table_info(work_claims)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'base_revision'))
      db.exec(
        "ALTER TABLE work_claims ADD COLUMN base_revision INTEGER; ALTER TABLE work_claims ADD COLUMN mode TEXT NOT NULL DEFAULT 'write'",
      );
  }
  private initializeRepairBudget(w: string, t: WorkTask) {
    const m = t.management!;
    const root = m.parentTaskId || t.id;
    const revision = m.parentRequirementsRevision || m.currentRequirementsRevision;
    if (this.repairBudget.has(w, root, revision)) return;
    const previous = this.all(w).filter(item => {
      const state = item.management;
      return state && (item.id === root ? state.currentRequirementsRevision === revision :
        state.parentTaskId === root && state.parentRequirementsRevision === revision);
    }).flatMap(item => {
      const state = item.management!;
      const c = state.continuation;
      return c && c.revision === state.currentRequirementsRevision
        ? [{ taskId: item.id, attempts: c.attempts, spentMs: c.spentMs, grants: c.grants }] : [];
    });
    this.repairBudget.initialize(w, root, revision, previous);
  }
  command(w: string, input: unknown, host = false, inTransaction = false): any {
    const transaction: Api['tx'] = inTransaction
      ? (f) => {
          this.db.exec('SAVEPOINT work_nested');
          try {
            const value = f();
            this.db.exec('RELEASE work_nested');
            return value;
          } catch (error) {
            this.db.exec('ROLLBACK TO work_nested; RELEASE work_nested');
            throw error;
          }
        }
      : (f) => this.api.tx(f);
    if ((input as any)?.operation === 'bot_events') {
      if (!host) fail('HOST_REQUIRED', 'Bot 事件邮箱只能由可信宿主操作');
      return transaction(() => this.botEvents.command(w, (input as any).payload));
    }
    const p = WorkCommand.parse(input);
    if (p.operation === 'orchestration') {
      if (!host) fail('HOST_REQUIRED', '调度接收只能由可信宿主操作');
      return transaction(() => this.orchestrate(w, p.payload));
    }
    if (p.operation === 'pool') {
      const v = p.payload as Record<string, any>;
      if (
        ![
          'pool_list',
          'pool_detail',
          'pool_leases',
          'pool_confirm',
          'pool_control',
          'pool_resolve',
          'pool_followup',
        ].includes(v.operation)
      )
        fail('HOST_REQUIRED', '此操作只能由可信宿主执行');
      return transaction(() => this.poolCommand(w, v));
    }
    if (p.operation === 'reports') {
      if (!host) fail('HOST_REQUIRED', '此操作只能由可信宿主执行');
      return transaction(() => {
        const before = z.number().int().positive().optional().parse(p.payload.before);
        const rows = this.db
          .prepare(
            "SELECT rowid AS cursor,value FROM settings WHERE workspace=? AND key LIKE 'work-report:%' AND rowid<? ORDER BY rowid DESC LIMIT 100",
          )
          .all(w, before ?? Number.MAX_SAFE_INTEGER) as { cursor: number; value: string }[];
        return {
          workspaceId: w,
          events: rows.map((row) => JSON.parse(row.value)),
          nextCursor: rows.length === 100 ? rows.at(-1)!.cursor : null,
        };
      });
    }
    // Status lines change often. They live beside the task, not in it, so a
    // report never bumps the revision a user's pending action was based on.
    if (p.operation === 'progress') {
      if (!host) fail('HOST_REQUIRED', '执行回执只能由可信宿主登记');
      return transaction(() => {
        const t = this.task(w, id.parse(p.taskId)),
          m = t.management!,
          v = p.payload as Record<string, any>,
          run = m.runs.find((r) => r.id === v.runId);
        if (
          !run ||
          !active(run) ||
          run.generation !== m.generation ||
          run.requirementsRevision !== m.currentRequirementsRevision
        )
          fail('STALE_RUN', '此执行已结束，不能再汇报进度');
        const report = z
          .object({
            text: z.string().trim().min(1).max(80),
            step: z.number().int().min(0).max(999).optional(),
            total: z.number().int().min(1).max(999).optional(),
          })
          .strict()
          .parse({ text: v.text, step: v.step, total: v.total });
        this.put(w, `work-progress:${t.id}`, { ...report, runId: run.id, at: at() });
        this.api.event(w, 'worktask.updated');
        return { receipt: '已更新进度，继续工作' };
      });
    }
    if (p.operation === 'list')
      return transaction(() => ({
        ...this.view(w, p.payload.compact === true),
        ...(host ? { conversation: this.conversation(w) } : {}),
      }));
    if (p.operation === 'detail')
      return transaction(() => {
        const t = this.progress(w, this.task(w, id.parse(p.taskId)));
        this.refreshArtifacts(w, t);
        return t;
      });
    if (p.operation === 'review')
      return transaction(() => {
        const t = this.task(w, id.parse(p.taskId));
        if (t.revision !== p.expectedRevision) fail('REVISION_CONFLICT', '工作已更新，请刷新');
        return this.review(w, t);
      });
    if (
      [
        'delegate',
        'consult_bind',
        'consult_unbind',
        'voice_bind',
        'remind',
        'wait',
        'prepare',
        'dispatch',
        'ack',
        'finish',
        'recover',
        'reconcile',
        'completion_prepare',
        'recovery_budget',
        'suspend_for_exit',
        'execution_activity',
      ].includes(p.operation) &&
      !host
    )
      fail('HOST_REQUIRED', '执行回执只能由可信宿主登记');
    if (!p.requestId) fail('REQUEST_REQUIRED', '缺少幂等请求标识');
    return transaction(() => {
      const result = this.api.once(w, p.requestId!, p, () => {
        const v = p.payload;
        if (p.operation === 'execution_activity') {
          const t = this.task(w, id.parse(p.taskId));
          const r = t.management!.runs.find(r => r.id === v.runId);
          if (!r || !active(r)) return { recorded: false };
          const segment = z.string().uuid().parse(v.segment);
          const elapsed = z.number().finite().nonnegative().parse(v.elapsedMs);
          r.activitySegments ||= {};
          const previous = r.activitySegments[segment] || 0;
          if (elapsed <= previous) return { recorded: true };
          r.activeMs = (r.activeMs || 0) + elapsed - previous;
          r.activitySegments[segment] = elapsed;
          // Accounting must not repaint the desktop or invalidate user actions.
          this.put(w, `prototype-task:${t.id}`, t);
          return { recorded: true };
        }
        if (p.operation === 'suspend_for_exit') {
          const t = this.task(w, id.parse(p.taskId));
          const m = t.management!;
          const r = m.runs.find(r => r.id === v.runId);
          if (!r || !active(r) || ['paused', 'cancelled', 'pausing', 'cancelling'].includes(m.state)) return t;
          r.restartRequestedAt ||= at();
          return this.save(w, t, 'application_exit_requested', '', r.id);
        }
        if (p.operation === 'recovery_budget') {
          const t = this.task(w, id.parse(p.taskId));
          const m = t.management!;
          const run = m.runs.find(r => r.id === v.runId);
          if (!run) fail('NOT_FOUND', '原执行不存在');
          const root = m.parentTaskId || t.id;
          const revision = m.parentRequirementsRevision || run!.requirementsRevision;
          const key = `recovery:${run!.id}:${id.parse(v.key)}`;
          if (v.action === 'settle') {
            this.repairBudget.settle(w, root, revision, key,
              z.number().finite().nonnegative().parse(v.elapsedMs));
            return { settled: true };
          }
          if (v.action !== 'reserve') fail('INVALID_INPUT', '未知预算操作');
          if (run!.state !== 'unknown') return null;
          if (run!.requirementsRevision !== m.currentRequirementsRevision) return null;
          this.initializeRepairBudget(w, t);
          const allowance = this.repairBudget.reserveRecovery(w, root, revision, t.id, key);
          const reserved = m.continuation?.reservation;
          if (reserved) {
            const entry = this.repairBudget.read(w, root, revision).entries.find(e => e.key === reserved.key);
            if (entry && entry.allowanceMs !== reserved.allowanceMs) {
              reserved.allowanceMs = entry.allowanceMs;
              this.put(w, `prototype-task:${t.id}`, t);
            }
          }
          return allowance;
        }
        if (p.operation === 'notice_read') {
          const ids = z.array(id).max(1000).parse(v.ids);
          const read = this.get<string[]>(w, 'work-notices-read') || [];
          this.put(w, 'work-notices-read', [...new Set([...read, ...ids])].slice(-5000));
          return this.view(w);
        }
        if (p.operation === 'configure') {
          const policy = z
            .object({ maxConcurrent: z.number().int().min(1).max(5) })
            .strict()
            .parse(v);
          this.put(w, 'work-policy', policy);
          return this.view(w);
        }
        if (p.operation === 'voice_bind') {
          const thread = id.parse(v.threadId);
          this.db
            .prepare('INSERT OR REPLACE INTO work_voice_coordinators VALUES(?,?)')
            .run(w, thread);
          return { threadId: thread, workspaceId: w };
        }
        if (p.operation === 'consult_unbind') {
          const thread = id.parse(v.threadId);
          if (
            this.db.prepare('SELECT 1 FROM bot_slots WHERE thread_id=?').get(thread) ||
            this.db
              .prepare(
                "SELECT 1 FROM work_runs WHERE thread_id=? AND state IN ('starting','running','waiting','stopping','unknown')",
              )
              .get(thread)
          )
            fail('THREAD_ACTIVE', '原执行未结束，不能改变工具权限');
          this.db
            .prepare('DELETE FROM work_consultations WHERE workspace=? AND thread_id=?')
            .run(w, thread);
          return { released: true };
        }
        if (p.operation === 'consult_bind') {
          const thread = id.parse(v.threadId),
            requestId = id.parse(v.requestId);
          const row = this.db
            .prepare('SELECT body FROM work_requests WHERE workspace=? AND id=?')
            .get(w, requestId) as any;
          if (!row || JSON.parse(row.body).intent !== 'consult')
            fail('REQUEST_MISMATCH', '咨询来源无效');
          this.db
            .prepare('INSERT OR REPLACE INTO work_consultations VALUES(?,?,?)')
            .run(w, thread, requestId);
          if (v.turnId)
            this.put(w, 'consult-turn:' + id.parse(v.turnId), {
              threadId: thread,
              requestId,
              turnId: v.turnId,
              at: at(),
            });
          return { requestId, threadId: thread };
        }

        if (p.operation === 'remind') {
          const notices: string[] = [];
          this.db
            .prepare(
              "UPDATE work_claims SET expires=? WHERE workspace=? AND run_id IN (SELECT id FROM work_runs WHERE workspace=? AND state IN ('starting','running','waiting'))",
            )
            .run(Date.now() + 120000, w, w);
          for (const task of this.all(w)) {
            const m = task.management!;
            if (terminal(task) || m.legacy) continue;
            const s = m.schedule;
            let due = false;
            if (s.dueAt) due = Date.parse(s.dueAt) - Date.now() <= 30 * 60000;
            else if (s.dueDate) {
              const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: s.timezone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                hourCycle: 'h23',
              }).formatToParts(new Date());
              const get = (key: string) => parts.find((p) => p.type === key)?.value || '';
              const today = get('year') + '-' + get('month') + '-' + get('day');
              due = today > s.dueDate || (today === s.dueDate && Number(get('hour')) >= 9);
            }
            const key = String(s.dueAt || s.dueDate) + ':' + m.currentRequirementsRevision;
            if (due && m.dueNotice !== key) {
              m.dueNotice = key;
              this.save(w, task, 'deadline_notice', '交付时间提醒，不代表自动执行');
              notices.push(task.title + '：请检查交付进展');
            }
          }
          return { notices };
        }
        if (p.operation === 'prepare') {
          const t = this.task(w, id.parse(p.taskId));
          this.sourceCheck(w, t);
          const attachments = t.management!.requestIds.flatMap((key) => {
            const r = this.db
              .prepare('SELECT body FROM work_requests WHERE workspace=? AND id=?')
              .get(w, key) as any;
            return r ? JSON.parse(r.body).attachments || [] : [];
          });
          const sourceSnapshots = [
            ...new Set(
              t.management!.requestIds.flatMap((key) => {
                const r = this.db
                  .prepare('SELECT body FROM work_requests WHERE workspace=? AND id=?')
                  .get(w, key) as any;
                return r ? JSON.parse(r.body).sourceSnapshots || [] : [];
              }),
            ),
          ];
          return {
            task: t,
            context: this.context(w, t),
            attachments,
            sourceSnapshots,
            collaboration: this.results(w, t),
          };
        }

        if (p.operation === 'intake') {
          const q = z
            .object({
              text,
              dependencies: z.array(id).max(8).default([]),
              modelSettings: WorkModelSettings.optional(),
              provider: z.enum(['codex', 'gemini', 'custom-acp']).default('codex'),
              threadId: id.optional(),
              intent: z.enum(['task', 'consult']).default('task'),
              contextTaskId: id.optional(),
              sources: z
                .array(
                  z.object({
                    objectId: id,
                    revision: z.number().int().positive(),
                    selection: z.unknown().optional(),
                  }),
                )
                .max(20)
                .default([]),
              schedule: WorkSchedule.optional(),
              deliverables: z.string().max(6000).default(''),
              acceptanceCriteria: z.string().max(6000).default('按要求交付完整成果，保留真实文件与修改范围'),
              sourceSnapshots: z.array(id).max(8).default([]),
              attachments: z
                .array(
                  z.union([
                    z.object({
                      type: z.literal('image'),
                      mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
                      data: z.string().max(8000000),
                    }),
                    z.object({ type: z.literal('text'), text: z.string().max(50000) }),
                  ]),
                )
                .max(12)
                .default([]),
              deliveries: z.array(text).max(8).optional(),
              derivedFrom: id.optional(),
              goalId: id.optional(),
              entry: z.string().max(80).default('composer'),
            })
            .parse(v);
          if (q.sourceSnapshots.length && !host)
            fail('HOST_REQUIRED', '旧入口映射只能由工作宿主登记');
          let serialSource = false;
          for (const snapshotId of q.sourceSnapshots) {
            const snapshot = this.db
              .prepare('SELECT payload FROM snapshots WHERE id=? AND workspace=?')
              .get(snapshotId, w) as any;
            if (!snapshot) fail('STALE_INPUT', '原入口选区不存在，请重新选择');
            const bound =
              !!this.get(w, `comment-binding:${snapshotId}`) ||
              !!this.get(w, `workflow-binding:${snapshotId}`) ||
              !!this.get(w, `local-run:grant:${snapshotId}`);
            const owner = bound
              ? this.get<string>(w, `work-source-owner:${snapshotId}`)
              : undefined;
            if (owner)
              fail('SOURCE_ALREADY_ASSIGNED', '此入口已经关联工作，请在原工作补充，不能重复执行');
            serialSource ||=
              !!this.get(w, `workflow-binding:${snapshotId}`) ||
              !!this.get(w, `local-run:grant:${snapshotId}`);
          }
          if (Buffer.byteLength(JSON.stringify(q.attachments)) > 8000000)
            fail('CONTEXT_TOO_LARGE', '附件超过 8 MB，请减少图片');
          const upstream = q.dependencies.map((key) => this.task(w, key));
          for (const source of upstream) {
            if (source.management!.state !== 'completed')
              fail('DEPENDENCY_PENDING', '前置工作尚未验收');
            this.refreshArtifacts(w, source);
            for (const a of source.management!.artifacts.filter((a) => a.validity === 'current'))
              if (!q.sources.some((s) => s.objectId === a.objectId))
                q.sources.push({ objectId: a.objectId, revision: a.revision });
          }
          if (q.sources.length > 20) fail('CONTEXT_TOO_LARGE', '前置成果超过材料上限，请拆分工作');
          const deliveries = q.deliveries?.length ? q.deliveries : [q.text],
            taskIds = q.intent === 'task' ? deliveries.map(() => `worktask_${uid()}`) : [],
            requestId = uid(),
            taskId = taskIds[0];
          if (q.contextTaskId) this.task(w, q.contextTaskId);
          this.db.prepare('INSERT INTO work_requests VALUES(?,?,?,?)').run(
            w,
            requestId,
            p.requestId!,
            JSON.stringify({
              id: requestId,
              idempotencyKey: p.requestId,
              messageRef: { threadId: q.threadId || null, requestId: p.requestId },
              text: q.text,
              intent: q.intent,
              entry: q.entry,
              threadId: q.threadId,
              sourceSnapshots: q.sourceSnapshots,
              sources: q.sources,
              attachments: q.attachments,
              dependencies: q.dependencies,
              taskLinks: q.intent === 'consult' && q.contextTaskId ? [q.contextTaskId] : taskIds,
              at: at(),
            }),
          );
          const linkedTasks = q.contextTaskId && q.intent === 'consult' ? [q.contextTaskId] : taskIds;
          if (linkedTasks.length) {
            this.put(w, 'work-context-focus', { id: requestId, intent: q.intent, taskLinks: linkedTasks });
          }
          if (taskIds.length && this.all(w).length + taskIds.length > 1000)
            fail('TASK_LIMIT', '工作区最多保留 1000 项工作，请先归档');
          if (!taskId) return { requestId, taskId: null, receipt: '咨询已记录，不创建执行任务' };
          const sources = q.sources.map((s) => {
            const o = this.api.object(w, s.objectId);
            if (o.archived || o.policy?.private || o.revision !== s.revision)
              fail('STALE_INPUT', '引用材料已变化，请重新选择');
            return { ...s, title: o.title, kind: o.kind };
          });
          if (q.goalId) {
            const g = this.get<WorkGoal>(w, `work-goal:${q.goalId}`);
            if (!g || g.state !== 'active') fail('GOAL_INACTIVE', '目标不存在或已暂停');
            if (
              g.budget &&
              this.all(w).filter((t) => t.management!.goalId === g.id).length + deliveries.length >
                g.budget
            )
              fail('GOAL_BUDGET', '目标的工作数量预算已用完，请先调整预算');
          }
          const stamp = at(),
            schedule = q.schedule || WorkSchedule.parse({});
          const t: WorkTask = {
            id: taskId,
            title: q.text.split('\n')[0].slice(0, 120),
            goal: q.text,
            constraints: '',
            revision: 1,
            status: 'queued',
            step: 0,
            createdAt: stamp,
            updatedAt: stamp,
            archived: false,
            sources: sources as any,
            events: [],
            proposal: q.deliverables,
            budget: { maxSteps: 6, maxMinutes: 30, maxTokens: 20000 },
            writeObjectIds: [],
            usage: { demoSteps: 0, modelTokens: null, executionMs: null },
            retries: 0,
            management: {
              responsibilityVersion: 6,
              version: 1,
              modelSettings: q.modelSettings,
              derivedFrom: q.derivedFrom,
              goalId: q.goalId,
              provider: q.provider,
              state:
                schedule.notBefore && Date.parse(schedule.notBefore) > Date.now()
                  ? 'scheduled'
                  : 'queued',
              currentRequirementsRevision: 1,
              generation: 1,
              schedule,
              reason: '要求已保存，等待执行器接收',
              requirements: [
                {
                  sources: structuredClone(sources),
                  revision: 1,
                  goal: q.text,
                  confirmation: confirmationPolicy(q.text, undefined, requestId),
                  delivery: { formats: expectedDeliveryFormats({goal: q.text, deliverables: q.deliverables, sources}), sourceRequestId: requestId },
                  constraints: '',
                  deliverables: q.deliverables,
                  acceptanceCriteria: q.acceptanceCriteria,
                  sourceRequestId: requestId,
                  reason: '新交办',
                  at: stamp,
                },
              ],
              runs: [],
              artifacts: [],
              acceptances: [],
              dependencies: upstream.map((t) => ({
                taskId: t.id,
                revision: t.management!.currentRequirementsRevision,
                condition: 'accepted' as const,
              })),
              events: [],
              requestIds: [requestId],
              originThreadId: q.threadId,
              threadId: q.threadId,
              acceptancePolicy: 'manual',
            },
          };
          for (const snapshotId of q.sourceSnapshots)
            if (
              this.get(w, `comment-binding:${snapshotId}`) ||
              this.get(w, `workflow-binding:${snapshotId}`) ||
              this.get(w, `local-run:grant:${snapshotId}`)
            ) {
              if (deliveries.length > 1) fail('SOURCE_SCOPE', '评论或工作流一次只能关联一项工作');
              this.put(w, `work-source-owner:${snapshotId}`, taskId);
            }
          if (serialSource) t.management!.executionMode = 'serial';
          const tasks = deliveries.map((goal, index) => {
            const item = structuredClone(t);
            item.id = taskIds[index]!;
            item.title = goal.split('\n')[0]!.slice(0, 120);
            item.goal = goal;
            item.management!.requirements[0]!.goal = goal;
            return this.save(w, item, 'request_received', '新交办已持久保存');
          });
          return {
            requestId,
            taskId,
            task: tasks[0],
            taskIds,
            tasks,
            receipt: tasks.length > 1 ? `已拆分为 ${tasks.length} 项工作，共用原始要求` : '已接下',
          };
        }
        if (p.operation === 'goal_review') {
          const g = this.get<WorkGoal>(w, `work-goal:${id.parse(v.id)}`);
          if (!g) fail('NOT_FOUND', '目标不存在');
          if (g.revision !== v.expectedRevision) fail('REVISION_CONFLICT', '目标已变化，请刷新');
          const related = this.all(w).filter((t) => t.management!.goalId === g.id);
          related.forEach((t) => this.refreshArtifacts(w, t));
          const evidenceTasks = related
            .filter(
              (t) =>
                t.management!.state === 'completed' &&
                (t.management!.artifacts.some((a) => a.validity === 'current') ||
                  t.management!.acceptances.some(
                    (a) =>
                      a.requirementsRevision === t.management!.currentRequirementsRevision &&
                      a.textResults?.length,
                  )),
            )
            .map((t) => t.id);
          const blockers = related
            .filter((t) => ['attention', 'waiting', 'paused'].includes(t.management!.state))
            .map((t) => t.title + '：' + t.management!.reason);
          const criteria = g.criteria
            .split(/\n|[；;]/)
            .map((s) => s.trim())
            .filter(Boolean);
          const suggestion = blockers.length
            ? '先处理阻碍：' + blockers.join('；')
            : evidenceTasks.length
              ? '请对照以下成功标准核查已验收成果，指出仍缺的交付：' + criteria.join('；')
              : '收集并交付支持目标成功标准的证据：' + criteria.join('；');
          g.review = { at: at(), criteria, evidenceTasks, blockers, suggestion };
          g.nextStep = suggestion;
          g.revision++;
          g.history.push({ at: at(), description: '已检查当前成果版本；成功标准仍需逐项人工核实' });
          this.put(w, `work-goal:${g.id}`, g);
          this.api.event(w, 'worktask.updated');
          return g;
        }
        if (p.operation === 'goal_save') {
          const q = z
            .object({
              id: id.optional(),
              expectedRevision: z.number().int().optional(),
              title: z.string().trim().min(1).max(1000),
              description: z.string().max(6000).default(''),
              scope: z.string().max(6000).default(''),
              deadline: z.string().max(40).default(''),
              budget: z.number().int().min(1).max(1000).optional(),
              reviewAfter: z.string().max(40).default(''),
              criteria: text,
              nextStep: z.string().max(6000).default(''),
              state: z.enum(['active', 'paused', 'achieved', 'archived']).default('active'),
              evidence: z
                .array(
                  z.union([
                    z.object({ taskId: id, objectId: id, revision: z.number().int().positive() }),
                    z.object({ taskId: id, runId: id, hash: text }),
                  ]),
                )
                .default([]),
            })
            .parse(v);
          const old = q.id ? this.get<WorkGoal>(w, `work-goal:${q.id}`) : undefined;
          if (q.id && !old) fail('NOT_FOUND', '目标不存在');
          if (old && old.revision !== q.expectedRevision) fail('REVISION_CONFLICT', '目标已更新');
          if (q.state === 'achieved') {
            if (!q.evidence.length) fail('EVIDENCE_REQUIRED', '确认目标达成需要成果证据');
            for (const e of q.evidence) {
              const t = this.task(w, e.taskId),
                m = t.management!;
              if (m.state !== 'completed' || m.goalId !== q.id)
                fail('STALE_EVIDENCE', '目标证据不属于此目标或已过时');
              if ('runId' in e) {
                if (
                  !m.runs.some(
                    (r) =>
                      r.id === e.runId &&
                      r.resultHash === e.hash &&
                      r.requirementsRevision === m.currentRequirementsRevision &&
                      r.state === 'succeeded',
                  ) ||
                  !m.acceptances.some(
                    (a) =>
                      a.requirementsRevision === m.currentRequirementsRevision &&
                      a.textResults?.some((r) => r.runId === e.runId && r.hash === e.hash),
                  )
                )
                  fail('STALE_EVIDENCE', '文本成果尚未验收或已过时');
              } else {
                const o = this.api.object(w, e.objectId);
                if (
                  !m.artifacts.some(
                    (a) =>
                      a.objectId === e.objectId &&
                      a.revision === e.revision &&
                      a.validity === 'current',
                  ) ||
                  o.archived ||
                  o.revision !== e.revision
                )
                  fail('STALE_EVIDENCE', '目标证据不属于此目标或已过时');
              }
            }
          }
          const g: WorkGoal = {
            review: old?.criteria === q.criteria ? old.review : undefined,
            id: old?.id || uid(),
            title: q.title,
            description: q.description,
            scope: q.scope,
            deadline: q.deadline,
            budget: q.budget,
            reviewAfter: q.reviewAfter,
            criteria: q.criteria,
            nextStep: q.nextStep,
            state: q.state,
            evidence: q.evidence,
            revision: (old?.revision || 0) + 1,
            history: [
              ...(old?.history || []),
              { at: at(), description: q.title + ' · ' + q.state },
            ],
          };
          this.put(w, `work-goal:${g.id}`, g);
          this.api.event(w, 'worktask.updated');
          return g;
        }
        if (p.operation === 'recover') {
          for (const t of this.all(w)) {
            if (t.management!.restoredHistory) continue;
            let changed = false;
            for (const r of t.management!.runs)
              if (active(r) && r.state !== 'unknown') {
                r.state = 'unknown';
                r.reason = '宿主重启：需要核实上次执行结果';
                this.db
                  .prepare('UPDATE work_runs SET state=? WHERE workspace=? AND id=?')
                  .run('unknown', w, r.id);
                changed = true;
              }
            if (changed) {
              t.management!.state = 'attention';
              t.management!.reason = '需要核实上次执行结果；不会自动重放';
              this.save(w, t, 'recovery_required');
            }
          }
          return this.view(w);
        }
        if (!p.taskId) fail('TASK_REQUIRED', '请选择工作');
        const t = this.task(w, p.taskId!),
          m = t.management!;
        if (
          !['delegate', 'wait', 'dispatch', 'ack', 'finish', 'reconcile'].includes(p.operation) &&
          p.expectedRevision !== t.revision
        )
          fail('REVISION_CONFLICT', '工作已更新，请重新加载后操作');
        if (p.operation === 'delegate') {
          const run = m.runs.find((r) => r.id === v.runId);
          if (
            m.parentTaskId ||
            !run ||
            !active(run) ||
            run.generation !== m.generation ||
            run.requirementsRevision !== m.currentRequirementsRevision
          )
            fail('STALE_RUN', '此执行不能再分派工作');
          if (v.operation === 'clarify') {
            if (m.delegation) fail('PLAN_EXISTS', '已分工的要求请在现有工作中补充');
            const question = text.max(1200).parse(v.question),
              normalize = (value: string) => value.normalize('NFKC').replace(/[\s?？。.!！]/g, '');
            const answered = (m.answeredQuestions || [])
              .slice()
              .reverse()
              .find(
                (a) =>
                  a.revision === m.currentRequirementsRevision &&
                  normalize(a.question) === normalize(question),
              );
            if (answered)
              return {
                state: 'answered',
                ...answered,
                receipt: '用户已经回答，请使用此回答继续完成，不要再次提问',
              };
            if (
              !/[?？]|什么|哪|多少|是否|能否|吗|呢|请.*(?:提供|确认|选择|补充)|\b(?:what|which|when|where|how|please provide|please choose)\b/i.test(
                question,
              )
            )
              return {
                state: 'continue',
                receipt:
                  '这不是需要用户回答的问题。已收到的信息请直接用于完成工作；执行进度请用 report_status 汇报，不要作为提问。',
              };
            m.question = question;
            m.questionId = uid();
            m.reason = m.question;
            return this.save(w, t, 'clarification_requested', m.question);
          }
          if (m.delegation)
            return {
              children: m.delegation.children,
              receipt:
                m.delegation.phase === 'integrating'
                  ? '当前已经进入汇总。请检查分工结果并完成最终交付，不要再分派或等待。'
                  : '已安排，结束本回合后由宿主继续调度',
            };
          if (m.continuation?.revision === m.currentRequirementsRevision && m.continuation.next === 'repair')
            return { state: 'continue', receipt: '本轮只修复未通过的成果，沿用当前执行和剩余预算，不再创建新的分工。' };
          const jobs = z
            .array(
              z
                .object({
                  title: z.string().trim().min(1).max(100),
                  instructions: text.max(12000),
                  after: z.array(z.number().int().min(0)).max(3).default([]),
                })
                .strict(),
            )
            .min(2)
            .max(4)
            .parse(v.jobs);
          if (jobs.some((job, i) => job.after.some((n) => n >= i)))
            fail('DEPENDENCY_CYCLE', '子任务只可依赖排在前面的子任务');
          if (this.all(w).length + jobs.length > 1000) fail('TASK_LIMIT', '工作数量已到上限');
          if (process.env.YIRANG_AGENT_POOL === '1' && this.dailyOnly(w, t)) {
            // The main work's own integrating turn is the reduce step, so the pool plan holds only the workers.
            // Workers inherit the same readable materials and constraints the original child tasks would have received.
            const requirement = m.requirements.at(-1)!,
              readable = t.sources.filter((s) => {
                try {
                  const o = this.api.object(w, s.objectId) as any;
                  return !o.archived && !o.policy?.private && o.revision === s.revision;
                } catch {
                  return false;
                }
              });
            const selections = readable
              .filter((s) => s.selection)
              .map((s) => `${s.title}（v${s.revision}）选区：${JSON.stringify(s.selection)}`);
            const scope = [
              `原始目标：${requirement.goal || t.goal}`,
              t.constraints && `约束：${t.constraints}`,
              requirement.acceptanceCriteria && `验收标准：${requirement.acceptanceCriteria}`,
              selections.length ? selections.join('\n') : '',
              `要求版本：v${m.currentRequirementsRevision}`,
              '只完成本分工，不写回原文件；提供有依据的分析或草稿，由负责人整合。',
            ]
              .filter(Boolean)
              .join('\n')
              .slice(0, 6000);
            const legacy = legacyPlan({
              id: 'plan_' + uid(),
              workId: t.id,
              goal: requirement.goal || t.goal,
              jobs,
              model: {
                provider: m.provider || 'codex',
                account: 'default',
                model: m.modelSettings?.childModel || m.modelSettings?.model || 'default',
                effort: m.modelSettings?.childEffort ?? null,
              },
            });
            const spec = {
              ...legacy,
              scope,
              nodes: legacy.nodes
                .filter((n) => n.id !== 'reduce')
                .map((n) => ({
                  ...n,
                  inputRefs: readable
                    .slice(0, 64)
                    .map((s) => ({ objectId: s.objectId, revision: s.revision })),
                })),
              edges: legacy.edges.filter((e) => e.to !== 'reduce'),
            };
            const plan = this.pool.create(
              w,
              spec,
              'delegate:' + t.id + ':' + m.currentRequirementsRevision,
            );
            if (!plan.planId) fail('POOL_FULL', plan.reason || '尚未安排');
            m.delegation = {
              revision: m.currentRequirementsRevision,
              children: [],
              phase: 'waiting',
              poolPlanId: plan.planId,
            };
            m.reason = '已安排分工';
            this.save(w, t, 'work_delegated');
            return {
              children: [],
              planId: plan.planId,
              receipt:
                '分工已保存。结束本回合，不等待、不重复创建；宿主会并行执行并重新唤起你汇总。',
            };
          }
          const children = jobs.map(() => `worktask_${uid()}`),
            stamp = at();
          jobs.forEach((job, i) => {
            const child = structuredClone(t);
            child.id = children[i]!;
            child.title = job.title;
            child.goal = job.instructions;
            child.createdAt = stamp;
            child.updatedAt = stamp;
            child.revision = 1;
            child.status = 'queued';
            child.writeObjectIds = [];
            child.execution = undefined;
            child.events = [];
            child.management = {
              version: 1,
              modelSettings: m.modelSettings
                ? {
                    ...m.modelSettings,
                    model: m.modelSettings.childModel,
                    effort: m.modelSettings.childEffort,
                  }
                : undefined,
              parentTaskId: t.id,
              parentRequirementsRevision: m.currentRequirementsRevision,
              afterTasks: job.after.map((n) => children[n]!),
              provider: m.provider,
              executionMode: 'isolated',
              state: 'queued',
              currentRequirementsRevision: 1,
              generation: 1,
              schedule: { ...m.schedule },
              reason: '等待分工执行',
              requirements: [
                {
                  ...m.requirements.at(-1)!,
                  revision: 1,
                  goal: job.instructions,
                  constraints: `原始目标：${t.goal}\n${t.constraints}\n只完成本分工，不写回原文件；提供有依据的分析或草稿，由负责人整合。`,
                  reason: '自动分工',
                  at: stamp,
                },
              ],
              runs: [],
              artifacts: [],
              acceptances: [],
              dependencies: [],
              events: [],
              requestIds: [...m.requestIds],
              acceptancePolicy: 'manual',
            };
            this.save(w, child, 'subtask_created', t.id);
          });
          m.delegation = { revision: m.currentRequirementsRevision, children, phase: 'waiting' };
          m.reason = '已安排分工';
          this.save(w, t, 'work_delegated');
          return {
            children,
            receipt: '分工已保存。结束本回合，不等待、不重复创建；宿主会并行执行并重新唤起你汇总。',
          };
        }
        if (p.operation === 'objective_policy') {
          if (m.runs.some(active)) fail('RUN_ACTIVE', '先暂停执行，再设置客观检查');
          if (v.enabled === false) {
            m.objectiveCheck = undefined;
            return this.save(w, t, 'objective_policy_cleared');
          }
          const q = z.object({ objectId: id, replacement: z.string().max(50000) }).parse(v),
            source = t.sources.find((s) => s.objectId === q.objectId),
            o = this.api.object(w, q.objectId),
            range = source?.selection as any;
          if (
            !source ||
            o.archived ||
            o.policy?.private ||
            o.revision !== source.revision ||
            !['text', 'code'].includes(o.kind) ||
            !range ||
            !['text', 'code'].includes(range.type) ||
            range.baseRevision !== o.revision
          )
            fail('OBJECTIVE_SCOPE', '客观检查仅适用于当前版本的文字或代码精确选区');
          const content = structuredClone(o.content) as any,
            value = o.kind === 'text' ? content.blocks[0].text : content.code;
          if (
            !Number.isInteger(range.start) ||
            !Number.isInteger(range.end) ||
            range.start < 0 ||
            range.end < range.start ||
            range.end > value.length
          )
            fail('STALE_SELECTION', '文字范围已经失效');
          const expected = value.slice(0, range.start) + q.replacement + value.slice(range.end);
          if (o.kind === 'text') content.blocks[0].text = expected;
          else content.code = expected;
          m.objectiveCheck = {
            objectId: o.id,
            baseRevision: o.revision,
            requirementsRevision: m.currentRequirementsRevision,
            expectedHash: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
          };
          return this.save(
            w,
            t,
            'objective_policy_saved',
            '用户指定准确替换结果；同时核查选区外内容及其他来源版本，失败转人工验收',
          );
        }
        if (p.operation === 'execution_policy') {
          if (m.runs.some(active)) fail('RUN_ACTIVE', '请先暂停当前执行，再调整执行范围');
          m.executionMode = z.enum(['isolated', 'serial']).parse(v.mode);
          return this.save(w, t, 'execution_policy_changed', m.executionMode);
        }
        if (p.operation === 'goal_link') {
          const goalId = id.nullable().parse(v.goalId);
          if (goalId && !this.get(w, `work-goal:${goalId}`)) fail('NOT_FOUND', '目标不存在');
          m.goalId = goalId || undefined;
          return this.save(w, t, 'goal_linked');
        }
        if (p.operation === 'schedule') {
          m.schedule = WorkSchedule.parse(v);
          m.dueNotice = undefined;
          return this.save(w, t, 'schedule_updated', '交付期限与最早开始独立保存');
        }
        if (p.operation === 'dependencies') {
          const deps = z.array(id).max(30).parse(v.taskIds);
          const visit = (key: string, seen = new Set<string>()): boolean => {
            if (key === t.id) return true;
            if (seen.has(key)) return false;
            seen.add(key);
            return this.task(w, key).management!.dependencies.some((d) => visit(d.taskId, seen));
          };
          if (deps.some((d) => visit(d))) fail('DEPENDENCY_CYCLE', '前置工作不能形成循环');
          const explicit = z
            .array(z.object({ taskId: id, objectId: id, revision: z.number().int().positive() }))
            .max(30)
            .parse(v.artifacts || []);
          if (explicit.some((d) => visit(d.taskId)))
            fail('DEPENDENCY_CYCLE', '成果依赖不能形成循环');
          m.dependencies = [
            ...deps.map((key) => ({
              taskId: key,
              revision: this.task(w, key).management!.currentRequirementsRevision,
              condition: 'accepted' as const,
            })),
            ...explicit.map((d) => {
              const upstream = this.task(w, d.taskId);
              this.refreshArtifacts(w, upstream);
              if (
                !upstream.management!.acceptances.some(
                  (a) =>
                    a.requirementsRevision === upstream.management!.currentRequirementsRevision &&
                    a.artifacts.some((a) => a.objectId === d.objectId && a.revision === d.revision),
                )
              )
                fail('UNPUBLISHED_ARTIFACT', '只可引用已验收发布的明确成果版本');
              return {
                taskId: d.taskId,
                revision: upstream.management!.currentRequirementsRevision,
                condition: 'artifact' as const,
                objectId: d.objectId,
                objectRevision: d.revision,
              };
            }),
          ];
          return this.save(w, t, 'dependencies_updated');
        }
        if (p.operation === 'revise') {
          const continuing = v.continueRun === true && host &&
            (!m.provider || m.provider === 'codex') && !m.delegation &&
            m.runs.filter(active).length === 1
            ? m.runs.find(r => r.state === 'running' && r.turnId && r.threadId !== 'pending')
            : undefined;
          const stamp = Date.now(),
            openedAt = m.revisionWindow?.openedAt ?? stamp;
          m.revisionWindow = {
            openedAt,
            lastAt: stamp,
            readyAt: Math.min(openedAt + 5000, stamp + 2000),
          };
          const previousQuestion = m.question;
          this.stopChildren(w, t, 'cancel');
          m.delegation = undefined;
          m.question = undefined;
          m.questionId = undefined;
          const q = z
            .object({
              text,
              attachments: z.array(attachment).max(12).default([]),
              sources: z
                .array(
                  z.object({
                    objectId: id,
                    revision: z.number().int().positive(),
                    selection: z.unknown().optional(),
                  }),
                )
                .max(20)
                .optional(),
              goal: text.optional(),
              constraints: z.string().max(6000).optional(),
              deliverables: z.string().max(6000).optional(),
              acceptanceCriteria: z.string().max(6000).optional(),
              anchor: z
                .object({
                  objectId: id,
                  revision: z.number().int().positive(),
                  range: z.unknown().optional(),
                })
                .optional(),
            })
            .parse(v);
          if (m.state === 'cancelled') fail('TASK_CANCELLED', '已取消的工作请另建交办');
          if (q.anchor) {
            const o = this.api.object(w, q.anchor.objectId);
            if (o.archived || o.revision !== q.anchor.revision)
              fail('STALE_SELECTION', '旧版本选区已失效，请重新定位，不会扩大修改范围');
          }
          if (Buffer.byteLength(JSON.stringify(q.attachments)) > 8000000)
            fail('CONTEXT_TOO_LARGE', '附件超过 8 MB');
          if (previousQuestion)
            m.answeredQuestions = [
              ...(m.answeredQuestions || []),
              {
                question: previousQuestion,
                answer: q.text,
                revision: m.currentRequirementsRevision + 1,
              },
            ];
          const requestId = uid();
          this.db.prepare('INSERT INTO work_requests VALUES(?,?,?,?)').run(
            w,
            requestId,
            p.requestId!,
            JSON.stringify({
              id: requestId,
              idempotencyKey: p.requestId,
              text: q.text,
              sources: q.sources,
              attachments: q.attachments,
              intent: 'correction',
              taskLinks: [t.id],
              anchor: q.anchor,
              at: at(),
            }),
          );
          this.put(w, 'work-context-focus', {
            id: requestId,
            intent: 'correction',
            taskLinks: [t.id],
          });
          if (q.sources !== undefined) {
            t.sources = q.sources.map((s) => {
              const o = this.api.object(w, s.objectId);
              if (o.archived || o.policy?.private || o.revision !== s.revision)
                fail('STALE_INPUT', '修订材料已变化');
              return { ...s, title: o.title, kind: o.kind } as any;
            });
          }
          if (q.anchor) {
            const o = this.api.object(w, q.anchor.objectId);
            if (o.policy?.private) fail('MATERIAL_UNAVAILABLE', '该材料不可引用');
            t.sources = [
              ...t.sources.filter((s) => s.objectId !== o.id),
              {
                objectId: o.id,
                revision: o.revision,
                title: o.title,
                kind: o.kind,
                ...(q.anchor.range ? { selection: q.anchor.range } : {}),
              } as any,
            ];
          }
          const previous = m.requirements.at(-1)!;
          m.objectiveCheck = undefined;
          m.currentRequirementsRevision++;
          m.responsibilityVersion = 6;
          m.generation++;
          m.requestIds.push(requestId);
          m.requirements.push({
            ...previous,
            confirmation: confirmationPolicy([q.text, q.constraints].filter(Boolean).join('\n'),
              previous.confirmation || { required: requiresDeliveryConfirmation(m) }, requestId),
            delivery: { formats: reviseDeliveryFormats(previous, q.text,
              q.deliverables !== undefined ? { deliverables: q.deliverables } : undefined), sourceRequestId: requestId },
            sources: structuredClone(t.sources),
            goal: q.goal || previous.goal + '\n\n补充要求：' + q.text,
            constraints: q.constraints ?? previous.constraints,
            deliverables: q.deliverables ?? previous.deliverables,
            acceptanceCriteria: q.acceptanceCriteria ?? previous.acceptanceCriteria,
            anchor: q.anchor,
            revision: m.currentRequirementsRevision,
            reason: q.text,
            sourceRequestId: requestId,
            at: at(),
          });
          t.goal = m.requirements.at(-1)!.goal;
          t.constraints = m.requirements.at(-1)!.constraints;
          m.artifacts.forEach((a) => (a.validity = 'stale'));
          if (continuing) {
            continuing.generation = m.generation;
            continuing.requirementsRevision = m.currentRequirementsRevision;
            m.revisionWindow = undefined;
            m.state = 'running';
            m.reason = '补充要求已保存，正在交给当前执行';
            return this.save(w, t, 'requirements_revised', q.text);
          }
          m.state = 'revising';
          m.reason = m.runs.some(active)
            ? '新要求已保存；等待旧执行安全停止并接收修订'
            : '补充要求已保存，将在同一工作中开始下一轮';
          for (const r of m.runs) if (active(r) && r.state !== 'unknown') r.state = 'stopping';
          return this.save(w, t, 'requirements_revised', q.text);
        }
        if (p.operation === 'handoff') {
          if (m.runs.some(active))
            fail('RUN_ACTIVE', '先暂停并核实旧执行已停止，再交接；已写入文件不会撤销');
          const target = this.task(w, id.parse(v.targetTaskId)),
            tm = target.management!;
          if (
            target.id === t.id ||
            target.revision !== v.targetRevision ||
            terminal(target) ||
            tm.runs.some(active)
          )
            fail('REVISION_CONFLICT', '接收工作已变化或正在运行');
          const explanation = text.parse(v.explanation),
            previous = tm.requirements.at(-1)!,
            requestId = uid();
          this.db.prepare('INSERT INTO work_requests VALUES(?,?,?,?)').run(
            w,
            requestId,
            p.requestId!,
            JSON.stringify({
              id: requestId,
              idempotencyKey: p.requestId,
              text: explanation,
              intent: 'handoff',
              originInputId: this.get<any>(w, 'bot-last-return:' + t.id)?.requestId,
              fromTaskId: t.id,
              taskLinks: [target.id],
              sources: t.sources,
              at: at(),
            }),
          );
          this.put(w, 'work-context-focus', {
            id: requestId,
            intent: 'handoff',
            taskLinks: [target.id],
          });
          tm.requestIds.push(requestId);
          tm.artifacts.forEach((a) => (a.validity = 'stale'));
          tm.currentRequirementsRevision++;
          tm.generation++;
          tm.handoffFrom = t.id;
          tm.requirements.push({
            ...previous,
            sourceRequestId: requestId,
            revision: tm.currentRequirementsRevision,
            goal: previous.goal + '\n交接：' + explanation,
            reason: explanation,
            at: at(),
          });
          for (const source of [
            ...t.sources,
            ...m.artifacts
              .filter((a) => a.validity === 'current')
              .map((a) => ({
                objectId: a.objectId,
                revision: a.revision,
                title: a.title,
                kind: this.api.object(w, a.objectId).kind,
              })),
          ])
            if (!target.sources.some((s) => s.objectId === source.objectId))
              target.sources.push(source as any);
          tm.state = 'queued';
          tm.reason = '已接收交接；保留原文件及旧执行历史';
          target.goal = tm.requirements.at(-1)!.goal;
          m.state = 'paused';
          m.reason = '已交接，不自动撤销旧写入';
          this.save(w, target, 'handoff_received', explanation);
          return this.save(w, t, 'handoff_sent', target.id);
        }
        if (p.operation === 'reassign') {
          const requestId = id.parse(v.requestId),
            target = this.task(w, id.parse(v.targetTaskId));
          if (target.id === t.id || terminal(target) || target.revision !== v.targetRevision)
            fail('REVISION_CONFLICT', '目标工作已变化，请重新选择');
          if (m.requestIds.length !== 1)
            fail('HANDOFF_REQUIRED', '此工作已有多条要求，请通过修订明确交接范围');
          if (m.runs.length || target.management!.runs.length)
            fail(
              'HANDOFF_REQUIRED',
              '已有执行或写入：请停止并检查成果后进行明确交接，不自动撤销写入',
            );
          const row = this.db
            .prepare('SELECT body FROM work_requests WHERE workspace=? AND id=?')
            .get(w, requestId) as any;
          if (!row) fail('NOT_FOUND', '原要求不存在');
          const req = JSON.parse(row.body);
          if (!m.requestIds.includes(requestId)) fail('REQUEST_MISMATCH', '要求不属于此工作'); // Request body remains immutable; task associations and their events record the transfer.
          m.requestIds = m.requestIds.filter((key) => key !== requestId);
          if (!m.requestIds.length) {
            m.state = 'cancelled';
            m.reason = '要求已转交';
          }
          target.management!.requestIds.push(requestId);
          for (const source of t.sources)
            if (!target.sources.some((s) => s.objectId === source.objectId))
              target.sources.push(source);
          const rev = target.management!.requirements.at(-1)!;
          target.management!.currentRequirementsRevision++;
          target.management!.generation++;
          target.goal = rev.goal + '\n' + req.text;
          target.management!.requirements.push({
            ...rev,
            revision: target.management!.currentRequirementsRevision,
            goal: rev.goal + '\n' + req.text,
            sourceRequestId: requestId,
            reason: '用户更改归属',
            at: at(),
          });
          this.save(w, target, 'request_reassigned', req.text);
          return this.save(w, t, 'request_reassigned', '已转交，原文保留');
        }
        if (p.operation === 'control') {
          const action = z.enum(['pause', 'cancel', 'resume', 'archive']).parse(v.action);
          const running = m.runs.some(active);
          this.stopChildren(w, t, action);
          if (action === 'archive') {
            if (!terminal(t) || running)
              fail('INVALID_STATE', '仅已结束且没有活动执行的工作可归档');
            t.archived = true;
            return this.save(w, t, 'task_archived');
          }
          if (action === 'resume') {
            if (m.state !== 'paused' && m.state !== 'attention')
              fail('INVALID_STATE', '当前工作不需要继续');
            if (running) fail('RECONCILIATION_REQUIRED', '先核实上次执行结果');
            this.sourceCheck(w, t);
            if (host && m.continuation?.revision === m.currentRequirementsRevision && m.continuation.next === 'blocked') {
              this.initializeRepairBudget(w, t);
              const c = m.continuation;
              c.grants = [...(c.grants || []), { at: at(), attempts: continuationLimits.attempts, activeMs: continuationLimits.activeMs }];
              c.repeats = 0;
              c.fingerprint = '';
              c.next = 'repair';
              this.repairBudget.grant(w, m.parentTaskId || t.id,
                m.parentRequirementsRevision || m.currentRequirementsRevision, p.requestId!);
              const rootTaskId = m.parentTaskId || t.id;
              const rootRevision = m.parentRequirementsRevision || m.currentRequirementsRevision;
              const key = `resume:${p.requestId}`;
              const reservation = this.repairBudget.reserve(w, rootTaskId, rootRevision, t.id, key);
              if (!reservation) fail('BUDGET_EXHAUSTED', '修复预算已耗尽');
              c.reservation = { rootTaskId, rootRevision, key, allowanceMs: reservation.allowanceMs };
            }
            m.state = 'queued';
            m.reason = '等待安排';
          } else {
            m.state = running
              ? action === 'pause'
                ? 'pausing'
                : 'cancelling'
              : action === 'pause'
                ? 'paused'
                : 'cancelled';
            m.generation++;
            m.reason =
              typeof v.reason === 'string'
                ? v.reason.slice(0, 1000)
                : running
                  ? '等待执行器确认停止'
                  : '用户' + (action === 'pause' ? '暂停' : '取消');
            for (const r of m.runs) if (active(r) && r.state !== 'unknown') r.state = 'stopping';
          }
          return this.save(w, t, 'control_requested', action);
        }
        if (p.operation === 'accept') {
          this.refreshArtifacts(w, t);
          const q = z
            .object({
              requirementsRevision: z.number().int(),
              artifacts: z.array(z.object({ objectId: id, revision: z.number().int().positive() })),
              textResults: z.array(z.object({ runId: id, hash: text })).default([]),
              evidence: text,
              criteriaChecks: z.array(z.string().max(6000)).max(100),
              scopeConfirmed: z.literal(true),
            })
            .parse(v);
          const criteria = m.requirements
            .at(-1)!
            .acceptanceCriteria.split(/\n|[；;]/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (JSON.stringify(criteria) !== JSON.stringify(q.criteriaChecks))
            fail('STALE_ACCEPTANCE', '请逐项核实当前验收标准与修改范围');
          const actual = m.artifacts
            .filter((a) => a.validity === 'current')
            .map((a) => ({ objectId: a.objectId, revision: a.revision }));
          const canonical = (a: any[]) =>
            JSON.stringify([...a].sort((x, y) => x.objectId.localeCompare(y.objectId)));
          const texts = m.runs
            .filter(
              (r) =>
                r.state === 'succeeded' &&
                r.requirementsRevision === m.currentRequirementsRevision &&
                r.resultHash,
            )
            .map((r) => ({ runId: r.id, hash: r.resultHash }));
          if (JSON.stringify(texts) !== JSON.stringify(q.textResults))
            fail('STALE_ACCEPTANCE', '文本成果版本已变化');
          if (
            m.state !== 'review' ||
            m.runs.some(active) ||
            q.requirementsRevision !== m.currentRequirementsRevision ||
            (!actual.length && !texts.length) ||
            canonical(actual) !== canonical(q.artifacts)
          )
            fail('STALE_ACCEPTANCE', '要求或成果已变化，请重新检查当前版本');
          m.acceptances.push({ ...q, actor: 'human', at: at() });
          m.state = 'completed';
          m.reason = '用户已确认当前要求与成果版本';
          return this.save(w, t, 'task_accepted', q.evidence);
        }
        if (p.operation === 'dispatch') {
          if (m.revisionWindow && Date.now() < m.revisionWindow.readyAt)
            return { task: t, waiting: true, resumeAt: m.revisionWindow.readyAt };
          const q = z
            .object({
              threadId: id,
              provider: id,
              dispatchKey: id,
              controlled: z.boolean().default(false),
            })
            .parse(v);
          const prior = m.runs.find((r) => r.dispatchKey === q.dispatchKey);
          if (prior) return { task: t, run: prior };
          if (m.parentTaskId) {
            const parent = this.task(w, m.parentTaskId),
              pm = parent.management!;
            if (
              pm.currentRequirementsRevision !== m.parentRequirementsRevision ||
              !pm.delegation?.children.includes(t.id) ||
              ['paused', 'pausing', 'cancelled', 'cancelling'].includes(pm.state) ||
              pm.runs.some(active)
            )
              return { task: t, waiting: true };
            if ((m.afterTasks || []).some((key) => !this.resultReady(this.task(w, key))))
              return { task: t, waiting: true };
          }
          if (
            m.delegation?.phase === 'waiting' &&
            !m.runs.some(active) &&
            !['paused', 'pausing', 'cancelled', 'cancelling'].includes(m.state)
          ) {
            if (m.delegation.poolPlanId) {
              const plan = this.pool.detail(w, m.delegation.poolPlanId);
              if (!['review', 'completed', 'failed'].includes(plan.state)) {
                const blocked =
                    ['needs_input', 'paused', 'interrupted', 'unknown'].includes(plan.state) ||
                    plan.nodes.some((n) => ['waiting_user', 'unknown'].includes(n.state)),
                  state = blocked ? 'attention' : 'waiting',
                  asking = plan.nodes.find((n: any) => n.state === 'waiting_user' && n.question),
                  reason = asking
                    ? `${asking.spec.title} 需要你回答：${asking.question!.text}（请在"并行计划"中回答）`
                    : blocked
                      ? plan.reason
                      : '各项分工正在处理';
                if (m.state !== state || m.reason !== reason) {
                  m.state = state;
                  m.reason = reason;
                  this.save(w, t, 'delegation_waiting');
                }
                return { task: t, waiting: true };
              }
            }
            const children = m.delegation.children.map((key) => this.task(w, key));
            if (!children.every((child) => this.resultReady(child))) {
              const blocked = children.find((child) =>
                  ['attention', 'paused', 'cancelled'].includes(child.management!.state),
                ),
                state = blocked ? 'attention' : 'waiting',
                reason = blocked
                  ? `${blocked.title}：${blocked.management!.reason}`
                  : '各项分工正在处理';
              if (m.state !== state || m.reason !== reason) {
                m.state = state;
                m.reason = reason;
                this.save(w, t, 'delegation_waiting');
              }
              return { task: t, waiting: true };
            }
            m.delegation.phase = 'integrating';
            m.state = 'queued';
            m.reason = '分工已返回，正在汇总与检查';
          }
          if (
            terminal(t) ||
            ['paused', 'pausing', 'cancelling', 'review', 'attention'].includes(m.state)
          )
            fail('NOT_ELIGIBLE', '工作尚不具备执行条件');
          if (m.runs.some(active)) fail('RUN_ACTIVE', '上次执行尚未结束');
          if (m.schedule.notBefore && Date.parse(m.schedule.notBefore) > Date.now()) {
            m.state = 'scheduled';
            m.reason = '尚未到最早开始时间；需保持执行宿主可用';
            this.save(w, t, 'resource_waiting');
            return { task: t, waiting: true };
          }
          const dep = m.dependencies.find((d) => {
            const upstream = this.task(w, d.taskId);
            this.refreshArtifacts(w, upstream);
            return d.condition === 'artifact'
              ? !upstream.management!.artifacts.some(
                  (a) =>
                    a.objectId === d.objectId &&
                    a.revision === d.objectRevision &&
                    a.validity === 'current',
                )
              : upstream.management!.state !== 'completed' ||
                  upstream.management!.currentRequirementsRevision !== d.revision;
          });
          const all = this.all(w),
            running = all.flatMap((x) => x.management!.runs).filter(active);
          const globalRows = this.db
            .prepare(
              "SELECT workspace,task_id,id FROM work_runs WHERE state IN ('starting','running','waiting','stopping','unknown')",
            )
            .all() as { workspace: string; task_id: string; id: string }[];
          const globalRuns = globalRows
            .map(
              (row) =>
                this.task(row.workspace, row.task_id).management!.runs.find(
                  (r) => r.id === row.id,
                )!,
            )
            .filter(Boolean);
          const family = m.parentTaskId || t.id,
            familyBusy = all
              .filter((x) => (x.management!.parentTaskId || x.id) === family)
              .flatMap((x) => x.management!.runs)
              .filter(active).length;
          const capacity = this.capacity.counts();
          if (capacity.total >= 7 || capacity.background >= 5 || familyBusy >= 3)
            return { task: t, waiting: true };
          const reason = dep
            ? '等待前置工作验收或重新确认依赖版本'
            : running.length >= Math.min(5, this.get<any>(w, 'work-policy')?.maxConcurrent || 5)
              ? '等待执行容量'
              : capacity.slots.some((s) => s.role === 'background') ||
                  globalRuns.some((r) => !r.controlled) ||
                  (!q.controlled && globalRuns.length)
                ? '当前 CLI 可直接写文件，未隔离的执行采用串行'
                : '';
          if (reason) {
            if (m.state !== 'waiting' || m.reason !== reason) {
              m.state = 'waiting';
              m.reason = reason;
              this.save(w, t, 'resource_waiting');
            }
            return { task: t, waiting: true };
          }
          try {
            this.sourceCheck(w, t);
          } catch (error) {
            m.state = 'attention';
            m.reason = (error as Error).message;
            this.save(w, t, 'input_invalid', m.reason);
            return { task: t, waiting: true };
          }
          const resources = [
            ...new Set(
              (q.controlled
                ? t.sources.filter((s) => t.writeObjectIds.includes(s.objectId))
                : t.sources
              ).map((s) => this.resource(w, this.api.object(w, s.objectId))),
            ),
          ].sort();
          if (
            resources.some((resource) =>
              this.db
                .prepare('SELECT 1 FROM work_claims WHERE workspace=? AND resource=?')
                .get(w, resource),
            )
          ) {
            m.state = 'waiting';
            m.reason = '等待材料写入资格（含需要核实的旧执行）';
            this.save(w, t, 'resource_waiting');
            return { task: t, waiting: true };
          }
          const r: WorkRun = {
            modelSettings: m.modelSettings ? structuredClone(m.modelSettings) : undefined,
            controlled: q.controlled,
            id: uid(),
            taskId: t.id,
            provider: q.provider,
            threadId: q.threadId,
            dispatchKey: q.dispatchKey,
            generation: m.generation,
            requirementsRevision: m.currentRequirementsRevision,
            appliedRequirementsRevision: null,
            state: 'starting',
            createdAt: at(),
            activeMs: 0,
          };
          r.submission = { operationId: `${t.id}:${m.currentRequirementsRevision}`, attemptId: r.id,
            requestDigest: createHash('sha256').update(JSON.stringify(m.requirements.at(-1))).digest('hex'), state: 'prepared' };
          for (const resource of resources)
            this.db
              .prepare(
                'INSERT INTO work_claims(workspace,resource,task_id,run_id,generation,expires) VALUES(?,?,?,?,?,?)',
              )
              .run(w, resource, t.id, r.id, r.generation, Date.now() + 120000);
          this.db
            .prepare('INSERT INTO work_runs VALUES(?,?,?,?,?,?)')
            .run(w, r.id, t.id, q.threadId, null, r.state);
          m.runs.push(r);
          m.revisionWindow = undefined;
          m.threadId = q.threadId;
          m.state = 'running';
          m.reason = '已派发，等待执行器确认';
          this.save(w, t, 'run_dispatched', '', r.id);
          return { task: t, run: r };
        }
        const run = m.runs.find((r) => r.id === v.runId);
        if (!run) fail('RUN_NOT_FOUND', '执行归属不匹配');
        if (p.operation === 'wait') {
          if (run.generation !== m.generation || !active(run)) return t;
          const waiting = z.boolean().parse(v.waiting);
          if (waiting && !run.waitingSince) run.waitingSince = at();
          if (!waiting && run.waitingSince) {
            run.waitingMs = (run.waitingMs || 0) + Math.max(0, Date.now() - Date.parse(run.waitingSince));
            run.waitingSince = undefined;
          }
          run.state = waiting ? 'waiting' : 'running';
          m.state = waiting ? 'attention' : 'running';
          m.reason = waiting ? '需要用户回答或授权；请打开执行对话' : '执行器已继续';
          this.db
            .prepare('UPDATE work_runs SET state=? WHERE workspace=? AND id=?')
            .run(run.state, w, run.id);
          return this.save(
            w,
            t,
            waiting ? 'user_input_required' : 'user_input_received',
            m.reason,
            run.id,
          );
        }
        if (p.operation === 'ack') {
          if (v.recovered === true) {
            if (run.turnId === v.turnId && run.threadId === v.threadId &&
                run.submission?.state === 'received') return t;
            if (run.state !== 'unknown' || run.turnId || run.reception ||
                run.submission?.state !== 'possibly_sent' ||
                run.threadId !== v.threadId || !v.turnId)
              fail('RUN_STATE', '原执行回执与待核实运行不匹配');
            run.turnId = id.parse(v.turnId);
            run.submittedRequirementsRevision = run.requirementsRevision;
            run.reception = { turnId: run.turnId, receivedAt: at() };
            run.submission.state = 'received';
            run.submission.turnId = run.turnId;
            this.db.prepare(
              'UPDATE work_runs SET turn_id=? WHERE workspace=? AND id=?',
            ).run(run.turnId, w, run.id);
            return this.save(w, t, 'run_receipt_recovered', '', run.id);
          }
          if (v.reconnect === true) {
            if (m.responsibilityVersion !== 6 || run.state !== 'unknown' ||
                run.threadId !== v.threadId || run.turnId !== v.turnId ||
                run.generation !== m.generation || run.requirementsRevision !== m.currentRequirementsRevision ||
                ['cancelled', 'cancelling', 'paused', 'pausing', 'revising'].includes(m.state))
              fail('RUN_STATE', '原执行已变化，不能重新接续');
            run.state = 'running';
            run.endedAt = undefined;
            run.activityUnobserved = true;
            m.state = 'running';
          }
          if (run.state !== 'starting' && run.state !== 'running') {
            if (run.turnId && run.turnId === v.turnId) return t;
            fail('RUN_STATE', '执行已结束或已停止');
          }
          if (v.modelSettings) {
            run.modelSettings = WorkModelSettings.parse(v.modelSettings);
            m.modelSettings ||= run.modelSettings;
          }
          if (v.submitting === true && run.submission) run.submission.state = 'possibly_sent';
          run.threadId = id.parse(v.threadId);
          m.threadId = run.threadId;
          if (v.outputDirectory) run.outputDirectory = text.parse(v.outputDirectory);
          if (v.turnId) {
            run.turnId = id.parse(v.turnId);
            run.submittedRequirementsRevision = v.requirementsRevision == null
              ? run.requirementsRevision
              : z.number().int().positive().max(run.requirementsRevision).parse(v.requirementsRevision);
            run.reception = { turnId: run.turnId, receivedAt: at() };
            if (run.submission) { run.submission.state = 'received'; run.submission.turnId = run.turnId; }
            run.state = 'running';
            m.reason = '执行器已接收输入，尚不代表要求已落实';
          }
          this.db
            .prepare(
              'UPDATE work_runs SET thread_id=?,turn_id=?,state=? WHERE workspace=? AND id=?',
            )
            .run(run.threadId, run.turnId || null, run.state, w, run.id);
          return this.save(w, t, v.turnId ? 'run_acknowledged' : 'run_bound', '', run.id);
        }
        if (p.operation === 'finish' || p.operation === 'reconcile') {
          const q = z
            .object({
              runId: id,
              state: z.enum(['succeeded', 'failed', 'interrupted', 'unknown']),
              resultText: z.string().max(100000).optional(),
              reason: z.string().max(6000).default(''),
              batchId: id.optional(),
              notReceived: z.boolean().optional(),
              retryableTransport: z.boolean().optional(),
              restartSafe: z.boolean().optional(),
              retryAfterMs: z.number().finite().nonnegative().max(8640000000000000 - Date.now()).optional(),
              completionEvidence: z.array(z.object({
                objectId: id, revision: z.number().int().positive(),
                status: z.enum(['passed', 'failed', 'unknown']), code: z.string(), detail: z.string(), hash: z.string().optional(),
                criterion: z.object({ id: z.string(), source: z.string(), description: z.string() }).optional(),
              })).max(500).optional(),
              artifacts: z
                .array(z.object({ objectId: id, revision: z.number().int().positive() }))
                .max(500)
                .default([]),
              retainedArtifacts: z.array(z.object({ objectId: id,
                revision: z.number().int().positive() })).max(500).default([]),
            })
            .parse(v);
          if (!active(run)) return t;
          // Persist the distinction before processing the CLI interrupt receipt.
          // Keep claims until the next host observes the original terminal turn.
          if (p.operation === 'finish' && q.state === 'interrupted' && run.restartRequestedAt &&
              !['paused', 'cancelled', 'pausing', 'cancelling'].includes(m.state)) q.state = 'unknown';
          run.state = q.state;
          run.reason = q.reason;
          run.endedAt = at();
          if (run.waitingSince) {
            run.waitingMs = (run.waitingMs || 0) + Math.max(0, Date.now() - Date.parse(run.waitingSince));
            run.waitingSince = undefined;
          }
          run.batchId = q.batchId;
          if (q.notReceived && q.state === 'failed' && run.submission && !run.reception)
            run.submission.state = 'not_received';
          if (q.resultText?.trim()) {
            run.resultText = q.resultText;
            run.resultHash = createHash('sha256').update(q.resultText).digest('hex');
          }
          const valid =
            run.generation === m.generation &&
            run.requirementsRevision === m.currentRequirementsRevision &&
            (run.submittedRequirementsRevision == null ||
              run.submittedRequirementsRevision === run.requirementsRevision);
          // A failed/cancelled repair also finishes its reservation. Do not leave
          // sibling work charged for the entire allowance after this run ends.
          const pendingRepair = m.continuation;
          if (q.state !== 'unknown' && pendingRepair?.reservation &&
              pendingRepair.revision === run.requirementsRevision &&
              pendingRepair.next === 'repair' && pendingRepair.checkedRunId !== run.id) {
            const budget = pendingRepair.reservation;
            this.repairBudget.settle(w, budget.rootTaskId, budget.rootRevision, budget.key,
              run.activeMs ?? Number.NaN);
          }
          const receipts = this.db
            .prepare(
              'SELECT object_id AS objectId,MAX(revision) AS revision FROM work_artifact_receipts WHERE workspace=? AND run_id=? GROUP BY object_id',
            )
            .all(w, run.id) as { objectId: string; revision: number }[];
          for (const a of [...q.artifacts, ...receipts]) {
            const o = completionObject(() => this.api.object(w, a.objectId));
            if (!o || o.archived || o.policy?.private) continue;
            m.artifacts = m.artifacts.filter(
              (old) => old.objectId !== a.objectId || old.runId !== run.id,
            );
            m.artifacts.push({
              ...a,
              runId: run.id,
              outputBatchId: q.batchId,
              title: o.title,
              validity: valid && o.revision === a.revision ? 'current' : 'stale',
              fileName: o.kind === 'file' && 'fileName' in o.content ? String(o.content.fileName) : undefined,
            });
          }
          const priorRequirement = m.requirements.at(-2);
          const inherited = priorRequirement && m.requirements.at(-1)!.goal.startsWith(priorRequirement.goal) &&
            m.events.some(e => e.requirementsRevision === priorRequirement.revision &&
              ['execution_completed', 'task_accepted'].includes(e.type));
          if (valid && inherited)
            for (const retained of q.retainedArtifacts) {
              const old = m.artifacts.find(a => a.objectId === retained.objectId &&
                a.revision === retained.revision && a.validity === 'stale' &&
                m.runs.some(r => r.id === a.runId && r.state === 'succeeded'));
              const object = completionObject(() => this.api.object(w, retained.objectId));
              if (old && object && !object.archived && !object.policy?.private &&
                  object.revision === retained.revision &&
                  q.completionEvidence?.some(e => e.objectId === retained.objectId &&
                    e.revision === retained.revision && e.status === 'passed' &&
                    e.code === 'structure_valid')) old.validity = 'current';
            }
          if (q.state !== 'unknown')
            this.db
              .prepare('DELETE FROM work_claims WHERE workspace=? AND run_id=?')
              .run(w, run.id);
          this.db
            .prepare('UPDATE work_runs SET state=? WHERE workspace=? AND id=?')
            .run(run.state, w, run.id);
          m.state =
            q.state === 'unknown'
              ? 'attention'
              : m.state === 'pausing'
                ? 'paused'
                : m.state === 'cancelling'
                  ? 'cancelled'
                  : !valid
                    ? 'revising'
                    : q.state === 'succeeded' &&
                        (m.artifacts.some((a) => a.validity === 'current') || !!run.resultHash)
                      ? 'review'
                      : 'attention';
          if (
            valid &&
            q.state === 'succeeded' &&
            m.delegation?.phase === 'waiting' &&
            !['paused', 'cancelled'].includes(m.state)
          ) {
            run.resultHash = undefined;
            m.state = 'waiting';
            m.reason = '各项分工正在处理';
            return this.save(w, t, 'delegation_waiting');
          }
          if (
            valid &&
            m.question &&
            q.state !== 'unknown' &&
            !['paused', 'cancelled'].includes(m.state)
          ) {
            run.resultHash = undefined;
            m.state = 'attention';
            m.reason = m.question;
            return this.save(w, t, 'clarification_requested', m.question);
          }
          const missing = missingDeliveries(m, m.artifacts);
          if (p.operation === 'reconcile' && valid && q.state === 'interrupted' &&
              q.restartSafe && run.restartRequestedAt && run.controlled && m.state === 'attention' && !m.question) {
            this.initializeRepairBudget(w, t);
            const rootTaskId = m.parentTaskId || t.id;
            const rootRevision = m.parentRequirementsRevision || m.currentRequirementsRevision;
            const key = `restart:${run.id}`;
            const reservation = this.repairBudget.reserve(w, rootTaskId, rootRevision, t.id, key);
            if (reservation) {
              const previous = m.continuation?.revision === m.currentRequirementsRevision ? m.continuation : undefined;
              m.continuation = { revision: m.currentRequirementsRevision,
                attempts: (previous?.attempts || 0) + 1, spentMs: previous?.spentMs || 0,
                fingerprint: '', repeats: 0, checkedRunId: run.id,
                evidence: previous?.evidence || [], missing: previous?.missing || [],
                grants: previous?.grants || [], next: 'repair',
                reservation: { rootTaskId, rootRevision, key, allowanceMs: reservation.allowanceMs } };
              m.state = 'queued';
              m.reason = '已确认退出前尚未执行操作，继续原工作';
              return this.save(w, t, 'restart_scheduled', m.reason, run.id);
            }
          }
          if (valid && q.state === 'failed' && q.retryableTransport && run.controlled && run.submission?.state === 'not_received' &&
              m.state === 'attention' && !m.question) {
            const rejected = m.runs.filter(r => r.requirementsRevision === m.currentRequirementsRevision &&
              r.submission?.state === 'not_received').length;
            if (rejected <= continuationLimits.transportBackoffMs.length) {
              m.state = 'queued';
              m.schedule.notBefore = new Date(Date.now() + retryDelayMs(continuationLimits.transportBackoffMs[rejected - 1]!, q.retryAfterMs)).toISOString();
              m.reason = '请求尚未被执行器接收，稍后重试';
              return this.save(w, t, 'submission_retry_scheduled', m.reason, run.id);
            }
          }
          if (valid && q.state === 'succeeded' &&
              (m.state === 'review' || (m.responsibilityVersion === 6 && m.state === 'attention' &&
                (missing.length > 0 || !!q.completionEvidence?.length))) && q.completionEvidence) {
            // Inspection ran outside the transaction. Never accept a result for a changed object.
            const evidence = q.completionEvidence.map(e => {
              const object = completionObject(() => this.api.object(w, e.objectId));
              return !object || object.archived || object.policy?.private || object.revision !== e.revision
                ? { ...e, status: 'unknown' as const, code: 'object_changed', detail: '检查期间材料发生变化' } : e;
            });
            const previous = m.continuation;
            this.initializeRepairBudget(w, t);
            if (previous?.reservation && previous.next === 'repair') {
              const b = previous.reservation;
              this.repairBudget.settle(w, b.rootTaskId, b.rootRevision, b.key,
                run.activeMs ?? Number.NaN);
            }
            m.continuation = decideContinuation(m, run, missing, evidence);
            if (m.continuation.next === 'repair') {
              const rootTaskId = m.parentTaskId || t.id;
              const rootRevision = m.parentRequirementsRevision || m.currentRequirementsRevision;
              const key = `${t.id}:${m.currentRequirementsRevision}:${run.id}`;
              const reservation = this.repairBudget.reserve(w, rootTaskId, rootRevision, t.id, key);
              if (!reservation) {
                m.continuation.next = 'blocked';
                m.continuation.attempts = Math.max(0, m.continuation.attempts - 1);
              }
              else m.continuation.reservation = { rootTaskId, rootRevision, key,
                allowanceMs: reservation.allowanceMs };
            }
            if (m.continuation.next !== 'done') {
              m.state = m.continuation.next === 'repair' ? 'queued' : 'attention';
              m.reason = m.continuation.next === 'repair' ? '成果检查发现缺项，正在继续修复' : '自动处理已停止，需要核实未完成项';
              if (m.continuation.next === 'repair') {
                // Adopt only revisions written by this work; user edits remain a conflict.
                t.sources = t.sources.map(s => {
                  const a = m.artifacts.find(a => a.objectId === s.objectId && a.validity === 'current');
                  const o = completionObject(() => this.api.object(w, s.objectId));
                  return a && o && o.revision === a.revision && !o.archived && !o.policy?.private ? { ...s, revision: a.revision } : s;
                });
              }
              return this.save(w, t, 'completion_checked', m.reason, run.id);
            }
          }
          if (valid && q.state === 'succeeded' && missing.length && m.state === 'review') {
            m.state = 'attention';
            m.reason = `尚未交付：${missing.join('、').toUpperCase()}。已有成果保留，可以在同一工作中继续。`;
            return this.save(w, t, 'delivery_incomplete', m.reason, run.id);
          }
          const check = m.objectiveCheck;
          if (
            m.state === 'review' &&
            !requiresDeliveryConfirmation(m) &&
            run.controlled &&
            check &&
            check.requirementsRevision === m.currentRequirementsRevision
          ) {
            const artifacts = m.artifacts.filter((a) => a.validity === 'current'),
              o = this.api.object(w, check.objectId);
            const unchanged = t.sources
              .filter((s) => s.objectId !== o.id)
              .every((s) => {
                const item = this.api.object(w, s.objectId);
                return !item.archived && !item.policy?.private && item.revision === s.revision;
              });
            if (
              artifacts.length === 1 &&
              artifacts[0]!.objectId === o.id &&
              artifacts[0]!.runId === run.id &&
              o.revision > check.baseRevision &&
              !o.archived &&
              !o.policy?.private &&
              unchanged &&
              createHash('sha256').update(JSON.stringify(o.content)).digest('hex') ===
                check.expectedHash
            ) {
              m.acceptances.push({
                requirementsRevision: m.currentRequirementsRevision,
                artifacts: [{ objectId: o.id, revision: o.revision }],
                textResults: [],
                actor: 'objective',
                at: at(),
                evidence:
                  '用户指定的精确替换结果哈希一致；完整内容匹配（含选区外）；其他来源版本未变；本回合无其他文件成果',
                scopeConfirmed: true,
              });
              m.state = 'completed';
              m.reason = '精确文本替换通过客观检查';
              return this.save(w, t, 'task_accepted', m.reason, run.id);
            }
          }
          // Completion records execution, not human acceptance or permission to
          // publish. Never fabricate an acceptance entry for an ordinary job.
          if (m.state === 'review' && !m.parentTaskId && !requiresDeliveryConfirmation(m)) {
            m.state = 'completed';
            m.reason = m.artifacts.some(a => a.validity === 'current')
              ? '文件已保存到桌面' : '本轮执行已完成';
            return this.save(w, t, 'execution_completed', m.reason, run.id);
          }
          m.reason =
            m.state === 'review'
              ? m.artifacts.some((a) => a.validity === 'current')
                ? '文件成果已保存，等待检查与验收'
                : '执行结论已返回，没有文件成果，等待检查'
              : m.state === 'revising'
                ? '旧执行已结束，新要求等待重新派发'
                : q.reason || '没有可验收的成果，需要检查执行结果';
          return this.save(
            w,
            t,
            m.parentTaskId
              ? 'subtask_returned'
              : p.operation === 'reconcile'
                ? 'run_reconciled'
                : 'review_requested',
            m.reason,
            run.id,
          );
        }
        fail('INVALID_OPERATION', '不支持此工作操作');
      });
      const finishedTask = result as WorkTask;
      const finishedRunId = (p.payload as Record<string, unknown>)?.runId;
      if (['finish', 'reconcile'].includes(p.operation) && finishedTask?.management &&
          typeof finishedRunId === 'string')
        this.botEvents.publishResult(w, finishedTask, finishedRunId);
      return result;
    });
  }
}

// Thread identity and write guards live in work-thread-guards.ts, task/goal
// persistence in work-task-store.ts, read models in work-views.ts, and the
// supervisor/orchestration routing in work-orchestration.ts; all share the
// store's db/api plumbing via these mixins.
export interface WorkManagementStore
  extends ThreadGuardMethods,
    TaskStoreMethods,
    WorkViewsMethods,
    WorkOrchestrationMethods {}
Object.assign(WorkManagementStore.prototype, threadGuards);
Object.assign(WorkManagementStore.prototype, taskStore);
Object.assign(WorkManagementStore.prototype, workViews);
Object.assign(WorkManagementStore.prototype, workOrchestration);
