// Thread identity and write-guard surface of WorkManagementStore: which run a
// conversation thread is bound to, and which tools and object writes a thread
// may perform while consulting, coordinating voice, or owning a managed run.
import type { DatabaseSync } from 'node:sqlite';
import { fail, type WorkTask } from '../../contracts/index.js';
import type { WorkRun } from '../../contracts/work-management.js';
import { active } from './work-conventions.js';
import type { Api } from './work-management.js';
import type { TaskStoreMethods } from './work-task-store.js';

type StoreSurface = Pick<TaskStoreMethods, 'get' | 'task' | 'resource'>;

/** The WorkManagementStore surface the thread-guard cluster relies on. */
export type ThreadGuardHost = {
  db: DatabaseSync;
  api: Pick<Api, 'object'>;
} & StoreSurface;

export interface ThreadGuardMethods {
  current(w: string, thread: string | undefined): { task: WorkTask; run: WorkRun } | undefined;
  workingDirectory(w: string, thread: string | undefined): string | undefined;
  isVoiceCoordinator(thread: string | undefined): boolean;
  isConsultation(thread: string | undefined): boolean;
  guardTool(thread: string | undefined, name: string, args: any): void;
  guardWrite(w: string, thread: string | undefined, ids: string[]): void;
  releaseAfterConflict(thread: string | undefined): void;
  recordArtifact(
    w: string,
    thread: string | undefined,
    objectId: string,
    revision: number,
    type: string,
  ): void;
}

