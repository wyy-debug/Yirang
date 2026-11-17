// Read models of work tasks: summaries and compact views, artifact validity,
// review bundles, result digests and the latest conversation focus.
import type { DatabaseSync } from 'node:sqlite';
import { fail, type WorkTask } from '../../contracts/index.js';
import { WorkGoal } from '../../contracts/work-management.js';
import { active, terminal } from './work-conventions.js';
import type { AgentPoolStore } from '../agents/agent-pool.js';
import type { Api } from './work-management.js';
import type { TaskStoreMethods } from './work-task-store.js';

type StoreSurface = Pick<TaskStoreMethods, 'get' | 'put' | 'task' | 'all' | 'goals'>;

/** The WorkManagementStore surface the read-model cluster relies on. */
export type WorkViewsHost = {
  db: DatabaseSync;
  api: Pick<Api, 'object'>;
  pool: AgentPoolStore;
} & StoreSurface;

/** Compact digest of one task's results, shown next to its parent. */
export type WorkResultDigest = {
  taskId: string;
  title: string;
  state: string;
  text: string;
  truncated: boolean;
};

/** Full work list payload returned to the panel. */
export type WorkListView = {
  workspaceId: string;
  tasks: WorkTask[];
  goals: WorkGoal[];
  notices: any[];
  counts: { open: number; attention: number };
  capabilities: {
    background: boolean;
    automaticGoals: boolean;
    maxConcurrent: number;
    uncontrolledWrites: string;
  };
  hostCondition: string;
};

export interface WorkViewsMethods {
  sourceCheck(w: string, t: WorkTask): void;
  refreshArtifacts(w: string, t: WorkTask): void;
  summary(t: WorkTask): WorkTask;
  summaries(w: string): WorkTask[];
  conversation(w: string): { id: string; intent: string; taskLinks: string[] }[];
  view(w: string, compact?: boolean): WorkListView;
  progress(w: string, t: WorkTask): WorkTask;
  resultReady(t: WorkTask): boolean;
  results(w: string, t: WorkTask): WorkResultDigest[];
  poolResults(w: string, t: WorkTask): WorkResultDigest[];
}

