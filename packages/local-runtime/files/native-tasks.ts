import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  Id,
  TaskBudget,
  fail,
  type DesktopObject,
  type MaterialRange,
  type WorkTask,
} from '../../contracts/index.js';

export type ExecutionAuth = {
  kind: 'panel' | 'execution';
  workspaceId: string;
  owner: string;
  session: string | null;
  scope: string[];
  observed: Record<string, number>;
  status: string;
};
type Binding = {
  taskId: string;
  participantId: string;
  role: 'writer' | 'reviewer';
  reviewRound: number;
  generation?: number;
  reads: Record<string, number>;
  fileReads?: Record<string, number>;
  acknowledgedFeedback?: string;
};
export type NativeTaskContext = { task: WorkTask; binding: Binding; auth: ExecutionAuth };
type Context = NativeTaskContext;
export type NativeTaskFileBinding = {
  taskId: string;
  participantId: string;
  role: 'writer' | 'reviewer';
  generation: number;
};
type Api = {
  managed?: (workspace: string) => WorkTask | undefined;
  tx: <T>(fn: () => T) => T;
  once: <T>(workspace: string, request: string, payload: unknown, fn: () => T) => T;
  auth: (
    workspace: string,
    credential: string,
    session: string | null,
    kind?: 'panel' | 'execution',
  ) => ExecutionAuth;
  issue: (
    workspace: string,
    kind: 'execution',
    owner: string,
    session: string | null,
    scope: string[],
    observed: Record<string, number>,
  ) => string;
  object: (workspace: string, id: string) => DesktopObject;
  select: (object: DesktopObject, range?: MaterialRange) => DesktopObject;
  event: (
    workspace: string,
    type: string,
    objectId: string | null,
    revision: number | null,
    actor: string,
  ) => void;
};
export const NativeTaskStart = z
  .object({
    workspaceId: Id,
    credential: Id,
    requestId: Id,
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(6000),
    constraints: z.string().max(3000).default(''),
    objectIds: z.array(Id).min(1).max(10),
    writeObjectIds: z.array(Id).max(10).default([]),
    budget: TaskBudget,
  })
  .strict();
export const NativeTaskAction = z
  .object({
    workspaceId: Id,
    credential: Id,
    requestId: Id,
    action: z.enum([
      'status',
      'next',
      'progress',
      'finish',
      'invite_review',
      'feedback',
      'acknowledge',
    ]),
    body: z.string().trim().max(6000).optional(),
    decision: z.enum(['revise', 'approve']).optional(),
    feedbackId: Id.optional(),
    executionRef: z.string().max(500).optional(),
    reportedTokens: z.number().int().min(0).max(1000000000).optional(),
  })
  .strict();
export const NativeTaskJoin = z.object({ workspaceId: Id, invitation: Id, requestId: Id }).strict();
export const NativeTaskResume = z
  .object({
    workspaceId: Id,
    credential: Id,
    taskId: Id,
    requestId: Id,
    acceptCurrentSources: z.boolean().default(false),
  })
  .strict();
