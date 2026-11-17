import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getUiLanguage as interfaceLocale,
  t as uiText,
} from '../../../packages/components/ui-language.js';
import { Icon } from '../ui/icons.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { useWorkbenchLayer } from '../ui/workbench-layers.js';
import './intent-workbench.css';

type NativeReceipt = {
  requestId: string;
  threadId: string | null;
  turnId: string | null;
  title: string;
  state: string;
  reason?: string;
  updatedAt: string;
};
type OutputBatch = {
  id: string;
  threadId: string;
  state: string;
  files: { objectId: string; title: string; result: string }[];
  issues: number;
};
type StateInfo = { label: string; tone: 'running' | 'done' | 'warning' | 'danger'; hint?: string };
// requestId -> updatedAt at clearing time, so a record that changes later shows up again.
type ClearedRecords = Record<string, string>;

const post = (value: object) => window.parent.postMessage(value, '*');
const activeStates = new Set([
  'prepared',
  'thread_starting',
  'thread_resuming',
  'thread_created',
  'turn_starting',
  'running',
]);
const isActive = (record: NativeReceipt) => activeStates.has(record.state);
const runningState: StateInfo = {
  label: '进行中',
  tone: 'running',
  hint: '正在处理，完成后会提醒你。',
};
const endedStates: Record<string, StateInfo> = {
  completed: { label: '已完成', tone: 'done' },
  unknown: {
    label: '需要核实',
    tone: 'warning',
    hint: '无法确认是否完成，请在对话中查看结果；不会自动重试。',
  },
  partial: {
    label: '部分完成',
    tone: 'warning',
    hint: '只完成了一部分，可以在对话中让 AI 接着做。',
  },
  failed: {
    label: '未能完成',
    tone: 'danger',
    hint: '这次没有完成，可以在对话中查看原因后重试。',
  },
  interrupted: {
    label: '已中断',
    tone: 'warning',
    hint: '任务中途停止了，可以在对话中让 AI 继续。',
  },
  not_sent: {
    label: '未送达',
    tone: 'warning',
    hint: '消息没有发出去，请在对话中重新发送。',
  },
};
const stateInfo = (record: NativeReceipt) =>
  isActive(record) ? runningState : (endedStates[record.state] ?? endedStates.unknown);

