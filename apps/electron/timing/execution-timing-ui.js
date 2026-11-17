import { t, subscribeUiLanguage } from '../../../packages/components/ui-language.js';
import { timingView } from './timing-view-model.mjs';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const duration = (ms) => {
  if (!Number.isFinite(ms)) return t('未记录');
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? t('{0} 秒', { 0: seconds })
    : t('{0} 分 {1} 秒', { 0: Math.floor(seconds / 60), 1: seconds % 60 });
};
const phaseLabels = {
  model: '模型响应',
  tool: '工具执行',
  approval: '等待确认',
  wait: '等待与调度',
  unknown: '未分类',
};
const effortLabels = {
  none: '无',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高',
};
const modelLabel = (value) =>
  value === '未提供'
    ? t(value)
    : value.replace(
        / · (none|minimal|low|medium|high|xhigh|max|ultra)$/,
        (_, effort) => ' · ' + t(effortLabels[effort]),
      );

export function createTimingCard({ load, emptyHidden = false, onChange = () => {} }) {
  const card = el('details', undefined, 'execution-timing'),
    summary = el('summary'),
    label = el('span'),
    clock = el('span', undefined, 'timing-clock'),
    chevron = el('span', '', 'timing-chevron ui-chevron'),
    body = el('div', undefined, 'timing-body');
  const overview = el('div', undefined, 'timing-overview'),
    timeline = el('details', undefined, 'timing-timeline'),
    timelineSummary = el('summary', t('查看时间轴')),
    chart = el('div', undefined, 'timing-chart'),
    calls = el('details', undefined, 'timing-calls'),
    callsSummary = el('summary'),
    callList = el('div');
  const hint = el('p', t('模型响应包含服务与网络等待。并行时间不重复相加。'), 'timing-hint'),
    error = el('p', undefined, 'timing-error'),
    retry = el('button', t('重新读取'));
  retry.type = 'button';
  retry.onclick = () => void refresh();
  error.append(retry);
  summary.append(label, clock, chevron);
  timeline.append(timelineSummary, chart);
  calls.append(callsSummary, callList);
  body.append(overview, timeline, calls, hint, error);
  card.append(summary, body);
  let data = null,
    received = 0,
    loading = false,
    pending = false,
    disposed = false,
    epoch = 0,
    userToggled = false,
    selectedTurn = null;
  const history = el('select', undefined, 'timing-history');
  history.setAttribute('aria-label', t('选择回合'));
  body.prepend(history);
  history.onchange = () => {
    selectedTurn = history.value;
    paint();
  };
  function mode() {
    if (!userToggled) {
      card.open = false;
      timeline.open = false;
    }
    paint();
  }
  const totalLine = (label, value) => {
    const row = el('div');
    row.append(el('span', t(label)), el('strong', value));
    return row;
  };
  function paint() {
    if (disposed) return;
    if (!data) {
      label.textContent = t('正在读取耗时…');
      return;
    }
    const stamp = data.observedAt + Math.max(0, performance.now() - received),
      view = timingView(data, { now: stamp, turnId: selectedTurn });
    card.hidden = emptyHidden && view.missing;
    const taskState = view.root?.task?.state;
    label.textContent = t(
      view.missing
        ? '暂无耗时记录'
        : taskState === 'attention'
          ? '需要你'
          : taskState === 'paused'
            ? '已暂停'
            : taskState === 'cancelled'
              ? '已取消'
              : view.running
                ? '正在处理'
                : taskState &&
                    ['queued', 'scheduled', 'waiting', 'revising', 'running'].includes(taskState)
                  ? '等待与调度'
                  : view.root?.status === 'completed'
                    ? '结果已就绪'
                    : view.root?.status === 'interrupted'
                      ? '已停止'
                      : view.root?.status === 'failed'
                        ? '执行未完成'
                        : view.root?.status === 'unknown'
                          ? '记录不完整'
                          : '工作耗时',
    );
    if (view.running) {
      const phase = view.root?.spans.at(-1)?.kind;
      if (phase) label.textContent = t(phaseLabels[phase]);
    }
    clock.textContent = view.missing ? '' : duration(view.elapsed);
    chevron.classList.toggle('up', card.open);
    if (!card.open) {
      onChange();
      return;
    }
    const options = (data.tasks?.length ? [] : data.runs || []).filter((run) => run.turnId);
    history.hidden = options.length < 2;
    const signature = options.map((run) => run.turnId).join();
    if (history.dataset.keys !== signature) {
      history.dataset.keys = signature;
      history.replaceChildren(
        ...options
          .slice()
          .reverse()
          .map((run, index) => {
            const option = el(
              'option',
              `${index === 0 ? t('最新回合') + ' · ' : ''}${new Date(run.startedAt).toLocaleTimeString()} · ${run.model || t('未提供')}`,
            );
            option.value = run.turnId;
            return option;
          }),
      );
    }
    if (options.length) history.value = selectedTurn || options.at(-1).turnId;
    overview.replaceChildren();
    chart.replaceChildren();
    callList.replaceChildren();
    timeline.hidden = view.missing;
    calls.hidden = view.missing;
    if (view.missing) {
      overview.append(
        el(
          'p',
          t(
            data.tasks?.some((task) => task.runs?.length)
              ? '这项工作没有分项耗时记录'
              : '开始执行后显示真实耗时',
          ),
          'timing-hint',
        ),
      );
      onChange();
      return;
    }
    if (view.root && !view.root.missing) {
      const root = view.root;
      overview.append(
        el('strong', t(root.task ? '主任务' : '本轮对话'), 'timing-row-title'),
        totalLine('模型响应', duration(root.totals.model)),
        totalLine('工具执行', duration(root.totals.tool)),
      );
      if (root.totals.approval)
        overview.append(totalLine('等待确认', duration(root.totals.approval)));
      if (root.totals.wait) overview.append(totalLine('等待与调度', duration(root.totals.wait)));
      if (root.totals.unknown) overview.append(totalLine('未分类', duration(root.totals.unknown)));
    }
    const children = view.rows.filter((row) => row.task?.parentTaskId);
    if (children.length) {
      overview.append(totalLine('子任务阶段', duration(view.childrenElapsed)));
      for (const child of children)
        overview.append(
          totalLine(child.title, child.missing ? t('等待开始') : duration(child.elapsed)),
        );
    }
    const legend = el('div', undefined, 'timing-legend');
    for (const kind of [
      'model',
      'tool',
      'approval',
      'wait',
      ...(view.rows.some((row) => row.totals?.unknown) ? ['unknown'] : []),
    ]) {
      const key = el('span', t(phaseLabels[kind]));
      key.dataset.kind = kind;
      legend.append(key);
    }
    chart.append(legend);
    const width = Math.max(1, view.elapsed),
      axis = el('div', undefined, 'timing-axis');
    axis.append(el('span', '0'), el('span', duration(width / 2)), el('span', duration(width)));
    chart.append(axis);
    for (const row of view.rows) {
      const line = el('div', undefined, 'timing-track-row'),
        name = el('div', undefined, 'timing-track-name'),
        track = el('div', undefined, 'timing-track');
      name.append(
        el('strong', row.task?.parentTaskId ? row.title : t(row.task ? '主任务' : '本轮对话')),
        el('small', row.models.map(modelLabel).join(' / ') || t('等待开始')),
      );
      name.title = row.title;
      line.append(
        name,
        el('span', row.missing ? t('未记录') : duration(row.elapsed), 'timing-row-duration'),
        track,
      );
      for (const span of row.spans) {
        const bar = el('span', undefined, 'timing-span');
        bar.dataset.kind = span.kind;
        bar.style.left = `${Math.max(0, ((span.start - view.start) / width) * 100)}%`;
        bar.style.width = `${Math.min(100, ((span.end - span.start) / width) * 100)}%`;
        bar.title = `${t(phaseLabels[span.kind])} · ${duration(span.end - span.start)}`;
        track.append(bar);
      }
      track.setAttribute('role', 'img');
      track.setAttribute(
        'aria-label',
        `${row.title}：${row.spans.map((s) => t(phaseLabels[s.kind]) + ' ' + duration(s.end - s.start)).join('，')}`,
      );
      chart.append(line);
    }
    const tools = view.rows
      .flatMap((row) => row.tools.map((tool) => ({ ...tool, owner: row.title })))
      .sort((a, b) => a.start - b.start);
    calls.hidden = !tools.length;
    callsSummary.textContent = t('工具明细 · {0}', { 0: tools.length });
    if (calls.open)
      for (const tool of tools) {
        const line = totalLine(tool.label, duration(tool.duration));
        line.append(
          el(
            'small',
            [
              tool.owner,
              tool.waiting ? t('等待确认') + ' ' + duration(tool.waiting) : '',
              tool.incomplete ? t('记录不完整') : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        );
        callList.append(line);
      }
    hint.textContent = t(
      view.incomplete
        ? '部分记录不完整，仅显示已记录的时间。'
        : '模型响应包含服务与网络等待。并行时间不重复相加。',
    );
    onChange();
  }
  async function refresh() {
    if (disposed) return;
    if (loading) {
      pending = true;
      return;
    }
    const version = epoch;
    loading = true;
    try {
      const value = await load();
      if (disposed || version !== epoch) return;
      data = value;
      received = performance.now();
      error.hidden = true;
      paint();
    } catch (cause) {
      if (disposed || version !== epoch) return;
      card.hidden = false;
      label.textContent = t('耗时暂不可用');
      clock.textContent = '';
      error.hidden = false;
      error.title = cause.message;
    } finally {
      loading = false;
      if (pending) {
        pending = false;
        void refresh();
      }
    }
  }
  summary.addEventListener('click', () => {
    userToggled = true;
  });
  card.addEventListener('toggle', paint);
  timeline.addEventListener('toggle', paint);
  calls.addEventListener('toggle', paint);
  const unlanguage = subscribeUiLanguage(() => {
    timelineSummary.textContent = t('查看时间轴');
    retry.textContent = t('重新读取');
    history.setAttribute('aria-label', t('选择回合'));
    history.dataset.keys = '';
    paint();
  });
  const timer = setInterval(() => {
    if (card.isConnected && !document.hidden && data) paint();
  }, 1000);
  error.hidden = true;
  mode();
  return {
    element: card,
    refresh,
    reset() {
      epoch++;
      data = null;
      clock.textContent = '';
      card.hidden = emptyHidden;
      selectedTurn = null;
      pending = loading;
      void refresh();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      unlanguage();
    },
  };
}
