import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { retainEqual } from '../workspace/workspace-refresh.js';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import type { MaterialRange, Workspace } from '../../../packages/contracts/index.js';
import {
  COMMENT_BODY_LIMIT,
  type CommentDispatch,
  type CommentMessage,
  type CommentThread,
} from '../../../packages/contracts/comments.js';
import { Icon } from '../ui/icons.js';
import { PanelActionError, SendRejectedError } from '../host.js';
import {
  flushDraftStorage,
  scheduleDraftWrite,
  writeDraftNow,
} from '../documents/draft-storage.js';
import './comments.css';

export type CommentsDrawerProps = {
  workspace: Workspace;
  initialThreadId?: string;
  objectId?: string;
  range?: MaterialRange;
  rangeLabel?: string;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  send: (threadId: string, expectedRevision: number) => Promise<void>;
  canSend: boolean;
  connectionMessage?: string;
  close: () => void;
  openObject: (id: string) => void;
  history: (id: string, revision?: number) => void;
  changed?: () => void;
};
type Target = { objectId: string; baseRevision: number; range?: MaterialRange; label?: string };
type Pending = { payload: Record<string, unknown>; draftKey?: string; body?: string };
type SendGuard = { previousDispatchId?: string; revision: number };
type LocalDraft = {
  version: 1;
  drafts: Record<string, string>;
  target?: Target;
  pending?: Pending;
  sends: Record<string, SendGuard>;
};
type Filter = 'open' | 'waiting' | 'resolved' | 'all';
const newLocal = (): LocalDraft => ({ version: 1, drafts: {}, sends: {} });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const uid = () => crypto.randomUUID();
const latest = (thread: CommentThread) => thread.dispatches[thread.dispatches.length - 1];
const dateText = (value: string) =>
  new Date(value).toLocaleString(interfaceLocale(), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const knownRejection = (error: unknown) =>
  error instanceof SendRejectedError ||
  (error instanceof PanelActionError &&
    !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code));
const targetKey = (target: Target) =>
  `new:${target.objectId}:${target.baseRevision}:${JSON.stringify(target.range ?? null)}`;
function describeRange(range?: MaterialRange) {
  return !range
    ? uiText('整个对象')
    : range.type === 'cells'
      ? uiText('{0} 行 × {1} 列', { '0': range.rowIds.length, '1': range.columnIds.length })
      : range.type === 'native'
        ? uiText('文件中的所选区域')
        : uiText('第 {0}–{1} 个字符', { '0': range.start + 1, '1': range.end });
}
function readLocal(key: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (parsed?.version === 1 && parsed.drafts && typeof parsed.drafts === 'object')
      return { ...parsed, sends: parsed.sends ?? {} } as LocalDraft;
  } catch {}
  return newLocal();
}
function dispatchBlocks(dispatch?: CommentDispatch) {
  return (
    !!dispatch &&
    !dispatch.restoredAt &&
    (dispatch.status === 'queued' || dispatch.status === 'running')
  );
}
function dispatchLabel(dispatch?: CommentDispatch) {
  if (!dispatch) return uiText('未交给 AI');
  if (dispatch.status === 'completed') return uiText('AI 已完成');
  if (dispatch.status === 'failed' || dispatch.delivery === 'failed') return uiText('处理未完成');
  if (dispatch.status === 'waiting') return uiText('等你回复');
  if (dispatch.delivery === 'unknown' || dispatch.delivery === 'claimed')
    return uiText('等待发送确认');
  if (dispatch.delivery === 'preparing' || dispatch.delivery === 'prepared')
    return uiText('正在准备');
  if (dispatch.status === 'running') return uiText('AI 处理中');
  return uiText('等待 AI 回复');
}
function dispatchNote(dispatch: CommentDispatch) {
  if (dispatch.status === 'waiting')
    return uiText('直接在下方回答，点击“回复并继续”即可把补充内容交给 AI。');
  if (dispatch.status === 'failed')
    return dispatch.message || uiText('执行没有完成。可以补充评论后再次交给 AI。');
  if (dispatch.status === 'completed')
    return uiText('回复与结果已回到这里，可以查看修改或继续补充要求。');
  if (dispatch.delivery === 'unknown' || dispatch.delivery === 'claimed')
    return uiText(
      '发送结果尚未确认，暂不重复提交。收到 AI 回报后会自动更新；可先在这里继续写草稿。',
    );
  if (dispatch.delivery === 'prepared' || dispatch.delivery === 'preparing')
    return uiText('正在准备这条评论对应的材料和选区。');
  return uiText('进度、追问和处理结果会更新到当前评论，无需切换页面。');
}

