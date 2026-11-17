import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useWorkspaceRefresh, retainEqual } from './workspace-refresh.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import { kindLabels } from '../../../packages/components/content.js';
import { FileBadge } from '../ui/icons.js';
import { PanelActionError } from '../host.js';
import { nativeDraftKey, nativeDraftKinds } from '../documents/native/native-drafts.js';
import { flushDraftStorage, writeDraftNow } from '../documents/draft-storage.js';
import { workflowDraftKey } from '../workflows/workflow-editor.js';
import './desktop-delete.css';

type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
type Entry = { id: string; title: string; revision: number };
type Operation = {
  entry: Entry;
  requestId: string;
  operation: 'archive' | 'unarchive';
  discardWorkflowDraft?: boolean;
};
type Failure = { id: string; title: string; message: string };
type Options = {
  workspace: Workspace | null;
  action: Action;
  hasDraft: (id: string, discardWorkflowDraft?: boolean) => boolean;
  updated: () => Promise<void>;
  removed?: (ids: string[]) => void;
};
export type DesktopDeletionController = {
  busy: boolean;
  pendingCount: number;
  notice: string;
  failures: Failure[];
  undoCount: number;
  autoDismiss: boolean;
  remove: (ids: string[], options?: { discardWorkflowDraftIds?: string[] }) => Promise<string[]>;
  restore: (objects: Entry[]) => Promise<string[]>;
  undo: () => Promise<string[]>;
  retry: () => Promise<string[]>;
  dismiss: () => void;
};

export function TrashIcon({ size = 16 }: { size?: number }) {
  useUiLocale();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </svg>
  );
}

