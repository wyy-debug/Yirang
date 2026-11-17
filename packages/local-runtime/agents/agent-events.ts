import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class AgentEvents {
  constructor(private db: DatabaseSync) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS agent_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,workspace TEXT NOT NULL,plan_id TEXT NOT NULL,revision INTEGER NOT NULL,type TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS agent_outbox(id TEXT PRIMARY KEY,event_sequence INTEGER UNIQUE NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS agent_events_plan ON agent_events(workspace,plan_id,revision,sequence);
 `);
  }
  append(w: string, planId: string, revision: number, type: string, body: unknown, at: number) {
    const id = randomUUID(),
      r = this.db
        .prepare(
          'INSERT INTO agent_events(id,workspace,plan_id,revision,type,at,body) VALUES(?,?,?,?,?,?,?)',
        )
        .run(id, w, planId, revision, type, at, JSON.stringify(body));
    this.db
      .prepare('INSERT INTO agent_outbox(id,event_sequence) VALUES(?,?)')
      .run(id, r.lastInsertRowid);
  }
  read(w: string, planId: string) {
    return this.db
      .prepare('SELECT * FROM agent_events WHERE workspace=? AND plan_id=? ORDER BY sequence')
      .all(w, planId);
  }
  pending() {
    return this.db
      .prepare(
        'SELECT e.* FROM agent_outbox o JOIN agent_events e ON e.sequence=o.event_sequence WHERE o.delivered=0 ORDER BY e.sequence LIMIT 256',
      )
      .all();
  }
  acknowledge(sequence: number) {
    this.db.prepare('UPDATE agent_outbox SET delivered=1 WHERE event_sequence=?').run(sequence);
  }
}
