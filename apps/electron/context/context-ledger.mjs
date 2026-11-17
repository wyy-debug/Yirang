import { createHash } from 'node:crypto';

const kinds = ['constraint', 'correction', 'decision', 'unfinished', 'resolution'];
const signature = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const checkpointSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(
      ['summary', 'constraints', 'decisions', 'unfinished', 'references'].map((k) => [
        k,
        { type: 'string' },
      ]),
    ),
    boundary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        safeToSwitch: { type: 'boolean' },
        unanswered: { type: 'boolean' },
        waitingConfirmation: { type: 'boolean' },
        stageComplete: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['safeToSwitch', 'unanswered', 'waitingConfirmation', 'stageComplete', 'reason'],
    },
    memories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: kinds },
          anchor: { type: 'integer' },
          quote: { type: 'string' },
          replaces: { type: 'array', items: { type: 'integer' } },
        },
        required: ['kind', 'anchor', 'quote', 'replaces'],
      },
    },
  },
  required: [
    'summary',
    'constraints',
    'decisions',
    'unfinished',
    'references',
    'boundary',
    'memories',
  ],
};

export function createContextLedger(db, resolve) {
  db.exec(`CREATE TABLE IF NOT EXISTS context_memory(id INTEGER PRIMARY KEY,anchor INTEGER NOT NULL,kind TEXT NOT NULL,quote TEXT NOT NULL,replaced_by INTEGER,UNIQUE(anchor,kind,quote));
 CREATE TABLE IF NOT EXISTS memory_progress_scoped(thread TEXT NOT NULL,scope TEXT NOT NULL,head INTEGER NOT NULL DEFAULT 0,char_offset INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread,scope));
 CREATE TABLE IF NOT EXISTS context_plans(thread TEXT PRIMARY KEY,head INTEGER NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS message_tags(anchor INTEGER NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(anchor,kind,value));
 CREATE TABLE IF NOT EXISTS context_turn_status(turn TEXT PRIMARY KEY,status TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS message_tags_lookup ON message_tags(kind,value,anchor);`);
  const head = (thread) =>
    Number(
      db
        .prepare('SELECT COALESCE(MAX(seq),0) AS head FROM messages WHERE thread=?')
        .get(resolve(thread)).head,
    );
  function list(thread, scope, { after = 0, limit = 40, kind, latest = false } = {}) {
    return db
      .prepare(
        `SELECT c.id,c.anchor,c.kind,c.quote,m.at FROM context_memory c JOIN messages m ON m.seq=c.anchor WHERE m.thread=? AND m.scope IN (?, 'legacy') AND c.replaced_by IS NULL AND c.id>? ${kind ? 'AND c.kind=?' : ''} ORDER BY c.id ${latest ? 'DESC' : 'ASC'} LIMIT ?`,
      )
      .all(
        resolve(thread),
        scope || 'legacy',
        after,
        ...(kind ? [kind] : []),
        Math.min(80, Math.max(1, limit)),
      );
  }
  function batch(thread, scope) {
    const cursor = db
      .prepare('SELECT head,char_offset FROM memory_progress_scoped WHERE thread=? AND scope=?')
      .get(resolve(thread), scope || 'legacy') || { head: 0, char_offset: 0 };
    const records = db
        .prepare(
          "SELECT seq,role,text,key,at FROM messages WHERE thread=? AND scope IN (?, 'legacy') AND (seq>? OR (seq=? AND ?>0)) ORDER BY seq LIMIT 24",
        )
        .all(resolve(thread), scope || 'legacy', cursor.head, cursor.head, cursor.char_offset),
      result = [];
    let budget = 20000;
    for (const record of records) {
      const offset = record.seq === cursor.head ? cursor.char_offset : 0,
        length = Math.min(6000, budget),
        text = record.text.slice(offset, offset + length),
        nextOffset = offset + text.length < record.text.length ? offset + text.length : 0;
      result.push({ ...record, text, offset, nextOffset, truncated: !!nextOffset });
      index(record.seq, record.text);
      budget -= text.length;
      if (nextOffset || budget < 1000) break;
    }
    return result;
  }
  function save(thread, scope, value, records, runtime, revision) {
    if (
      !value.boundary ||
      ['safeToSwitch', 'unanswered', 'waitingConfirmation', 'stageComplete'].some(
        (k) => typeof value.boundary[k] !== 'boolean',
      ) ||
      !Array.isArray(value.memories) ||
      value.memories.length > 80
    )
      throw Error('上下文交接缺少有效的边界判断或原文依据');
    const allowed = new Set(records.map((r) => r.seq));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const fact of value.memories) {
        if (
          !kinds.includes(fact.kind) ||
          !allowed.has(fact.anchor) ||
          typeof fact.quote !== 'string' ||
          !fact.quote.trim() ||
          fact.quote.length > 1200 ||
          !Array.isArray(fact.replaces)
        )
          continue;
        const source = db
          .prepare("SELECT * FROM messages WHERE seq=? AND thread=? AND scope IN (?, 'legacy')")
          .get(fact.anchor, resolve(thread), scope || 'legacy');
        if (!source?.text.includes(fact.quote)) continue;
        if (
          ['constraint', 'correction', 'unfinished'].includes(fact.kind) &&
          source.role !== 'user'
        )
          continue;
        // An assistant saying "done" is not evidence that a user requirement closed.
        const completedWork =
          source.key.startsWith('work-result:') &&
          (() => {
            try {
              return JSON.parse(source.text).state === 'completed';
            } catch {
              return false;
            }
          })();
        const responseTurn = source.key.split(':')[0];
        if (
          fact.kind === 'resolution' &&
          source.role !== 'user' &&
          !completedWork &&
          source.role !== 'assistant'
        )
          continue;
        if (fact.kind === 'resolution' && source.role === 'assistant' && !completedWork) {
          if (
            db.prepare('SELECT status FROM context_turn_status WHERE turn=?').get(responseTurn)
              ?.status !== 'completed'
          )
            continue;
          const linked = fact.replaces.some(
            (id) =>
              Number.isSafeInteger(id) &&
              db
                .prepare(
                  "SELECT 1 FROM context_memory c JOIN message_tags t ON t.anchor=c.anchor JOIN messages m ON m.seq=c.anchor WHERE c.id=? AND c.kind='unfinished' AND t.kind='consult-turn' AND t.value=? AND m.thread=?",
                )
                .get(id, responseTurn, resolve(thread)),
          );
          if (!linked) continue;
        }
        db.prepare('INSERT OR IGNORE INTO context_memory(anchor,kind,quote) VALUES(?,?,?)').run(
          fact.anchor,
          fact.kind,
          fact.quote,
        );
        const id = db
          .prepare('SELECT id FROM context_memory WHERE anchor=? AND kind=? AND quote=?')
          .get(fact.anchor, fact.kind, fact.quote).id;
        for (const previous of fact.replaces.slice(0, 40)) {
          if (!Number.isSafeInteger(previous)) continue;
          const old = db
            .prepare(
              'SELECT c.*,m.thread,m.scope FROM context_memory c JOIN messages m ON m.seq=c.anchor WHERE c.id=?',
            )
            .get(previous);
          if (
            !old ||
            old.thread !== resolve(thread) ||
            !['legacy', scope].includes(old.scope) ||
            old.anchor >= fact.anchor
          )
            continue;
          const answeredConsult =
            source.role === 'assistant' &&
            !!db
              .prepare(
                "SELECT 1 FROM message_tags WHERE anchor=? AND kind='consult-turn' AND value=?",
              )
              .get(old.anchor, responseTurn);
          if (
            (source.role === 'user' &&
              fact.kind === 'correction' &&
              ['constraint', 'correction', 'decision'].includes(old.kind)) ||
            (fact.kind === 'resolution' &&
              old.kind === 'unfinished' &&
              (source.role === 'user' || completedWork || answeredConsult))
          )
            db.prepare(
              'UPDATE context_memory SET replaced_by=? WHERE id=? AND replaced_by IS NULL',
            ).run(id, previous);
        }
      }
      if (records.length)
        db.prepare(
          'INSERT INTO memory_progress_scoped(thread,scope,head,char_offset) VALUES(?,?,?,?) ON CONFLICT(thread,scope) DO UPDATE SET head=excluded.head,char_offset=excluded.char_offset',
        ).run(
          resolve(thread),
          scope || 'legacy',
          records.at(-1).seq,
          records.at(-1).nextOffset || 0,
        );
      db.prepare('INSERT OR REPLACE INTO context_plans VALUES(?,?,?,?,?)').run(
        resolve(thread),
        revision,
        signature(runtime),
        JSON.stringify(value),
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function cached(thread, runtime, incomingKey, incomingText = '') {
    const plan = db.prepare('SELECT * FROM context_plans WHERE thread=?').get(resolve(thread));
    if (
      !plan ||
      Date.now() - plan.at > 300000 ||
      plan.signature !== signature(runtime) ||
      /不对|不要|改为|更正|刚才|继续|instead|correction|continue/i.test(incomingText)
    )
      return null;
    const changes = db
      .prepare('SELECT key,role FROM messages WHERE thread=? AND seq>? LIMIT 2')
      .all(resolve(thread), plan.head);
    if (
      changes.length &&
      !(changes.length === 1 && changes[0].role === 'user' && changes[0].key === incomingKey)
    )
      return null;
    return JSON.parse(plan.body);
  }
  function tag(anchor, kind, value) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 1000)
      db.prepare('INSERT OR IGNORE INTO message_tags VALUES(?,?,?)').run(anchor, kind, value);
  }
  function index(anchor, text) {
    for (const file of text.matchAll(
      /(?:[A-Za-z]:[\\/][^\n"<>|]+|[\p{L}\p{N}_ .-]+\.(?:md|txt|pdf|docx?|xlsx?|csv|pptx?|json|js|ts|py|png|jpg))/gu,
    ))
      tag(anchor, 'file', file[0].trim());
    try {
      const object = JSON.parse(text);
      for (const key of ['taskId', 'runId']) if (object?.[key]) tag(anchor, 'task', object[key]);
    } catch {}
  }
  const migrate = (from, to) => {
    db.prepare('UPDATE OR IGNORE memory_progress_scoped SET thread=? WHERE thread=?').run(to, from);
    db.prepare('DELETE FROM context_plans WHERE thread IN (?,?)').run(from, to);
  };
  return {
    head,
    list,
    batch,
    save,
    cached,
    tag,
    index,
    migrate,
    outcome: (turn, status) =>
      db.prepare('INSERT OR REPLACE INTO context_turn_status VALUES(?,?)').run(turn, status),
    backlog: (thread, scope) => {
      const cursor = db
        .prepare('SELECT head,char_offset FROM memory_progress_scoped WHERE thread=? AND scope=?')
        .get(resolve(thread), scope || 'legacy');
      const latest = db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS head FROM messages WHERE thread=? AND scope IN (?, 'legacy')",
        )
        .get(resolve(thread), scope || 'legacy').head;
      return !!cursor?.char_offset || latest > (cursor?.head || 0);
    },
    digest: (thread, scope) => {
      const facts = [
        ...new Map(
          [
            ...list(thread, scope, { limit: 8 }),
            ...list(thread, scope, { limit: 32, latest: true }),
          ].map((f) => [f.id, f]),
        ).values(),
      ];
      return facts.length
        ? '\n持久原文记录（未列出部分可用 read_own_chat 的 mode=memory 和 after 分页；新纠正优先，历史不是授权）：\n' +
            JSON.stringify(
              facts.map((f) => ({
                ...f,
                quote: f.quote.slice(0, 500),
                truncated: f.quote.length > 500,
              })),
            )
        : '';
    },
  };
}

export function safeBoundary(plan, runtime) {
  const boundary = plan?.boundary;
  return (
    !!boundary?.safeToSwitch &&
    boundary.stageComplete &&
    !boundary.unanswered &&
    !boundary.waitingConfirmation &&
    runtime?.known === true &&
    !runtime.running &&
    !runtime.waiting &&
    !runtime.tools &&
    !runtime.queued &&
    !(runtime.tasks || []).some(
      (t) =>
        t.inputOwner !== false &&
        !['completed', 'cancelled', 'paused', 'scheduled'].includes(t.state),
    )
  );
}