// Reuse soft deletion: original bytes, layout, groups and revision history remain recoverable.
export function useDesktopDeletion(options: Options): DesktopDeletionController {
  const current = useRef(options);
  current.current = options;
  const alive = useRef(true),
    working = useRef(false),
    pending = useRef<Operation[]>([]),
    undoItems = useRef<Entry[]>([]);
  const [busy, setBusy] = useState(false),
    [pendingCount, setPendingCount] = useState(0),
    [undoCount, setUndoCount] = useState(0);
  const [notice, setNotice] = useState(''),
    [failures, setFailures] = useState<Failure[]>([]);
  const [autoDismiss, setAutoDismiss] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    pending.current = [];
    undoItems.current = [];
    setPendingCount(0);
    setUndoCount(0);
    setNotice('');
    setFailures([]);
    setAutoDismiss(false);
  }, [options.workspace?.id]);
  const run = useCallback(async (operations: Operation[]) => {
    if (working.current || !operations.length || !current.current.workspace) return [];
    const workspaceId = current.current.workspace.id,
      scope = current.current,
      success: Entry[] = [],
      failed: Failure[] = [],
      unknown: Operation[] = [];
    const valid = () => alive.current && current.current.workspace?.id === workspaceId;
    working.current = true;
    setBusy(true);
    setNotice('');
    setFailures([]);
    setAutoDismiss(false);
    let refreshed = true;
    try {
      for (const request of operations) {
        if (!valid()) break;
        const { entry, operation } = request;
        try {
          if (operation === 'archive') {
            if (current.current.hasDraft(entry.id, request.discardWorkflowDraft))
              throw new PanelActionError(
                'DRAFT_ACTIVE',
                uiText('有未保存或待确认的修改，请先保存或处理草稿再删除。'),
              );
            // A native editor can have a recoverable draft even while its detail view is closed.
            try {
              for (const kind of nativeDraftKinds) {
                const key = nativeDraftKey(entry.id, kind);
                flushDraftStorage(key);
                if (localStorage.getItem(key))
                  throw new PanelActionError(
                    'DRAFT_ACTIVE',
                    uiText('有未保存的原生文件草稿，请展开材料处理后再删除。'),
                  );
              }
            } catch (error) {
              if (error instanceof PanelActionError) throw error;
              throw new PanelActionError(
                'DRAFT_STATUS_UNAVAILABLE',
                uiText('暂时无法读取本地草稿状态，未删除材料。请重新打开工作桌面后再试。'),
              );
            }
          }
          const result: DesktopObject = await scope.action('object_manage', {
            requestId: request.requestId,
            objectId: entry.id,
            expectedRevision: entry.revision,
            operation,
          });
          if (!valid()) break;
          if (operation === 'archive' && request.discardWorkflowDraft) {
            try {
              writeDraftNow(workflowDraftKey(entry.id), null);
            } catch {}
          }
          const saved = { id: result.id, title: result.title, revision: result.revision };
          success.push(saved);
          if (operation === 'archive')
            undoItems.current = [
              ...undoItems.current.filter((item) => item.id !== saved.id),
              saved,
            ];
          else undoItems.current = undoItems.current.filter((item) => item.id !== saved.id);
        } catch (error) {
          if (!valid()) break;
          if (!(error instanceof PanelActionError)) unknown.push(request);
          failed.push({
            id: entry.id,
            title: entry.title,
            message:
              error instanceof PanelActionError
                ? error.message
                : uiText('尚未确认操作结果，请重试同一次操作。'),
          });
        }
      }
      if (!valid()) return [];
      pending.current = unknown;
      setPendingCount(unknown.length);
      setUndoCount(undoItems.current.length);
      setFailures(failed);
      const removed = success
        .filter((item) =>
          operations.some(
            (request) => request.entry.id === item.id && request.operation === 'archive',
          ),
        )
        .map((item) => item.id);
      if (removed.length) {
        try {
          scope.removed?.(removed);
        } catch {
          refreshed = false;
        }
      }
      if (success.length) {
        try {
          await scope.updated();
        } catch {
          refreshed = false;
        }
      }
      if (!valid()) return success.map((item) => item.id);
      const archive = operations[0]?.operation === 'archive';
      setAutoDismiss(success.length > 0 && !failed.length && refreshed);
      setNotice(
        success.length
          ? uiText('{0} {1} 份材料{2}{3}。{4}', {
              '0': archive ? uiText('已删除') : uiText('已恢复'),
              '1': success.length,
              '2': archive ? uiText('，可在回收站恢复') : uiText('到原来的桌面位置'),
              '3': failed.length ? uiText('；{0} 份未完成', { '0': failed.length }) : '',
              '4': refreshed ? '' : uiText('列表暂未刷新，请刷新桌面。'),
            })
          : failed.length
            ? uiText('有 {0} 份材料未完成{1}。', {
                '0': failed.length,
                '1': archive ? uiText('删除') : uiText('恢复'),
              })
            : '',
      );
      return success.map((item) => item.id);
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  const remove = useCallback(
    (ids: string[], options?: { discardWorkflowDraftIds?: string[] }) => {
      if (pending.current.length) return Promise.resolve([]);
      const objects = current.current.workspace?.objects ?? [];
      return run(
        [...new Set(ids)].flatMap((id) => {
          const object = objects.find((item) => item.id === id);
          return object
            ? [
                {
                  entry: { id, title: object.title, revision: object.revision },
                  operation: 'archive' as const,
                  requestId: crypto.randomUUID(),
                  discardWorkflowDraft: options?.discardWorkflowDraftIds?.includes(id),
                },
              ]
            : [];
        }),
      );
    },
    [run],
  );
  const restore = useCallback(
    (objects: Entry[]) =>
      pending.current.length
        ? Promise.resolve([])
        : run(
            [...new Map(objects.map((object) => [object.id, object])).values()].map((entry) => ({
              entry,
              operation: 'unarchive' as const,
              requestId: crypto.randomUUID(),
            })),
          ),
    [run],
  );
  const undo = useCallback(() => restore(undoItems.current), [restore]);
  const retry = useCallback(() => run(pending.current), [run]);
  const dismiss = useCallback(() => {
    if (!pending.current.length && !working.current) {
      setNotice('');
      setFailures([]);
    }
  }, []);
  return {
    busy,
    pendingCount,
    notice,
    failures,
    undoCount,
    autoDismiss,
    remove,
    restore,
    undo,
    retry,
    dismiss,
  };
}

export function DeletionFeedback({
  deletion,
  openTrash,
}: {
  deletion: DesktopDeletionController;
  openTrash: () => void;
}) {
  useUiLocale();
  const feedback = useRef<HTMLElement>(null);
  useEffect(() => {
    if (
      !deletion.notice ||
      !deletion.autoDismiss ||
      deletion.busy ||
      deletion.pendingCount ||
      deletion.failures.length
    )
      return;
    let timer: ReturnType<typeof setTimeout>;
    const dismissWhenIdle = () => {
      const node = feedback.current;
      if (document.hidden || node?.matches(':hover') || node?.contains(document.activeElement)) {
        timer = setTimeout(dismissWhenIdle, 6000);
        return;
      }
      deletion.dismiss();
    };
    timer = setTimeout(dismissWhenIdle, 6000);
    return () => clearTimeout(timer);
  }, [
    deletion.notice,
    deletion.autoDismiss,
    deletion.busy,
    deletion.pendingCount,
    deletion.failures.length,
    deletion.dismiss,
  ]);
  if (!deletion.notice && !deletion.failures.length && !deletion.busy) return null;
  return (
    <aside
      ref={feedback}
      className="desktop-delete-feedback"
      aria-live="polite"
      aria-label={uiText('删除与恢复状态')}
    >
      <div className="desktop-delete-feedback-main">
        <TrashIcon />
        <span>{deletion.busy ? uiText('正在更新材料…') : deletion.notice}</span>
        {!!deletion.undoCount && (
          <button
            disabled={deletion.busy || !!deletion.pendingCount}
            onClick={() => void deletion.undo()}
          >
            {uiText('撤销删除')}
          </button>
        )}
        {!!deletion.pendingCount && (
          <button disabled={deletion.busy} onClick={() => void deletion.retry()}>
            {uiText('重试')}
            {deletion.pendingCount} {uiText('项')}
          </button>
        )}
        <button disabled={deletion.busy} onClick={openTrash}>
          {uiText('回收站')}
        </button>
        <button
          className="delete-feedback-close"
          aria-label={uiText('关闭删除提示')}
          disabled={deletion.busy || !!deletion.pendingCount}
          onClick={deletion.dismiss}
        >
          ×
        </button>
      </div>
      {!!deletion.failures.length && (
        <details>
          <summary>{uiText('查看未完成的材料')}</summary>
          <ul>
            {deletion.failures.map((failure) => (
              <li key={failure.id}>
                <strong>{failure.title}</strong>
                <span>{failure.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}

export function DeleteConfirmation({
  objects,
  draftIds,
  discardableIds,
  markCount = 0,
  busy,
  onCancel,
  onConfirm,
  onReview,
}: {
  objects: DesktopObject[];
  draftIds: string[];
  discardableIds: string[];
  markCount?: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onReview: (id: string) => void;
}) {
  useUiLocale();
  const blockingIds = draftIds.filter((id) => !discardableIds.includes(id)),
    blocked = blockingIds.length > 0;
  return (
    <div
      className="desktop-delete-confirm-backdrop"
      data-desktop-overlay
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        className="desktop-delete-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-delete-confirm-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape' && !busy) onCancel();
        }}
      >
        <div className="desktop-delete-confirm-icon">
          <TrashIcon size={21} />
        </div>
        <h2 id="desktop-delete-confirm-title">
          {uiText('是否删除')}
          {objects.length === 1
            ? uiText('这份材料')
            : uiText('这 {0} 份材料', { '0': objects.length })}
          ？
        </h2>
        <p>{uiText('确认后移入回收站，仍可恢复内容、历史与桌面位置。')}</p>
        {markCount > 0 && (
          <p>
            {uiText('同时删除选区内的')}
            {markCount} {uiText('个画布图形；图形可用画布撤销恢复。')}
          </p>
        )}
        <ul className="desktop-delete-confirm-items">
          {objects.map((object) => (
            <li key={object.id}>
              <FileBadge
                kind={object.kind}
                fileName={
                  object.kind === 'file'
                    ? (object.content as { fileName: string }).fileName
                    : undefined
                }
              />
              <span>{object.title}</span>
              {draftIds.includes(object.id) && <small>{uiText('有未保存修改')}</small>}
            </li>
          ))}
        </ul>
        {!!draftIds.length && (
          <div className="desktop-delete-confirm-warning" role="status">
            <strong>
              {draftIds.length} {uiText('份材料还有未保存的修改')}
            </strong>
            <span>
              {blocked
                ? uiText('待确认的操作或其他草稿需要先处理，暂时不能删除。')
                : uiText('确认删除会放弃这些流程草稿；已保存的内容和历史仍可从回收站恢复。')}
            </span>
            {blocked && (
              <button onClick={() => onReview(blockingIds[0])}>{uiText('打开材料处理')}</button>
            )}
          </div>
        )}
        <footer>
          <button autoFocus disabled={busy} onClick={onCancel}>
            {uiText('取消')}
          </button>
          <button
            className="desktop-delete-confirm-primary"
            disabled={blocked || busy}
            onClick={onConfirm}
          >
            {busy
              ? uiText('正在删除…')
              : discardableIds.length
                ? uiText('放弃草稿并删除')
                : uiText('移到回收站')}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function DesktopTrash({
  workspace,
  action,
  deletion,
  close,
}: {
  workspace: Workspace;
  action: Action;
  deletion: DesktopDeletionController;
  close: () => void;
}) {
  useUiLocale();
  const [items, setItems] = useState<DesktopObject[]>([]),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const actions = useRef(action);
  actions.current = action;
  const [refresh, setRefresh] = useState(0),
    dataRevision = useWorkspaceRefresh(workspace.id, 'trash');
  const loaded = useRef(false);
  useEffect(() => {
    let live = true;
    if (!loaded.current) setLoading(true);
    setError('');
    void actions
      .current('archived_objects')
      .then((value: DesktopObject[]) => {
        if (live) {
          loaded.current = true;
          setItems((previous) => retainEqual(previous, value));
          setSelected((ids) => {
            const next = ids.filter((id) => value.some((item) => item.id === id));
            return next.length === ids.length ? ids : next;
          });
        }
      })
      .catch((error) => {
        if (live) setError(String(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspace.id, dataRevision, refresh]);
  const filtered = items.filter((item) =>
    item.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selectedItems = items.filter((item) => selected.includes(item.id));
  const [clearing, setClearing] = useState(false),
    [clearPending, setClearPending] = useState(false);
  const clearRequest = useRef<{
      requestId: string;
      items: { id: string; revision: number }[];
    } | null>(null),
    clearingRef = useRef(false);
  const disabled = deletion.busy || !!deletion.pendingCount || loading || clearing || clearPending;
  async function clear(objects: DesktopObject[]) {
    if (
      clearingRef.current ||
      deletion.busy ||
      loading ||
      (!clearRequest.current && !objects.length)
    )
      return;
    const request = clearRequest.current ?? {
      requestId: crypto.randomUUID(),
      items: objects.map((object) => ({ id: object.id, revision: object.revision })),
    };
    clearRequest.current = request;
    clearingRef.current = true;
    setClearing(true);
    setClearPending(true);
    setError('');
    try {
      const result = await actions.current('trash_clear', request),
        ids: string[] = result.deletedIds;
      setItems((old) => old.filter((item) => !ids.includes(item.id)));
      setSelected((old) => old.filter((id) => !ids.includes(id)));
      clearRequest.current = null;
      setClearPending(false);
      deletion.dismiss();
      setRefresh((value) => value + 1);
    } catch (error) {
      if (
        error instanceof PanelActionError &&
        !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code)
      ) {
        clearRequest.current = null;
        setClearPending(false);
      }
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
  }
  async function restore(objects: DesktopObject[]) {
    const restored = await deletion.restore(objects);
    if (restored.length) {
      setItems((old) => old.filter((item) => !restored.includes(item.id)));
      setSelected((old) => old.filter((id) => !restored.includes(id)));
    }
  }
  return (
    <section className="desktop-trash" role="region" aria-label={uiText('回收站')}>
      <header>
        <div className="desktop-trash-emblem">
          <TrashIcon size={24} />
        </div>
        <div>
          <h2>{uiText('回收站')}</h2>
          <p>{uiText('删除的材料保留内容、历史和桌面位置，可随时恢复。')}</p>
        </div>
        <button aria-label={uiText('关闭回收站')} onClick={close}>
          {uiText('关闭')}
        </button>
      </header>
      <div className="desktop-trash-toolbar">
        <label>
          <span className="sr-only">{uiText('搜索已删除材料')}</span>
          <input
            type="search"
            placeholder={uiText('搜索已删除的材料')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span>
          {items.length} {uiText('份材料')}
        </span>
        <button
          disabled={disabled || !filtered.length}
          onClick={() =>
            setSelected(
              filtered.every((item) => selected.includes(item.id))
                ? selected.filter((id) => !filtered.some((item) => item.id === id))
                : [...new Set([...selected, ...filtered.map((item) => item.id)])],
            )
          }
        >
          {filtered.length > 0 && filtered.every((item) => selected.includes(item.id))
            ? uiText('取消全选')
            : uiText('全选搜索结果')}
        </button>
        <button
          className="primary"
          disabled={disabled || !selectedItems.length}
          onClick={() => void restore(selectedItems)}
        >
          {uiText('恢复所选')}
          {selectedItems.length ? ` (${selectedItems.length})` : ''}
        </button>
        <button
          disabled={disabled || !selectedItems.length}
          title={uiText('从回收站永久移除所选材料')}
          onClick={() => void clear(selectedItems)}
        >
          {uiText('删除所选')}
        </button>
        <button
          disabled={
            clearing ||
            loading ||
            deletion.busy ||
            !!deletion.pendingCount ||
            (!items.length && !clearPending)
          }
          title={uiText('清空当前桌面的全部回收站材料，不受搜索条件影响')}
          onClick={() => void clear(items)}
        >
          {clearing ? uiText('正在删除…') : clearPending ? uiText('重试删除') : uiText('全部删除')}
        </button>
        <button
          disabled={disabled}
          onClick={() => {
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
        >
          {uiText('刷新')}
        </button>
      </div>
      {error && (
        <div className="desktop-trash-error" role="alert">
          {error}
        </div>
      )}
      <div className="desktop-trash-list">
        {loading && !items.length ? (
          <p className="desktop-trash-empty">{uiText('正在读取回收站…')}</p>
        ) : !filtered.length ? (
          <div className="desktop-trash-empty">
            <TrashIcon size={38} />
            <h3>{query ? uiText('没有找到匹配的材料') : uiText('回收站是空的')}</h3>
            <p>
              {query
                ? uiText('试试其他名称。')
                : uiText('从卡片或选区点击删除，材料会先移到这里。')}
            </p>
          </div>
        ) : (
          filtered.map((object) => (
            <article key={object.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={uiText('选择 {0}', { '0': object.title })}
                  checked={selected.includes(object.id)}
                  disabled={disabled}
                  onChange={(event) =>
                    setSelected((ids) =>
                      event.target.checked
                        ? [...ids, object.id]
                        : ids.filter((id) => id !== object.id),
                    )
                  }
                />
                <FileBadge
                  kind={object.kind}
                  fileName={
                    object.kind === 'file'
                      ? (object.content as { fileName: string }).fileName
                      : undefined
                  }
                />
                <span>
                  <strong>{object.title}</strong>
                  <small>
                    {kindLabels[object.kind]} · v{object.revision} {uiText('· 原内容与历史已保留')}
                  </small>
                </span>
              </label>
              <button disabled={disabled} onClick={() => void restore([object])}>
                {uiText('恢复')}
              </button>
            </article>
          ))
        )}
      </div>
      <footer>
        <span>{uiText('全部删除后不能从回收站恢复；磁盘来源文件与已有备份保持原样。')}</span>
      </footer>
    </section>
  );
}
