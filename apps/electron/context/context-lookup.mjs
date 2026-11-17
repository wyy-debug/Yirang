// Scope all lookups to this Bot, including exact anchors and structured filters.
export function createContextLookup({ db, resolve, indexed }) {
  function search(
    thread,
    scope,
    query,
    { anchor, limit = 6, from, until, file, taskId, segment } = {},
  ) {
    thread = resolve(thread);
    limit = Math.max(1, Math.min(12, Number(limit) || 6));
    if (!scope) return [];
    if (Number.isSafeInteger(anchor))
      return db
        .prepare(
          "SELECT seq,role,text,at FROM messages WHERE thread=? AND scope IN (?, 'legacy') AND seq=?",
        )
        .all(thread, scope, anchor);
    if (from || until || file || taskId || segment)
      return locatedSearch(thread, scope, query, { from, until, file, taskId, segment, limit });
    const terms = [
      ...new Set(
        [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(String(query))]
          .filter(
            (s) =>
              s.isWordLike &&
              s.segment.length >= 2 &&
              !/^(之前|刚才|这个|那个|什么|如何|一下|可以|please|what|that)$/i.test(s.segment),
          )
          .map((s) => s.segment),
      ),
    ].slice(0, 6);
    if (!terms.length) return [];
    if (indexed && terms.every((t) => [...t].length >= 3)) {
      const match = terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
      const found = db
        .prepare(
          "SELECT m.seq,m.role,m.text,m.at FROM message_search JOIN messages m ON m.seq=message_search.rowid WHERE message_search MATCH ? AND m.thread=? AND m.scope IN (?, 'legacy') ORDER BY rank LIMIT ?",
        )
        .all(match, thread, scope, limit);
      if (found.length) return found;
    }
    const predicates = terms.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ');
    return db
      .prepare(
        `SELECT seq,role,text,at FROM messages WHERE thread=? AND scope IN (?, 'legacy') AND (${predicates}) ORDER BY at DESC,seq DESC LIMIT ?`,
      )
      .all(
        thread,
        scope,
        ...terms.map((t) => '%' + t.replace(/[\\%_]/g, (c) => '\\' + c) + '%'),
        limit,
      )
      .reverse();
  }
  function locatedSearch(thread, scope, query, filters) {
    const conditions = ['m.thread=?', "m.scope IN (?, 'legacy')"],
      values = [resolve(thread), scope];
    for (const [name, operator] of [
      ['from', '>='],
      ['until', '<='],
    ])
      if (filters[name]) {
        const stamp = Date.parse(filters[name]);
        if (!Number.isFinite(stamp)) throw Error('历史查询时间无效');
        conditions.push(`m.at ${operator} ?`);
        values.push(new Date(stamp).toISOString());
      }
    for (const [name, kind] of [
      ['file', 'file'],
      ['taskId', 'task'],
    ])
      if (filters[name]) {
        const value = String(filters[name]);
        if (value.length > 1000) throw Error('历史定位条件过长');
        conditions.push(
          '(EXISTS(SELECT 1 FROM message_tags t WHERE t.anchor=m.seq AND t.kind=? AND instr(lower(t.value),lower(?))>0) OR instr(lower(m.text),lower(?))>0)',
        );
        values.push(kind, value, value);
      }
    if (filters.segment) {
      conditions.push('m.source=?');
      values.push(String(filters.segment));
    }
    if (query) {
      conditions.push('instr(lower(m.text),lower(?))>0');
      values.push(String(query));
    }
    return db
      .prepare(
        `SELECT m.seq,m.role,m.text,m.at,m.source AS segment FROM messages m WHERE ${conditions.join(' AND ')} ORDER BY m.at DESC,m.seq DESC LIMIT ?`,
      )
      .all(...values, filters.limit)
      .reverse();
  }
  return search;
}
