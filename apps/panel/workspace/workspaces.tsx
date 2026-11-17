import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useState } from 'react';
import { DesktopMark } from '../canvas/desktop-mark.js';
import type { Workspace, WorkspaceSummary } from '../../../packages/contracts/index.js';

import { browserCommand } from '../browser/electron-browser-bridge.js';

export type WorkspaceChange = {
  operation: 'create' | 'switch' | 'delete';
  targetId?: string;
  name?: string;
  rootPath?: string;
};

export function Workspaces({
  workspace,
  action,
  updated,
  change,
  close,
  backups,
}: {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  change: (value: WorkspaceChange) => Promise<void>;
  close: () => void;
  backups: () => void;
}) {
  useUiLocale();
  const [items, setItems] = useState<WorkspaceSummary[]>([]);
  const [name, setName] = useState(workspace.name);
  const [newName, setNewName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    let active = true,
      revision = 0;
    const refresh = () => {
      const request = ++revision;
      void action('workspace_list')
        .then((value) => {
          if (active && request === revision) setItems(value);
        })
        .catch((e) => {
          if (active && request === revision) setError(String(e));
        })
        .finally(() => {
          if (active && request === revision) setLoading(false);
        });
    };
    refresh();
    window.addEventListener('yirang:workspaces-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('yirang:workspaces-changed', refresh);
    };
  }, [workspace.id]);
  async function rename() {
    setBusy(true);
    setError('');
    try {
      const result = await action('workspace_rename', {
        requestId: crypto.randomUUID(),
        name: name.trim(),
        expectedName: workspace.name,
      });
      setName(result.name);
      setItems((rows) => rows.map((row) => (row.current ? { ...row, name: result.name } : row)));
      await updated();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(value: WorkspaceChange) {
    setBusy(true);
    setError('');
    try {
      await change(value);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-manager" role="region" aria-label={uiText('工作区')}>
      <header>
        <div>
          <strong>{uiText('工作区')}</strong>
        </div>
        <button disabled={busy} onClick={close}>
          {uiText('返回桌面')}
        </button>
      </header>
      <div className="workspace-manager-body">
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <section className="workspace-current">
          <span className="eyebrow">{uiText('正在使用')}</span>
          <label htmlFor="workspace-name">{uiText('工作区名称')}</label>
          <div className="workspace-name-row">
            <input
              id="workspace-name"
              maxLength={80}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              disabled={busy || !name.trim() || name.trim() === workspace.name}
              onClick={() => void rename()}
            >
              {uiText('保存名称')}
            </button>
          </div>
          <small>
            {workspace.objects.length} {uiText('份材料 · 内容与布局随工作区保存')}
          </small>
          <button disabled={busy} onClick={backups}>
            {uiText('备份与恢复')}
          </button>
        </section>
        <section>
          <h2>{uiText('继续已有工作')}</h2>
          <p>
            {uiText(
              '这里列出可切换的本地工作区。切换前会保存当前编辑，并停止旧工作区选区的后续写入。原工作区仍保留在本机。',
            )}
          </p>
          <input
            aria-label={uiText('查找工作区')}
            placeholder={uiText('按名称查找…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="workspace-choices">
            {loading ? (
              <p>{uiText('正在读取本地工作区…')}</p>
            ) : (
              items
                .filter(
                  (row) =>
                    !row.current &&
                    row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                )
                .map((row) => (
                  <button
                    key={row.id}
                    disabled={busy}
                    onClick={() => void open({ operation: 'switch', targetId: row.id })}
                  >
                    <span className="workspace-choice-icon">
                      <DesktopMark size={36} />
                    </span>
                    <span>
                      <strong>{row.name}</strong>
                      <small>
                        {row.objectCount} {uiText('份材料')}
                        {row.updatedAt
                          ? uiText(' · {0} 更新', {
                              '0': new Date(row.updatedAt).toLocaleDateString(interfaceLocale()),
                            })
                          : ''}
                      </small>
                    </span>
                    <span>{uiText('切换')}</span>
                  </button>
                ))
            )}
            {!loading &&
              !items.some(
                (row) =>
                  !row.current && row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
              ) && <p>{query ? uiText('没有匹配的工作区。') : uiText('暂无可切换的工作区。')}</p>}
          </div>
        </section>
        <section>
          <h2>{uiText('开始一项新工作')}</h2>
          <button
            disabled={busy}
            onClick={() =>
              void browserCommand<string | null>('choose-workspace-folder')
                .then((path) => {
                  if (path) {
                    setRootPath(path);
                    if (!newName) setNewName(path.split(/[\\/]/).filter(Boolean).at(-1) ?? '');
                  }
                })
                .catch((e) => setError(String(e)))
            }
          >
            {uiText('选择文件夹并关联')}
          </button>
          {rootPath && (
            <p>
              {rootPath} <button onClick={() => setRootPath('')}>{uiText('取消关联')}</button>
            </p>
          )}
          <p>
            {uiText(
              '选择文件夹：关联原目录，修改写回原文件。不选文件夹：创建独立工作区，导入文件时复制。',
            )}
          </p>
          <div className="workspace-name-row">
            <input
              aria-label={uiText('新工作区名称')}
              placeholder={uiText('例如：产品方案、资料整理')}
              value={newName}
              maxLength={80}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              className="primary"
              disabled={busy || !newName.trim()}
              onClick={() =>
                void open({
                  operation: 'create',
                  name: newName.trim(),
                  ...(rootPath ? { rootPath } : {}),
                })
              }
            >
              {uiText('新建并切换')}
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}
