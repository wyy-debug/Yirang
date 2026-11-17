import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useState } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import {
  emptyFileTree,
  folderPath,
  nestedFolders,
} from '../../../packages/components/file-tree.js';
import { kindIcons, kindLabels } from '../../../packages/components/content.js';
import { nativeFormat } from '../../../packages/components/native-files.js';

type Props = {
  workspace: Workspace;
  selected: string[];
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  select: (ids: string[]) => void;
  locate: (ids: string[]) => void;
  open: (id: string) => void;
  close: () => void;
};
export function FileBrowser({
  workspace,
  selected,
  action,
  updated,
  select,
  locate,
  open,
  close,
}: Props) {
  useUiLocale();
  const tree = workspace.fileTree ?? emptyFileTree;
  const [folderId, setFolderId] = useState<string | null>(null),
    [query, setQuery] = useState('');
  const [name, setName] = useState(''),
    [rename, setRename] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const folder = tree.folders.find((f) => f.id === folderId),
    path = folderPath(tree, folderId);
  useEffect(() => {
    if (folderId && !folder) setFolderId(null);
  }, [tree, folderId]);
  const children = tree.folders
    .filter((f) => f.parentId === folderId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const members = workspace.objects.filter((o) => (tree.locations[o.id] ?? null) === folderId);
  const visible = members.filter((o) =>
    o.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const descendants = nestedFolders(tree, folderId);
  const all = workspace.objects.filter(
    (o) => !folderId || tree.locations[o.id] === folderId || descendants.has(tree.locations[o.id]),
  );
  async function manage(operation: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action('folders_manage', {
        requestId: crypto.randomUUID(),
        revision: tree.revision,
        operation,
        ...(operation === 'create'
          ? { parentId: folderId, name }
          : operation === 'rename'
            ? { folderId, name }
            : operation === 'move_objects'
              ? { folderId, objectIds: selected }
              : { folderId }),
      });
      await updated();
      setName('');
      setRename(false);
      if (operation === 'remove') setFolderId(folder?.parentId ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function enter(id: string | null) {
    setFolderId(id);
    setQuery('');
    setName('');
    setRename(false);
    setError('');
  }
  return (
    <aside className="file-browser" role="dialog" aria-label={uiText('文件夹')}>
      <header>
        <div>
          <strong>{uiText('文件夹')}</strong>
        </div>
        <button onClick={close} aria-label={uiText('关闭文件夹')}>
          ×
        </button>
      </header>
      {error && (
        <div className="navigator-error" role="alert">
          {error}
          <button disabled={busy} onClick={() => void updated().catch((e) => setError(String(e)))}>
            {uiText('刷新')}
          </button>
        </div>
      )}
      <div className="folder-breadcrumb">
        <button disabled={busy} onClick={() => enter(null)}>
          {uiText('工作区')}
        </button>
        {folder && (
          <>
            <span>/ {path}</span>
            <button disabled={busy} onClick={() => enter(folder.parentId)}>
              {uiText('上一级')}
            </button>
          </>
        )}
      </div>
      <div className="folder-actions">
        <button disabled={busy || !selected.length} onClick={() => void manage('move_objects')}>
          {uiText('将选中')}
          {selected.length} {uiText('项移到这里')}
        </button>
        <button disabled={!all.length} onClick={() => locate(all.map((o) => o.id))}>
          {uiText('定位全部')}
          {all.length} {uiText('项')}
        </button>
      </div>
      <form
        className="folder-create"
        onSubmit={(e) => {
          e.preventDefault();
          void manage(rename ? 'rename' : 'create');
        }}
      >
        <input
          aria-label={rename ? uiText('重命名文件夹') : uiText('新文件夹名称')}
          placeholder={rename ? uiText('新的文件夹名称') : uiText('新文件夹名称')}
          maxLength={120}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <button disabled={busy || !name.trim()}>
          {rename ? uiText('保存名称') : uiText('＋ 新建')}
        </button>
        {rename && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRename(false);
              setName('');
            }}
          >
            {uiText('取消')}
          </button>
        )}
      </form>
      {folder && (
        <div className="folder-actions">
          <button
            disabled={busy}
            onClick={() => {
              setRename(true);
              setName(folder.name);
            }}
          >
            {uiText('重命名此文件夹')}
          </button>
          <button
            disabled={
              busy || children.length > 0 || Object.values(tree.locations).includes(folder.id)
            }
            onClick={() => void manage('remove')}
          >
            {uiText('删除空文件夹')}
          </button>
        </div>
      )}
      <div className="folder-contents">
        {children.map((child) => (
          <button
            className="folder-row"
            key={child.id}
            disabled={busy}
            onClick={() => enter(child.id)}
          >
            <span>▰</span>
            <strong>{child.name}</strong>
            <span>›</span>
          </button>
        ))}
        <label className="folder-search">
          <span>
            {members.length} {uiText('份材料')}
          </span>
          <input
            aria-label={uiText('筛选当前文件夹')}
            placeholder={uiText('筛选名称…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {!!visible.length && (
          <div className="folder-actions">
            <button
              onClick={() => select([...new Set([...selected, ...visible.map((o) => o.id)])])}
            >
              {uiText('选中本页')}
            </button>
            <button
              onClick={() => select(selected.filter((id) => !visible.some((o) => o.id === id)))}
            >
              {uiText('取消本页选择')}
            </button>
          </div>
        )}
        {visible.map((object) => (
          <article
            className={`folder-file ${selected.includes(object.id) ? 'chosen' : ''}`}
            key={object.id}
          >
            <input
              type="checkbox"
              checked={selected.includes(object.id)}
              aria-label={uiText('选择 {0}', { '0': object.title })}
              onChange={(e) =>
                select(
                  e.target.checked
                    ? [...selected, object.id]
                    : selected.filter((id) => id !== object.id),
                )
              }
            />
            <button onClick={() => open(object.id)}>
              <strong>
                {kindIcons[object.kind]} {object.title}
              </strong>
              <small>
                {object.kind === 'file'
                  ? nativeFormat((object.content as { fileName: string }).fileName).label
                  : kindLabels[object.kind]}{' '}
                · v{object.revision}
              </small>
            </button>
            <button onClick={() => locate([object.id])} title={uiText('在画布定位')}>
              ⌖
            </button>
          </article>
        ))}
        {!children.length && !members.length && (
          <p className="editor-empty">
            {uiText('文件夹还是空的。可以创建子文件夹，或选中桌面材料后移到这里。')}
          </p>
        )}
      </div>
    </aside>
  );
}