const uid = (prefix: string) => `${prefix}_${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const time = () => new Date().toISOString();

export class NativeTasks {
  constructor(
    private db: DatabaseSync,
    private api: Api,
  ) {}
  private get<T>(workspace: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(workspace, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  private put(workspace: string, key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(workspace, key, JSON.stringify(value));
  }
  private task(workspace: string, id: string) {
    const task = this.get<WorkTask>(workspace, `prototype-task:${id}`);
    if (!task?.execution) fail('NOT_FOUND', '真实协作任务不存在。');
    return task;
  }
  private record(
    workspace: string,
    task: WorkTask,
    actor: WorkTask['events'][number]['actor'],
    title: string,
    body: string,
    participantId?: string,
  ) {
    if (task.events.length < 400)
      task.events.push({
        id: uid('event'),
        actor,
        title,
        body,
        at: time(),
        ...(participantId ? { participantId } : {}),
      });
    task.revision++;
    task.updatedAt = time();
    if (task.management && !task.management.legacy && task.status === 'completed') {
      task.status = 'ready';
      task.management.state = 'review';
      task.management.reason = '协作阶段结束，仍需按当前要求验收';
    }
    this.put(workspace, `prototype-task:${task.id}`, task);
    this.api.event(workspace, 'worktask.updated', null, null, actor === 'human' ? 'human' : 'ai');
  }
  private grant(workspace: string, task: WorkTask) {
    const row = this.db
      .prepare(
        "SELECT status,expires FROM credentials WHERE workspace=? AND owner=? AND kind='execution'",
      )
      .get(workspace, task.execution!.originOwner) as
      | { status: string; expires: number }
      | undefined;
    if (!row || row.status !== 'delegated' || row.expires < Date.now())
      fail('PERMISSION_REVOKED', '任务的原材料授权已移除、改变或到期，请在原对话重新引用材料。');
  }
  private active(task: WorkTask) {
    if (task.archived || task.status === 'cancelled' || task.status === 'completed')
      fail('TASK_FINISHED', '任务已停止，迟到操作不会写入。');
    if (
      task.management &&
      !task.management.legacy &&
      ['paused', 'pausing', 'cancelling', 'cancelled', 'revising', 'completed'].includes(
        task.management.state,
      )
    )
      fail('TASK_PAUSED', '当前工作已停止或要求更新，旧协作身份不能继续回写');
    if (task.status === 'paused') fail('TASK_PAUSED', '用户已暂停任务，请等待继续。');
    if (task.execution!.deadlineAt <= Date.now())
      fail('BUDGET_EXHAUSTED', '任务本地读写窗口已到期，请用户调整预算或重新建立任务。');
  }
  private sources(workspace: string, task: WorkTask) {
    const observed: Record<string, number> = {};
    for (const source of task.sources) {
      const object = this.api.object(workspace, source.objectId);
      if (object.archived || object.policy?.private)
        fail('PERMISSION_DENIED', '任务材料已归档或禁止交给 AI。');
      if (object.revision !== source.revision)
        fail('STALE_INPUT', '任务之外的修改改变了材料，请在原对话重新引用当前版本。');
      this.api.select(object, source.selection);
      observed[object.id] = object.revision;
    }
    return observed;
  }
  private sameSelection(workspace: string, left?: MaterialRange, right?: MaterialRange) {
    if (JSON.stringify(left ?? null) === JSON.stringify(right ?? null)) return true;
    if (
      left?.type !== 'native' ||
      right?.type !== 'native' ||
      left.baseRevision !== right.baseRevision
    )
      return false;
    // Re-referencing the same range issues a new opaque selection ID, not new authority.
    const a = this.get<any>(workspace, `native-reference:${left.selectionId}`),
      b = this.get<any>(workspace, `native-reference:${right.selectionId}`);
    return (
      !!a &&
      !!b &&
      a.objectId === b.objectId &&
      a.baseRevision === b.baseRevision &&
      a.writable === b.writable &&
      JSON.stringify(a.selection) === JSON.stringify(b.selection)
    );
  }
  private step(task: WorkTask) {
    if (task.execution!.steps >= task.budget.maxSteps)
      fail('BUDGET_EXHAUSTED', '已达到任务的提交与反馈步数上限，请用户调整预算。');
  }
  private usageEvidence(workspace: string, task: WorkTask) {
    const execution = task.execution!,
      reported = this.get<Record<string, number>>(workspace, `native-usage:${task.id}`) ?? {},
      refs = this.get<Record<string, string>>(workspace, `native-execution-refs:${task.id}`) ?? {};
    return {
      hostTokens: {
        status: 'unavailable',
        tokens: null,
        reason: '当前宿主未提供可认证的逐任务计费或 Token 计量信号。',
      },
      executorReports: execution.participants.map((participant) => ({
        participantId: participant.id,
        role: participant.role,
        ...(reported[participant.id] !== undefined
          ? { reportedTokens: reported[participant.id] }
          : {}),
        ...(refs[participant.id] ? { reportedExecutionRef: refs[participant.id] } : {}),
      })),
      enforced: {
        commitAndFeedbackSteps: execution.steps,
        maxSteps: task.budget.maxSteps,
        deadlineAt: execution.deadlineAt,
        remainingWindowMs: Math.max(0, execution.deadlineAt - Date.now()),
      },
      wallElapsedMs: Math.max(0, Date.now() - Date.parse(execution.startedAt)),
      tokenBudget: {
        preference: task.budget.maxTokens,
        enforced: false,
        source: 'user_preference',
      },
      note: '时间为任务建立后的墙钟时间，包含等待和暂停，不等同模型运行时长。执行者报告与执行引用未经宿主计费认证。',
    };
  }
  private readAll(context: Context) {
    if (
      context.task.sources.some(
        (source) => context.binding.reads[source.objectId] !== source.revision,
      )
    )
      fail('READ_REQUIRED', '请先用此执行凭据实际读取全部任务材料的当前版本，再提交、交接或反馈。');
    if (
      context.task.sources.some(
        (source) =>
          source.kind === 'file' &&
          !source.selection &&
          context.binding.fileReads?.[source.objectId] !== source.revision,
      )
    )
      fail(
        'FILE_READ_REQUIRED',
        '原生文件的对象信息不是文件正文。请先 prepare_file(intent=read) 获取当前文件，并在原对话读取 sourcePath，再提交或审阅。',
      );
  }
  /** Called inside the controller's existing transaction, before any material access. */
  guard(auth: ExecutionAuth): Context | undefined {
    const binding = this.get<Binding>(auth.workspaceId, `native-binding:${auth.owner}`);
    if (!binding) {
      if (auth.status === 'delegated')
        fail('TASK_CREDENTIAL_REQUIRED', '此材料授权已交给任务，请使用任务返回的执行凭据。');
      return;
    }
    const task = this.task(auth.workspaceId, binding.taskId);
    this.grant(auth.workspaceId, task);
    this.active(task);
    if (
      (binding.generation ?? 0) !==
      (this.get<number>(auth.workspaceId, `native-source-generation:${task.id}`) ?? 0)
    )
      fail(
        'TASK_SOURCES_REFRESHED',
        '任务材料基线已更新，请使用恢复任务返回的新凭据；旧副本不能继续回写。',
      );
    const participant = task.execution!.participants.find(
      (value) => value.id === binding.participantId,
    );
    if (!auth.session || !participant || participant.hostSessionHash !== digest(auth.session))
      fail('SESSION_MISMATCH', '任务执行身份与宿主会话不一致。');
    if (binding.role === 'reviewer' && binding.reviewRound !== task.execution!.reviewRound)
      fail('REVIEW_EXPIRED', '这一轮审阅已结束，请使用新一轮审阅邀请。');
    auth.observed = this.sources(auth.workspaceId, task);
    return { task, binding, auth };
  }
  read(context: Context, ids: string[], nativeFile = false) {
    context.task.usage.readOperations = (context.task.usage.readOperations ?? 0) + 1;
    for (const id of ids) context.binding.reads[id] = context.auth.observed[id];
    if (nativeFile) {
      context.binding.fileReads ??= {};
      for (const id of ids) context.binding.fileReads[id] = context.auth.observed[id];
    }
    this.put(context.auth.workspaceId, `native-binding:${context.auth.owner}`, context.binding);
    context.task.execution!.participants.find(
      (value) => value.id === context.binding.participantId,
    )!.lastReads = { ...context.binding.reads };
    this.record(
      context.auth.workspaceId,
      context.task,
      context.binding.role === 'writer' ? 'codex-writer' : 'codex-reviewer',
      nativeFile ? '取得原生文件读取副本' : '读取任务材料',
      ids
        .map(
          (id) =>
            `${context.task.sources.find((source) => source.objectId === id)?.title ?? id} · v${context.auth.observed[id]}`,
        )
        .join('\n'),
      context.binding.participantId,
    );
  }
  /** The same task guard covers native files and structured objects. Reviewers never inherit writer rights. */
  fileAccess(auth: ExecutionAuth, objectId: string, write: boolean): Context | undefined {
    const context = this.guard(auth);
    if (!context) return;
    if (
      !auth.scope.includes(objectId) ||
      !context.task.sources.some((source) => source.objectId === objectId)
    )
      fail('PERMISSION_DENIED', '文件不在此任务的材料范围内。');
    if (write) this.beforeCommit(context, [objectId]);
    return context;
  }
  fileBinding(context: Context): NativeTaskFileBinding {
    return {
      taskId: context.task.id,
      participantId: context.binding.participantId,
      role: context.binding.role,
      generation: context.binding.generation ?? 0,
    };
  }
  beforeCommit(context: Context, objectIds: string[]) {
    const execution = context.task.execution!;
    if (context.binding.role !== 'writer' || !['writing', 'revising'].includes(execution.phase))
      fail('PERMISSION_DENIED', '当前执行身份或任务阶段不允许写入；审阅者只读。');
    if (objectIds.some((id) => !context.task.writeObjectIds.includes(id)))
      fail('PERMISSION_DENIED', '本次修改超出了任务明确允许的写入对象。');
    this.readAll(context);
    this.step(context.task);
    if (
      execution.phase === 'revising' &&
      context.binding.acknowledgedFeedback !== execution.currentFeedbackId
    )
      fail('FEEDBACK_REQUIRED', '请先通过 acknowledge 明确接收本轮审阅反馈，再修订材料。');
    const participant = execution.participants.find(
      (value) => value.id === context.binding.participantId,
    )!;
    return {
      taskId: context.task.id,
      participantId: participant.id,
      hostSessionHash: participant.hostSessionHash,
      role: context.binding.role,
      ...(execution.phase === 'revising' ? { feedbackId: execution.currentFeedbackId } : {}),
    };
  }
  committed(
    context: Context,
    changed: { objectId: string; revision: number }[],
    ranges: Record<string, MaterialRange>,
  ) {
    for (const change of changed) {
      const source = context.task.sources.find((value) => value.objectId === change.objectId)!;
      source.revision = change.revision;
      if (ranges[change.objectId]) source.selection = ranges[change.objectId];
    }
    context.task.execution!.steps++;
    context.task.execution!.writes++;
    context.task.step = context.task.execution!.phase === 'revising' ? 2 : 1;
    this.record(
      context.auth.workspaceId,
      context.task,
      'codex-writer',
      context.task.execution!.phase === 'revising' ? '引用审阅反馈后提交修订' : '提交材料修改',
      changed
        .map(
          (change) =>
            `${context.task.sources.find((source) => source.objectId === change.objectId)?.title} → v${change.revision}`,
        )
        .join('\n'),
      context.binding.participantId,
    );
  }
  start(input: unknown, session: string | null) {
    const p = NativeTaskStart.parse(input);
    return this.api.tx(() => {
      const auth = this.api.auth(p.workspaceId, p.credential, session, 'execution');
      if (!session) fail('HOST_ID_REQUIRED', '宿主没有提供真实会话标识，不能建立执行身份。');
      return this.api.once(
        p.workspaceId,
        p.requestId,
        { operation: 'native.start', ...p, session },
        () => {
          if (
            auth.status === 'delegated' ||
            this.get(p.workspaceId, `native-binding:${auth.owner}`)
          )
            fail('INVALID_STATE', '此凭据已属于任务，请使用已有任务。');
          const count = (
            this.db
              .prepare(
                "SELECT COUNT(*) AS n FROM settings WHERE workspace=? AND key LIKE 'prototype-task:%'",
              )
              .get(p.workspaceId) as { n: number }
          ).n;
          if (count >= 1000) fail('TASK_LIMIT', '当前工作区任务数量已到上限。');
          if (
            p.objectIds.some((id) => !auth.scope.includes(id)) ||
            p.writeObjectIds.some((id) => !p.objectIds.includes(id))
          )
            fail('PERMISSION_DENIED', '任务范围必须属于用户已引用的材料。');
          const ranges =
            this.get<Record<string, MaterialRange>>(
              p.workspaceId,
              `execution-ranges:${auth.owner}`,
            ) ?? {};
          const sources = [...new Set(p.objectIds)].map((objectId) => {
            const object = this.api.object(p.workspaceId, objectId);
            if (
              object.archived ||
              object.policy?.private ||
              object.revision !== auth.observed[objectId]
            )
              fail('STALE_INPUT', '材料或权限已变化，请重新引用。');
            if (p.writeObjectIds.includes(objectId) && object.policy?.locked)
              fail('LOCKED_CONTENT', '已保留的整份材料只能只读。');
            if (
              this.db
                .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
                .get(p.workspaceId, objectId, Date.now())
            )
              fail('DRAFT_ACTIVE', '用户有未保存草稿，请先保存材料。');
            const selected = this.api.select(object, ranges[objectId]);
            if (
              p.writeObjectIds.includes(objectId) &&
              (ranges[objectId]?.type === 'file_text' || selected.selectionWritable === false)
            )
              fail('PERMISSION_DENIED', '引用的文件片段只读，不能设为任务写入材料。');
            return {
              objectId,
              title: object.title,
              kind: object.kind,
              revision: object.revision,
              ...(ranges[objectId] ? { selection: ranges[objectId] } : {}),
            };
          });
          const participant = {
            id: uid('participant'),
            role: 'writer' as const,
            hostSessionHash: digest(session),
            joinedAt: time(),
            lastReads: {},
          };
          const task: WorkTask = {
            id: uid('worktask'),
            title: p.title,
            goal: p.goal,
            constraints: p.constraints,
            revision: 1,
            status: 'working',
            step: 0,
            createdAt: time(),
            updatedAt: time(),
            archived: false,
            sources,
            proposal: '',
            budget: p.budget,
            writeObjectIds: [...new Set(p.writeObjectIds)],
            usage: { demoSteps: 0, modelTokens: null, executionMs: null },
            retries: 0,
            events: [
              {
                id: uid('event'),
                actor: 'codex-writer',
                title: '从原对话建立任务',
                body: '执行身份取自宿主会话元数据；材料正文需由执行者实际读取。',
                at: time(),
                participantId: participant.id,
              },
            ],
            execution: {
              mode: 'codex',
              originOwner: auth.owner,
              phase: 'writing',
              startedAt: time(),
              deadlineAt: Date.now() + p.budget.maxMinutes * 60000,
              steps: 0,
              writes: 0,
              reviewRound: 0,
              reviewedWrites: 0,
              participants: [participant],
              feedbacks: [],
            },
          };
          const managed = this.api.managed?.(p.workspaceId);
          if (managed) {
            const runId = managed.management!.runs.at(-1)!.id;
            if (
              managed.execution &&
              this.get(p.workspaceId, `native-managed-run:${managed.id}`) === runId
            )
              fail('TASK_ALREADY_BOUND', '本执行已有协作身份，请恢复原任务');
            if (managed.execution) {
              this.put(
                p.workspaceId,
                `native-execution-history:${managed.id}:${managed.execution.startedAt}`,
                managed.execution,
              );
              this.put(
                p.workspaceId,
                `native-source-generation:${managed.id}`,
                (this.get<number>(p.workspaceId, `native-source-generation:${managed.id}`) ?? 0) +
                  1,
              );
            }
            this.put(p.workspaceId, `native-managed-run:${managed.id}`, runId);
            task.id = managed.id;
            task.title = managed.title;
            task.goal = managed.goal;
            task.constraints = managed.constraints;
            task.createdAt = managed.createdAt;
            task.revision = managed.revision + 1;
            task.management = managed.management;
            task.events = [...managed.events, ...task.events];
          }
          this.put(p.workspaceId, `prototype-task:${task.id}`, task);
          this.db
            .prepare(
              "UPDATE credentials SET status='delegated' WHERE workspace=? AND owner=? AND kind='execution'",
            )
            .run(p.workspaceId, auth.owner);
          const result = this.issue(p.workspaceId, session, task, participant.id, 'writer');
          this.api.event(p.workspaceId, 'worktask.created', null, null, 'ai');
          return {
            ...result,
            task,
            instructions:
              '在原对话报告进度。用新的 credential 调用 desktop_read_objects；原生文件继续用同一任务凭据 prepare_file(read)，实际读取后 prepare_file(edit) 和 file_result(commit)，结构化材料用 desktop_commit_changes。需要独立审阅时，用户须已授权委派，再获取邀请交给另一个真实 Codex 执行上下文。不要将角色标签当作第二个执行身份。',
          };
        },
      );
    });
  }
  resume(input: unknown, session: string | null) {
    const p = NativeTaskResume.parse(input);
    return this.api.tx(() =>
      this.api.once(
        p.workspaceId,
        p.requestId,
        { operation: 'native.resume', ...p, session },
        () => {
          const auth = this.api.auth(p.workspaceId, p.credential, session, 'execution'),
            task = this.task(p.workspaceId, p.taskId),
            execution = task.execution!;
          if (!session || task.archived || ['completed', 'cancelled'].includes(task.status))
            fail('TASK_FINISHED', '任务不能恢复。');
          const writer = execution.participants.find((p) => p.role === 'writer');
          if (!writer || writer.hostSessionHash !== digest(session))
            fail('SESSION_MISMATCH', '请在建立任务的原对话恢复。');
          if (auth.status !== 'active' || this.get(p.workspaceId, `native-binding:${auth.owner}`))
            fail('FILE_SELECTION_REQUIRED', '请使用用户重新引用材料后的新凭据。');
          const ranges =
            this.get<Record<string, MaterialRange>>(
              p.workspaceId,
              `execution-ranges:${auth.owner}`,
            ) ?? {};
          const currentSources = task.sources.map((source) => {
            if (!auth.scope.includes(source.objectId))
              fail(
                'PERMISSION_DENIED',
                '新引用必须包含原任务的全部材料；不会自动扩大或缩减任务范围。',
              );
            const object = this.api.object(p.workspaceId, source.objectId),
              selection = ranges[source.objectId];
            if (
              object.archived ||
              object.policy?.private ||
              object.revision !== auth.observed[object.id]
            )
              fail('STALE_INPUT', '新引用已失效，请重新引用当前材料。');
            if (
              this.db
                .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
                .get(p.workspaceId, object.id, Date.now())
            )
              fail('DRAFT_ACTIVE', '材料有未保存草稿，请先保存后重新引用。');
            this.api.select(object, selection);
            return {
              objectId: object.id,
              title: object.title,
              kind: object.kind,
              revision: object.revision,
              ...(selection ? { selection } : {}),
            };
          });
          const sourceChanged = currentSources.some(
            (source, index) =>
              source.revision !== task.sources[index].revision ||
              !this.sameSelection(p.workspaceId, source.selection, task.sources[index].selection),
          );
          if (sourceChanged && !p.acceptCurrentSources)
            fail(
              'TASK_REFRESH_REQUIRED',
              '材料或引用范围已变化。比较保留已有修改后，用新引用调用 resume(acceptCurrentSources=true)，明确接纳当前版本；旧副本将停止回写。',
            );
          const refreshed = sourceChanged && p.acceptCurrentSources;
          this.db
            .prepare(
              "UPDATE credentials SET status='revoked' WHERE workspace=? AND owner IN (SELECT substr(key,16) FROM settings WHERE workspace=? AND key LIKE 'native-binding:%' AND json_extract(value,'$.taskId')=? AND (json_extract(value,'$.role')='writer' OR ?=1))",
            )
            .run(p.workspaceId, p.workspaceId, task.id, refreshed ? 1 : 0);
          if (refreshed) {
            task.sources = currentSources;
            const generation =
              (this.get<number>(p.workspaceId, `native-source-generation:${task.id}`) ?? 0) + 1;
            this.put(p.workspaceId, `native-source-generation:${task.id}`, generation);
            // Retain completed writes and feedback as history, but no old approval applies to a new source revision.
            execution.phase = 'writing';
            if (execution.reviewRound > 0) execution.reviewRound++;
            delete execution.currentFeedbackId;
            if (
              task.management &&
              !task.management.legacy &&
              ['paused', 'pausing', 'cancelling', 'cancelled', 'revising', 'completed'].includes(
                task.management.state,
              )
            )
              fail('TASK_PAUSED', '当前工作已停止或要求更新，旧协作身份不能继续回写');
            if (task.status === 'paused') task.resumeStatus = 'working';
            else task.status = 'working';
            this.db
              .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
              .run(p.workspaceId, `native-dispatch:${task.id}`);
            for (const row of this.db
              .prepare(
                "SELECT key,value FROM settings WHERE workspace=? AND key LIKE 'native-file:session:%'",
              )
              .all(p.workspaceId) as { key: string; value: string }[]) {
              const record = JSON.parse(row.value);
              if (record.task?.taskId !== task.id || record.state !== 'prepared') continue;
              record.state = 'discarded';
              record.lastError = {
                code: 'TASK_SOURCES_REFRESHED',
                message:
                  '任务已接纳新的材料版本。旧工作副本保留供比较，不能回写；请在新副本中合并需要保留的修改。',
                at: time(),
              };
              this.put(p.workspaceId, row.key, record);
              this.api.event(
                p.workspaceId,
                'native_file.discarded',
                record.objectId,
                record.baseRevision,
                'ai',
              );
            }
            for (const participant of execution.participants) participant.lastReads = {};
          } else this.sources(p.workspaceId, task);
          execution.originOwner = auth.owner;
          this.db
            .prepare(
              "UPDATE credentials SET status='delegated' WHERE workspace=? AND owner=? AND kind='execution'",
            )
            .run(p.workspaceId, auth.owner);
          // Preserve phase, deadlines and pause state. Renewed authority is not a renewed budget.
          const result = this.issue(p.workspaceId, session, task, writer.id, 'writer');
          this.record(
            p.workspaceId,
            task,
            'codex-writer',
            refreshed ? '接纳当前材料并恢复原任务' : '原对话恢复任务',
            refreshed
              ? '使用新引用更新材料基线；旧副本和审阅授权停止写入，已提交结果、历史反馈、暂停状态与累计预算保留。'
              : '恢复材料授权；保留阶段、反馈、已完成修改和预算。',
            writer.id,
          );
          return {
            ...result,
            task,
            sourcesRefreshed: refreshed,
            instructions: refreshed
              ? '读取更新后的材料；已完成修改仍在原对象，不要重跑。旧副本仅供比较，将必要修改合并到新副本。旧审阅意见保留为历史，需重新审阅。暂停状态与时间预算未重置。'
              : '先调用 next 检查阶段；不要重复已完成写入。暂停状态与时间预算没有自动重置。',
          };
        },
      ),
    );
  }
  private issue(
    workspace: string,
    session: string,
    task: WorkTask,
    participantId: string,
    role: Binding['role'],
  ) {
    const owner = uid('native'),
      observed = Object.fromEntries(
        task.sources.map((source) => [source.objectId, source.revision]),
      );
    const credential = this.api.issue(
      workspace,
      'execution',
      owner,
      session,
      task.sources.map((source) => source.objectId),
      observed,
    );
    this.put(workspace, `native-binding:${owner}`, {
      taskId: task.id,
      participantId,
      role,
      reviewRound: task.execution!.reviewRound,
      generation: this.get<number>(workspace, `native-source-generation:${task.id}`) ?? 0,
      reads: {},
      fileReads: {},
    });
    this.put(
      workspace,
      `execution-ranges:${owner}`,
      Object.fromEntries(
        task.sources.flatMap((source) =>
          source.selection ? [[source.objectId, source.selection]] : [],
        ),
      ),
    );
    return { workspaceId: workspace, credential, taskId: task.id, participantId, role };
  }
  action(input: unknown, session: string | null) {
    const p = NativeTaskAction.parse(input);
    return this.api.tx(() => {
      const auth = this.api.auth(p.workspaceId, p.credential, session, 'execution');
      const binding = this.get<Binding>(p.workspaceId, `native-binding:${auth.owner}`);
      if (!binding) fail('TASK_CREDENTIAL_REQUIRED', '请使用真实任务的执行凭据。');
      if (p.action === 'status' || p.action === 'next') {
        const task = this.task(p.workspaceId, binding.taskId);
        this.grant(p.workspaceId, task);
        const dispatch = this.get<any>(p.workspaceId, `native-dispatch:${task.id}`),
          phase = task.execution!.phase;
        const staleSources = task.sources
          .filter(
            (source) =>
              this.api.object(p.workspaceId, source.objectId).revision !== source.revision,
          )
          .map((source) => ({
            objectId: source.objectId,
            taskRevision: source.revision,
            currentRevision: this.api.object(p.workspaceId, source.objectId).revision,
          }));
        const next =
          task.archived || ['completed', 'cancelled'].includes(task.status)
            ? 'finished'
            : task.status === 'paused'
              ? 'paused'
              : staleSources.length
                ? 'refresh_sources'
                : Date.now() >= task.execution!.deadlineAt
                  ? 'adjust_time_budget'
                  : binding.role === 'reviewer'
                    ? 'read_and_review'
                    : phase === 'writing'
                      ? 'read_and_write'
                      : phase === 'revising'
                        ? 'acknowledge_and_revise'
                        : phase === 'reviewing'
                          ? dispatch?.claimed
                            ? 'wait_for_reviewer'
                            : dispatch?.expires > Date.now()
                              ? 'dispatch_reviewer'
                              : 'renew_invitation'
                          : 'await_user_confirmation';
        return {
          task,
          role: binding.role,
          participantId: binding.participantId,
          next,
          staleSources,
          usageEvidence: this.usageEvidence(p.workspaceId, task),
          elapsedMs: Date.now() - Date.parse(task.execution!.startedAt),
          ...(next === 'dispatch_reviewer'
            ? { invitation: dispatch.invitation, expires: dispatch.expires }
            : {}),
          feedback: task.execution!.feedbacks.at(-1),
          instructions:
            next === 'refresh_sources'
              ? '在原对话使用用户新引用的全部任务材料，调用 desktop_task_resume(acceptCurrentSources=true) 接纳当前版本；保留已提交结果，停止旧副本回写并重新读取，不要重跑任务。'
              : next === 'adjust_time_budget'
                ? '任务读写窗口已到期，请在桌面任务设置中调整时间窗口；重新引用不会自动重置预算。'
                : next === 'finished'
                  ? '任务已结束，保留已有结果；后续工作需要用户新授权。'
                  : next === 'dispatch_reviewer'
                    ? '仅在用户已授权委派时，用原对话的真实代理工具派发独立审阅者；交给它 invitation 并让它 desktop_task_join。不要自行创建额外聊天或隐藏执行器。'
                    : next === 'wait_for_reviewer'
                      ? '等待已领取邀请的真实审阅者，不重复派发。通过宿主代理等待工具等待进度。'
                      : next === 'acknowledge_and_revise'
                        ? '先 acknowledge 当前 feedback.id，实际修订并写回后再 invite_review。'
                        : next === 'paused'
                          ? '任务已暂停，等待用户继续。'
                          : '沿用原对话工具执行；原生文件需 prepare_file(read) 后实际读取，再准备 edit 和提交结果。',
        };
      }
      return this.api.once(
        p.workspaceId,
        p.requestId,
        { operation: 'native.action', ...p, session },
        () => {
          const context = this.guard(auth)!;
          const { task } = context,
            execution = task.execution!;
          if (p.action === 'progress') {
            if (p.reportedTokens !== undefined) {
              const key = `native-usage:${task.id}`,
                usage = this.get<Record<string, number>>(p.workspaceId, key) ?? {};
              if (p.reportedTokens < (usage[binding.participantId] ?? 0))
                fail('USAGE_SEQUENCE', '累计用量报告不能倒退。');
              usage[binding.participantId] = p.reportedTokens;
              this.put(p.workspaceId, key, usage);
              task.usage.reportedTokens = Object.values(usage).reduce((a, b) => a + b, 0);
            }
            if (p.executionRef) {
              const refs =
                this.get<Record<string, string>>(
                  p.workspaceId,
                  `native-execution-refs:${task.id}`,
                ) ?? {};
              refs[binding.participantId] = p.executionRef;
              this.put(p.workspaceId, `native-execution-refs:${task.id}`, refs);
            }
            this.record(
              p.workspaceId,
              task,
              binding.role === 'writer' ? 'codex-writer' : 'codex-reviewer',
              '执行进度',
              p.body ?? '更新执行记录',
              binding.participantId,
            );
            return {
              task,
              tokenSource:
                task.usage.reportedTokens === undefined ? 'unavailable' : 'executor_report',
              usageEvidence: this.usageEvidence(p.workspaceId, task),
              elapsedMs: Date.now() - Date.parse(execution.startedAt),
            };
          }
          if (p.action === 'acknowledge') {
            if (
              binding.role !== 'writer' ||
              execution.phase !== 'revising' ||
              !p.feedbackId ||
              p.feedbackId !== execution.currentFeedbackId
            )
              fail('INVALID_STATE', '没有匹配的待处理审阅反馈。');
            binding.acknowledgedFeedback = p.feedbackId;
            this.put(p.workspaceId, `native-binding:${auth.owner}`, binding);
            return { task, acknowledgedFeedback: p.feedbackId };
          }
          this.readAll(context);
          if (p.action === 'finish') {
            if (
              binding.role !== 'writer' ||
              execution.phase !== 'writing' ||
              execution.reviewRound > 0 ||
              !p.body
            )
              fail(
                'INVALID_STATE',
                '仅未进入审阅流程的写入者可以提交完成摘要；已经发起审阅的任务需完成审阅。',
              );
            execution.phase = 'ready';
            task.status = 'ready';
            task.step = 3;
            this.record(
              p.workspaceId,
              task,
              'codex-writer',
              '提交结果，等待用户确认',
              p.body,
              binding.participantId,
            );
            return { task };
          }
          if (p.action === 'invite_review') {
            if (
              binding.role !== 'writer' ||
              !['writing', 'revising', 'reviewing'].includes(execution.phase)
            )
              fail('INVALID_STATE', '当前阶段不能发起审阅。');
            if (execution.phase === 'revising' && execution.writes <= execution.reviewedWrites)
              fail('REVISION_REQUIRED', '请先根据反馈实际提交修订，再发起下一轮审阅。');
            const previous = this.get<any>(p.workspaceId, `native-dispatch:${task.id}`);
            if (
              execution.phase === 'reviewing' &&
              previous &&
              (previous.claimed || previous.expires > Date.now())
            )
              return {
                workspaceId: p.workspaceId,
                taskId: task.id,
                task,
                ...(!previous.claimed
                  ? { invitation: previous.invitation, expires: previous.expires }
                  : {}),
                instructions: previous.claimed
                  ? '已有真实审阅者领取邀请，请等待。'
                  : '复用尚未领取的审阅邀请，避免重复派发。',
              };
            execution.phase = 'reviewing';
            execution.reviewRound++;
            execution.reviewedWrites = execution.writes;
            task.status = 'review';
            const invitation = uid('review'),
              expires = Date.now() + 10 * 60000;
            this.put(p.workspaceId, `native-invitation:${digest(invitation)}`, {
              taskId: task.id,
              round: execution.reviewRound,
              expires,
              used: false,
            });
            this.put(p.workspaceId, `native-dispatch:${task.id}`, {
              invitation,
              expires,
              round: execution.reviewRound,
              claimed: false,
            });
            this.record(
              p.workspaceId,
              task,
              'codex-writer',
              '等待独立执行者审阅',
              '审阅邀请只允许另一宿主会话领取，接收者获得所选材料的只读权限。',
              binding.participantId,
            );
            return {
              workspaceId: p.workspaceId,
              taskId: task.id,
              invitation,
              expires,
              task,
              instructions:
                '仅在用户已授权委派时，将此 invitation 交给另一个真实执行上下文，让其调用 desktop_task_join。不要在当前会话伪装审阅者。',
            };
          }
          if (
            binding.role !== 'reviewer' ||
            execution.phase !== 'reviewing' ||
            !p.body ||
            !p.decision
          )
            fail('INVALID_STATE', '审阅反馈需要审阅身份、内容和结论。');
          this.step(task);
          const feedback = {
            id: uid('feedback'),
            participantId: binding.participantId,
            body: p.body,
            decision: p.decision,
            basedOn: this.sources(p.workspaceId, task),
            at: time(),
          };
          execution.feedbacks.push(feedback);
          execution.currentFeedbackId = feedback.id;
          execution.steps++;
          execution.phase = p.decision === 'approve' ? 'approved' : 'revising';
          task.status = p.decision === 'approve' ? 'ready' : 'working';
          task.step = p.decision === 'approve' ? 3 : 2;
          this.record(
            p.workspaceId,
            task,
            'codex-reviewer',
            p.decision === 'approve' ? '审阅者提交通过意见' : '审阅者提出修订意见',
            p.body,
            binding.participantId,
          );
          return { task, feedback };
        },
      );
    });
  }
  join(input: unknown, session: string | null) {
    const p = NativeTaskJoin.parse(input);
    return this.api.tx(() => {
      if (!session) fail('HOST_ID_REQUIRED', '宿主没有提供真实会话标识，不能建立审阅身份。');
      return this.api.once(
        p.workspaceId,
        p.requestId,
        { operation: 'native.join', ...p, session },
        () => {
          const key = `native-invitation:${digest(p.invitation)}`,
            invitation = this.get<{
              taskId: string;
              round: number;
              expires: number;
              used: boolean;
            }>(p.workspaceId, key);
          if (!invitation || invitation.used || invitation.expires < Date.now())
            fail('INVITATION_EXPIRED', '审阅邀请无效、已领取或已到期。');
          const task = this.task(p.workspaceId, invitation.taskId),
            execution = task.execution!;
          this.grant(p.workspaceId, task);
          this.active(task);
          this.sources(p.workspaceId, task);
          if (execution.phase !== 'reviewing' || execution.reviewRound !== invitation.round)
            fail('REVIEW_EXPIRED', '审阅轮次已改变。');
          const hostSessionHash = digest(session);
          if (
            execution.participants.some(
              (value) => value.role === 'writer' && value.hostSessionHash === hostSessionHash,
            )
          )
            fail(
              'DISTINCT_EXECUTOR_REQUIRED',
              '审阅必须来自另一真实宿主会话；当前身份不能同时充当写入者与审阅者。',
            );
          let participant = execution.participants.find(
            (value) => value.role === 'reviewer' && value.hostSessionHash === hostSessionHash,
          );
          if (!participant) {
            if (execution.participants.length >= 8)
              fail('PARTICIPANT_LIMIT', '此任务最多记录 8 个执行上下文。');
            participant = {
              id: uid('participant'),
              role: 'reviewer',
              hostSessionHash,
              joinedAt: time(),
              lastReads: {},
            };
            execution.participants.push(participant);
          }
          invitation.used = true;
          this.put(p.workspaceId, key, invitation);
          const dispatch = this.get<any>(p.workspaceId, `native-dispatch:${task.id}`);
          if (dispatch)
            this.put(p.workspaceId, `native-dispatch:${task.id}`, { ...dispatch, claimed: true });
          const result = this.issue(p.workspaceId, session, task, participant.id, 'reviewer');
          this.record(
            p.workspaceId,
            task,
            'codex-reviewer',
            '独立执行者加入审阅',
            '身份依据宿主会话元数据登记；需实际读取当前材料后才能反馈。',
            participant.id,
          );
          return {
            ...result,
            task,
            instructions:
              '先调用 desktop_read_objects 读取全部任务材料；完整原生文件还需用此审阅凭据 prepare_file(intent=read)，在当前宿主上下文读取 sourcePath。再用 desktop_task_action feedback 提交 approve 或 revise。此身份不能准备编辑副本或回写文件。',
          };
        },
      );
    });
  }
  control(
    workspace: string,
    task: WorkTask,
    operation: string,
    budget?: WorkTask['budget'],
    writeIds?: string[],
  ) {
    const execution = task.execution!;
    if (operation === 'cancel' || operation === 'archive') {
      if (operation === 'cancel' && task.status === 'completed')
        fail('TASK_FINISHED', '已完成任务无需停止，可以归档记录。');
      if (task.status !== 'completed') task.status = 'cancelled';
      if (operation === 'archive') task.archived = true;
      this.record(
        workspace,
        task,
        'human',
        operation === 'archive' ? '停止并归档任务' : '停止任务',
        '后续任务读取、反馈和写入会被拒绝；已保存内容保留。',
      );
    } else if (operation === 'pause') {
      if (['completed', 'cancelled', 'paused'].includes(task.status))
        fail('INVALID_STATE', '当前任务不能暂停。');
      task.resumeStatus = task.status;
      task.status = 'paused';
      this.record(
        workspace,
        task,
        'human',
        '暂停任务',
        '插件停止后续材料操作；不会宣称已中断宿主正在进行的模型推理。',
      );
    } else if (operation === 'resume') {
      if (task.status !== 'paused') fail('INVALID_STATE', '任务没有暂停。');
      task.status = task.resumeStatus ?? 'working';
      task.resumeStatus = undefined;
      this.record(workspace, task, 'human', '继续任务', '恢复原阶段；模型需要在原对话继续操作。');
    } else if (operation === 'complete') {
      if (task.status !== 'ready' || !['ready', 'approved'].includes(execution.phase))
        fail('INVALID_STATE', '请先在原对话提交完成摘要，或完成已经发起的审阅。');
      this.sources(workspace, task);
      task.status = 'completed';
      this.record(
        workspace,
        task,
        'human',
        '用户确认完成',
        '用户确认本次任务结果，已有材料与操作记录保留。',
      );
    } else if (operation === 'configure') {
      if (['completed', 'cancelled'].includes(task.status))
        fail('TASK_FINISHED', '已结束任务不能调整。');
      if (writeIds) {
        if (
          writeIds.some((id) => {
            const object = this.api.object(workspace, id);
            return (
              !task.sources.some((source) => source.objectId === id) ||
              object.archived ||
              object.policy?.private ||
              object.policy?.locked
            );
          })
        )
          fail('PERMISSION_DENIED', '可写范围必须属于任务，且未被归档、禁止引用或整份保留。');
        task.writeObjectIds = [...new Set(writeIds)];
      }
      if (budget) {
        task.budget = budget;
        execution.deadlineAt = Date.parse(execution.startedAt) + budget.maxMinutes * 60000;
      }
      this.record(
        workspace,
        task,
        'human',
        '更新任务边界',
        `提交和反馈上限 ${task.budget.maxSteps} 步；可写 ${task.writeObjectIds.length} 份材料。Token 消耗尚无宿主可信计量。`,
      );
    } else fail('NATIVE_TASK_ACTION', '真实任务由原对话中的执行工具推进，请在原消息框继续。');
    return task;
  }
}