export const threadGuards: ThreadGuardMethods & ThisType<ThreadGuardHost & ThreadGuardMethods> = {
  current(w: string, thread: string | undefined) {
    if (!thread) return;
    const row = this.db
      .prepare(
        'SELECT task_id,id FROM work_runs WHERE workspace=? AND thread_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(w, thread) as any;
    if (!row) return;
    const task = this.task(w, row.task_id),
      run = task.management!.runs.find((r) => r.id === row.id);
    if (run && active(run)) return { task, run };
  },
  workingDirectory(w: string, thread: string | undefined) {
    const current = this.current(w, thread);
    return current?.run.controlled ? current.run.outputDirectory : undefined;
  },
  isVoiceCoordinator(thread: string | undefined) {
    return (
      !!thread &&
      !!this.db.prepare('SELECT 1 FROM work_voice_coordinators WHERE thread_id=?').get(thread)
    );
  },
  isConsultation(thread: string | undefined) {
    return (
      !!thread &&
      (!!this.db.prepare('SELECT 1 FROM work_consultations WHERE thread_id=?').get(thread) ||
        !!this.db
          .prepare("SELECT 1 FROM bot_slots WHERE thread_id=? AND role IN ('router','consult')")
          .get(thread))
    );
  },
  guardTool(thread: string | undefined, name: string, args: any) {
    // The native host owns output batch setup and collection. Workers cannot
    // impersonate this connection; collection still validates every file write.
    if (
      process.env.AI_DESKTOP_WORK_HOST === '1' &&
      name === 'desktop_generated_files' &&
      ['begin', 'bind', 'collect'].includes(args.operation)
    )
      return;
    if (!this.isConsultation(thread) && !this.isVoiceCoordinator(thread)) {
      if (
        !thread &&
        process.env.AI_DESKTOP_WORK_HOST !== '1' &&
        this.db
          .prepare(
            "SELECT 1 FROM work_runs WHERE state IN ('starting','running','waiting','unknown') LIMIT 1",
          )
          .get()
      )
        fail(
          'RUN_IDENTITY_REQUIRED',
          '当前有受管工作，工具必须提供真实执行线程身份；不能按当前窗口推断归属',
        );
      if (thread) {
        const row = this.db
          .prepare(
            'SELECT workspace,task_id,id FROM work_runs WHERE thread_id=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(thread) as any;
        if (row) {
          const t = this.task(row.workspace, row.task_id);
          // The transport thread, not a model-copied UUID, owns the workspace.
          // Report the correction without substituting credentials or executing
          // a write against a different workspace on the caller's behalf.
          if (typeof args.credential === 'string' && typeof args.workspaceId === 'string' &&
              args.workspaceId !== row.workspace)
            fail('RUN_WORKSPACE_MISMATCH',
              `本次工具调用的 workspaceId 与当前工作不一致。当前工作 workspaceId=${row.workspace}；请从本轮引用读取完整参数后重试，勿重新申请权限。`);
          if (
            t.management!.parentTaskId &&
            ![
              'desktop_work_host',
              'desktop_workspace_overview',
              'desktop_read_objects',
              'desktop_use_objects',
              'desktop_regions_read',
              'desktop_search',
              'desktop_read_search_hits',
              'desktop_index_status',
            ].includes(name) &&
            !(name === 'desktop_prepare_file' && (!args.intent || args.intent === 'read')) &&
            !(
              name === 'desktop_generated_files' &&
              ['list', 'references_check'].includes(args.operation)
            )
          )
            fail('SUBTASK_READ_ONLY', '子任务只读材料，由负责人写回成果');
          const r = t.management!.runs.find((r) => r.id === row.id)!;
          if (
            (!active(r) ||
              r.generation !== t.management!.generation ||
              r.requirementsRevision !== t.management!.currentRequirementsRevision) &&
            ![
              'desktop_work_host',
              'desktop_workspace_overview',
              'desktop_read_objects',
              'desktop_regions_read',
              'desktop_search',
              'desktop_read_search_hits',
              'desktop_index_status',
            ].includes(name)
          )
            fail('STALE_RUN', '旧执行只能查看，已停止继续操作的资格');
          if (
            r.controlled &&
            ![
              'desktop_work_host',
              'desktop_workspace_overview',
              'desktop_workspaces_list',
              'desktop_read_objects',
              'desktop_use_objects',
              'desktop_prepare_context',
              'desktop_regions_read',
              'desktop_search',
              'desktop_read_search_hits',
              'desktop_index_status',
              'desktop_locate_search_hit',
              'desktop_prepare_file',
              'desktop_edit_file_selection',
              'desktop_file_result',
              'desktop_commit_changes',
              'desktop_task_start',
              'desktop_task_action',
              'desktop_task_join',
              'desktop_review',
              'desktop_review_outputs',
              'desktop_comment_reply',
              'desktop_work_manage',
            ].includes(name) &&
            !(
              name === 'desktop_generated_files' &&
              ['list', 'references_check', 'collect'].includes(args.operation)
            )
          )
            fail(
              'EXTERNAL_RESOURCE_REQUIRED',
              '此动作尚未接入对象写入协调。请暂停后在工作详情将执行方式改为串行，再继续；不会绕过并发隔离',
            );
        }
      }
      return;
    }
    const reads = [
      'desktop_work_host',
      'desktop_workspace_overview',
      'desktop_read_objects',
      'desktop_use_objects',
      'desktop_regions_read',
      'desktop_search',
      'desktop_search_materials',
      'desktop_retrieval_search',
      'desktop_read_search_hits',
      'desktop_index_status',
      'desktop_locate_search_hit',
      'apps_list',
      'apps_describe',
      'apps_runs_get',
    ];
    if (
      (this.isVoiceCoordinator(thread) && name === 'desktop_voice_work') ||
      reads.includes(name) ||
      (name === 'desktop_generated_files' &&
        ['list', 'references_check'].includes(args.operation)) ||
      (name === 'desktop_prepare_file' && (!args.intent || args.intent === 'read')) ||
      (name === 'desktop_work_manage' && args.operation === 'list')
    )
      return;
    fail('CONSULTATION_READ_ONLY', '当前是只读咨询。请先交办工作，再执行修改或外部操作。');
  },
  guardWrite(w: string, thread: string | undefined, ids: string[]) {
    if (this.isConsultation(thread) || this.isVoiceCoordinator(thread))
      fail('CONSULTATION_READ_ONLY', '咨询不能回写材料，请先交办工作');
    const runs = thread
      ? (this.db
          .prepare(
            'SELECT task_id,id FROM work_runs WHERE workspace=? AND thread_id=? ORDER BY rowid DESC LIMIT 1',
          )
          .all(w, thread) as any[])
      : [];
    const own = runs[0];
    if (own) {
      const t = this.task(w, own.task_id),
        m = t.management!;
      if (m.question || m.delegation?.phase === 'waiting')
        fail('WORK_YIELDED', '工作已让出执行，不能继续回写');
      if (m.parentTaskId) fail('SUBTASK_READ_ONLY', '子任务仅提交分析和草稿，由负责人统一回写');
      const r = m.runs.find((r) => r.id === own.id)!;
      if (
        r.controlled &&
        t.sources.length &&
        ids.some(
          (objectId) =>
            !t.sources.some((s) => s.objectId === objectId) &&
            !m.artifacts.some((a) => a.objectId === objectId) &&
            !this.db
              .prepare(
                'SELECT 1 FROM work_artifact_receipts WHERE workspace=? AND run_id=? AND object_id=?',
              )
              .get(w, r.id, objectId),
        )
      )
        fail('WORK_SOURCE_SCOPE', '写入对象不在本次工作材料范围内');
      if (
        !['starting', 'running', 'waiting'].includes(r.state) ||
        r.generation !== m.generation ||
        r.requirementsRevision !== m.currentRequirementsRevision
      )
        fail('STALE_RUN', '执行要求已更新或已停止，文件副本保留，不能继续回写');
    }
    for (const objectId of [...ids].sort((a, b) =>
      this.resource(w, this.api.object(w, a)).localeCompare(
        this.resource(w, this.api.object(w, b)),
      ),
    )) {
      const resource = this.resource(w, this.api.object(w, objectId)),
        claim = this.db
          .prepare('SELECT run_id FROM work_claims WHERE workspace=? AND resource=?')
          .get(w, resource) as any;
      if (claim && claim.run_id !== own?.id) {
        if (own)
          this.db.prepare('DELETE FROM work_claims WHERE workspace=? AND run_id=?').run(w, own.id);
        fail('RESOURCE_CLAIMED', '此材料正在被另一工作修改；工作副本保留，请稍后重新申请写回');
      }
      if (own && !claim) {
        const t = this.task(w, own.task_id);
        this.db
          .prepare(
            'INSERT INTO work_claims(workspace,resource,task_id,run_id,generation,expires) VALUES(?,?,?,?,?,?)',
          )
          .run(w, resource, t.id, own.id, t.management!.generation, Date.now() + 120000);
      }
      this.db
        .prepare(
          'UPDATE work_claims SET base_revision=COALESCE(base_revision,?),expires=? WHERE workspace=? AND resource=?',
        )
        .run(this.api.object(w, objectId).revision, Date.now() + 120000, w, resource);
    }
  },
  releaseAfterConflict(thread: string | undefined) {
    if (!thread) return;
    this.db
      .prepare(
        "DELETE FROM work_claims WHERE run_id IN (SELECT id FROM work_runs WHERE thread_id=? AND state IN ('starting','running','waiting'))",
      )
      .run(thread);
  },
  recordArtifact(
    w: string,
    thread: string | undefined,
    objectId: string,
    revision: number,
    type: string,
  ) {
    if (!thread || !['object.changed', 'object.created'].includes(type)) return;
    const r = this.db
      .prepare(
        "SELECT id FROM work_runs WHERE workspace=? AND thread_id=? AND state IN ('starting','running') ORDER BY rowid DESC LIMIT 1",
      )
      .get(w, thread) as any;
    if (r)
      this.db
        .prepare('INSERT OR IGNORE INTO work_artifact_receipts VALUES(?,?,?,?,?)')
        .run(w, r.id, objectId, revision, type);
  }
};
