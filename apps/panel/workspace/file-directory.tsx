import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import { emptyFileTree, folderPath } from '../../../packages/components/file-tree.js';
import { Icon, materialAppearance } from '../ui/icons.js';
import './file-directory.css';
import type { BrowserTab } from '../browser/electron-browser-bridge.js';

type Props = {
  rename: (id: string) => void;
  action: (name: string, payload: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<unknown>;
  workspace: Workspace;
  selected: string[];
  locate: (ids: string[]) => void;
  preview: (id: string) => void;
  activate: (id: string) => void;
  close: () => void;
  manage: () => void;
  disabled: boolean;
  browserTabs?: BrowserTab[];
  locateBrowser?: (id: string) => void;
};
export function FileDirectory({
  workspace,
  selected,
  locate,
  preview,
  activate,
  close,
  manage,
  disabled,
  rename,
  action,
  updated,
  browserTabs = [],
  locateBrowser,
}: Props) {
  useUiLocale();
  const tree = workspace.fileTree ?? emptyFileTree,
    key = `yirang:file-directory:${workspace.id}`;
  const [editing, setEditing] = useState<{
      kind: 'folder' | 'group';
      id: string;
      name: string;
    } | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const savingRef = useRef(false);
  const begin = (kind: 'folder' | 'group', id: string, name: string) => {
    if (disabled || savingRef.current) return;
    setEditing({ kind, id, name });
    setError('');
  };
  async function saveName() {
    if (!editing || disabled || savingRef.current || !editing.name.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const name = editing.name.trim();
      if (editing.kind === 'folder')
        await action('folders_manage', {
          requestId: crypto.randomUUID(),
          revision: tree.revision,
          operation: 'rename',
          folderId: editing.id,
          name,
        });
      else
        await action('groups_save', {
          requestId: crypto.randomUUID(),
          revision: workspace.groups.revision,
          items: workspace.groups.items.map((group) =>
            group.id === editing.id ? { ...group, name } : group,
          ),
        });
      await updated();
      setEditing(null);
    } catch (problem) {
      setError(String(problem));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  const nameEditor = (kind: 'folder' | 'group', id: string) =>
    editing?.kind === kind && editing.id === id ? (
      <form
        className="directory-rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveName();
        }}
      >
        <input
          autoFocus
          aria-label={uiText('新名称')}
          value={editing.name}
          maxLength={kind === 'group' ? 80 : 120}
          disabled={saving}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setEditing({ ...editing, name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !saving) {
              event.preventDefault();
              setEditing(null);
            }
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          }}
        />
        <button
          disabled={saving || disabled || !editing.name.trim()}
          title={uiText('保存名称')}
          aria-label={uiText('保存名称')}
        >
          <Icon name="check" size={13} />
        </button>
        <button
          type="button"
          disabled={saving}
          title={uiText('取消改名')}
          aria-label={uiText('取消改名')}
          onClick={() => setEditing(null)}
        >
          <Icon name="close" size={13} />
        </button>
      </form>
    ) : null;
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    } catch {
      return new Set();
    }
  });
  const list = useRef<HTMLDivElement>(null),
    selectedKey = selected.join('|');
  const objects = useMemo(
    () =>
      workspace.objects
        .filter((object) => !object.archived)
        .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true })),
    [workspace.objects, getUiLocale()],
  );
  const index = useMemo(() => {
    const folders = new Map(tree.folders.map((folder) => [folder.id, folder])),
      children = new Map<string | null, typeof tree.folders>(),
      files = new Map<string | null, DesktopObject[]>();
    for (const folder of tree.folders) {
      const parent = folders.has(folder.parentId ?? '') ? folder.parentId : null;
      children.set(parent, [...(children.get(parent) ?? []), folder]);
    }
    for (const rows of children.values())
      rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    for (const object of objects) {
      const id = tree.locations[object.id],
        parent = id && folders.has(id) ? id : null;
      files.set(parent, [...(files.get(parent) ?? []), object]);
    }
    return { folders, children, files };
  }, [tree, objects, workspace.groups, getUiLocale()]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify([...expanded]));
    } catch {}
  }, [key, expanded]);
  useEffect(() => {
    const id = selected.at(-1);
    if (!id) return;
    setExpanded((previous) => {
      const next = new Set(previous),
        seen = new Set<string>();
      let folder: string | undefined = tree.locations[id];
      while (folder && !seen.has(folder)) {
        seen.add(folder);
        next.add(folder);
        folder = index.folders.get(folder)?.parentId ?? undefined;
      }
      return next.size === previous.size ? previous : next;
    });
  }, [selectedKey, tree, index]);
  useEffect(() => {
    list.current
      ?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedKey, expanded]);
  useEffect(() => {
    const id = selected.at(-1);
    if (!id) return;
    setExpanded((previous) => {
      const next = new Set(previous),
        seen = new Set<string>();
      let g = workspace.groups.items.find((g) => g.bounds && g.objectIds.includes(id));
      while (g && !seen.has(g.id)) {
        seen.add(g.id);
        next.add(`group:${g.id}`);
        g = workspace.groups.items.find((p) => p.id === g!.parentId);
      }
      return next.size === previous.size ? previous : next;
    });
  }, [selectedKey, workspace.groups]);
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const fileName = (object: DesktopObject) =>
    object.kind === 'file' ? (object.content as { fileName: string }).fileName : object.title;
  const regionPath = (id: string) => {
    const parts: string[] = [],
      seen = new Set<string>();
    let g = workspace.groups.items.find((g) => g.bounds && g.objectIds.includes(id));
    while (g && !seen.has(g.id)) {
      seen.add(g.id);
      parts.unshift(g.name);
      g = workspace.groups.items.find((p) => p.id === g!.parentId);
    }
    return parts.join('/');
  };
  const path = (object: DesktopObject) =>
    [regionPath(object.id) || folderPath(tree, tree.locations[object.id] ?? null), fileName(object)]
      .filter(Boolean)
      .join('/');
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle
    ? objects.filter((object) =>
        `${object.title}\n${path(object)}\n${folderPath(tree, tree.locations[object.id] ?? null)}`
          .toLocaleLowerCase()
          .includes(needle),
      )
    : objects;
  const row = (object: DesktopObject, showPath = false) => {
    const appearance = materialAppearance(object.kind, fileName(object)),
      current = selected.includes(object.id);
    return (
      <li
        key={object.id}
        className={`directory-file ${current ? 'is-selected' : ''}`}
        data-current={selected.at(-1) === object.id ? 'true' : undefined}
      >
        <button
          className="directory-file-link"
          disabled={disabled}
          aria-current={current ? 'true' : undefined}
          title={uiText('{0}\n单击定位 · 双击打开 · F2 改名', { '0': path(object) })}
          onClick={() => locate([object.id])}
          onDoubleClick={() => activate(object.id)}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault();
              rename(object.id);
            }
          }}
        >
          <Icon name={appearance.icon} size={15} />
          <span>
            <strong>{object.title}</strong>
            {showPath && <small>{path(object)}</small>}
          </span>
        </button>
        <button
          className="directory-preview"
          disabled={disabled || saving}
          aria-label={uiText('重命名 {0}', { '0': object.title })}
          title={uiText('重命名 · F2')}
          onClick={() => rename(object.id)}
        >
          <Icon name="text" size={14} />
        </button>
        <button
          className="directory-preview"
          disabled={disabled}
          aria-label={uiText('预览 {0}', { '0': object.title })}
          title={uiText('桌面内预览')}
          onClick={() => preview(object.id)}
        >
          <Icon name="eye" size={14} />
        </button>
      </li>
    );
  };
  function branch(parent: string | null, ancestors = new Set<string>()): React.ReactNode {
    return (
      <ul>
        {(index.children.get(parent) ?? [])
          .filter((folder) => !ancestors.has(folder.id))
          .map((folder) => (
            <li key={folder.id}>
              <div className="directory-folder-row">
                <button
                  className="directory-folder"
                  onKeyDown={(event) => {
                    if (event.key === 'F2') {
                      event.preventDefault();
                      begin('folder', folder.id, folder.name);
                    }
                  }}
                  aria-expanded={expanded.has(folder.id)}
                  onClick={() => toggle(folder.id)}
                  title={folderPath(tree, folder.id)}
                >
                  <Icon name="chevron" size={11} />
                  <Icon name="folder" size={15} />
                  <span>{folder.name}</span>
                </button>
                <button
                  className="directory-preview"
                  disabled={disabled || saving}
                  title={uiText('重命名文件夹')}
                  aria-label={uiText('重命名 {0}', { '0': folder.name })}
                  onClick={() => begin('folder', folder.id, folder.name)}
                >
                  <Icon name="text" size={14} />
                </button>
              </div>
              {nameEditor('folder', folder.id)}
              {expanded.has(folder.id) && branch(folder.id, new Set([...ancestors, folder.id]))}
            </li>
          ))}
        {(index.files.get(parent) ?? []).map((object) => row(object))}
        {parent && !index.children.get(parent)?.length && !index.files.get(parent)?.length && (
          <li className="directory-empty-folder">{uiText('空文件夹')}</li>
        )}
      </ul>
    );
  }
  function regionBranch(parent?: string): React.ReactNode {
    return (
      <ul>
        {workspace.groups.items
          .filter((g) => g.parentId === parent)
          .map((group) => {
            const id = `group:${group.id}`,
              members = objects.filter((o) => group.objectIds.includes(o.id)),
              children = workspace.groups.items.filter((g) => g.parentId === group.id);
            return (
              <li key={id}>
                <div className="directory-folder-row">
                  <button
                    className="directory-folder"
                    aria-expanded={expanded.has(id)}
                    onClick={() => toggle(id)}
                    onKeyDown={(e) => {
                      if (e.key === 'F2') {
                        e.preventDefault();
                        begin('group', group.id, group.name);
                      }
                    }}
                  >
                    <Icon name="chevron" size={11} />
                    <Icon name="folder" size={15} />
                    <span>{group.name}</span>
                    <small>{members.length + children.length}</small>
                  </button>
                  <button
                    className="directory-preview"
                    title={uiText('重命名')}
                    disabled={disabled || saving}
                    onClick={() => begin('group', group.id, group.name)}
                  >
                    <Icon name="text" size={14} />
                  </button>
                </div>
                {nameEditor('group', group.id)}
                {expanded.has(id) && (
                  <>
                    {regionBranch(group.id)}
                    <ul>
                      {members.map((o) => row(o))}
                      {!members.length && !children.length && (
                        <li className="directory-empty-folder">{uiText('空区域')}</li>
                      )}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
      </ul>
    );
  }
  return (
    <aside
      className="file-directory"
      aria-label={uiText('文件目录')}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header>
        <div>
          <strong>{uiText('文件目录')}</strong>
          <small>
            {objects.length} {uiText('份材料')}
          </small>
        </div>
        <button aria-label={uiText('收起文件目录')} title={uiText('收起目录')} onClick={close}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <label className="directory-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={uiText('搜索名称或路径')}
          aria-label={uiText('搜索目录中的文档')}
        />
        {query && (
          <button aria-label={uiText('清除搜索')} onClick={() => setQuery('')}>
            <Icon name="close" size={12} />
          </button>
        )}
      </label>
      <div className="directory-actions">
        <button
          onClick={() =>
            setExpanded(
              new Set([
                ...tree.folders.map((folder) => folder.id),
                ...workspace.groups.items.map((group) => `group:${group.id}`),
              ]),
            )
          }
        >
          {uiText('展开全部')}
        </button>
        <button onClick={() => setExpanded(new Set())}>{uiText('收起全部')}</button>
        <button disabled={disabled} onClick={manage} title={uiText('新建文件夹和移动材料')}>
          {uiText('管理')}
        </button>
      </div>
      <div className="directory-list" ref={list}>
        {browserTabs.some((tab) =>
          `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(needle),
        ) && (
          <>
            <p className="directory-section">{uiText('浏览器页面')}</p>
            <ul>
              {browserTabs
                .filter((tab) => `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(needle))
                .map((tab) => (
                  <li key={tab.id} className="directory-file">
                    <button
                      className="directory-file-link"
                      disabled={disabled}
                      title={tab.url}
                      onClick={() => locateBrowser?.(tab.id)}
                    >
                      <Icon name="compass" size={15} />
                      <span>
                        <strong>{tab.title || uiText('网页')}</strong>
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </>
        )}
        {needle ? (
          <>
            <p className="directory-section">
              {uiText('找到')}
              {matches.length} {uiText('份材料')}
            </p>
            <ul>{matches.map((object) => row(object, true))}</ul>
            {!matches.length && <p className="directory-empty">{uiText('没有匹配的文档')}</p>}
          </>
        ) : (
          <>
            <p className="directory-section">{workspace.name}</p>
            {branch(null)}
            {!!workspace.groups.items.length && (
              <>
                <p className="directory-section">{uiText('区域')}</p>
                {regionBranch()}
              </>
            )}
            {!objects.length && !tree.folders.length && !browserTabs.length && (
              <p className="directory-empty">{uiText('导入或新建文档后，会显示在这里。')}</p>
            )}
          </>
        )}
      </div>
      {error && (
        <p className="directory-rename-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
