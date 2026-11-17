import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fail } from '../../contracts/index.js';

const id = z.string().min(1).max(200);
export class BotCapacityStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS bot_slots(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,role TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'turn',request_id TEXT);`,
    );
    if (
      !(db.prepare('PRAGMA table_info(bot_slots)').all() as { name: string }[]).some(
        (c) => c.name === 'kind',
      )
    )
      db.exec("ALTER TABLE bot_slots ADD COLUMN kind TEXT NOT NULL DEFAULT 'turn'");
    if (
      !(db.prepare('PRAGMA table_info(bot_slots)').all() as { name: string }[]).some(
        (c) => c.name === 'request_id',
      )
    )
      db.exec('ALTER TABLE bot_slots ADD COLUMN request_id TEXT');
  }
  counts() {
    const runs = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM work_runs WHERE state IN ('starting','running','waiting','stopping','unknown')",
          )
          .get() as { n: number }
      ).n,
    );
    const all = this.db.prepare('SELECT * FROM bot_slots').all() as {
      id: string;
      workspace: string;
      role: string;
      thread_id: string;
      turn_id: string | null;
      state: string;
      created_at: number;
      kind: string;
    }[];
    // Agent Pool slots count toward capacity but are recovered only by the pool, never by conversation capacity.
    const slots = all.filter((s) => s.kind !== 'pool');
    return {
      runs,
      slots,
      pool: all.length - slots.length,
      background: runs + all.filter((s) => s.role === 'background').length,
      total: runs + all.length,
    };
  }
  command(w: string, p: Record<string, unknown>) {
    if (p.operation === 'capacity_read') return this.counts();
    if (p.operation === 'capacity_acquire') {
      const q = z
        .object({
          id,
          threadId: id,
          role: z.enum(['router', 'consult', 'background']),
          kind: z.enum(['turn', 'compact', 'realtime']).default('turn'),
          requestId: id.optional(),
        })
        .parse(p);
      const c = this.counts(),
        old = c.slots.find((s) => s.id === q.id);
      if (old) {
        if (old.workspace !== w || old.thread_id !== q.threadId || old.role !== q.role)
          fail('SLOT_REUSED', '容量身份不匹配');
        return old;
      }
      if (c.slots.some((s) => s.thread_id === q.threadId))
        fail('THREAD_BUSY', '此执行入口已有待核实的回合');
      if (
        c.total >= 7 ||
        (q.role === 'background' && c.background >= 5) ||
        (q.role !== 'background' && c.slots.some((s) => s.role === q.role))
      )
        fail('CAPACITY_WAIT', '正在等待执行名额，输入已保留');
      if (
        q.role === 'router' &&
        c.background >= 6 &&
        this.db
          .prepare(
            "SELECT 1 FROM bot_requests WHERE json_extract(body,'$.delivery.state')='queued' OR (json_extract(body,'$.consultationWaiting')=1 AND json_extract(body,'$.state') IN ('received','routing')) LIMIT 1",
          )
          .get()
      )
        fail('CAPACITY_WAIT', '迁移期间优先处理已确定的咨询');
      this.db
        .prepare('INSERT INTO bot_slots VALUES(?,?,?,?,NULL,?,?,?,?)')
        .run(q.id, w, q.role, q.threadId, 'sending', Date.now(), q.kind, q.requestId || null);
      return q;
    }
    const slot = this.db
      .prepare('SELECT * FROM bot_slots WHERE id=? AND workspace=?')
      .get(id.parse(p.id), w) as
      | {
          thread_id: string;
          turn_id: string | null;
          state: string;
          created_at: number;
          kind: string;
          request_id: string | null;
        }
      | undefined;
    if (!slot) return { released: true };
    if (slot.kind === 'pool') fail('POOL_SLOT', '并行计划名额只能由 Agent Pool 处理');
    if (p.threadId !== slot.thread_id) fail('SLOT_MISMATCH', '执行回执不属于此名额');
    if (p.operation === 'capacity_ack') {
      const turn = id.parse(p.turnId);
      if (slot.turn_id && slot.turn_id !== turn) fail('SLOT_MISMATCH', '执行回合不匹配');
      this.db
        .prepare("UPDATE bot_slots SET turn_id=?,state='running' WHERE id=?")
        .run(turn, p.id as string);
      if (slot.request_id) {
        const row = this.db
          .prepare('SELECT body FROM bot_requests WHERE workspace=? AND id=?')
          .get(w, slot.request_id) as { body: string } | undefined;
        if (row) {
          const r = JSON.parse(row.body);
          if (
            r.delivery?.threadId === slot.thread_id &&
            ['sending', 'unknown'].includes(r.delivery.state)
          ) {
            r.delivery = { ...r.delivery, state: 'acknowledged', turnId: turn };
            this.db
              .prepare('UPDATE bot_requests SET body=? WHERE workspace=? AND id=?')
              .run(JSON.stringify(r), w, slot.request_id);
          }
        }
      }
      return { acknowledged: true };
    }
    if (p.operation === 'capacity_unknown') {
      this.db.prepare("UPDATE bot_slots SET state='unknown' WHERE id=?").run(p.id as string);
      return { unknown: true };
    }
    if (p.operation === 'capacity_resolve') {
      if (
        p.confirmedStopped !== true ||
        (slot.state !== 'unknown' && Date.now() - slot.created_at < 300000)
      )
        fail('END_EVIDENCE_REQUIRED', '仅可人工核实未知或长期失联的执行');
      const note = z.string().trim().min(1).max(2000).parse(p.note);
      this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
        w,
        'bot-capacity-resolution:' + p.id,
        JSON.stringify({
          slot,
          note,
          at: Date.now(),
          outcome: 'manually_closed',
          replayed: false,
        }),
      );
      this.db.prepare('DELETE FROM bot_slots WHERE id=?').run(p.id as string);
      return { released: true, replayed: false };
    }
    if (p.operation === 'capacity_release') {
      if (
        p.notReceived !== true &&
        !(slot.kind === 'realtime' && p.event === 'thread/realtime/closed') &&
        (!slot.turn_id ||
          slot.turn_id !== p.turnId ||
          !['completed', 'failed', 'interrupted'].includes(String(p.status)))
      )
        fail('END_EVIDENCE_REQUIRED', '需匹配旧回合终态才能释放名额');
      if (p.notReceived === true && slot.turn_id)
        fail('END_EVIDENCE_REQUIRED', '已确认接收的回合不能认定为未发送');
      this.db.prepare('DELETE FROM bot_slots WHERE id=?').run(p.id as string);
      return { released: true };
    }
    fail('UNKNOWN_OPERATION', '不支持的容量操作');
  }
}
