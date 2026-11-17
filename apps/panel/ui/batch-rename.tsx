import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from './ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopObject } from '../../../packages/contracts/index.js';
import {
  DesktopDisplayName,
  ObjectRenameBatch,
  type ObjectRenameBatchInput,
} from '../../../packages/contracts/object-names.js';
import { PanelActionError } from '../host.js';
import { Icon } from './icons.js';
import './batch-rename.css';

export type BatchRenameDialogProps = {
  objects: DesktopObject[];
  workspaceId: string;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  close: () => void;
  updated: () => Promise<void>;
  renamed?: (ids: string[]) => void;
};
type Original = { id: string; title: string; revision: number };
type RenameForm = {
  mode: 'affix' | 'replace' | 'number';
  exact: string;
  prefix: string;
  suffix: string;
  find: string;
  replacement: string;
  common: string;
  start: string;
  padding: string;
  extension: boolean;
};
type Pending = { payload: ObjectRenameBatchInput; form: RenameForm };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const originals = (objects: DesktopObject[]): Original[] =>
  objects.map(({ id, title, revision }) => ({ id, title, revision }));
const initialForm = (title = ''): RenameForm => ({
  mode: 'affix',
  exact: title,
  prefix: '',
  suffix: '',
  find: '',
  replacement: '',
  common: uiText('材料'),
  start: '1',
  padding: '2',
  extension: true,
});
function readPending(key: string): { pending?: Pending; error?: string } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const value = JSON.parse(raw),
      parsed = ObjectRenameBatch.safeParse(value?.payload);
    if (!parsed.success)
      throw new Error(uiText('上次改名请求无法读取，请保留此浏览器的本地数据后再处理。'));
    const form = initialForm(parsed.data.items[0].title);
    return {
      pending: {
        payload: parsed.data,
        form: { ...form, ...(value.form && typeof value.form === 'object' ? value.form : {}) },
      },
    };
  } catch (error) {
    return { error: message(error) };
  }
}
function extensionParts(title: string, preserve: boolean) {
  const match = preserve ? title.match(/^(.*)(\.[A-Za-z0-9]{1,12})$/) : null;
  return match && match[1]
    ? { stem: match[1], extension: match[2] }
    : { stem: title, extension: '' };
}
function nextName(object: Original, index: number, form: RenameForm, single: boolean) {
  if (single) return form.exact.trim();
  const { stem, extension } = extensionParts(object.title, form.extension);
  if (form.mode === 'number')
    return `${form.prefix}${form.common}${String(Number(form.start) + index).padStart(Math.min(8, Math.max(1, Number(form.padding) || 1)), '0')}${form.suffix}${extension}`.trim();
  if (form.mode === 'replace')
    return `${form.find ? stem.split(form.find).join(form.replacement) : stem}${extension}`.trim();
  return `${form.prefix}${stem}${form.suffix}${extension}`.trim();
}
const knownRejection = (error: unknown) =>
  error instanceof PanelActionError &&
  !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code);

