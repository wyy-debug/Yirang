import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fail } from '../../contracts/index.js';
import { WorkCommand } from '../../contracts/work-management.js';

const key = z.string().min(1).max(160);
const receive = z.object({
  id: key,
  text: z
    .string()
    .min(1)
    .max(50000)
    .refine((s) => !!s.trim()),
  mode: z.enum(['daily', 'professional']),
  capture: z.record(z.string(), z.unknown()),
});
const terminal = new Set(['committed', 'cancelled', 'rejected']);
type Request = {
  id: string;
  sequence: number;
  text: string;
  mode: 'daily' | 'professional';
  capture: Record<string, unknown>;
  state: string;
  generation: number;
  owner: 'v2';
  contextVersion?: number;
  restoredAt?: string;
  receivedAt: number;
  updatedAt: number;
  response?: { turnId: string; status: string; text: string };
  reason?: string;
  choices?: unknown[];
  unresolved?: unknown[];
  consultationWaiting?: boolean;
  consultation?: { text: string; taskId?: string };
  modelSettings?: unknown;
  delivery?: {
    state: 'queued' | 'sending' | 'acknowledged' | 'unknown';
    threadId?: string;
    turnId?: string;
    sentAt?: number;
  };
};
type Effect = {
  intent?: string;
  afterIntents?: string[];
  id: string;
  requestId: string;
  generation: number;
  state: 'queued' | 'acknowledged' | 'cancelled' | 'failed';
  error?: string;
  command: z.infer<typeof WorkCommand>;
  result?: unknown;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Called inside the work store transaction. A business effect and its receipt
// commit together; a lost IPC reply can safely read the same durable receipt.
export class BotIntakeStore {
  constructor(
    private db: DatabaseSync,
    private apply: (workspace: string, command: unknown) => unknown,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS bot_requests(workspace TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,id),UNIQUE(workspace,sequence));
   CREATE TABLE IF NOT EXISTS bot_effects(workspace TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(workspace,id));
   CREATE INDEX IF NOT EXISTS bot_effects_request ON bot_effects(workspace,request_id);
   CREATE INDEX IF NOT EXISTS bot_request_turn ON bot_requests(workspace,json_extract(body,'$.delivery.threadId'),json_extract(body,'$.delivery.turnId'));`);
    // Never-sent direct deliveries from older versions return to the received state.
    this.db.exec(`UPDATE bot_requests SET body=json_set(json_remove(body,'$.delivery'),
      '$.mode','daily','$.capture.route','auto','$.state','received')
      WHERE json_extract(body,'$.mode')='professional'
      AND json_extract(body,'$.state')='committed'
      AND json_extract(body,'$.delivery.state')='queued'
      AND json_extract(body,'$.consultation') IS NULL
      AND NOT EXISTS (SELECT 1 FROM bot_effects WHERE bot_effects.workspace=bot_requests.workspace
        AND bot_effects.request_id=bot_requests.id)`);
  }
  private read(w: string, id: string): Request {
    const row = this.db
      .prepare('SELECT body FROM bot_requests WHERE workspace=? AND id=?')
      .get(w, id) as { body: string } | undefined;
    if (!row) fail('REQUEST_NOT_FOUND', '已保存的输入不存在');
    return JSON.parse(row.body);
  }
  private save(w: string, r: Request) {
    r.updatedAt = Date.now();
    this.db
      .prepare('UPDATE bot_requests SET body=? WHERE workspace=? AND id=?')
      .run(JSON.stringify(r), w, r.id);
    return r;
  }
  private effects(w: string, id: string): Effect[] {
    return (
      this.db
        .prepare('SELECT body FROM bot_effects WHERE workspace=? AND request_id=? ORDER BY rowid')
        .all(w, id) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  }
  private markFailed(w: string, r: Request, e: Effect, message: string) {
    e.state = 'failed';
    e.error = message;
    r.state = 'needs_input';
    r.reason = message;
    this.writeEffect(w, e);
    this.save(w, r);
    return e;
  }
  private writeEffect(w: string, e: Effect) {
    this.db
      .prepare('INSERT OR REPLACE INTO bot_effects VALUES(?,?,?,?)')
      .run(w, e.id, e.requestId, JSON.stringify(e));
  }
  list(w: string) {
    return (
      this.db
        .prepare(
          'SELECT body FROM bot_requests WHERE workspace=? ORDER BY sequence DESC LIMIT 1000',
        )
        .all(w) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as Request);
  }
  command(w: string, p: Record<string, unknown>): unknown {
    const operation = z.string().parse(p.operation);
    if (operation === 'receive') {
      const q = receive.parse(p.request);
      if (Buffer.byteLength(JSON.stringify(q)) > 9_000_000)
        fail('CONTEXT_TOO_LARGE', '输入和附件过大，请减少材料');
      const old = this.db
        .prepare('SELECT body FROM bot_requests WHERE workspace=? AND id=?')
        .get(w, q.id) as { body: string } | undefined;
      if (old) {
        const r = JSON.parse(old.body) as Request;
        if (digest([r.text, r.mode, r.capture]) !== digest([q.text, q.mode, q.capture]))
          fail('REQUEST_ID_REUSED', '同一请求不能替换原文或接收配置');
        return { ...r, effects: this.effects(w, r.id) };
      }
      const sequence = Number(
        (
          this.db
            .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM bot_requests WHERE workspace=?')
            .get(w) as { n: number }
        ).n,
      );
      const r: Request = {
        ...q,
        sequence,
        state: 'received',
        generation: 1,
        owner: 'v2',
        contextVersion: 2,
        receivedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.db
        .prepare('INSERT INTO bot_requests VALUES(?,?,?,?)')
        .run(w, r.id, sequence, JSON.stringify(r));
      return r;
    }
    if (operation === 'consult_result') {
      const threadId = key.parse(p.threadId),
        turnId = key.parse(p.turnId);
      const row = this.db
        .prepare(
          "SELECT body FROM bot_requests WHERE workspace=? AND json_extract(body,'$.delivery.threadId')=? AND json_extract(body,'$.delivery.turnId')=?",
        )
        .get(w, threadId, turnId) as { body: string } | undefined;
      if (!row) return null;
      const request = JSON.parse(row.body) as Request;
      if (request.response) return request.response;
      request.response = {
        turnId,
        status: z.enum(['completed', 'failed', 'interrupted']).parse(p.status),
        text: z.string().max(200000).parse(p.text),
      };
      this.save(w, request);
      return request.response;
    }
    if (operation === 'work_event_report') {
      const requestId = key.parse(p.id);
      const runId = key.parse(p.runId);
      if (requestId !== `followup-${runId}`)
        fail('WORK_EVENT_MISMATCH', '工作结果事件标识不匹配');
      const request = this.read(w, requestId);
      if (request.response) return request.response;
      const row = this.db.prepare('SELECT body FROM bot_events WHERE workspace=? AND id=?')
        .get(w, `work_result:${runId}`) as { body: string } | undefined;
      if (!row) fail('WORK_EVENT_NOT_FOUND', '工作结果事件不存在');
      const event = JSON.parse(row.body) as {
        taskId: string; runId: string; title: string; state: string;
        requirementsRevision: number; delivery: { state: string };
        artifacts?: { objectId: string; revision: number; title: string }[];
        verification?: { state: string; checkedRunId?: string; missing?: string[] };
      };
      if (event.runId !== runId || !['claimed', 'acknowledged'].includes(event.delivery.state) ||
          request.text !== `工作「${event.title}」结果已更新` ||
          request.capture.route !== 'consult' || request.capture.consultTaskId !== event.taskId)
        fail('WORK_EVENT_MISMATCH', '结果事件与主会话输入不一致');
      let current: any;
      try {
        current = this.apply(w, { operation: 'detail', taskId: event.taskId });
      } catch {
        // A missing or unreadable current task cannot certify a current completion.
      }
      const currentVersion = current?.id === event.taskId &&
        current.management?.currentRequirementsRevision === event.requirementsRevision &&
        current.management?.state === 'completed' &&
        current.management?.continuation?.checkedRunId === runId &&
        current.management?.continuation?.next === 'done';
      const verified = event.verification?.checkedRunId === runId &&
        event.verification.state === 'passed' && event.state === 'completed' && currentVersion;
      const files = (event.artifacts || []).map(a => `${a.title}（${a.objectId}@${a.revision}）`);
      const base = `工作「${event.title}」（taskId: ${event.taskId}，runId: ${runId}，要求版本: ${event.requirementsRevision}）`;
      const text = verified
        ? `${base}已完成并通过宿主核验。${files.length ? `该轮核验成果：${files.join('、')}。` : '本轮无文件成果。'}`
        : `${base}${event.verification?.state === 'passed' && !currentVersion
          ? '该轮曾通过核验，但当前任务或要求版本已变化，不能代表当前工作完成。'
          : `尚未确认完成。核验状态：${event.verification?.state || 'unknown'}。${event.verification?.missing?.length ? `待补：${event.verification.missing.join('、')}。` : ''}`}`;
      request.response = { turnId: `host:${runId}`, status: 'completed', text };
      request.state = 'committed';
      request.updatedAt = Date.now();
      this.save(w, request);
      return request.response;
    }
    if (operation === 'transcript') {
      const before = z.number().int().positive().optional().parse(p.before);
      const rows = this.db
        .prepare(
          'SELECT body FROM bot_requests WHERE workspace=? AND sequence<? ORDER BY sequence DESC LIMIT 50',
        )
        .all(w, before ?? Number.MAX_SAFE_INTEGER) as { body: string }[];
      // The transcript needs stable work links, not the full execution payload.
      // Effects live separately from the request body and survive restarts.
      const requests = rows.map((row) => {
        const request = JSON.parse(row.body) as Request;
        const acknowledged = this.effects(w, request.id)
          .filter(effect => effect.state === 'acknowledged');
        const taskLinks = [...new Set(acknowledged
          .flatMap(effect => {
            const result = effect.result as any;
            return [effect.command.taskId, result?.task?.id, result?.taskId,
              ...(result?.taskIds || [])];
          }).filter((id): id is string => typeof id === 'string' && !!id))];
        const workRequestIds = [...new Set(acknowledged.flatMap(effect => [
          effect.command.requestId, (effect.result as any)?.requestId,
        ]).filter((id): id is string => typeof id === 'string' && !!id))];
        return { ...request, taskLinks, workRequestIds };
      });
      return { requests, nextCursor: requests.length === 50 ? requests.at(-1)!.sequence : null };
    }
    if (operation === 'list')
      return this.list(w).map(({ capture, ...r }) => ({ ...r, effects: this.effects(w, r.id) }));
    if (operation === 'pending')
      return (
        this.db
          .prepare(
            "SELECT body FROM bot_requests WHERE workspace=? AND sequence>? AND (json_extract(body,'$.state') IN ('received','routing') OR json_extract(body,'$.delivery.state') IN ('queued','sending')) ORDER BY sequence LIMIT 100",
          )
          .all(
            w,
            z
              .number()
              .int()
              .nonnegative()
              .parse(p.afterSequence ?? 0),
          ) as { body: string }[]
      ).map((row) => JSON.parse(row.body));
    if (operation === 'lookup') {
      const row = this.db
        .prepare('SELECT body FROM bot_requests WHERE workspace=? AND id=?')
        .get(w, key.parse(p.id)) as { body: string } | undefined;
      return row ? { ...JSON.parse(row.body), effects: this.effects(w, key.parse(p.id)) } : null;
    }
    const r = this.read(w, key.parse(p.id));
    if (operation === 'read') return { ...r, effects: this.effects(w, r.id) };
    if (operation === 'apply') {
      const prior = this.effects(w, r.id).find((e) => e.id === p.effectId);
      if (prior?.state === 'acknowledged') return prior;
    }
    if (operation === 'retry') {
      if (['cancelled', 'rejected'].includes(r.state))
        fail('REQUEST_CLOSED', '已取消或拒绝的输入不能重放');
      if (r.restoredAt) fail('RESTORED_INPUT', '历史输入不能重放，请重新引用材料后发送');
      if (r.delivery && r.delivery.state !== 'queued')
        fail('DELIVERY_UNCERTAIN', '先核实原发送，不会自动重发');
      if (r.unresolved?.length || r.choices?.length)
        fail('CHOICE_REQUIRED', '请先确认剩余要求的目标');
      if (this.effects(w, r.id).some((e) => e.state === 'acknowledged') && !r.delivery)
        fail('REQUEST_COMMITTED', '已提交要求请从原工作继续');
      if (!this.effects(w, r.id).length) r.generation++;
      r.state = 'received';
      r.reason = undefined;
      return this.save(w, r);
    }
    if (operation === 'send_prepare') {
      if (r.delivery?.state !== 'queued')
        fail('DELIVERY_UNCERTAIN', '此问题已发送或发送结果待核实，不会重复发送');
      r.delivery = { state: 'sending', threadId: key.parse(p.threadId), sentAt: Date.now() };
      return this.save(w, r);
    }
    if (operation === 'send_ack' || operation === 'send_failed') {
      if (!r.delivery || r.delivery.threadId !== p.threadId)
        fail('DELIVERY_MISMATCH', '接收回执不属于此问题');
      if (r.delivery.state === 'acknowledged') return r;
      if (operation === 'send_ack') {
        r.delivery.state = 'acknowledged';
        r.delivery.turnId = key.parse(p.turnId);
      } else r.delivery.state = p.notReceived === true ? 'queued' : 'unknown';
      return this.save(w, r);
    }
    if (operation === 'cancel') {
      if (r.state === 'cancelled') return r;
      if (r.state === 'committed')
        fail('REQUEST_COMMITTED', '工作已接收，请按工作身份停止，不会抹去已执行记录');
      r.generation++;
      for (const e of this.effects(w, r.id))
        if (e.state === 'queued') {
          e.state = 'cancelled';
          this.writeEffect(w, e);
        }
      r.state = this.effects(w, r.id).some((e) => e.state === 'acknowledged')
        ? 'committed'
        : 'cancelled';
      r.reason = '未提交部分已取消';
      r.unresolved = undefined;
      r.choices = undefined;
      return this.save(w, r);
    }
    if (terminal.has(r.state)) fail('REQUEST_CLOSED', '此输入已结束，不能重新派发');
    if (r.generation !== p.generation) fail('STALE_ROUTE', '输入已取消或重新确认，旧决定无效');
    if (operation === 'consult_wait') {
      r.consultationWaiting = true;
      return this.save(w, r);
    }
    if (operation === 'model_capture') {
      if (r.modelSettings && digest(r.modelSettings) !== digest(p.modelSettings))
        fail('MODEL_MISMATCH', '输入已绑定模型，不能更换');
      r.modelSettings = p.modelSettings;
      return this.save(w, r);
    }
    if (operation === 'needs_input') {
      r.state = 'needs_input';
      r.reason = z.string().max(1000).parse(p.reason);
      r.choices = z
        .array(z.unknown())
        .max(12)
        .parse(p.choices || []);
      return this.save(w, r);
    }
    if (operation === 'plan') {
      if (r.state === 'needs_input')
        fail('REQUEST_STATE', '目标尚未确认，动作不能落库');
      const plans = z
        .array(
          z.object({
            intent: key,
            command: WorkCommand,
            afterIntents: z.array(key).max(8).default([]),
          }),
        )
        .max(8)
        .parse(p.effects);
      const selectedRoute = typeof r.capture.route === 'string' ? r.capture.route : undefined;
      for (const plan of plans) {
        const command = plan.command;
        const consult = command.operation === 'intake' && command.payload.intent === 'consult';
        if (selectedRoute && selectedRoute !== 'auto' &&
          typeof command.payload.text === 'string' &&
          !command.payload.text.split(/\r?\n/).filter((part) => part.trim())
            .every((part) => r.text.includes(part)))
          fail('SOURCE_MISMATCH', '动作内容不是本次用户原文，未写入效果账本');
        if (selectedRoute === 'consult' && !consult)
          fail('EXPLICIT_ROUTE_CHANGED', '用户选择了咨询，不能改为执行工作');
        if (selectedRoute === 'new' && command.operation !== 'intake')
          fail('EXPLICIT_ROUTE_CHANGED', '用户选择了新工作，不能改派到已有工作');
        if (selectedRoute && !['auto', 'new', 'consult'].includes(selectedRoute)) {
          if (consult) {
            if (command.payload.contextTaskId !== selectedRoute)
              fail('EXPLICIT_ROUTE_CHANGED', '咨询目标与用户所选工作不一致');
          } else if (
            !['revise', 'control', 'schedule'].includes(command.operation) ||
            command.taskId !== selectedRoute
          ) fail('EXPLICIT_ROUTE_CHANGED', '动作目标与用户所选工作不一致');
        }
        if (command.taskId) {
          const task = this.apply(w, { operation: 'detail', taskId: command.taskId }) as {
            revision: number
          };
          if (command.expectedRevision !== task.revision)
            fail('STALE_ROUTE_TARGET', '目标版本已变化，动作未落库');
        }
      }
      if (new Set(plans.map((x) => x.intent)).size !== plans.length)
        fail('DUPLICATE_INTENT', '同一意图不能重复派发');
      const known = new Map([
        ...this.effects(w, r.id).map((e) => [e.intent, e.afterIntents || []] as const),
        ...plans.map((e) => [e.intent, e.afterIntents] as const),
      ]);
      const visit = (name: string, path = new Set<string>()) => {
        if (path.has(name) || !known.has(name)) fail('INVALID_DEPENDENCY', '前置动作缺失或循环');
        for (const dep of known.get(name)!) visit(dep, new Set([...path, name]));
      };
      plans.forEach((p) => visit(p.intent));
      for (const plan of plans) {
        if (
          !['cancel_request', 'intake', 'revise', 'control', 'schedule'].includes(
            plan.command.operation,
          )
        )
          fail('ROUTE_OPERATION', '路由不能调用执行或管理操作');
        const id = 'bot:' + digest([w, r.id, plan.intent]),
          command = { ...plan.command, requestId: id };
        const prior = this.effects(w, r.id).find((e) => e.id === id);
        if (prior && !(prior.state === 'failed' && prior.generation < r.generation)) {
          if (
            digest([prior.command, prior.afterIntents || []]) !==
            digest([command, plan.afterIntents])
          )
            fail('INTENT_REUSED', '已接受意图不能在重试时改变');
          continue;
        }
        this.writeEffect(w, {
          intent: plan.intent,
          afterIntents: plan.afterIntents,
          id,
          requestId: r.id,
          generation: r.generation,
          state: 'queued',
          command,
        });
      }
      if (Array.isArray(p.unresolved))
        r.unresolved = z.array(z.unknown()).max(8).parse(p.unresolved);
      r.state = plans.length ? 'routing' : r.unresolved?.length ? 'needs_input' : 'committed';
      return { ...this.save(w, r), effects: this.effects(w, r.id) };
    }
    if (operation === 'apply') {
      const e = this.effects(w, r.id).find((e) => e.id === p.effectId);
      if (!e) fail('EFFECT_NOT_FOUND', '待投递效果不存在');
      if (e.state === 'acknowledged') return e;
      if (e.state !== 'queued' || e.generation !== r.generation)
        fail('STALE_EFFECT', '待投递效果已失效');
      let dependencyError: string | undefined;
      const upstream: string[] = [];
      for (const intent of e.afterIntents || []) {
        const previous = this.effects(w, r.id).find((item) => item.intent === intent);
        if (!previous || ['failed', 'cancelled'].includes(previous.state)) {
          dependencyError = '前置要求未成功，请先确认前置要求';
          break;
        }
        if (previous.state !== 'acknowledged') return { ...e, waiting: true };
        const result = previous.result as any;
        if (previous.command.operation === 'cancel_request') {
          if (result?.state !== 'cancelled') {
            dependencyError = '原要求已有提交内容，请先核实相关工作已停止';
            break;
          }
          continue;
        }
        const taskIds = [
          ...new Set(
            [previous.command.taskId, ...(result?.taskIds || []), result?.task?.id].filter(Boolean),
          ),
        ] as string[];
        if (!taskIds.length) {
          dependencyError = '前置咨询结果需要确认后再继续';
          break;
        }
        for (const taskId of taskIds) {
          let task: any;
          try {
            task = this.apply(w, { operation: 'detail', taskId });
          } catch {
            dependencyError = '前置工作已不可用，请确认剩余要求';
            break;
          }
          const expected =
            previous.command.operation === 'control' &&
            ['cancel', 'pause'].includes(String(previous.command.payload.action))
              ? previous.command.payload.action === 'cancel'
                ? 'cancelled'
                : 'paused'
              : 'completed';
          if (expected === 'completed' && task.management.state === 'cancelled') {
            dependencyError = '前置工作已取消，请确认剩余要求';
            break;
          }
          if (
            task.management.state !== expected ||
            task.management.runs.some((r: any) =>
              ['starting', 'running', 'waiting', 'stopping', 'unknown'].includes(r.state),
            )
          )
            return { ...e, waiting: true };
          if (expected === 'completed') upstream.push(taskId);
        }
        if (dependencyError) break;
      }
      if (dependencyError) return this.markFailed(w, r, e, dependencyError);
      const command =
        upstream.length && e.command.operation === 'intake'
          ? { ...e.command, payload: { ...e.command.payload, dependencies: upstream } }
          : e.command;
      try {
        if (e.command.operation === 'cancel_request') {
          const target = this.read(w, key.parse(e.command.payload.id));
          if (target.id === r.id || target.generation !== e.command.payload.generation)
            fail('STALE_CANCEL', '待取消的输入已变化');
          e.result = this.command(w, { operation: 'cancel', id: target.id });
        } else e.result = this.apply(w, command);
        e.state = 'acknowledged';
      } catch (error) {
        return this.markFailed(w, r, e, (error as Error).message);
      }
      this.writeEffect(w, e);
      if (e.command.operation === 'intake' && (e.result as any)?.task?.id) {
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(w, 'bot-owner:' + (e.result as any).task.id, JSON.stringify('v2'));
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(
            w,
            'bot-context-version:' + (e.result as any).task.id,
            JSON.stringify(r.contextVersion || 2),
          );
      }
      if (e.command.operation === 'intake' && e.command.payload.intent === 'consult') {
        r.delivery = { state: 'queued' };
        r.consultation = {
          text: String(e.command.payload.text),
          ...(e.command.payload.contextTaskId
            ? { taskId: String(e.command.payload.contextTaskId) }
            : {}),
        };
      }
      if (this.effects(w, r.id).every((item) => item.state !== 'queued'))
        r.state =
          r.unresolved?.length || this.effects(w, r.id).some((item) => item.state === 'failed')
            ? 'needs_input'
            : 'committed';
      this.save(w, r);
      return e;
    }
    fail('UNKNOWN_OPERATION', '不支持的接收操作');
  }
}
