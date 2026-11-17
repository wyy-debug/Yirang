// Persistence of work tasks and goals: settings-backed get/put, legacy task
// normalization, event-recording save, and stable resource identity for claims.
import type { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, type DesktopObject, type WorkTask } from '../../contracts/index.js';
import { WorkSchedule, type WorkGoal } from '../../contracts/work-management.js';
import { at, uid } from './work-conventions.js';
import type { Api } from './work-management.js';

/** The WorkManagementStore surface the persistence cluster relies on. */
export type TaskStoreHost = {
  db: DatabaseSync;
  api: Pick<Api, 'event'>;
  summary(t: WorkTask): WorkTask;
};

export interface TaskStoreMethods {
  get<T>(w: string, key: string): T | undefined;
  put(w: string, key: string, value: unknown): void;
  normalize(w: string, t: WorkTask): WorkTask;
  task(w: string, key: string): WorkTask;
  all(w: string): WorkTask[];
  goals(w: string): WorkGoal[];
  save(w: string, t: WorkTask, type: string, detail?: string, runId?: string): WorkTask;
  resource(w: string, o: DesktopObject): string;
}

export const taskStore: TaskStoreMethods & ThisType<TaskStoreHost & TaskStoreMethods> = {
  get<T>(w: string, key: string): T | undefined {
    const r = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(w, key) as any;
    return r ? JSON.parse(r.value) : undefined;
  },
  put(w: string, key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(w, key, JSON.stringify(value));
  },
  normalize(w: string, t: WorkTask) {
    if (t.management) {
      if (t.management.legacy && t.execution) {
        t.management.state =
          t.status === 'completed'
            ? 'completed'
            : t.status === 'cancelled'
              ? 'cancelled'
              : t.status === 'ready'
                ? 'review'
                : t.status === 'paused'
                  ? 'paused'
                  : 'attention';
        t.management.reason = '历史协作记录，保留原身份与历史；不会自动重新执行';
      }
      return t;
    }

    // Keep the original WorkTask and an untouched migration backup, never infer history by title/time.
    this.put(w, `work-migration-backup:${t.id}`, t);
    const state =
      t.status === 'completed'
        ? 'completed'
        : t.status === 'cancelled'
          ? 'cancelled'
          : t.status === 'ready'
            ? 'review'
            : t.status === 'paused'
              ? 'paused'
              : 'attention';
    t.management = {
      version: 1,
      state,
      currentRequirementsRevision: 1,
      generation: 1,
      schedule: WorkSchedule.parse({}),
      reason: state === 'attention' ? '历史工作：执行状态需要核实，不自动重跑' : '历史工作记录',
      requirements: [
        {
          revision: 1,
          goal: t.goal,
          constraints: t.constraints,
          deliverables: t.proposal || '',
          acceptanceCriteria: '人工检查交付结果',
          reason: '保留原任务历史',
          sourceRequestId: 'legacy',
          at: t.createdAt,
        },
      ],
      runs: [],
      artifacts: [],
      acceptances: [],
      dependencies: [],
      events: [],
      requestIds: [],
      acceptancePolicy: 'manual',
      legacy: true,
    };
    this.put(w, `prototype-task:${t.id}`, t);
    return t;
  },
  task(w: string, key: string) {
    const t = this.get<WorkTask>(w, `prototype-task:${key}`);
    if (!t) fail('NOT_FOUND', '工作不存在');
    const normalized = this.normalize(w, t);
    if (!normalized.management) fail('LEGACY_EXECUTION', '此协作任务仍由原执行控制器管理');
    return normalized;
  },
  all(w: string) {
    return (
      this.db
        .prepare("SELECT value FROM settings WHERE workspace=? AND key LIKE 'prototype-task:%'")
        .all(w) as any[]
    )
      .map((r) => this.normalize(w, JSON.parse(r.value)))
      .filter((t) => !t.archived && t.management);
  },
  goals(w: string) {
    return (
      this.db
        .prepare("SELECT value FROM settings WHERE workspace=? AND key LIKE 'work-goal:%'")
        .all(w) as any[]
    ).map((r) => JSON.parse(r.value) as WorkGoal);
  },
  save(w: string, t: WorkTask, type: string, detail = '', runId?: string) {
    const m = t.management!;
    m.events.push({
      id: uid(),
      sequence: (m.events.at(-1)?.sequence || 0) + 1,
      type,
      at: at(),
      requirementsRevision: m.currentRequirementsRevision,
      detail,
      runId,
    });
    t.revision++;
    t.updatedAt = at();
    t.status =
      (
        {
          running: 'working',
          revising: 'working',
          review: 'ready',
          attention: 'failed',
          scheduled: 'queued',
          waiting: 'queued',
          pausing: 'working',
          cancelling: 'working',
        } as any
      )[m.state] || m.state;
    this.put(w, `prototype-task:${t.id}`, t);
    this.put(w, `work-summary:${t.id}`, this.summary(t));
    // Same transaction as the task: a crash cannot commit state without its report.
    this.put(w, `work-report:${m.events.at(-1)!.id}`, {
      id: m.events.at(-1)!.id,
      taskId: t.id,
      revision: t.revision,
      runId: runId || null,
      requirementsRevision: m.currentRequirementsRevision,
      state: m.state,
      reason: detail || m.reason,
      at: t.updatedAt,
    });
    this.api.event(w, 'worktask.updated');
    return t;
  },
  resource(w: string, o: DesktopObject) {
    const link = this.get<any>(w, `generated-object:${o.id}`);
    let path = link?.path; // fall back to object identity if not a linked file

    if (path) {
      try {
        path = realpathSync(path);
      } catch {
        path = resolve(path);
      }
      return 'path:' + (process.platform === 'win32' ? path.toLowerCase() : path);
    }
    return 'object:' + o.id;
  },
};