export const workViews: WorkViewsMethods & ThisType<WorkViewsHost & WorkViewsMethods> = {
  sourceCheck(w: string, t: WorkTask) {
    for (const s of t.sources) {
      const o = this.api.object(w, s.objectId);
      if (o.archived || o.policy?.private)
        fail('MATERIAL_UNAVAILABLE', '材料已删除或禁止引用，请重新选择');
      if (o.revision !== s.revision)
        fail('STALE_INPUT', '材料版本已变化，请重新定位选区并修订要求');
    }
  },
  refreshArtifacts(w: string, t: WorkTask) {
    for (const a of t.management!.artifacts) {
      try {
        const o = this.api.object(w, a.objectId);
        if (o.archived || o.policy?.private || o.revision !== a.revision) a.validity = 'stale';
      } catch {
        a.validity = 'stale';
      }
    }
  },
  summary(t: WorkTask) {
    return {
      ...t,
      events: [],
      management: {
        ...t.management!,
        events: t
          .management!.events.filter((e) =>
            [
              'deadline_notice',
              'review_requested',
              'user_input_required',
              'run_reconciled',
              'task_accepted',
            ].includes(e.type),
          )
          .slice(-20),
        requirements: t.management!.requirements.slice(-1),
        runs: t.management!.runs.map(({ resultText, ...r }) => r),
      },
    };
  },
  // A status line belongs to one run. Once that run is no longer current the
  // line would describe work that is not happening, so it is not shown.
  progress(w: string, t: WorkTask) {
    const saved = this.get<any>(w, `work-progress:${t.id}`),
      m = t.management!,
      run = saved && m.runs.find((r) => r.id === saved.runId);
    const { progress: _, lastReport: __, ...rest } = m;
    if (
      run &&
      active(run) &&
      run.generation === m.generation &&
      run.requirementsRevision === m.currentRequirementsRevision
    )
      return { ...t, management: { ...rest, progress: saved } };
    // A run that stopped blocked leaves its last words as the reason it stopped.
    if (run && m.state === 'attention' && m.runs.at(-1)?.id === run.id)
      return { ...t, management: { ...rest, lastReport: saved.text } };
    return { ...t, management: rest as typeof m };
  },
  summaries(w: string) {
    const rows = this.db
      .prepare(
        "SELECT key,json_extract(value,'$.revision') AS revision,json_extract(value,'$.updatedAt') AS updatedAt,json_extract(value,'$.archived') AS archived FROM settings WHERE workspace=? AND key LIKE 'prototype-task:%'",
      )
      .all(w) as { key: string; revision: number; updatedAt: string; archived: number }[];
    return rows
      .filter((r) => !r.archived)
      .map((row) => {
        const key = row.key.replace('prototype-task:', 'work-summary:');
        let t = this.get<WorkTask>(w, key);
        if (!t || t.revision !== row.revision || t.updatedAt !== row.updatedAt) {
          t = this.summary(this.task(w, row.key.slice('prototype-task:'.length)));
          this.put(w, key, t);
        }
        return t;
      })
      .filter((t) => !t.archived);
  },
  conversation(w: string) {
    const saved = this.get<{ id: string; intent: string; taskLinks: string[] }>(
      w,
      'work-context-focus',
    );
    if (saved?.taskLinks?.length) return [saved];
    const row = this.db
      .prepare(
        "SELECT id,json_extract(body,'$.intent') AS intent,json_extract(body,'$.taskLinks') AS links FROM work_requests WHERE workspace=? AND json_array_length(body,'$.taskLinks') > 0 ORDER BY rowid DESC LIMIT 1",
      )
      .get(w) as { id: string; intent: string; links: string } | undefined;
    return row
      ? [{ id: row.id, intent: row.intent, taskLinks: JSON.parse(row.links || '[]') }]
      : [];
  },
  view(w: string, compact = false) {
    const old = this.get<any>(w, 'work-policy');
    if (old?.maxConcurrent > 5) {
      if (!this.get(w, 'work-policy-before-v2')) this.put(w, 'work-policy-before-v2', old);
      this.put(w, 'work-policy', { ...old, maxConcurrent: 5 });
    }
    const tasks = (compact ? this.summaries(w) : this.all(w)).map((t) => this.progress(w, t));
    for (const t of tasks) this.refreshArtifacts(w, t);
    return {
      workspaceId: w,
      tasks: compact
        ? tasks.map((t) => ({
            ...t,
            events: [],
            management: {
              ...t.management!,
              events: t
                .management!.events.filter((e) =>
                  [
                    'deadline_notice',
                    'review_requested',
                    'user_input_required',
                    'run_reconciled',
                    'task_accepted',
                  ].includes(e.type),
                )
                .slice(-20),
              requirements: t.management!.requirements.slice(-1),
              runs: t.management!.runs.map(({ resultText, ...r }) => r),
            },
          }))
        : tasks,
      goals: this.goals(w),
      notices: tasks
        .flatMap((t) =>
          t
            .management!.events.filter((e) =>
              [
                'deadline_notice',
                'review_requested',
                'user_input_required',
                'run_reconciled',
                'task_accepted',
              ].includes(e.type),
            )
            .map((e) => ({
              ...e,
              taskId: t.id,
              title: t.title,
              read: (this.get<string[]>(w, 'work-notices-read') || []).includes(e.id),
            })),
        )
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 150),
      counts: {
        open: tasks.filter((t) => !t.management!.parentTaskId && !terminal(t)).length,
        attention: tasks.filter(
          (t) =>
            !t.management!.parentTaskId &&
            (['attention', 'review'].includes(t.management!.state) ||
              t.management!.runs.some((r) => r.state === 'waiting')),
        ).length,
      },
      capabilities: {
        background: false,
        automaticGoals: false,
        maxConcurrent: Math.min(5, this.get<any>(w, 'work-policy')?.maxConcurrent || 5),
        uncontrolledWrites: 'serial',
      },
      hostCondition: '普通 AI 需要保持一壤及执行宿主运行',
    };
  },
  resultReady(t: WorkTask) {
    const m = t.management!;
    return (
      m.state === 'review' &&
      !m.runs.some(active) &&
      m.runs.some(
        (r) =>
          r.state === 'succeeded' &&
          r.requirementsRevision === m.currentRequirementsRevision &&
          !!r.resultHash,
      )
    );
  },
  results(w: string, t: WorkTask) {
    return [
      ...new Set([
        ...(t.management!.delegation?.children || t.management!.afterTasks || []),
        ...t.management!.dependencies.map((d) => d.taskId),
      ]),
    ]
      .map((key): WorkResultDigest => {
        const child = this.task(w, key),
          r = child
            .management!.runs.filter(
              (r) =>
                r.state === 'succeeded' &&
                r.requirementsRevision === child.management!.currentRequirementsRevision,
            )
            .at(-1);
        return {
          taskId: child.id,
          title: child.title,
          state: child.management!.state,
          text: r?.resultText?.slice(0, 16000) || '',
          truncated: (r?.resultText?.length || 0) > 16000,
        };
      })
      .concat(this.poolResults(w, t));
  },
  poolResults(w: string, t: WorkTask) {
    const id = t.management!.delegation?.poolPlanId;
    if (!id) return [];
    const plan = this.pool.detail(w, id);
    return plan.nodes.map((n: any) => {
      const r = plan.results.find((x: any) => x.nodeId === n.spec.id),
        text = r
          ? JSON.stringify({
              summary: r.summary,
              evidence: r.evidence,
              warnings: r.warnings,
              conflicts: r.conflicts,
              next: r.next,
            })
          : n.reason || '';
      return {
        taskId: id + '/' + n.spec.id,
        title: n.spec.title,
        state: n.state,
        text: text.slice(0, 16000),
        truncated: text.length > 16000,
      };
    });
  }
};
