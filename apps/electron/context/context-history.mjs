// Native segments share one visible history; checkpoint turns stay internal.
import { PRIMARY_DECISION_MARKER } from '../conversation/internal-turn-marker.mjs';
export function createContextHistory({ db, resolve, readHistory }) {
  const hidden = (thread, turn) =>
    !!db.prepare('SELECT 1 FROM hidden_turns WHERE thread=? AND turn=?').get(thread, turn || '');
  function hiddenTurn(thread, turn) {
    const internal =
      hidden(thread, turn.id) ||
      (turn.items || []).some(
        (item) =>
          item.type === 'userMessage' &&
          (item.content || []).some(
          (c) => c.type === 'text' && (
            c.text?.startsWith('[内部连续上下文交接，不是用户新请求]') ||
            c.text?.startsWith(PRIMARY_DECISION_MARKER)),
          ),
      );
    if (internal && turn.id)
      db.prepare('INSERT OR IGNORE INTO hidden_turns VALUES(?,?)').run(thread, turn.id);
    return internal;
  }
  const prepared = (thread) =>
    db.prepare('SELECT * FROM segments WHERE previous=? AND committed=0').get(thread);
  function parts(thread) {
    const result = [resolve(thread)],
      seen = new Set(result);
    for (;;) {
      const prior = db
        .prepare('SELECT previous FROM segments WHERE target=? AND committed=1')
        .get(result.at(-1))?.previous;
      if (!prior) break;
      if (seen.has(prior)) throw Error('对话分段记录出现循环');
      seen.add(prior);
      result.push(prior);
    }
    return result;
  }
  async function history(thread, limit = 100, cursor = null) {
    const family = parts(thread);
    let segment = family[0],
      nativeCursor = cursor;
    if (cursor?.startsWith('segment:')) {
      const decoded = JSON.parse(Buffer.from(cursor.slice(8), 'base64url').toString());
      segment = decoded.thread;
      nativeCursor = decoded.cursor;
      if (!family.includes(segment)) throw Error('历史分页不属于当前对话');
    }
    const data = [],
      seen = new Set();
    let next = null;
    do {
      const key = JSON.stringify([segment, nativeCursor]);
      if (seen.has(key)) throw Error('历史分页重复');
      seen.add(key);
      const page = await readHistory(segment, nativeCursor, Math.max(1, limit - data.length));
      data.push(
        ...page.data
          .filter((t) => !hiddenTurn(segment, t))
          .map((t) => {
            db.prepare('INSERT OR IGNORE INTO turn_origins VALUES(?,?)').run(t.id, segment);
            return { ...t, sourceThreadId: segment };
          }),
      );
      if (page.nextCursor) nativeCursor = page.nextCursor;
      else {
        segment = family[family.indexOf(segment) + 1];
        nativeCursor = null;
      }
      next = segment
        ? 'segment:' +
          Buffer.from(JSON.stringify({ thread: segment, cursor: nativeCursor })).toString(
            'base64url',
          )
        : null;
    } while (next && data.length < limit);
    return { data, nextCursor: next };
  }
  return { hidden, hiddenTurn, prepared, parts, history };
}