export function CommentsDrawer(props: CommentsDrawerProps) {
  useUiLocale();
  const content = <CommentsDrawerBody key={props.workspace.id} {...props} />;
  return props.objectId || !isIntegratedDesktop ? createPortal(content, document.body) : content;
}

function CommentsDrawerBody(props: CommentsDrawerProps) {
  useUiLocale();
  const callbacks = useRef(props);
  callbacks.current = props;
  const storageKey = `ai-desktop:comments-drafts:${props.workspace.id}`;
  const [local, setLocal] = useState<LocalDraft>(() => readLocal(storageKey)),
    localRef = useRef(local);
  localRef.current = local;
  const initialObject = props.workspace.objects.find((object) => object.id === props.objectId);
  const [target, setTargetState] = useState<Target | undefined>(() =>
    initialObject && props.range
      ? {
          objectId: initialObject.id,
          baseRevision: props.range.baseRevision,
          range: props.range,
          label: props.rangeLabel,
        }
      : local.target?.objectId === props.objectId
        ? local.target
        : initialObject
          ? { objectId: initialObject.id, baseRevision: initialObject.revision }
          : local.target,
  );
  const [scope, setScope] = useState<'object' | 'all'>(props.objectId ? 'object' : 'all'),
    [filter, setFilter] = useState<Filter>('open');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [threads, setThreads] = useState<CommentThread[]>([]),
    [chosen, setChosen] = useState<string | null>(props.initialThreadId ?? null),
    [composing, setComposing] = useState(!!props.range);
  const [loading, setLoading] = useState(true),
    [detailLoading, setDetailLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [storageError, setStorageError] = useState('');
  const [truncated, setTruncated] = useState(false),
    working = useRef(false),
    reading = useRef(false),
    mounted = useRef(true),
    listSequence = useRef(0);
  const selectionStamp = JSON.stringify([props.objectId, props.range, props.rangeLabel]),
    previousSelection = useRef(selectionStamp);
  const inputRef = useRef<HTMLTextAreaElement>(null),
    chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const current = threads.find((thread) => thread.id === chosen),
    objectFilter = props.objectId ?? target?.objectId;
  const targetObject = props.workspace.objects.find((object) => object.id === target?.objectId),
    currentObject = props.workspace.objects.find((object) => object.id === current?.objectId);
  const draftKey = current ? `reply:${current.id}` : target ? targetKey(target) : '',
    body = local.drafts[draftKey] ?? '',
    dispatch = current ? latest(current) : undefined;
  const stale =
    !!current &&
    !!currentObject &&
    ((!!current.range && current.baseRevision !== currentObject.revision) || !!current.restoredAt);
  const newStale = !!targetObject && !!target && target.baseRevision !== targetObject.revision;
  const currentRange =
    props.objectId === current?.objectId && props.range?.baseRevision === currentObject?.revision
      ? props.range
      : undefined;
  const localSendUnknown = !!current && !!local.sends[current.id],
    sendBlocked = dispatchBlocks(dispatch) || localSendUnknown;
  const locked = busy || detailLoading || !!local.pending;
  const scopeRef = useRef(scope),
    objectFilterRef = useRef(objectFilter);
  scopeRef.current = scope;
  objectFilterRef.current = objectFilter;

  function updateLocal(update: (value: LocalDraft) => LocalDraft, immediate = false) {
    const next = update(localRef.current);
    localRef.current = next;
    setLocal(next);
    try {
      if (immediate) {
        writeDraftNow(storageKey, JSON.stringify(next));
        setStorageError('');
      } else
        scheduleDraftWrite(
          storageKey,
          () => JSON.stringify(localRef.current),
          (problem) => {
            if (mounted.current)
              setStorageError(problem ? uiText('本机草稿存储暂不可用，请保留此页面。') : '');
          },
          900,
        );
    } catch {
      setStorageError(uiText('本机草稿存储暂不可用，请保留此页面。'));
    }
  }
  function setTarget(value: Target | undefined) {
    setTargetState(value);
    updateLocal((data) => ({ ...data, target: value }));
  }
  function mergeThread(thread: CommentThread) {
    setThreads((items) => {
      const existing = items.find((item) => item.id === thread.id);
      if (
        existing &&
        (existing.revision > thread.revision || retainEqual(existing, thread) === existing)
      )
        return items;
      return [thread, ...items.filter((item) => item.id !== thread.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    });
  }
  function reconcileSends(items: CommentThread[]) {
    const remaining = { ...localRef.current.sends };
    let changed = false;
    for (const thread of items) {
      const guard = remaining[thread.id],
        last = latest(thread);
      if (
        guard &&
        last &&
        last.id !== guard.previousDispatchId &&
        !['preparing', 'prepared'].includes(last.delivery)
      ) {
        delete remaining[thread.id];
        changed = true;
      }
    }
    if (changed) updateLocal((value) => ({ ...value, sends: remaining }));
  }
  async function refresh(quiet = true) {
    if (reading.current) return;
    reading.current = true;
    const sequence = ++listSequence.current,
      selected = chosenRef.current;
    const filterObject =
      scopeRef.current === 'object' &&
      callbacks.current.workspace.objects.some((object) => object.id === objectFilterRef.current)
        ? objectFilterRef.current
        : undefined;
    try {
      const result = await callbacks.current.action(
        'comments',
        selected
          ? { operation: 'read', threadId: selected }
          : { operation: 'list', ...(filterObject ? { objectId: filterObject } : {}) },
      );
      if (!mounted.current || sequence !== listSequence.current) return;
      if (selected) {
        mergeThread(result.thread);
        reconcileSends([result.thread]);
      } else {
        const items = result.threads as CommentThread[];
        setThreads((previous) =>
          retainEqual(
            previous,
            items.map((item) => {
              const known = previous.find((thread) => thread.id === item.id);
              return known &&
                (known.revision > item.revision ||
                  (known.revision === item.revision &&
                    known.messages.length > item.messages.length))
                ? known
                : item;
            }),
          ),
        );
        setTruncated(!!result.truncated);
        reconcileSends(items);
      }
      if (!quiet) setError('');
    } catch (problem) {
      if (mounted.current && !quiet) setError(errorText(problem));
    } finally {
      reading.current = false;
      if (mounted.current) {
        setLoading(false);
        if (selected === chosenRef.current) setDetailLoading(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh(false);
    const timer = setInterval(() => {
      if (!document.hidden && !working.current) void refresh();
    }, 2600);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      listSequence.current++;
      flushDraftStorage(storageKey);
    };
  }, []);
  useEffect(() => {
    if (target) updateLocal((value) => ({ ...value, target }));
  }, []);
  useEffect(() => {
    setDetailLoading(!!chosen);
    void refresh(false);
  }, [chosen]);
  useEffect(() => {
    if (!chosenRef.current) void refresh(false);
  }, [scope, objectFilter]);
  useEffect(() => {
    if (previousSelection.current === selectionStamp) return;
    previousSelection.current = selectionStamp;
    const object = props.workspace.objects.find((item) => item.id === props.objectId);
    if (object) {
      setTarget({
        objectId: object.id,
        baseRevision: props.range?.baseRevision ?? object.revision,
        range: props.range,
        label: props.rangeLabel,
      });
      setScope('object');
      setChosen(null);
      setComposing(!!props.range);
    } else setScope('all');
  }, [selectionStamp]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        flushDraftStorage(storageKey);
        callbacks.current.close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  async function mutate(payload: Record<string, unknown>, draft?: { key: string; body: string }) {
    if (working.current) return null;
    working.current = true;
    setBusy(true);
    setError('');
    const pending: Pending = {
      payload,
      ...(draft ? { draftKey: draft.key, body: draft.body } : {}),
    };
    updateLocal((value) => ({ ...value, pending }), true);
    try {
      const result = await callbacks.current.action('comments', payload);
      if (!mounted.current) return result.thread as CommentThread;
      const thread = result.thread as CommentThread;
      mergeThread(thread);
      updateLocal((value) => {
        const drafts = { ...value.drafts };
        if (pending.draftKey && drafts[pending.draftKey] === pending.body)
          delete drafts[pending.draftKey];
        return { ...value, drafts, pending: undefined };
      }, true);
      setChosen(thread.id);
      setComposing(false);
      callbacks.current.changed?.();
      return thread;
    } catch (problem) {
      if (mounted.current) {
        setError(errorText(problem));
        if (knownRejection(problem))
          updateLocal((value) => ({ ...value, pending: undefined }), true);
      }
      return null;
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function retryPending() {
    const pending = localRef.current.pending;
    if (pending)
      await mutate(
        pending.payload,
        pending.draftKey ? { key: pending.draftKey, body: pending.body ?? '' } : undefined,
      );
  }
  async function sendThread(thread: CommentThread) {
    if (
      working.current ||
      !callbacks.current.canSend ||
      localRef.current.sends[thread.id] ||
      dispatchBlocks(latest(thread))
    )
      return;
    working.current = true;
    setBusy(true);
    setError('');
    updateLocal(
      (value) => ({
        ...value,
        sends: {
          ...value.sends,
          [thread.id]: { revision: thread.revision, previousDispatchId: latest(thread)?.id },
        },
      }),
      true,
    );
    try {
      await callbacks.current.send(thread.id, thread.revision);
      const response = await callbacks.current.action('comments', {
        operation: 'read',
        threadId: thread.id,
      });
      if (mounted.current) {
        mergeThread(response.thread);
        reconcileSends([response.thread]);
        callbacks.current.changed?.();
      }
    } catch (problem) {
      if (mounted.current) {
        setError(errorText(problem));
        if (knownRejection(problem))
          updateLocal((value) => {
            const sends = { ...value.sends };
            delete sends[thread.id];
            return { ...value, sends };
          }, true);
      }
    } finally {
      working.current = false;
      if (mounted.current) {
        setBusy(false);
        void refresh();
      }
    }
  }
  async function submit(withAi: boolean) {
    if (locked || !body.trim()) return;
    let thread: CommentThread | null;
    if (current) {
      thread = await mutate(
        {
          operation: 'reply',
          threadId: current.id,
          expectedRevision: current.revision,
          requestId: uid(),
          body,
        },
        { key: draftKey, body },
      );
    } else {
      if (!target || !targetObject || newStale) return;
      thread = await mutate(
        { operation: 'create', requestId: uid(), ...target, body },
        { key: draftKey, body },
      );
    }
    if (thread && withAi) await sendThread(thread);
  }
  function beginNew() {
    const object =
      props.workspace.objects.find((item) => item.id === props.objectId) ??
      targetObject ??
      props.workspace.objects.find((item) => !item.archived);
    if (object) {
      const localTarget =
        target?.objectId === object.id
          ? target
          : {
              objectId: object.id,
              baseRevision: object.revision,
              ...(props.objectId === object.id
                ? { range: props.range, label: props.rangeLabel }
                : {}),
            };
      setTarget(localTarget);
    }
    setChosen(null);
    setComposing(true);
    setError('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }
  function chooseTarget(id: string) {
    const object = props.workspace.objects.find((item) => item.id === id);
    if (object) setTarget({ objectId: id, baseRevision: object.revision });
  }
  async function reanchor(range?: MaterialRange) {
    if (!current || !currentObject) return;
    await mutate({
      operation: 'reanchor',
      requestId: uid(),
      threadId: current.id,
      expectedRevision: current.revision,
      baseRevision: currentObject.revision,
      ...(range
        ? { range, label: props.rangeLabel ?? describeRange(range) }
        : { label: uiText('整个对象') }),
    });
  }
  async function cancelDispatch() {
    if (!current) return;
    const result = await mutate({
      operation: 'cancel',
      requestId: uid(),
      threadId: current.id,
      expectedRevision: current.revision,
    });
    if (result)
      updateLocal((value) => {
        const sends = { ...value.sends };
        delete sends[current.id];
        return { ...value, sends };
      }, true);
  }
  function moveNewDraft(range?: MaterialRange) {
    if (!target || !targetObject) return;
    const next = {
      objectId: target.objectId,
      baseRevision: targetObject.revision,
      ...(range
        ? { range, label: props.rangeLabel ?? describeRange(range) }
        : { label: uiText('整个对象') }),
    };
    const oldKey = targetKey(target),
      nextKey = targetKey(next);
    updateLocal((value) => ({
      ...value,
      target: next,
      drafts: {
        ...value.drafts,
        ...(value.drafts[oldKey] ? { [nextKey]: value.drafts[oldKey] } : {}),
      },
    }));
    setTargetState(next);
  }

  const visible = threads.filter(
    (thread) =>
      (scope === 'all' || thread.objectId === objectFilter) &&
      (filter === 'all' ||
        (filter === 'open' && thread.state === 'open') ||
        (filter === 'resolved' && thread.state === 'resolved') ||
        (filter === 'waiting' && thread.state === 'open' && latest(thread)?.status === 'waiting')),
  );
  const waitingCount = threads.filter(
    (thread) => thread.state === 'open' && latest(thread)?.status === 'waiting',
  ).length;
  const newSelection =
    props.objectId === target?.objectId && props.range?.baseRevision === targetObject?.revision
      ? props.range
      : undefined;
  const showComposer = !!current || composing || (!!props.objectId && scope === 'object');
  const objectMissing = current ? !currentObject : !targetObject;
  const canSubmit =
    !!body.trim() &&
    body.length <= COMMENT_BODY_LIMIT &&
    !locked &&
    !objectMissing &&
    (!current ? !newStale : true) &&
    current?.state !== 'resolved';
  const canAi =
    canSubmit &&
    props.canSend &&
    !sendBlocked &&
    !(current ? stale : newStale) &&
    !(currentObject ?? targetObject)?.policy?.private;
  const hasUnsent = current?.messages.some(
    (message) => message.author === 'human' && !dispatch?.messageIds.includes(message.id),
  );

  return (
    <aside
      className={`comments-drawer comments-light${props.objectId ? '' : ' comments-page'}`}
      role={props.objectId ? 'complementary' : 'region'}
      aria-label={uiText('桌面评论')}
      data-loading={loading}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header>
        <div className="comments-drawer-title">
          <h2>
            {uiText('评论')}
            <small>{visible.length || ''}</small>
          </h2>
          <p>
            {scope === 'all'
              ? props.workspace.name
              : (props.workspace.objects.find((object) => object.id === objectFilter)?.title ??
                uiText('桌面对象'))}
          </p>
        </div>
        {(current || !showComposer) && (
          <button
            className="comments-icon-button"
            title={uiText('写新评论')}
            aria-label={uiText('写新评论')}
            disabled={!props.workspace.objects.some((object) => !object.archived) || locked}
            onClick={beginNew}
          >
            <Icon name="plus" size={15} />
          </button>
        )}
        <button
          className="comments-icon-button comments-more-button"
          title={uiText('筛选与更多')}
          aria-label={uiText('筛选与更多')}
          aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen(!optionsOpen)}
        >
          ⋯
        </button>
        <button
          className="comments-icon-button"
          title={uiText('收起评论')}
          aria-label={uiText('收起评论')}
          onClick={() => {
            flushDraftStorage(storageKey);
            props.close();
          }}
        >
          <Icon name="close" size={15} />
        </button>
      </header>
      {optionsOpen && (
        <div className="comments-options">
          <label>
            {uiText('范围')}
            <select
              aria-label={uiText('评论范围')}
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as 'object' | 'all');
                setChosen(null);
                setComposing(false);
              }}
            >
              <option value="object" disabled={!objectFilter}>
                {uiText('当前对象')}
              </option>
              <option value="all">
                {uiText('全部评论')}
                {waitingCount ? uiText(' · {0} 条待回复', { '0': waitingCount }) : ''}
              </option>
            </select>
          </label>
          <label>
            {uiText('状态')}
            <select
              aria-label={uiText('筛选评论')}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value as Filter);
                setChosen(null);
                setComposing(false);
              }}
            >
              <option value="open">{uiText('未解决')}</option>
              <option value="waiting">{uiText('等我回复')}</option>
              <option value="resolved">{uiText('已解决')}</option>
              <option value="all">{uiText('全部状态')}</option>
            </select>
          </label>
          <button
            className="comments-icon-button"
            title={uiText('刷新评论')}
            aria-label={uiText('刷新评论')}
            disabled={busy}
            onClick={() => void refresh(false)}
          >
            <Icon name="history" size={14} />
          </button>
        </div>
      )}
      {error && (
        <div className="comments-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {local.pending && (
        <div className="comments-error" role="status">
          <p>{uiText('上次保存尚未确认，内容和原请求已保留。确认保存前不会建立重复评论。')}</p>
          <button disabled={busy} onClick={() => void retryPending()}>
            {uiText('确认上次保存')}
          </button>
        </div>
      )}
      <div className="comments-scroll">
        {current ? (
          <div className="comments-thread-detail">
            <button
              className="comments-back"
              onClick={() => {
                setChosen(null);
                setComposing(false);
              }}
            >
              <Icon name="arrow" size={13} />
              {uiText('返回评论列表')}
            </button>
            <div
              className={`comments-scope${props.objectId === current.objectId && !current.range ? ' comments-scope-implicit' : ''}`}
            >
              <div className="comments-scope-title">
                <Icon name="document" size={14} />
                <strong>{currentObject?.title ?? uiText('对象已不在当前桌面')}</strong>
                {currentObject && (
                  <button onClick={() => props.openObject(current.objectId)}>
                    {uiText('打开')}
                  </button>
                )}
              </div>
              <p>
                {current.label || describeRange(current.range)} · v{current.baseRevision}
                {current.state === 'resolved' ? uiText(' · 已解决') : ''}
              </p>
              {currentObject?.selectedText &&
                current.range &&
                current.baseRevision === currentObject.revision && (
                  <blockquote>{currentObject.selectedText.slice(0, 240)}</blockquote>
                )}
            </div>
            {objectMissing && (
              <div className="comments-warning">{uiText('原对象已移除，评论保留在收件箱中。')}</div>
            )}
            {stale && (
              <div className="comments-warning">
                <strong>
                  {current.restoredAt
                    ? uiText('恢复的评论需要重新定位')
                    : current.range
                      ? uiText('原选区版本已变化')
                      : uiText('对象已有新版本')}
                </strong>
                <p>
                  {uiText('评论保留在 v')}
                  {current.baseRevision}
                  {uiText('，当前为 v')}
                  {currentObject!.revision}
                  {uiText('。继续处理前请明确选择新的范围。')}
                </p>
                {currentRange && (
                  <button
                    disabled={locked || sendBlocked}
                    onClick={() => void reanchor(currentRange)}
                  >
                    {uiText('定位到当前选区')}
                  </button>
                )}
                <button disabled={locked || sendBlocked} onClick={() => void reanchor()}>
                  {uiText('改为当前整个对象')}
                </button>
                <button onClick={() => props.history(current.objectId, current.baseRevision)}>
                  {uiText('查看原版本')}
                </button>
              </div>
            )}
            {current.restoredAt && (
              <div className="comments-notice">
                {uiText('这条评论来自恢复的工作区。旧执行记录保留为历史，不会自动继续运行。')}
              </div>
            )}
            {detailLoading && <p className="comments-list-notice">{uiText('正在读取完整讨论…')}</p>}
            <div className="comments-message-list">
              {current.messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  workspace={props.workspace}
                  openObject={props.openObject}
                  history={props.history}
                />
              ))}
            </div>
            {dispatch && (
              <div
                className="comments-activity"
                data-state={
                  dispatch.delivery === 'unknown' || dispatch.delivery === 'claimed'
                    ? 'unknown'
                    : dispatch.status
                }
                role="status"
              >
                <span />
                <div>
                  <strong>{dispatchLabel(dispatch)}</strong>
                  <details>
                    <summary>{uiText('详情')}</summary>
                    <p>{dispatchNote(dispatch)}</p>
                  </details>
                </div>
              </div>
            )}
            {localSendUnknown && !dispatchBlocks(dispatch) && (
              <div className="comments-warning">
                <strong>{uiText('等待确认这次发送')}</strong>
                <p>{uiText('请求结果尚未返回，暂不重复发送。评论草稿会继续保留。')}</p>
              </div>
            )}
            {dispatch &&
              !dispatch.restoredAt &&
              !['completed', 'failed'].includes(dispatch.status) && (
                <div className="comments-warning">
                  <p>
                    {uiText(
                      '需要结束这次桌面请求时，可以撤销后续桌面读写权限。已开始的原对话操作不会自动停止。',
                    )}
                  </p>
                  <button disabled={locked} onClick={() => void cancelDispatch()}>
                    {uiText('撤销此请求')}
                  </button>
                </div>
              )}
            {dispatch &&
              Object.keys(dispatch.resultRevisions).length > 0 &&
              !current.messages.some(
                (message) =>
                  message.dispatchId === dispatch.id &&
                  Object.keys(message.resultRevisions ?? {}).length,
              ) && (
                <ResultLinks
                  results={dispatch.resultRevisions}
                  workspace={props.workspace}
                  openObject={props.openObject}
                  history={props.history}
                />
              )}
            {!!hasUnsent && !body.trim() && current.state === 'open' && (
              <details className="comments-thread-extra">
                <summary>{uiText('AI 操作')}</summary>
                <button
                  className="comments-send-current"
                  disabled={
                    locked ||
                    sendBlocked ||
                    stale ||
                    !props.canSend ||
                    objectMissing ||
                    !!currentObject?.policy?.private
                  }
                  onClick={() => void sendThread(current)}
                >
                  <Icon name="play" size={12} />
                  {dispatch?.status === 'waiting'
                    ? uiText('继续处理这些回复')
                    : uiText('让 AI 处理这条评论')}
                </button>
              </details>
            )}
            <div className="comments-thread-actions">
              <button
                disabled={locked || sendBlocked}
                onClick={() =>
                  void mutate({
                    operation: current.state === 'resolved' ? 'reopen' : 'resolve',
                    requestId: uid(),
                    threadId: current.id,
                    expectedRevision: current.revision,
                  })
                }
              >
                <Icon name={current.state === 'resolved' ? 'history' : 'check'} size={13} />
                {current.state === 'resolved' ? uiText('重新打开评论') : uiText('标记为已解决')}
              </button>
              {currentObject && (
                <button onClick={() => props.history(current.objectId)}>
                  <Icon name="history" size={13} />
                  {uiText('修改记录')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="comments-thread-list">
              {visible.map((thread) => {
                const object = props.workspace.objects.find((item) => item.id === thread.objectId),
                  last = latest(thread),
                  isStale =
                    object &&
                    ((!!thread.range && thread.baseRevision !== object.revision) ||
                      !!thread.restoredAt);
                return (
                  <button
                    className="comments-thread-card"
                    key={thread.id}
                    onClick={() => {
                      setChosen(thread.id);
                      setComposing(false);
                      setError('');
                    }}
                  >
                    <div className="comments-thread-heading">
                      <strong>{object?.title ?? uiText('已移除的对象')}</strong>
                      <span
                        className="comments-pill"
                        data-state={
                          thread.state === 'resolved'
                            ? 'resolved'
                            : last?.delivery === 'unknown'
                              ? 'unknown'
                              : last?.status
                        }
                      >
                        {thread.state === 'resolved'
                          ? uiText('已解决')
                          : last
                            ? dispatchLabel(last)
                            : uiText('待处理')}
                      </span>
                    </div>
                    <p>{thread.messages[thread.messages.length - 1]?.body ?? uiText('暂无内容')}</p>
                    <div className="comments-thread-foot">
                      <span>{thread.label || describeRange(thread.range)}</span>
                      {isStale && (
                        <span className="comments-pill" data-state="stale">
                          {uiText('范围待更新')}
                        </span>
                      )}
                      <time dateTime={thread.updatedAt}>{dateText(thread.updatedAt)}</time>
                    </div>
                  </button>
                );
              })}
            </div>
            {!visible.length && !loading && (
              <div className="comments-empty">
                <p>
                  {filter === 'waiting'
                    ? uiText('暂无待回复的评论')
                    : filter === 'resolved'
                      ? uiText('暂无已解决的评论')
                      : uiText('还没有评论，写下你的想法。')}
                </p>
              </div>
            )}
            {loading && <p className="comments-list-notice">{uiText('正在读取评论…')}</p>}
            {truncated && (
              <p className="comments-list-notice">
                {uiText('当前显示最近的评论。旧评论仍保存在本地工作区。')}
              </p>
            )}
          </>
        )}
      </div>
      {showComposer && (
        <div className="comments-composer">
          {!current &&
            (!props.objectId || scope === 'all' || target?.objectId !== props.objectId) && (
              <div className="comments-composer-target">
                <select
                  aria-label={uiText('评论对象')}
                  disabled={locked}
                  value={target?.objectId ?? ''}
                  onChange={(event) => chooseTarget(event.target.value)}
                >
                  <option value="" disabled>
                    {uiText('选择评论对象')}
                  </option>
                  {props.workspace.objects
                    .filter((object) => !object.archived)
                    .map((object) => (
                      <option key={object.id} value={object.id}>
                        {object.title}
                      </option>
                    ))}
                </select>
              </div>
            )}
          {!current && target?.range && (
            <p className="comments-list-notice">{target.label || describeRange(target.range)}</p>
          )}
          {!current && newStale && (
            <div className="comments-warning">
              <p>{uiText('草稿引用的版本已变化，请重新确认评论范围。')}</p>
              {newSelection && (
                <button disabled={locked} onClick={() => moveNewDraft(newSelection)}>
                  {uiText('使用当前选区')}
                </button>
              )}
              <button disabled={locked} onClick={() => moveNewDraft()}>
                {uiText('改为当前整个对象')}
              </button>
            </div>
          )}
          {current?.state === 'resolved' ? (
            <div className="comments-notice">{uiText('重新打开评论后可以继续回复或交给 AI。')}</div>
          ) : (
            <>
              <div className="comments-composer-box">
                <textarea
                  ref={inputRef}
                  aria-label={current ? uiText('回复评论') : uiText('评论内容')}
                  disabled={!draftKey || !!local.pending}
                  rows={2}
                  placeholder={
                    current
                      ? dispatch?.status === 'waiting'
                        ? uiText('补充回答…')
                        : uiText('回复…')
                      : uiText('写条评论…')
                  }
                  value={body}
                  maxLength={COMMENT_BODY_LIMIT}
                  onChange={(event) => {
                    const value = event.target.value;
                    updateLocal((data) => ({
                      ...data,
                      drafts: { ...data.drafts, [draftKey]: value },
                    }));
                  }}
                  onBlur={() => flushDraftStorage(storageKey)}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key === 'Enter' &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      if (canSubmit) void submit(false);
                    }
                  }}
                />
              </div>
              <div className="comments-composer-actions">
                <details className="comments-extra">
                  <summary title={uiText('更多评论操作')} aria-label={uiText('更多评论操作')}>
                    ⋯
                  </summary>
                  <div>
                    <button
                      disabled={!canAi}
                      title={
                        !props.canSend
                          ? props.connectionMessage
                          : sendBlocked
                            ? uiText('等待当前请求回报')
                            : stale
                              ? uiText('请先更新评论范围')
                              : undefined
                      }
                      onClick={() => void submit(true)}
                    >
                      <Icon name="play" size={11} />
                      {current && dispatch?.status === 'waiting'
                        ? uiText('回复并交给 AI')
                        : uiText('发送并让 AI 处理')}
                    </button>
                    {!props.canSend && (
                      <p>{props.connectionMessage || uiText('连接 Codex 后可使用 AI 处理')}</p>
                    )}
                  </div>
                </details>
                <small>
                  {body.length > COMMENT_BODY_LIMIT * 0.8
                    ? `${body.length}/${COMMENT_BODY_LIMIT}`
                    : 'Ctrl / ⌘ ↵'}
                </small>
                <button
                  className="comments-primary"
                  disabled={!canSubmit}
                  onClick={() => void submit(false)}
                >
                  {busy ? uiText('发送中…') : current ? uiText('回复') : uiText('发送')}
                  <Icon name="arrow" size={12} />
                </button>
              </div>
            </>
          )}
          {storageError && (
            <p className="comments-local-error" role="alert">
              {storageError}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}

function ResultLinks({
  results,
  workspace,
  openObject,
  history,
}: {
  results: Record<string, number>;
  workspace: Workspace;
  openObject: (id: string) => void;
  history: (id: string, revision?: number) => void;
}) {
  useUiLocale();
  return (
    <div className="comments-message-results">
      {Object.entries(results).map(([id, revision]) => {
        const object = workspace.objects.find((item) => item.id === id);
        return (
          <React.Fragment key={id}>
            <button disabled={!object} onClick={() => openObject(id)}>
              {object?.title ?? uiText('结果对象')} · v{revision}
            </button>
            <button disabled={!object} onClick={() => history(id, revision)}>
              {uiText('查看修改')}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
function Message({
  message,
  workspace,
  openObject,
  history,
}: {
  message: CommentMessage;
  workspace: Workspace;
  openObject: (id: string) => void;
  history: (id: string, revision?: number) => void;
}) {
  useUiLocale();
  return (
    <article className="comments-message" data-author={message.author}>
      <span className="comments-avatar">{message.author === 'ai' ? 'AI' : uiText('我')}</span>
      <div>
        <div className="comments-message-heading">
          <strong>{message.author === 'ai' ? 'Codex' : uiText('你')}</strong>
          {message.status === 'waiting' && (
            <span className="comments-pill" data-state="waiting">
              {uiText('需要补充')}
            </span>
          )}
          <time dateTime={message.createdAt}>{dateText(message.createdAt)}</time>
        </div>
        <p className="comments-message-body">{message.body}</p>
        {message.resultRevisions && (
          <ResultLinks
            results={message.resultRevisions}
            workspace={workspace}
            openObject={openObject}
            history={history}
          />
        )}
      </div>
    </article>
  );
}

export default CommentsDrawer;
