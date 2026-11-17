import { subscribeUiLanguage as onUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import { PanelClosedError } from '../host.js';
import { fileRelativePath, fileOriginalPath, type DropPoint } from './file-drop.js';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { nativeFormat, NATIVE_FILE_LIMIT } from '../../../packages/components/native-files.js';
import { RelativeFilePath } from '../../../packages/contracts/index.js';

type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
type ImportKind = 'office' | 'image' | 'text' | 'code' | 'file';
type Entry = {
  id: string;
  file: File;
  path: string;
  fingerprint: string;
  kind: ImportKind;
  bounds: DesktopObject['bounds'];
  checked: boolean;
  status: 'ready' | 'blocked' | 'working' | 'failed' | 'done';
  reason?: string;
  objectId?: string;
  staged?: boolean;
};
type Request = { action: string; payload: Record<string, unknown> };
let labels: Record<ImportKind, string> = {
  office: uiText('Office 文档'),
  image: uiText('图片'),
  text: uiText('文本 / CSV'),
  code: uiText('代码'),
  file: uiText('其他文件'),
};
const MAX_FILES = 500,
  MAX_BYTES = 256 * 1024 * 1024;
const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ImportMaterialsHandle = {
  busy: () => boolean;
  drop: (files: File[], point: DropPoint, warning: string, directories?: string[]) => void;
};
type Props = {
  open: boolean;
  workspace: Workspace;
  action: Action;
  prepare: () => Promise<void>;
  updated: () => Promise<void>;
  close: () => void;
  locate: (ids: string[]) => void;
  imported: (count: number, folders: number) => void;
  importedObjects?: (ids: string[]) => void;
};
export const ImportMaterials = forwardRef<ImportMaterialsHandle, Props>(function ImportMaterials(
  { open, workspace, action, prepare, updated, close, locate, imported, importedObjects },
  ref,
) {
  useUiLocale();
  const [entries, setEntries] = useState<Entry[]>([]),
    [query, setQuery] = useState(''),
    [kind, setKind] = useState('all');
  const [running, setRunning] = useState(false),
    [pausing, setPausing] = useState(false);
  const [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [csv, setCsv] = useState('');
  const [dropWarning, setDropWarning] = useState('');
  const [restoring, setRestoring] = useState(true);
  const staging = useRef(new Map<string, Promise<void>>());
  const [folderPaths, setFolderPaths] = useState<string[]>([]),
    [foldersDone, setFoldersDone] = useState(false);
  const folderJob = useRef<{ requestId: string; paths: string[] } | null>(null);
  const filesInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null);
  const current = useRef(entries),
    mounted = useRef(true),
    active = useRef(false),
    stop = useRef(false);
  const requests = useRef(new Map<string, Request>()),
    nextSlot = useRef(workspace.objects.length),
    pasteNumber = useRef(1);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
    };
  }, []);
  useEffect(() => {
    void action('import_queue', { operation: 'list' })
      .then((result) => {
        if (!mounted.current) return;
        const recovered: Entry[] = result.items.map((item: any) => ({
          id: item.requestId,
          file: new File([new Uint8Array(item.size)], item.fileName, {
            lastModified: item.lastModified,
          }),
          path: item.relativePath,
          fingerprint: JSON.stringify([
            item.originalPath || item.relativePath,
            item.size,
            item.lastModified,
          ]),
          kind: /\.(xlsx|docx|pptx)$/i.test(item.fileName) ? 'office' : 'file',
          bounds: item.bounds,
          checked: !item.objectId,
          status: item.objectId ? 'done' : 'ready',
          objectId: item.objectId,
          staged: true,
        }));
        replace([
          ...current.current,
          ...recovered.filter((e) => !current.current.some((n) => n.id === e.id)),
        ]);
        if (result.folders) {
          folderJob.current = result.folders;
          setFolderPaths(result.folders.paths);
        }
        if (recovered.length)
          setNotice(uiText('已恢复本地导入队列；点击继续导入，沿用原请求避免重复创建。'));
      })
      .catch((e) => setError(uiText('导入队列暂未恢复：{0}', { '0': errorText(e) })))
      .finally(() => {
        if (mounted.current) setRestoring(false);
      });
  }, [workspace.id]);
  useImperativeHandle(ref, () => ({
    busy: () => active.current || restoring,
    drop: (files, point, warning, directories = []) => {
      if (active.current) return;
      setQuery('');
      setKind('all');
      const added = addFiles(files, point, directories);
      setDropWarning([warning, added.summary].filter(Boolean).join(' '));
      void run(
        added.ready,
        added.accepted === files.length && added.ready.length === files.length && !warning,
      );
    },
  }));
  function replace(next: Entry[]) {
    current.current = next;
    if (mounted.current) setEntries(next);
  }
  function change(id: string, patch: Partial<Entry>) {
    replace(current.current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }
  function addFiles(files: File[], point?: DropPoint, directories: string[] = []) {
    if (active.current || (!files.length && !directories.length))
      return { ready: [], accepted: 0, summary: '' };
    const paths = [
      ...new Set([
        ...directories,
        ...files.flatMap((file) => {
          const parts = fileRelativePath(file).split('/');
          parts.pop();
          return parts.length ? [parts.join('/')] : [];
        }),
      ]),
    ]
      .filter((path) => RelativeFilePath.safeParse(path).success)
      .slice(0, 1000);
    if (paths.length) {
      const pending = [...new Set([...(folderJob.current?.paths ?? []), ...paths])].slice(0, 1000);
      folderJob.current = { requestId: crypto.randomUUID(), paths: pending };
      setFolderPaths(pending);
      setFoldersDone(false);
      void action('import_queue', { operation: 'folders', job: folderJob.current }).catch((e) => {
        if (mounted.current) setError(uiText('目录队列暂存失败：{0}', { '0': errorText(e) }));
      });
    }
    const next = [...current.current];
    const ready: string[] = [];
    let accepted = 0;
    let duplicates = 0,
      overflow = 0;
    const known = new Set(next.map((entry) => entry.fingerprint));
    nextSlot.current = Math.max(nextSlot.current, workspace.objects.length);
    for (const file of files) {
      const path = fileRelativePath(file);
      const fingerprint = JSON.stringify([
        fileOriginalPath(file) || path,
        file.size,
        file.lastModified,
      ]);
      if (known.has(fingerprint)) {
        duplicates++;
        continue;
      }
      if (next.length >= MAX_FILES) {
        overflow++;
        continue;
      }
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const fileKind: ImportKind = ['xlsx', 'xlsm', 'xls', 'docx', 'doc', 'pptx', 'ppt'].includes(
        ext,
      )
        ? 'office'
        : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
          ? 'image'
          : ['txt', 'md', 'csv', 'tsv', 'log'].includes(ext)
            ? 'text'
            : [
                  'py',
                  'js',
                  'ts',
                  'json',
                  'html',
                  'css',
                  'c',
                  'cpp',
                  'h',
                  'cs',
                  'java',
                  'rs',
                  'go',
                ].includes(ext)
              ? 'code'
              : 'file';
      const limit = NATIVE_FILE_LIMIT;
      const reason =
        file.name.length > 120
          ? uiText('文件名超过 120 字符，请先在本地重命名。')
          : /[\\/:\u0000-\u001f]/.test(file.name)
            ? uiText('文件名不能包含路径字符。')
            : path.length > 1024 ||
                path.split('/').length > 32 ||
                path
                  .split('/')
                  .some(
                    (part) =>
                      !part ||
                      part === '.' ||
                      part === '..' ||
                      part.length > 120 ||
                      /[\\:\u0000-\u001f]/.test(part),
                  )
              ? uiText('相对路径过长或包含无效字符。')
              : file.size > limit
                ? uiText('超过此类型的单文件上限（{0}）。', { '0': sizeLabel(limit) })
                : undefined;
      const slot = nextSlot.current++,
        requestId = crypto.randomUUID(),
        offset = accepted++;
      if (!reason) ready.push(requestId);
      const clamp = (value: number) => Math.max(-100000, Math.min(100000, value));
      next.push({
        id: requestId,
        file,
        path,
        fingerprint,
        kind: fileKind,
        bounds: point
          ? {
              x: clamp(point.x + (offset % 3) * 390),
              y: clamp(point.y + Math.floor(offset / 3) * 350),
              width: 350,
              height: 300,
            }
          : {
              x: 60 + (slot % 3) * 390,
              y: 80 + (Math.floor(slot / 3) % 280) * 350,
              width: 350,
              height: 300,
            },
        checked: !reason,
        status: reason ? 'blocked' : 'ready',
        reason,
      });
      known.add(fingerprint);
    }
    replace(next);
    setError('');
    for (const id of ready) {
      const entry = next.find((e) => e.id === id)!;
      void persist(entry).catch((e) => {
        if (mounted.current)
          change(id, { reason: uiText('尚未暂存，关闭前请重试导入：{0}', { '0': errorText(e) }) });
      });
    }
    const summary = [
      duplicates
        ? uiText('已忽略 {0} 个路径、大小与修改时间相同的清单项。', { '0': duplicates })
        : '',
      overflow
        ? uiText('清单最多 {0} 项，另有 {1} 项未加入；可清除已完成项后继续选择。', {
            '0': MAX_FILES,
            '1': overflow,
          })
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    setNotice([summary, uiText('请勾选本次要放到桌面的材料。')].filter(Boolean).join(' '));
    return { ready, accepted, summary };
  }
  async function requestFor(entry: Entry): Promise<Request> {
    const previous = requests.current.get(entry.id);
    if (previous) return previous;
    if (!entry.staged) await persist(entry);
    const restored: Request = {
      action: 'native_workbench',
      payload: { operation: 'import_staged', id: entry.id },
    } as Request;
    requests.current.set(entry.id, restored);
    return restored;
  }
  async function persist(entry: Entry): Promise<void> {
    if (entry.staged) return;
    const existing = staging.current.get(entry.id);
    if (existing) return existing;
    const task = (async () => {
      const sourcePath = fileOriginalPath(entry.file);
      if (sourcePath)
        await browserCommand(
          'register-import-source',
          { path: sourcePath, requestId: entry.id, viewWorkspaceId: workspace.id },
          120000,
        );
      const begin = await action('native_workbench', {
        operation: 'upload',
        command: {
          operation: 'begin',
          id: entry.id,
          entry: {
            fileName: entry.file.name,
            relativePath: entry.path,
            lastModified: entry.file.lastModified,
            bounds: entry.bounds,
            size: entry.file.size,
          },
        },
      });
      for (
        let offset = 0, index = 0;
        offset < entry.file.size;
        offset += begin.chunkSize, index++
      ) {
        const bytes = new Uint8Array(
          await entry.file.slice(offset, offset + begin.chunkSize).arrayBuffer(),
        );
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await action('native_workbench', {
          operation: 'upload',
          command: { operation: 'chunk', id: entry.id, index, data: btoa(binary) },
        });
      }
      await action('native_workbench', {
        operation: 'upload',
        command: { operation: 'finish', id: entry.id },
      });
      entry.staged = true;
      if (mounted.current) change(entry.id, { staged: true, reason: undefined });
    })();
    staging.current.set(entry.id, task);
    try {
      await task;
    } finally {
      staging.current.delete(entry.id);
    }
  }
  async function forget(ids: string[]) {
    if (active.current || restoring) return;
    try {
      await Promise.all(ids.map((id) => staging.current.get(id)?.catch(() => {})));
      await action('import_queue', { operation: 'forget', ids });
      replace(current.current.filter((e) => !ids.includes(e.id)));
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function run(ids: string[], revealOnSuccess = false) {
    if (active.current || restoring || (!ids.length && !folderJob.current)) return;
    const work = current.current.filter(
      (entry) => ids.includes(entry.id) && ['ready', 'failed'].includes(entry.status),
    );
    if (!work.length && !folderJob.current) return;
    if (work.reduce((sum, entry) => sum + entry.file.size, 0) > MAX_BYTES) {
      setError(uiText('每次最多导入 256 MiB，请减少本次勾选数量，分批导入。'));
      return;
    }
    active.current = true;
    stop.current = false;
    setRunning(true);
    setPausing(false);
    setError('');
    setNotice('');
    let attempted = false;
    try {
      await prepare();
      const folders = folderJob.current;
      if (folders) {
        await action('import_queue', { operation: 'folders', job: folders });
        attempted = true;
        await action('folders_import', folders);
        if (!mounted.current) return;
        folderJob.current = null;
        setFoldersDone(true);
      }
      for (const entry of work) {
        if (stop.current || !mounted.current) break;
        change(entry.id, { status: 'working', reason: undefined });
        attempted = true;
        try {
          const request = await requestFor(entry);
          if (!mounted.current) break;
          const object: DesktopObject = await action(request.action, request.payload);
          if (!mounted.current) break;
          change(entry.id, { status: 'done', checked: false, objectId: object.id });
          requests.current.delete(entry.id);
        } catch (e) {
          if (!mounted.current || e instanceof PanelClosedError) break;
          change(entry.id, { status: 'failed', reason: errorText(e) });
        }
      }
      if (mounted.current) {
        let refreshed = !attempted;
        if (attempted) {
          try {
            await updated();
            refreshed = true;
          } catch (e) {
            if (mounted.current)
              setError(
                uiText('桌面暂未刷新：{0}。导入结果保留，可点击“刷新桌面”。', {
                  '0': errorText(e),
                }),
              );
          }
        }
        if (mounted.current)
          setNotice(
            stop.current
              ? uiText('已暂停；完成项保留，未完成项可继续。')
              : uiText('本轮导入结束；失败项可单独重试。'),
          );
        if (mounted.current && refreshed) {
          const ids = work.flatMap((entry) => {
            const item = current.current.find((item) => item.id === entry.id);
            return item?.status === 'done' && item.objectId ? [item.objectId] : [];
          });
          if (ids.length) importedObjects?.(ids);
        }
        if (
          mounted.current &&
          revealOnSuccess &&
          refreshed &&
          work.every(
            (entry) => current.current.find((item) => item.id === entry.id)?.status === 'done',
          )
        ) {
          imported(work.length, folders?.paths.length ?? 0);
          close();
        }
      }
    } catch (e) {
      if (mounted.current && !(e instanceof PanelClosedError)) setError(errorText(e));
    } finally {
      active.current = false;
      if (mounted.current) {
        setRunning(false);
        setPausing(false);
      }
    }
  }
  async function refresh() {
    try {
      await updated();
      if (mounted.current) setError('');
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    }
  }
  const pending = entries.filter((entry) => entry.status === 'ready' || entry.status === 'failed');
  const selected = pending.filter((entry) => entry.checked);
  const bytes = selected.reduce((sum, entry) => sum + entry.file.size, 0);
  const done = entries.filter((entry) => entry.status === 'done');
  const visible = entries.filter(
    (entry) =>
      (kind === 'all' || entry.kind === kind) &&
      entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const visiblePending = visible.filter(
    (entry) => entry.status === 'ready' || entry.status === 'failed',
  );
  if (!open) return null;
  return (
    <section
      className="material-import"
      role="dialog"
      aria-modal="true"
      aria-label={uiText('导入材料')}
    >
      <header>
        <div>
          <strong>{uiText('把材料放到小桌面')}</strong>
        </div>
        <button disabled={running} onClick={close}>
          {uiText('返回桌面')}
        </button>
      </header>
      <div className="import-body">
        <div className="import-pickers">
          <input
            ref={filesInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            {...{ webkitdirectory: '' }}
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <button
            className="primary"
            disabled={running || restoring}
            onClick={() => filesInput.current?.click()}
          >
            {uiText('＋ 选择文件')}
          </button>
          <button disabled={running || restoring} onClick={() => folderInput.current?.click()}>
            {uiText('选择文件夹')}
          </button>
          <small>{uiText('支持直接拖入多个文件或文件夹，保留子目录层级。')}</small>
        </div>
        <p className="import-limits">
          {uiText(
            '按原生文件保存，不转换 Office、CSV、图片或代码内容。单文件 ≤ 5 MiB，单批 ≤ 256 MiB，清单最多 500 项。',
          )}
        </p>
        {folderPaths.length > 0 && (
          <p className="import-notice">
            {foldersDone ? uiText('已保存') : uiText('待保存')} {folderPaths.length}{' '}
            {uiText('个目录路径，包含拖入的空文件夹。')}
            <small> {uiText('文件选择器只能提供包含文件的目录。')}</small>
          </p>
        )}
        {notice && (
          <p className="import-notice" role="status">
            {notice}
          </p>
        )}
        {dropWarning && (
          <p className="import-notice" role="status">
            {dropWarning}
          </p>
        )}
        {error && (
          <p className="import-error" role="alert">
            {error}
          </p>
        )}
        <div className="import-filters">
          <input
            aria-label={uiText('筛选文件路径')}
            placeholder={uiText('搜索文件名或文件夹…')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label={uiText('筛选导入类型')}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="all">{uiText('全部类型')}</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {entries.length > 0 && (
          <div className="import-list-actions">
            <button
              disabled={running || !visiblePending.length}
              onClick={() => {
                const ids = new Set(visiblePending.map((entry) => entry.id));
                replace(
                  current.current.map((entry) =>
                    ids.has(entry.id) ? { ...entry, checked: true } : entry,
                  ),
                );
              }}
            >
              {uiText('选择筛选结果')}
            </button>
            <button
              disabled={running || !selected.length}
              onClick={() =>
                replace(current.current.map((entry) => ({ ...entry, checked: false })))
              }
            >
              {uiText('清空勾选')}
            </button>
            <button
              disabled={running || !done.length}
              onClick={() => void forget(done.map((e) => e.id))}
            >
              {uiText('清除完成记录')}
            </button>
            <span>
              {visible.length} / {entries.length} {uiText('项')}
            </span>
          </div>
        )}
        <div className="import-file-list">
          {!visible.length && (
            <div className="import-empty">
              {entries.length
                ? uiText('没有匹配的文件。')
                : uiText('将文件拖到这里，或选择文件、文件夹。')}
            </div>
          )}
          {visible.map((entry) => (
            <article key={entry.id} className={`import-entry import-${entry.status}`}>
              <input
                type="checkbox"
                aria-label={uiText('导入 {0}', { '0': entry.path })}
                checked={entry.checked}
                disabled={running || entry.status === 'done' || entry.status === 'blocked'}
                onChange={(event) => change(entry.id, { checked: event.target.checked })}
              />
              <div>
                <strong title={entry.path}>{entry.file.name}</strong>
                <small>
                  {entry.path !== entry.file.name && `${entry.path} · `}
                  {nativeFormat(entry.file.name).label} · {sizeLabel(entry.file.size)}
                </small>
                {entry.reason && <p>{entry.reason}</p>}
              </div>
              <div className="import-entry-state">
                <span>
                  {
                    {
                      ready: uiText('待导入'),
                      blocked: uiText('暂不支持'),
                      working: uiText('导入中…'),
                      failed: uiText('未完成'),
                      done: uiText('已导入'),
                    }[entry.status]
                  }
                </span>
                {entry.status === 'failed' && (
                  <button disabled={running} onClick={() => void run([entry.id])}>
                    {uiText('重试此项')}
                  </button>
                )}
                {(entry.status === 'ready' ||
                  entry.status === 'blocked' ||
                  entry.status === 'failed') && (
                  <button
                    disabled={running}
                    aria-label={uiText('移出清单 {0}', { '0': entry.path })}
                    onClick={() => void forget([entry.id])}
                  >
                    {uiText('移出')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        <details className="import-csv">
          <summary>{uiText('粘贴为 CSV 原文件')}</summary>
          <label htmlFor="batch-csv">{uiText('按输入内容保存为 UTF-8 CSV 文件。')}</label>
          <textarea
            id="batch-csv"
            value={csv}
            disabled={running}
            onChange={(event) => setCsv(event.target.value)}
            maxLength={1000000}
            placeholder={uiText('项目,数量,说明\n示例,1,待确认')}
          />
          <button
            disabled={running || !csv.trim() || entries.length >= MAX_FILES}
            onClick={() => {
              addFiles([
                new File([csv], uiText('粘贴表格_{0}.csv', { '0': pasteNumber.current++ }), {
                  type: 'text/csv',
                }),
              ]);
              setCsv('');
            }}
          >
            {uiText('加入待导入清单')}
          </button>
        </details>
        <small className="import-footnote">
          {restoring
            ? uiText('正在恢复导入队列…')
            : uiText(
                '文件进入清单后暂存到本地；已暂存项目在关闭面板或切换工作区后可继续导入。失败项单独重试，原请求保持不变。原文件夹不会被移动或持续同步。暂存队列共 256 MiB，完成后可清除记录。',
              )}
        </small>
      </div>
      <footer>
        <div aria-live="polite">
          <strong>
            {uiText('已导入')}
            {done.length} {uiText('项')}
          </strong>
          <small>
            {uiText('勾选')}
            {selected.length} {uiText('项 ·')}
            {sizeLabel(bytes)}
          </small>
        </div>
        <div>
          {done.length > 0 && (
            <button disabled={running} onClick={() => void refresh()}>
              {uiText('刷新桌面')}
            </button>
          )}
          {done.length > 0 && (
            <button
              disabled={running}
              onClick={() => {
                locate(done.flatMap((entry) => (entry.objectId ? [entry.objectId] : [])));
                close();
              }}
            >
              {uiText('定位已导入')}
            </button>
          )}
          {running ? (
            <button
              disabled={pausing}
              onClick={() => {
                stop.current = true;
                setPausing(true);
              }}
            >
              {pausing ? uiText('正在完成当前文件…') : uiText('完成当前文件后暂停')}
            </button>
          ) : (
            <button
              className="primary"
              disabled={(!selected.length && !folderJob.current) || bytes > MAX_BYTES}
              onClick={() => void run(selected.map((entry) => entry.id))}
            >
              {uiText('导入勾选材料与目录')}
            </button>
          )}
        </div>
        {bytes > MAX_BYTES && (
          <small className="import-error">
            {uiText('本次超过 256 MiB，请取消部分勾选后分批导入。')}
          </small>
        )}
      </footer>
    </section>
  );
});

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  labels = {
    office: uiText('Office 文档'),
    image: uiText('图片'),
    text: uiText('文本 / CSV'),
    code: uiText('代码'),
    file: uiText('其他文件'),
  };
});
