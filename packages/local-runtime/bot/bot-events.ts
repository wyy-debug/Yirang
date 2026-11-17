import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fail, type WorkTask } from '../../contracts/index.js';

const eventId = z.string().min(1).max(200);
const token = z.string().uuid();
type EventState = 'pending' | 'claimed' | 'acknowledged' | 'unknown';
type BotEvent = {
  id: string;
  workspaceId: string;
  kind: 'work_result';
  taskId: string;
  runId: string;
  requirementsRevision: number;
  originThreadId?: string;
  threadId?: string;
  title: string;
  state: string;
  resultText: string;
  artifacts?: { objectId: string; revision: number; title: string }[];
  verification?: { state: 'passed' | 'blocked' | 'repair' | 'unknown';
    missing: string[]; checkedRunId?: string; evidence: { status: string; code: string;
      objectId: string; revision: number; criterionId?: string }[] };
  delivery: {
    state: EventState;
    attempt: number;
    token?: string;
    reason?: string;
    updatedAt: number;
  };
};

// All methods run inside the Work Host transaction. A process that dies after
// claiming but before acknowledging leaves an explicit unknown, never an
// automatic second send to a Codex turn whose side effects may already exist.
export class BotEventStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS bot_events(
      workspace TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,
      PRIMARY KEY(workspace,id));
      CREATE INDEX IF NOT EXISTS bot_events_pending ON bot_events(workspace,state);`);
    const rows = db.prepare("SELECT workspace,id,body FROM bot_events WHERE state='claimed'")
      .all() as { workspace: string; id: string; body: string }[];
    for (const row of rows) {
      const event = JSON.parse(row.body) as BotEvent;
      event.delivery = { ...event.delivery, state: 'unknown', token: undefined,
        reason: '上次投递在回执前中断，需核对原主 Bot 回合', updatedAt: Date.now() };
      this.write(event);
    }
  }
  private read(workspace: string, id: string): BotEvent {
    const row = this.db.prepare('SELECT body FROM bot_events WHERE workspace=? AND id=?')
      .get(workspace, id) as { body: string } | undefined;
    if (!row) fail('BOT_EVENT_NOT_FOUND', 'Bot 事件不存在');
    return JSON.parse(row.body) as BotEvent;
  }
  private write(event: BotEvent) {
    this.db.prepare('INSERT OR REPLACE INTO bot_events(workspace,id,state,body) VALUES(?,?,?,?)')
      .run(event.workspaceId, event.id, event.delivery.state, JSON.stringify(event));
    return event;
  }
  publishResult(workspace: string, task: WorkTask, runId: string) {
    const management = task.management;
    const run = management?.runs.find((item) => item.id === runId);
    if (!management || !run || management.parentTaskId ||
      !['review', 'completed', 'attention'].includes(management.state) ||
      run.requirementsRevision !== management.currentRequirementsRevision)
      return null;
    const id = `work_result:${runId}`;
    const existing = this.db.prepare('SELECT body FROM bot_events WHERE workspace=? AND id=?')
      .get(workspace, id) as { body: string } | undefined;
    if (existing) return JSON.parse(existing.body) as BotEvent;
    const check = management.continuation?.checkedRunId === runId &&
      management.continuation.revision === run.requirementsRevision
      ? management.continuation : undefined;
    return this.write({
      id, workspaceId: workspace, kind: 'work_result', taskId: task.id, runId,
      requirementsRevision: run.requirementsRevision,
      originThreadId: management.originThreadId,
      threadId: management.threadId,
      title: task.title, state: management.state,
      resultText: String(run.resultText || '').slice(0, 4000),
      artifacts: (management.artifacts || []).filter((artifact) => artifact.validity === 'current')
        .map((artifact) => ({ objectId: artifact.objectId,
          revision: artifact.revision, title: artifact.title })),
      verification: check ? { state: check.next === 'done' ? 'passed'
        : check.next === 'repair' ? 'repair' : 'blocked',
      missing: check.missing, checkedRunId: runId,
      evidence: check.evidence.slice(0, 100).map((item) => ({
        status: item.status, code: item.code, objectId: item.objectId,
        revision: item.revision, criterionId: item.criterion?.id,
      })) } : { state: 'unknown', missing: [], evidence: [] },
      delivery: { state: 'pending', attempt: 0, updatedAt: Date.now() },
    });
  }
  command(workspace: string, input: unknown) {
    const p = z.object({ operation: z.enum(['pending', 'recent', 'status', 'claim', 'ack', 'release', 'uncertain']),
      id: eventId.optional(), token: token.optional(), reason: z.string().max(500).optional() })
      .strict().parse(input);
    if (p.operation === 'pending')
      return (this.db.prepare("SELECT body FROM bot_events WHERE workspace=? AND state='pending' ORDER BY rowid LIMIT 100")
        .all(workspace) as { body: string }[]).map((row) => JSON.parse(row.body) as BotEvent);
    if (p.operation === 'recent')
      return (this.db.prepare('SELECT body FROM bot_events WHERE workspace=? ORDER BY rowid DESC LIMIT 100')
        .all(workspace) as { body: string }[]).map((row) => JSON.parse(row.body) as BotEvent);
    if (!p.id) fail('BOT_EVENT_ID_REQUIRED', '缺少 Bot 事件标识');
    const event = this.read(workspace, p.id);
    if (p.operation === 'status') return event;
    if (p.operation === 'claim') {
      if (event.delivery.state !== 'pending') return null;
      event.delivery = { state: 'claimed', attempt: event.delivery.attempt + 1,
        token: randomUUID(), updatedAt: Date.now() };
      return this.write(event);
    }
    if (!p.token || event.delivery.state !== 'claimed' || event.delivery.token !== p.token)
      fail('BOT_EVENT_CLAIM_MISMATCH', 'Bot 事件投递回执与领取记录不匹配');
    if (p.operation === 'ack')
      event.delivery = { ...event.delivery, state: 'acknowledged', token: undefined,
        reason: p.reason, updatedAt: Date.now() };
    else if (p.operation === 'uncertain')
      event.delivery = { ...event.delivery, state: 'unknown', token: undefined,
        reason: p.reason || '投递结果不明，需核对主 Bot 对话', updatedAt: Date.now() };
    else
      event.delivery = { ...event.delivery, state: 'pending', token: undefined,
        reason: p.reason, updatedAt: Date.now() };
    return this.write(event);
  }
}