export function BatchRenameDialog(props: BatchRenameDialogProps) {
  useUiLocale();
  return createPortal(<RenameBody key={props.workspaceId} {...props} />, document.body);
}
function RenameBody(props: BatchRenameDialogProps) {
  useUiLocale();
  const key = `ai-desktop:rename-pending:${props.workspaceId}`,
    saved = useMemo(() => readPending(key), [key, getUiLocale()]);
  const [pending, setPending] = useState<Pending | undefined>(saved.pending),
    [snapshot, setSnapshot] = useState<Original[]>(() =>
      saved.pending
        ? saved.pending.payload.items.map((item) => ({
            id: item.objectId,
            title: item.expectedTitle,
            revision: item.expectedRevision,
          }))
        : originals(props.objects),
    );
  const [form, setForm] = useState<RenameForm>(
      () => saved.pending?.form ?? initialForm(props.objects[0]?.title),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(saved.error ?? ''),
    [conflict, setConflict] = useState(false),
    [complete, setComplete] = useState(false),
    [refreshEpoch, setRefreshEpoch] = useState(0);
  const [storageBlocked, setStorageBlocked] = useState(!!saved.error),
    modal = useRef<HTMLDialogElement>(null),
    dialog = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    working = useRef(false),
    refreshRequested = useRef(false),
    callbacks = useRef(props);
  callbacks.current = props;
  const single = snapshot.length === 1,
    locked = busy || !!pending || storageBlocked || complete;
  const rows = snapshot.map((object, index) => {
    const title =
        pending?.payload.items.find((item) => item.objectId === object.id)?.title ??
        nextName(object, index, form, single),
      parsed = DesktopDisplayName.safeParse(title);
    return {
      object,
      title,
      error: parsed.success ? '' : (parsed.error.issues[0]?.message ?? uiText('名称无效')),
      changed: title !== object.title,
    };
  });
  const changed = rows.filter((row) => row.changed),
    invalid = rows.some((row) => row.error),
    overLimit = snapshot.length > 200;
  const invalidNumber =
    !single &&
    form.mode === 'number' &&
    (!/^\d+$/.test(form.start) ||
      !Number.isSafeInteger(Number(form.start)) ||
      Number(form.start) > 999999999 ||
      !/^\d+$/.test(form.padding) ||
      Number(form.padding) < 1 ||
      Number(form.padding) > 8 ||
      !form.common.trim());
  const duplicates = rows.length - new Set(rows.map((row) => row.title)).size;
  const stale =
    !pending &&
    !complete &&
    snapshot.some((object) => {
      const current = props.objects.find((item) => item.id === object.id);
      return (
        !current ||
        current.archived ||
        current.title !== object.title ||
        current.revision !== object.revision
      );
    });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      node = modal.current;
    node?.showModal();
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      if (single) {
        const title = input.current?.value ?? '',
          parts = extensionParts(title, true);
        input.current?.setSelectionRange(0, parts.stem.length);
      } else dialog.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      node?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!refreshRequested.current) return;
    refreshRequested.current = false;
    const current = callbacks.current.objects;
    setSnapshot((before) =>
      before.map((object) => {
        const match = current.find((item) => item.id === object.id);
        return match && !match.archived
          ? { id: match.id, title: match.title, revision: match.revision }
          : object;
      }),
    );
    setConflict(false);
  }, [refreshEpoch, props.objects]);
  function edit(patch: Partial<RenameForm>) {
    if (!locked) {
      setForm((value) => ({ ...value, ...patch }));
      setError('');
    }
  }
  function close() {
    if (!working.current) props.close();
  }
  async function refreshNames() {
    if (locked) return;
    setBusy(true);
    working.current = true;
    setError('');
    try {
      await callbacks.current.updated();
      refreshRequested.current = true;
      setRefreshEpoch((value) => value + 1);
    } catch (error) {
      setError(message(error));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function submit(retry = false) {
    if (working.current || storageBlocked || complete) return;
    if (
      !retry &&
      (pending || invalid || invalidNumber || overLimit || !changed.length || stale || conflict)
    )
      return;
    const request = retry
      ? pending
      : {
          payload: {
            requestId: crypto.randomUUID(),
            items: changed.map(({ object, title }) => ({
              objectId: object.id,
              expectedRevision: object.revision,
              expectedTitle: object.title,
              title,
            })),
          },
          form,
        };
    if (!request) return;
    // Persist the exact idempotency key before dispatch, so a transport failure never creates a new rename.
    try {
      localStorage.setItem(key, JSON.stringify(request));
    } catch (error) {
      setError(uiText('无法保存待确认请求，本次尚未发送：{0}', { '0': message(error) }));
      return;
    }
    setPending(request);
    working.current = true;
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      await callbacks.current.action('object_rename_batch', request.payload);
    } catch (problem) {
      if (knownRejection(problem)) {
        try {
          localStorage.removeItem(key);
          setPending(undefined);
        } catch (error) {
          setStorageBlocked(true);
          setError(uiText('请求已拒绝，但无法移除本地请求记录：{0}', { '0': message(error) }));
          working.current = false;
          setBusy(false);
          return;
        }
        setConflict(
          problem instanceof PanelActionError &&
            ['REVISION_CONFLICT', 'OBJECT_ARCHIVED', 'NOT_FOUND'].includes(problem.code),
        );
      }
      setError(message(problem));
      working.current = false;
      setBusy(false);
      return;
    }
    setComplete(true);
    setPending(undefined);
    let cleared = true;
    try {
      localStorage.removeItem(key);
    } catch (error) {
      cleared = false;
      setError(
        uiText('名称已更新；本地请求记录清理失败，再次打开后确认同一请求即可。{0}', {
          '0': message(error),
        }),
      );
    }
    try {
      callbacks.current.renamed?.(request.payload.items.map((item) => item.objectId));
      await callbacks.current.updated();
      if (cleared) callbacks.current.close();
    } catch (problem) {
      setError(uiText('名称已更新，桌面刷新暂未完成：{0}', { '0': message(problem) }));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function keyDown(event: React.KeyboardEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit(!!pending);
    }
    if (event.key !== 'Tab') return;
    const nodes = [
      ...dialog.current!.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
      ),
    ].filter((node) => node.offsetParent !== null);
    if (!nodes.length) {
      event.preventDefault();
      return;
    }
    const first = nodes[0],
      last = nodes[nodes.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialog.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return (
    <dialog
      ref={modal}
      className="rename-overlay"
      data-desktop-overlay="rename"
      aria-labelledby="rename-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={keyDown}
    >
      <div className="rename-dialog" ref={dialog} tabIndex={-1}>
        <header>
          <span className="rename-symbol">
            <Icon name="pen" size={20} />
          </span>
          <div>
            <h2 id="rename-title">{single ? uiText('重命名') : uiText('批量重命名')}</h2>
            <p>
              {snapshot.length} {uiText('个桌面对象 · 预览后一起保存')}
            </p>
          </div>
          <button
            aria-label={uiText('关闭重命名')}
            className="rename-close"
            disabled={busy}
            onClick={close}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="rename-body">
          <p className="rename-scope">
            {uiText('修改桌面显示名称，原文件名、文件内容和布局保持不变。')}
          </p>
          {single ? (
            <label className="rename-field">
              {uiText('桌面名称')}
              <input
                ref={input}
                autoComplete="off"
                maxLength={180}
                disabled={locked}
                value={form.exact}
                onChange={(event) => edit({ exact: event.target.value })}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </label>
          ) : (
            <>
              <div className="rename-tabs" role="tablist" aria-label={uiText('改名方式')}>
                {(
                  [
                    ['affix', uiText('添加前后缀')],
                    ['replace', uiText('查找替换')],
                    ['number', uiText('统一名称与编号')],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    role="tab"
                    aria-selected={form.mode === mode}
                    disabled={locked}
                    onClick={() => edit({ mode })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {form.mode === 'replace' ? (
                <div className="rename-grid">
                  <label className="rename-field">
                    {uiText('查找文字')}
                    <input
                      disabled={locked}
                      value={form.find}
                      onChange={(event) => edit({ find: event.target.value })}
                      placeholder={uiText('要替换的文字（非正则）')}
                    />
                  </label>
                  <label className="rename-field">
                    {uiText('替换为')}
                    <input
                      disabled={locked}
                      value={form.replacement}
                      onChange={(event) => edit({ replacement: event.target.value })}
                      placeholder={uiText('留空则移除匹配文字')}
                    />
                  </label>
                </div>
              ) : (
                <>
                  {form.mode === 'number' && (
                    <div className="rename-number-grid">
                      <label className="rename-field">
                        {uiText('统一名称')}
                        <input
                          disabled={locked}
                          value={form.common}
                          onChange={(event) => edit({ common: event.target.value })}
                        />
                      </label>
                      <label className="rename-field">
                        {uiText('起始编号')}
                        <input
                          type="number"
                          min="0"
                          max="999999999"
                          disabled={locked}
                          value={form.start}
                          onChange={(event) => edit({ start: event.target.value })}
                        />
                      </label>
                      <label className="rename-field">
                        {uiText('编号位数')}
                        <select
                          disabled={locked}
                          value={form.padding}
                          onChange={(event) => edit({ padding: event.target.value })}
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8].map((size) => (
                            <option key={size} value={size}>
                              {size}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  <div className="rename-grid">
                    <label className="rename-field">
                      {uiText('前缀')}
                      <input
                        disabled={locked}
                        value={form.prefix}
                        onChange={(event) => edit({ prefix: event.target.value })}
                        placeholder={uiText('例如：项目A_')}
                      />
                    </label>
                    <label className="rename-field">
                      {uiText('后缀')}
                      <input
                        disabled={locked}
                        value={form.suffix}
                        onChange={(event) => edit({ suffix: event.target.value })}
                        placeholder={uiText('例如：_定稿')}
                      />
                    </label>
                  </div>
                </>
              )}
              <label className="rename-check">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={form.extension}
                  onChange={(event) => edit({ extension: event.target.checked })}
                />
                {uiText('保留名称末尾的扩展名')}
                <span>{uiText('例如 .xlsx、.md')}</span>
              </label>
            </>
          )}
          <div className="rename-preview">
            <div className="rename-preview-heading">
              <strong>{uiText('名称预览')}</strong>
              <span>
                {changed.length} {uiText('项将更改')}
              </span>
            </div>
            <div className="rename-preview-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{uiText('现在')}</th>
                    <th scope="col">{uiText('改为')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.object.id} data-changed={row.changed} data-invalid={!!row.error}>
                      <td title={row.object.title}>{row.object.title}</td>
                      <td>
                        <span>{row.title || uiText('（空名称）')}</span>
                        {row.error && <small>{row.error}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {duplicates > 0 && (
            <p className="rename-notice">
              {uiText('预览中有')}
              {duplicates} {uiText('个重名。桌面允许重名，请确认这些名称容易区分。')}
            </p>
          )}
          {invalidNumber && (
            <p className="rename-warning">
              {uiText('请填写统一名称、有效的起始编号和 1–8 位编号长度。')}
            </p>
          )}
          {overLimit && (
            <p className="rename-warning">
              {uiText('一次最多更改 200 个对象，请减少选区后再打开。')}
            </p>
          )}
          {(stale || conflict) && !pending && !complete && (
            <div className="rename-warning">
              <p>
                {uiText(
                  '部分对象的名称、版本或可用状态已变化。当前输入已保留，请刷新名称后重新查看预览；已删除的对象请关闭窗口后重新选择。',
                )}
              </p>
              <button disabled={locked} onClick={() => void refreshNames()}>
                {uiText('刷新当前名称')}
              </button>
            </div>
          )}
          {pending && (
            <div className="rename-warning" role="status">
              <strong>{busy ? uiText('正在保存名称…') : uiText('上次保存的结果尚未确认')}</strong>
              <p>
                {busy
                  ? uiText('这些名称会作为一批写入。')
                  : uiText(
                      '原请求已保留，编辑暂时锁定。点击“确认上次保存”会查询或重试同一请求，不会重复改名；关闭窗口也会保留这条记录。',
                    )}
              </p>
            </div>
          )}
          {error && (
            <p className="rename-error" role="alert">
              {error}
            </p>
          )}
          {complete && (
            <p className="rename-success" role="status">
              {uiText('名称已保存。')}
            </p>
          )}
        </div>
        <footer>
          <span>{uiText('Ctrl / ⌘ + Enter 保存')}</span>
          <button disabled={busy} onClick={close}>
            {complete ? uiText('完成') : pending ? uiText('保留后关闭') : uiText('取消')}
          </button>
          {!complete &&
            (pending ? (
              <button
                className="rename-primary"
                disabled={busy || storageBlocked}
                onClick={() => void submit(true)}
              >
                {uiText('确认上次保存')}
              </button>
            ) : (
              <button
                className="rename-primary"
                disabled={
                  busy ||
                  storageBlocked ||
                  invalid ||
                  invalidNumber ||
                  overLimit ||
                  !changed.length ||
                  stale ||
                  conflict
                }
                onClick={() => void submit()}
              >
                {uiText('保存')}
                {single ? uiText('名称') : uiText(' {0} 个名称', { '0': changed.length })}
              </button>
            ))}
        </footer>
      </div>
    </dialog>
  );
}
