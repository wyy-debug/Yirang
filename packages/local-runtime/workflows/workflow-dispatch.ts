import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Id, fail, type DesktopObject, type ModelBlock } from '../../contracts/index.js';
import type { WorkflowRun } from '../../contracts/workflows.js';

const Action = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('prepare'),
      requestId: Id,
      runIds: z.array(Id).min(1).max(10),
      continuing: z.boolean().optional(),
    })
    .strict(),
  z.object({ operation: z.literal('claim'), requestId: Id, dispatchId: Id }).strict(),
  z.object({ operation: z.literal('host_read'), dispatchId: Id }).strict(),
  z.object({
    operation: z.literal('host_start'), requestId: Id, dispatchId: Id, threadId: Id,
  }).strict(),
  z.object({
    operation: z.literal('host_finish'), dispatchId: Id, threadId: Id,
    outcome: z.enum(['sent', 'failed']), message: z.string().max(2000).optional(),
  }).strict(),
  z
    .object({
      operation: z.literal('delivery'),
      requestId: Id,
      dispatchId: Id,
      outcome: z.enum(['sent', 'failed', 'unknown']),
      message: z.string().max(2000).optional(),
    })
    .strict(),
  z.object({ operation: z.literal('discard'), requestId: Id, dispatchId: Id }).strict(),
  z.object({ operation: z.literal('list'), objectId: Id }).strict(),
]);
type Dispatch = {
  id: string;
  session: string;
  objectId: string;
  runIds: string[];
  state: 'preparing' | 'prepared' | 'claimed' | 'sent' | 'unknown' | 'failed';
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  threadId?: string;
  generation?: number;
  failurePhase?: 'prepare' | 'delivery' | 'discard' | 'stale';
  message?: string;
  snapshotIds: string[];
  revisions: Record<string, number>;
  policies: Record<string, number>;
};
type Api = {
  auth: (w: string, c: string, s: string | null) => { owner: string };
  object: (w: string, id: string) => DesktopObject;
  assertReady: (w: string, id: string, owner: string) => void;
  tx: <T>(fn: () => T) => T;
  once: <T>(w: string, id: string, p: unknown, fn: () => T) => T;
  recover: (w: string, c: string, s: string | null, p: unknown) => any;
  prepare: (
    w: string,
    c: string,
    s: string | null,
    p: unknown,
  ) => { snapshotId: string; content: ModelBlock[] };
};
const now = () => new Date().toISOString();