// Generated task names can arrive as slugs such as "repair-svg-display-object_1d2355b9".
function readableTitle(title: string) {
  const line = (title || '').trim().split(/\r?\n/)[0];
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(line)) return line;
  const words = line.replace(/[-_](?=[a-f]*\d)[0-9a-f]{6,}$/i, '').replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function timeLabel(value?: string) {
  const at = Date.parse(value ?? '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor((Date.now() - at) / 60000),
    locale = interfaceLocale();
  if (minutes < 1) return uiText('刚刚');
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 60) return relative.format(-minutes, 'minute');
  if (minutes < 360) return relative.format(-Math.floor(minutes / 60), 'hour');
  return new Date(at).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
const clearedKey = (workspaceId: string) => `yirang:work-records-cleared:${workspaceId}`;
function readCleared(workspaceId: string): ClearedRecords {
  try {
    const value = JSON.parse(localStorage.getItem(clearedKey(workspaceId)) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function saveCleared(workspaceId: string, value: ClearedRecords) {
  try {
    if (Object.keys(value).length)
      localStorage.setItem(clearedKey(workspaceId), JSON.stringify(value));
    else localStorage.removeItem(clearedKey(workspaceId));
  } catch {
    // Without storage the list still stays cleared until the panel reloads.
  }
}

export function IntentWorkbench({
  workspaceId,
  visible,
}: {
  workspaceId: string;
  visible: boolean;
}) {
  useUiLocale();
  const [records, setRecords] = useState<NativeReceipt[]>([]);
  const [batches, setBatches] = useState<OutputBatch[]>([]);
  const [cleared, setCleared] = useState<ClearedRecords>({});
  const [undo, setUndo] = useState<{ previous: ClearedRecords; count: number } | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<NativeReceipt | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [chat, setChat] = useState({ fileOpen: false, open: false });
  const root = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const restored = useRef(false);
  const wasExpanded = useRef(false);
  const seenStates = useRef<Map<string, string> | null>(null);
  const badgeId = useId();
  useWorkbenchLayer(expanded, root, () => setExpanded(false), 'menu', trigger);

  useEffect(() => {
    if (!visible || chat.fileOpen) setExpanded(false);
  }, [visible, chat.fileOpen]);
  // Opening the list shows what finished; closing it marks those results as seen.
  useEffect(() => {
    if (expanded) setNotice(null);
    else if (wasExpanded.current) {
      setFresh(new Set());
      setUndo(null);
      setNotice(null);
    }
    wasExpanded.current = expanded;
  }, [expanded]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (undo) undoButton.current?.focus();
    else if (restored.current) {
      restored.current = false;
      clearButton.current?.focus();
    }
  }, [undo]);
  useEffect(() => {
    seenStates.current = null;
    setRecords([]);
    setBatches([]);
    setCleared(readCleared(workspaceId));
    setUndo(null);
    setFresh(new Set());
    setNotice(null);
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const value = event.data;
      if (value?.type === 'ai-desktop:chat-layout') {
        setChat({ open: !!value.open, fileOpen: !!value.fileOpen });
      } else if (value?.type === 'yirang:native-work-stream' && value.workspaceId === workspaceId) {
        const next: NativeReceipt[] = Array.isArray(value.records) ? value.records : [];
        const before = seenStates.current;
        seenStates.current = new Map(next.map((record) => [record.requestId, record.state]));
        // Only work that was seen running here counts as newly finished.
        const ended = before
          ? next.filter(
              (record) => !isActive(record) && activeStates.has(before.get(record.requestId) ?? ''),
            )
          : [];
        if (ended.length) {
          setFresh((current) => new Set([...current, ...ended.map((record) => record.requestId)]));
          setNotice(ended[0]);
        }
        setRecords(next);
        setBatches(Array.isArray(value.batches) ? value.batches : []);
      }
    };
    window.addEventListener('message', receive);
    post({ type: 'yirang:native-work-request', workspaceId });
    post({ type: 'ai-desktop:chat-layout-request' });
    return () => window.removeEventListener('message', receive);
  }, [workspaceId]);

  const shown = records.filter(
    (record) => isActive(record) || cleared[record.requestId] !== (record.updatedAt ?? ''),
  );
  const running = shown.filter(isActive);
  const finished = shown.filter((record) => !isActive(record));
  const attention = finished.filter((record) => record.state !== 'completed').length;
  const justDone = finished.filter(
    (record) => record.state === 'completed' && fresh.has(record.requestId),
  ).length;
  const focus = () => post({ type: 'yirang:native-work-focus' });
  const clearFinished = () => {
    const listed = new Set(records.map((record) => record.requestId));
    const next: ClearedRecords = Object.fromEntries(
      [
        ...Object.entries(cleared),
        ...finished.map((record) => [record.requestId, record.updatedAt ?? ''] as const),
      ].filter(([id]) => listed.has(id)),
    );
    saveCleared(workspaceId, next);
    setCleared(next);
    setUndo({ previous: cleared, count: finished.length });
  };
  const restore = () => {
    if (!undo) return;
    saveCleared(workspaceId, undo.previous);
    setCleared(undo.previous);
    restored.current = true;
    setUndo(null);
  };
  // Direct records own exactly one batch; older receipts can only be matched by thread.
  const batchesFor = (record: NativeReceipt) => {
    const own = batches.filter((batch) => batch.id === record.requestId);
    return own.length ? own : batches.filter((batch) => batch.threadId === record.threadId);
  };
  const renderRecord = (record: NativeReceipt) => {
    const info = stateInfo(record),
      related = batchesFor(record),
      hasFiles = related.some((batch) => batch.files.length > 0),
      hint =
        record.state === 'unknown' && record.reason
          ? record.reason
          : (info.hint ?? (hasFiles ? '' : '结果在对话中。')),
      time = timeLabel(record.updatedAt),
      isFresh = fresh.has(record.requestId);
    return (
      <article
        key={record.requestId}
        className={`intent-record tone-${info.tone}${isFresh ? ' fresh' : ''}`}
      >
        <div className="intent-work-heading">
          <strong title={record.title}>
            {readableTitle(record.title) || uiText('未命名任务')}
          </strong>
          <span className="intent-state">{uiText(info.label)}</span>
        </div>
        {hint && <p className="intent-work-meta">{uiText(hint)}</p>}
        {related.flatMap((batch) =>
          batch.files.map((file) => (
            <button
              key={`${batch.id}:${file.objectId}`}
              className="intent-result"
              title={uiText('在桌面上找到这个文件')}
              onClick={() =>
                post({
                  type: 'yirang:native-work-locate',
                  batchId: batch.id,
                  objectId: file.objectId,
                })
              }
            >
              <Icon name="document" size={15} />
              <span>{file.title}</span>
              <small>{uiText(file.result === 'updated' ? '已更新' : '新文件')}</small>
            </button>
          )),
        )}
        <div className="intent-work-actions">
          <button onClick={focus}>
            {uiText(isActive(record) ? '在对话中查看' : '在对话中继续')}
          </button>
          {isFresh ? (
            <b className="intent-fresh-tag">{uiText(info.tone === 'done' ? '刚完成' : '刚结束')}</b>
          ) : (
            time && <time dateTime={record.updatedAt}>{time}</time>
          )}
        </div>
      </article>
    );
  };
  const noticeInfo = notice && stateInfo(notice);
  const noticeTitle = notice ? readableTitle(notice.title) || uiText('未命名任务') : '';
  const badges = [
    running.length > 0 && (
      <span key="running" className="intent-record-badge tone-running">
        {uiText('{0} 进行中', { '0': running.length })}
      </span>
    ),
    justDone > 0 ? (
      <span key="done" className="intent-record-badge tone-done">
        <Icon name="check" size={12} />
        {uiText('{0} 刚完成', { '0': justDone })}
      </span>
    ) : (
      attention > 0 && (
        <span key="attention" className="intent-record-badge tone-warning">
          {uiText('{0} 需处理', { '0': attention })}
        </span>
      )
    ),
  ].filter(Boolean);
  const grouped = running.length > 0 && finished.length > 0;
  return (
    <aside
      ref={root}
      hidden={chat.fileOpen || !visible}
      className="intent-workbench"
      aria-label={uiText('AI 对话与执行')}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <p className="intent-live" role="status">
        {notice && noticeInfo ? `${noticeTitle} ${uiText(noticeInfo.label)}` : ''}
      </p>
      {notice && noticeInfo && !expanded && (
        <div className={`intent-work-notice tone-${noticeInfo.tone}`}>
          <span className="intent-notice-mark" aria-hidden="true">
            {noticeInfo.tone === 'done' ? <Icon name="check" size={14} /> : '!'}
          </span>
          <span className="intent-notice-text">
            <strong title={notice.title}>{noticeTitle}</strong>
            <small>{uiText(noticeInfo.label)}</small>
          </span>
          <button className="intent-notice-open" onClick={() => setExpanded(true)}>
            {uiText('查看')}
          </button>
          <button aria-label={uiText('关闭提醒')} onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
      {expanded && (
        <section className="intent-work-list" aria-label={uiText('执行记录')}>
          <header>
            <strong>{uiText('执行记录')}</strong>
            <div className="intent-work-tools">
              {finished.length > 0 && (
                <button
                  ref={clearButton}
                  className="intent-clear"
                  title={uiText('清空已结束的记录。进行中的任务、文件和对话都会保留。')}
                  onClick={clearFinished}
                >
                  {uiText('一键清空')}
                </button>
              )}
              <button aria-label={uiText('收起执行记录')} onClick={() => setExpanded(false)}>
                ×
              </button>
            </div>
          </header>
          {undo && (
            <p className="intent-cleared" role="status">
              <span>{uiText('已清空 {0} 条记录，文件和对话都还在。', { '0': undo.count })}</span>
              <button ref={undoButton} onClick={restore}>
                {uiText('撤销')}
              </button>
            </p>
          )}
          {!shown.length && (
            <div className="intent-empty">
              <strong>{uiText(records.length ? '记录已清空' : '还没有执行记录')}</strong>
              <p>{uiText('在对话里告诉 AI 要做什么，进度和结果会显示在这里。')}</p>
              <button onClick={focus}>{uiText('打开对话')}</button>
            </div>
          )}
          {grouped && (
            <h3 className="intent-work-group">
              {uiText('进行中')}
              <span>{running.length}</span>
            </h3>
          )}
          {running.map(renderRecord)}
          {grouped && (
            <h3 className="intent-work-group">
              {uiText('已结束')}
              <span>{finished.length}</span>
            </h3>
          )}
          {finished.map(renderRecord)}
        </section>
      )}
      <div className="intent-work-bar">
        <div id="intent-selection-slot" />
        <button className="intent-ask" onClick={focus}>
          <Icon name="comment" size={17} />
          {uiText('问 AI')}
        </button>
        <button
          ref={trigger}
          className={`intent-record-trigger${badges.length ? ' has-badges' : ''}`}
          aria-expanded={expanded}
          aria-label={uiText('查看执行记录')}
          aria-describedby={badges.length ? badgeId : undefined}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name="history" size={17} />
          <span className="intent-record-label">{uiText('执行记录')}</span>
          {badges.length > 0 && (
            <span id={badgeId} className="intent-record-badges">
              {badges}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}

export function IntentSelection({
  integrated,
  children,
}: {
  integrated: boolean;
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (integrated) setTarget(document.getElementById('intent-selection-slot'));
  }, [integrated]);
  return integrated ? target ? createPortal(children, target) : null : <>{children}</>;
}
