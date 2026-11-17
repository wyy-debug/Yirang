export function elapsedUnion(intervals) {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    start = null,
    end = null;
  for (const [a, b] of sorted) {
    if (start === null) {
      start = a;
      end = b;
    } else if (a <= end) end = Math.max(end, b);
    else {
      total += end - start;
      start = a;
      end = b;
    }
  }
  return total + (start === null ? 0 : end - start);
}

export function timingView(data, { now = data.observedAt, turnId } = {}) {
  const tasks = data.tasks || [],
    all = data.runs || [];
  const runs = tasks.length
    ? all
    : all.filter((run) => run.turnId === (turnId || all.at(-1)?.turnId));
  const liveEnd = (run) => run.endedAt ?? Math.max(run.observedAt, now);
  const makeRow = (id, title, records, task) => {
    records = [...records].sort((a, b) => a.startedAt - b.startedAt);
    if (!records.length)
      return { id, title, task, missing: true, spans: [], tools: [], models: [] };
    const start = records[0].startedAt;
    let end = Math.max(...records.map(liveEnd));
    const spans = records.flatMap((run) =>
      run.spans.map((span) => ({ ...span, end: span.end ?? liveEnd(run) })),
    );
    for (let i = 1; i < records.length; i++) {
      const previous = liveEnd(records[i - 1]);
      if (records[i].startedAt > previous)
        spans.push({ kind: 'wait', start: previous, end: records[i].startedAt });
    }
    const waiting =
      task &&
      !task.parentTaskId &&
      ((task.state === 'waiting' && task.delegation?.phase === 'waiting') ||
        (task.question && task.state === 'attention'));
    if (waiting && records.every((run) => run.endedAt != null)) {
      const tail = Math.max(end, now);
      spans.push({ kind: task.question ? 'approval' : 'wait', start: end, end: tail });
      end = tail;
    }
    spans.sort((a, b) => a.start - b.start);
    const totals = Object.fromEntries(
      ['model', 'tool', 'approval', 'wait', 'unknown'].map((kind) => [
        kind,
        elapsedUnion(
          spans.filter((span) => span.kind === kind).map((span) => [span.start, span.end]),
        ),
      ]),
    );
    const tools = records.flatMap((run) =>
      run.tools.map((tool) => {
        const stop = tool.end ?? liveEnd(run),
          blocked = elapsedUnion(
            run.spans
              .filter((s) => s.kind === 'approval')
              .map((s) => [Math.max(s.start, tool.start), Math.min(s.end ?? liveEnd(run), stop)]),
          );
        return {
          ...tool,
          start: tool.start,
          end: stop,
          duration: Math.max(0, stop - tool.start - blocked),
          waiting: blocked,
        };
      }),
    );
    return {
      id,
      title,
      task,
      start,
      end,
      elapsed: end - start,
      spans,
      tools,
      totals,
      models: [
        ...new Set(
          records.map((run) => [run.model, run.effort].filter(Boolean).join(' · ') || '未提供'),
        ),
      ],
      running: records.some((run) => run.endedAt == null) || !!waiting,
      incomplete: records.some((run) => run.incomplete),
      status: records.at(-1).status,
    };
  };
  const rows = tasks.length
    ? [...tasks]
        .sort((a, b) => Number(!!a.parentTaskId) - Number(!!b.parentTaskId))
        .map((task) =>
          makeRow(
            task.id,
            task.title,
            runs.filter((run) => run.taskId === task.id),
            task,
          ),
        )
    : [makeRow('conversation', '本轮对话', runs)];
  const root = rows.find((row) => !row.task?.parentTaskId),
    available = rows.filter((row) => !row.missing),
    children = rows.filter((row) => row.task?.parentTaskId && !row.missing);
  if (!available.length) return { rows, root, missing: true };
  const start = Math.min(...available.map((row) => row.start)),
    end = Math.max(...available.map((row) => row.end));
  return {
    rows,
    root,
    start,
    end,
    elapsed: end - start,
    running: available.some((row) => row.running),
    incomplete:
      available.some((row) => row.incomplete) ||
      rows.some((row) => row.missing && row.task?.runs?.length),
    childrenElapsed: children.length
      ? Math.max(...children.map((row) => row.end)) - Math.min(...children.map((row) => row.start))
      : null,
  };
}