/** Persisted one-shot delivery. Transport uncertainty never authorizes a resend. */
export class WorkflowDispatches {
  constructor(
    private db: DatabaseSync,
    private api: Api,
  ) {}
  private get<T>(w: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(w, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  private put(w: string, key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(w, key, JSON.stringify(value));
  }
  private run(w: string, id: string) {
    const value = this.get<WorkflowRun>(w, `workflow-run:${id}`);
    if (!value || value.restoredAt)
      fail('WORKFLOW_RECOVERY', '请选择此桌面的实际运行，备份历史不能重新发送。');
    return value;
  }
  private record(w: string, id: string, s: string | null) {
    const value = this.get<Dispatch>(w, `workflow-dispatch:${id}`);
    if (!value) fail('NOT_FOUND', '流程发送记录不存在。');
    if (!s || s !== value.session) fail('SESSION_MISMATCH', '请回到发起流程的原 Codex 会话继续。');
    return value;
  }
  private records(w: string, id: string) {
    return (
      this.db
        .prepare(
          "SELECT value FROM settings WHERE workspace=? AND key LIKE 'workflow-dispatch:%' AND json_extract(value,'$.objectId')=? ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 30",
        )
        .all(w, id) as { value: string }[]
    ).map((row) => JSON.parse(row.value) as Dispatch);
  }
  private reported(w: string, record: Dispatch) {
    return record.runIds.some((id) => {
      const run = this.get<WorkflowRun>(w, `workflow-run:${id}`);
      return !!run?.reportedAt && run.reportedAt > (record.claimedAt ?? record.createdAt);
    });
  }
  private finished(w: string, record: Dispatch) {
    return record.runIds.every((id) => {
      const run = this.get<WorkflowRun>(w, `workflow-run:${id}`);
      return !!run && ['succeeded', 'failed'].includes(run.status);
    });
  }
  private uncertain(w: string, record: Dispatch) {
    return (
      ['claimed', 'unknown'].includes(record.state) &&
      !this.reported(w, record) &&
      !this.finished(w, record)
    );
  }
  private revoke(w: string, record: Dispatch) {
    this.removePayload(w, record.id);
    for (const snapshot of record.snapshotIds)
      this.db
        .prepare(
          "UPDATE credentials SET status='revoked' WHERE workspace=? AND owner=? AND kind='execution'",
        )
        .run(w, snapshot);
  }
  private removePayload(w: string, id: string) {
    this.db.prepare('DELETE FROM settings WHERE workspace=? AND key=?')
      .run(w, `workflow-dispatch-payload:${id}`);
  }
  private retire(w: string, record: Dispatch, message: string) {
    record.state = 'failed';
    record.failurePhase = 'stale';
    record.message = message;
    record.updatedAt = now();
    this.revoke(w, record);
    this.put(w, `workflow-dispatch:${record.id}`, record);
  }
  private stale(w: string, dispatch: Dispatch, owner: string) {
    if (
      dispatch.snapshotIds.length !== dispatch.runIds.length ||
      !this.get<ModelBlock[]>(w, `workflow-dispatch-payload:${dispatch.id}`)?.length
    )
      fail('WORKFLOW_DISPATCH', '发送材料尚未完整准备，请继续准备原请求。');
    for (const [index, runId] of dispatch.runIds.entries()) {
      const run = this.run(w, runId),
        binding = this.get<{ owner: string }>(w, `workflow-binding:run:${runId}`);
      if (['failed', 'succeeded'].includes(run.status))
        fail('WORKFLOW_FINISHED', '此运行已结束，请查看结果或明确创建新的局部执行。');
      if (binding?.owner !== dispatch.snapshotIds[index])
        fail('PERMISSION_REVOKED', '运行材料授权已由其他准备请求更新，请使用最新发送记录。');
    }
    for (const [id, revision] of Object.entries(dispatch.revisions)) {
      const object = this.api.object(w, id);
      if (
        object.archived ||
        object.policy?.private ||
        object.revision !== revision ||
        (object.policy?.revision ?? 0) !== dispatch.policies[id]
      )
        fail('STALE_INPUT', '发送前材料或权限已变化，请保存当前状态后重新准备。');
      this.api.assertReady(w, id, owner);
    }
    if (
      dispatch.snapshotIds.some(
        (id) =>
          !this.db
            .prepare(
              "SELECT 1 FROM credentials WHERE workspace=? AND owner=? AND kind='execution' AND status='active' AND expires>?",
            )
            .get(w, id, Date.now()),
      )
    )
      fail('PERMISSION_REVOKED', '本次流程材料授权已过期或撤销，请重新准备。');
  }
  action(w: string, c: string, s: string | null, input: unknown) {
    const auth = this.api.auth(w, c, s),
      p = Action.parse(input);
    if (p.operation === 'list') {
      this.api.object(w, p.objectId);
      return {
        dispatches: this.records(w, p.objectId).map(
          ({ revisions, policies, session, ...record }) => ({
            ...record,
            ...(['claimed', 'unknown'].includes(record.state) &&
            this.reported(w, { ...record, revisions, policies, session })
              ? { state: 'sent' as const }
              : {}),
          }),
        ),
      };
    }
    if (p.operation === 'host_read') {
      const record = this.record(w, p.dispatchId, s);
      if (record.state === 'sent' || this.reported(w, record))
        return { state: 'sent' };
      if (record.state !== 'prepared')
        return { state: record.state, threadId: record.threadId };
      this.stale(w, record, auth.owner);
      return {
        state: 'prepared',
        content: this.get<ModelBlock[]>(w, `workflow-dispatch-payload:${record.id}`),
      };
    }
    if (p.operation === 'host_start')
      return this.api.tx(() =>
        this.api.once(w, p.requestId, { type: 'workflow.dispatch.host_start', ...p, session: s }, () => {
          const record = this.record(w, p.dispatchId, s);
          if (record.state !== 'prepared')
            fail('WORKFLOW_DISPATCH_BUSY', '流程已进入发送，请核对原对话。');
          this.stale(w, record, auth.owner);
          record.state = 'unknown';
          record.threadId = p.threadId;
          record.claimedAt = now();
          record.updatedAt = record.claimedAt;
          this.put(w, `workflow-dispatch:${record.id}`, record);
          this.removePayload(w, record.id);
          return { started: true };
        }),
      );
    if (p.operation === 'host_finish')
      return this.api.tx(() => {
        const record = this.record(w, p.dispatchId, s);
        if (record.threadId !== p.threadId)
          fail('SESSION_MISMATCH', '流程发送归属的原对话不匹配。');
        if (record.state === 'unknown') {
          record.state = p.outcome === 'sent' || this.reported(w, record) ? 'sent' : 'failed';
          record.message = record.state === 'failed' ? p.message : undefined;
          record.updatedAt = now();
          if (record.state === 'failed') {
            record.failurePhase = 'delivery';
            this.revoke(w, record);
          }
          this.put(w, `workflow-dispatch:${record.id}`, record);
        }
        return { state: record.state };
      });
    if (p.operation === 'prepare') {
      if (!s) fail('SESSION_REQUIRED', '请从 Codex 内的工作桌面运行组件。');
      const reservation = this.api.tx(() =>
        this.api.once(
          w,
          p.requestId,
          { type: 'workflow.dispatch.prepare', ...p, session: s },
          () => {
            const runs = [...new Set(p.runIds)].map((id) => this.run(w, id)),
              objectId = runs[0].flowObjectId;
            if (
              runs.some(
                (run) =>
                  run.flowObjectId !== objectId || ['succeeded', 'failed'].includes(run.status),
              )
            )
              fail(
                'WORKFLOW_FINISHED',
                '同一次发送只能包含同一流程尚未结束的运行；失败记录请明确局部重跑或重试批处理项目。',
              );
            if (!p.continuing && runs.some((run) => run.status !== 'prepared'))
              fail(
                'WORKFLOW_CONTINUE_REQUIRED',
                '已开始的流程请继续原运行，不能作为新运行再次发送。',
              );
            const records = this.records(w, objectId);
            if (records.some((previous) => this.uncertain(w, previous)))
              fail(
                'WORKFLOW_DISPATCH_BUSY',
                '上次发送结果尚未确认，请查看原会话或等待执行回报，暂不重复发送。',
              );
            for (const previous of records) {
              if (previous.state === 'failed') continue;
              if (this.finished(w, previous)) continue;
              if (previous.state === 'prepared')
                try {
                  this.stale(w, previous, auth.owner);
                } catch (error) {
                  this.retire(w, previous, error instanceof Error ? error.message : String(error));
                  continue;
                }
              if (
                previous.state === 'preparing' &&
                Date.now() - Date.parse(previous.updatedAt) > 10 * 60 * 1000
              ) {
                this.retire(w, previous, '未发送的准备已中断，可使用新请求重新准备。');
                continue;
              }
              const sameSet =
                runs.length === previous.runIds.length &&
                runs.every((run) => previous.runIds.includes(run.id));
              if (
                sameSet &&
                ['preparing', 'prepared'].includes(previous.state) &&
                previous.session === s
              )
                return { dispatchId: previous.id };
              const active = previous.runIds.map((id) => this.run(w, id));
              const unknown = this.uncertain(w, previous);
              const sameRuns =
                p.continuing && runs.every((run) => previous.runIds.includes(run.id));
              const relatedBatch =
                runs.every(
                  (run) =>
                    run.batch && active.some((old) => old.batch?.batchId === run.batch!.batchId),
                ) && !active.some((run) => ['running', 'waiting'].includes(run.status));
              if (
                unknown ||
                (!sameRuns &&
                  !relatedBatch &&
                  active.some((run) => ['prepared', 'running', 'waiting'].includes(run.status)))
              )
                fail(
                  'WORKFLOW_DISPATCH_BUSY',
                  unknown
                    ? '上次发送结果尚未确认，请查看原会话或等待执行回报，暂不重复发送。'
                    : '已有同一流程待提交或运行，请先查看桌面上的原运行记录。',
                );
            }
            const at = now(),
              record: Dispatch = {
                id: `flow_dispatch_${randomUUID()}`,
                objectId,
                runIds: runs.map((run) => run.id),
                session: s,
                state: 'preparing',
                createdAt: at,
                updatedAt: at,
                snapshotIds: [],
                revisions: {},
                policies: {},
              };
            this.put(w, `workflow-dispatch:${record.id}`, record);
            return { dispatchId: record.id };
          },
        ),
      );
      let record = this.record(w, reservation.dispatchId, s);
      if (record.state === 'failed')
        fail(
          'WORKFLOW_DELIVERY_FAILED',
          record.message || '上次准备或投递已明确失败，请使用新请求继续原运行。',
        );
      if (record.state === 'prepared')
        try {
          this.stale(w, record, auth.owner);
        } catch (error) {
          this.api.tx(() =>
            this.retire(w, record, error instanceof Error ? error.message : String(error)),
          );
          throw error;
        }
      if (record.state !== 'preparing') return { dispatchId: record.id, state: record.state };
      // A process interruption may leave child-context receipts whose credentials were
      // later revoked. Each resumed preparation gets fresh, independently bound contexts.
      record = this.api.tx(() => {
        const current = this.record(w, record.id, s);
        if (current.state !== 'preparing')
          fail('WORKFLOW_DISPATCH', '准备状态已变化，请读取最新记录。');
        for (const prior of this.records(w, current.objectId))
          if (prior.id !== current.id && this.uncertain(w, prior))
            fail('WORKFLOW_DISPATCH_BUSY', '另一轮投递结果未知，不能刷新授权并重复发送。');
        this.revoke(w, current);
        current.generation = (current.generation ?? 0) + 1;
        current.snapshotIds = [];
        current.revisions = {};
        current.policies = {};
        current.updatedAt = now();
        this.put(w, `workflow-dispatch:${current.id}`, current);
        return current;
      });
      const generation = record.generation!;
      const content: ModelBlock[] = [
        {
          type: 'text',
          text: '用户已在工作桌面点击运行或继续。请按以下各运行的真实状态和各自材料凭据依次处理；不要把准备或发送当成执行完成。成功步骤不重复执行，人工确认节点等待桌面决定，批处理失败按配置停止或继续。进度、结构化输出和原生文件结果通过 desktop_workflow_run 回报；代码和外部工具沿用当前会话的执行权限与审批。',
        },
      ];
      const snapshots: string[] = [],
        revisions: Record<string, number> = {},
        policies: Record<string, number> = {};
      try {
        for (const runId of record.runIds) {
          const prepared = this.api.recover(w, c, s, {
            operation: 'recover',
            runId,
            requestId: `${record.id}:${generation}:${runId}:recover`,
          });
          const context = this.api.prepare(w, c, s, {
            requestId: `${record.id}:${generation}:${runId}:context`,
            purpose: 'instruction',
            instruction:
              '请执行用户在桌面提交的此工作流；先查询 status，只处理待执行步骤；恢复时先找回真实会话和已有产物，禁止重跑已开始的外部动作。',
            objectIds: prepared.objectIds,
            expectedRevisions: prepared.expectedRevisions,
            workflowRunId: runId,
            ranges: {},
          });
          snapshots.push(context.snapshotId);
          content.push(...context.content);
          this.api.tx(() => {
            const current = this.record(w, record.id, s);
            if (current.state !== 'preparing' || current.generation !== generation)
              fail('WORKFLOW_DISPATCH', '材料准备已被另一请求更新。');
            current.snapshotIds = [...snapshots];
            current.updatedAt = now();
            this.put(w, `workflow-dispatch:${current.id}`, current);
          });
          for (const [id, revision] of Object.entries(
            prepared.expectedRevisions as Record<string, number>,
          )) {
            if (revisions[id] !== undefined && revisions[id] !== revision)
              fail('STALE_INPUT', '批处理共享材料在准备期间改变，请重新准备。');
            revisions[id] = revision;
          }
          for (const id of prepared.objectIds)
            policies[id] = this.api.object(w, id).policy?.revision ?? 0;
        }
        if (Buffer.byteLength(JSON.stringify(content)) > 6 * 1024 * 1024)
          fail('CONTEXT_TOO_LARGE', '本批材料超过 6 MiB，请减少文件数后再运行。');
        this.api.tx(() => {
          record = this.record(w, record.id, s);
          if (record.state !== 'preparing' || record.generation !== generation)
            fail('WORKFLOW_DISPATCH', '发送状态已变化。');
          Object.assign(record, {
            state: 'prepared',
            snapshotIds: snapshots,
            revisions,
            policies,
            updatedAt: now(),
          });
          this.put(w, `workflow-dispatch-payload:${record.id}`, content);
          this.put(w, `workflow-dispatch:${record.id}`, record);
        });
      } catch (error) {
        this.api.tx(() => {
          record = this.record(w, record.id, s);
          if (record.state === 'preparing' && record.generation === generation) {
            record.state = 'failed';
            record.failurePhase = 'prepare';
            record.updatedAt = now();
            record.message = error instanceof Error ? error.message : String(error);
            this.put(w, `workflow-dispatch:${record.id}`, record);
          }
          for (const snapshot of snapshots)
            this.db
              .prepare(
                "UPDATE credentials SET status='revoked' WHERE workspace=? AND owner=? AND kind='execution'",
              )
              .run(w, snapshot);
        });
        throw error;
      }
      return { dispatchId: record.id, state: record.state };
    }
    if (p.operation === 'claim') {
      let content: ModelBlock[] | undefined;
      const receipt = this.api.tx(() =>
        this.api.once(w, p.requestId, { type: 'workflow.dispatch.claim', ...p, session: s }, () => {
          const record = this.record(w, p.dispatchId, s);
          if (record.state !== 'prepared') return { dispatchId: record.id, send: false };
          this.stale(w, record, auth.owner);
          content = this.get<ModelBlock[]>(w, `workflow-dispatch-payload:${record.id}`);
          record.state = 'claimed';
          record.claimedAt = now();
          record.updatedAt = record.claimedAt;
          this.put(w, `workflow-dispatch:${record.id}`, record);
          this.removePayload(w, record.id);
          return { dispatchId: record.id, send: true };
        }),
      );
      return content ? { ...receipt, content } : { ...receipt, send: false };
    }
    if (p.operation === 'discard')
      return this.api.tx(() =>
        this.api.once(
          w,
          p.requestId,
          { type: 'workflow.dispatch.discard', ...p, session: s },
          () => {
            const record = this.record(w, p.dispatchId, s);
            if (!['preparing', 'prepared', 'failed'].includes(record.state))
              fail('WORKFLOW_DELIVERY', '发送已领取或结果未知，不能当作未发送而丢弃。');
            record.state = 'failed';
            record.failurePhase = 'discard';
            record.updatedAt = now();
            this.put(w, `workflow-dispatch:${record.id}`, record);
            this.revoke(w, record);
            return { dispatchId: record.id, state: record.state };
          },
        ),
      );
    return this.api.tx(() =>
      this.api.once(
        w,
        p.requestId,
        { type: 'workflow.dispatch.delivery', ...p, session: s },
        () => {
          const record = this.record(w, p.dispatchId, s);
          if (record.threadId)
            fail('WORKFLOW_DELIVERY', '此流程由桌面主进程记录投递结果。');
          if (!['claimed', 'sent', 'unknown', 'failed'].includes(record.state))
            fail('WORKFLOW_DELIVERY', '请先领取发送内容。');
          if (record.state === 'sent' || record.state === 'failed')
            return { dispatchId: record.id, state: record.state };
          if (p.outcome === 'failed' && (record.state === 'unknown' || this.reported(w, record))) {
            if (this.reported(w, record)) {
              record.state = 'sent';
              record.updatedAt = now();
              record.message = '已收到本次运行回报，保留执行授权。';
              this.put(w, `workflow-dispatch:${record.id}`, record);
            }
            return { dispatchId: record.id, state: record.state };
          }
          record.state = p.outcome;
          record.message = p.message;
          record.updatedAt = now();
          this.put(w, `workflow-dispatch:${record.id}`, record);
          if (p.outcome === 'failed') {
            record.failurePhase = 'delivery';
            this.put(w, `workflow-dispatch:${record.id}`, record);
            this.revoke(w, record);
          }
          return { dispatchId: record.id, state: record.state };
        },
      ),
    );
  }
}
