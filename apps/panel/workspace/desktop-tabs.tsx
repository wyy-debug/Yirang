import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Workspace, WorkspaceSummary } from '../../../packages/contracts/index.js';
import type { WorkspaceChange } from './workspaces.js';
import { t } from '../../../packages/components/ui-language.js';
import { useUiLanguage } from '../ui/ui-language.js';
import { Icon } from '../ui/icons.js';
import './desktop-tabs.css';
import '../ui/batch-rename.css';
import { useWorkbenchLayer } from '../ui/workbench-layers.js';
type Props = {
  children?: React.ReactNode;
  appActive?: boolean;
  showDesktop?: () => void;
  workspace: Workspace;
  disabled: boolean;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  change: (value: WorkspaceChange) => Promise<void>;
  manage: () => void;
  prepare: () => Promise<void>;
  updated: () => Promise<void>;
  busyChanged: (busy: boolean) => void;
};
export function DesktopTabs(p: Props) {
  useUiLanguage();
  const [items, setItems] = useState<WorkspaceSummary[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [menu, setMenu] = useState<string | null>(null),
    [edit, setEdit] = useState<'new' | 'rename' | null>(null),
    [name, setName] = useState(''),
    [removing, setRemoving] = useState<Pick<WorkspaceSummary, 'id' | 'name'> | null>(null),
    [deleted, setDeleted] = useState<Pick<WorkspaceSummary, 'id' | 'name'>[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  useWorkbenchLayer(!!menu || !!edit, root, () => {
    setMenu(null);
    setEdit(null);
  });
  const [archived, setArchived] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('desktop:archived-tabs') || '[]');
      return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  });
  const locked = p.disabled || busy;
  const list = async () => setItems(await p.action('workspace_list'));
  const replacement = items.find((w) => w.id !== p.workspace.id && !archived.includes(w.id))
    ?? items.find((w) => w.id !== p.workspace.id);
  useEffect(() => {
    if (removing) confirmation.current?.showModal();
  }, [removing]);
  useEffect(() => {
    if (menu !== p.workspace.id) return;
    let active = true;
    void p.action('workspace_trash', { operation: 'list' }).then(
      (rows) => { if (active) setDeleted(rows); },
      (e) => { if (active) setError(String(e)); },
    );
    return () => { active = false; };
  }, [menu, p.workspace.id, p.action]);
  useEffect(() => {
    let active = true,
      revision = 0;
    const refresh = () => {
      const request = ++revision;
      void p
        .action('workspace_list')
        .then((rows) => {
          if (active && request === revision) setItems(rows);
        })
        .catch((e) => {
          if (active && request === revision) setError(String(e));
        });
    };
    refresh();
    window.addEventListener('yirang:workspaces-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('yirang:workspaces-changed', refresh);
    };
  }, [p.workspace.id, p.workspace.name]);
  const run = async (fn: () => Promise<void>) => {
    if (locked) return;
    setBusy(true);
    p.busyChanged(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      p.busyChanged(false);
    }
  };
  const unhide = (id: string) => {
    if (!archived.includes(id)) return;
    const next = archived.filter((x) => x !== id);
    try {
      localStorage.setItem('desktop:archived-tabs', JSON.stringify(next));
      setArchived(next);
    } catch (e) {
      setError(String(e));
    }
  };
  async function duplicate() {
    await p.prepare();
    const key = `desktop:copy:${p.workspace.id}`;
    let request = JSON.parse(localStorage.getItem(key) || 'null');
    if (!request) {
      request = {
        createId: crypto.randomUUID(),
        restoreId: crypto.randomUUID(),
        name: `${p.workspace.name.slice(0, 65)} ${t('副本')}`,
      };
      localStorage.setItem(key, JSON.stringify(request));
    }
    const backup = await p.action('backup_create', {
      requestId: request.createId,
      label: request.name,
    });
    const preview = await p.action('backup_inspect', { id: backup.id });
    const copy = await p.action('backup_restore', {
      requestId: request.restoreId,
      id: backup.id,
      digest: preview.digest,
      name: request.name,
    });
    localStorage.removeItem(key);
    await list();
    setMenu(null);
    await p.change({ operation: 'switch', targetId: copy.id });
  }
  function offerDelete(targetId: string) {
    const target = targetId === p.workspace.id
      ? p.workspace
      : items.find((item) => item.id === targetId);
    if (!target) return;
    setMenu(null);
    setError('');
    setRemoving(target);
  }
  async function deleteDesktop() {
    if (!removing) return;
    if (removing.id === p.workspace.id) {
      if (!replacement) throw Error(t('请保留至少一个可用桌面。'));
      await p.change({ operation: 'delete', targetId: replacement.id });
      unhide(replacement.id);
    } else {
      await p.action('workspace_trash', {
        operation: 'delete', targetId: removing.id, requestId: crypto.randomUUID(),
      });
      await list();
    }
    setItems((rows) => rows.filter((row) => row.id !== removing.id));
    setRemoving(null);
  }
  return (
    <div
      ref={root}
      className="desktop-tabs-bar"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setMenu(null);
          setEdit(null);
          e.stopPropagation();
        }
      }}
    >
      <nav className="desktop-tabs" aria-label={t('页面切换')}>
        {(items.length ? items : [{ ...p.workspace, current: true }])
          .filter((w) => w.id === p.workspace.id || !archived.includes(w.id))
          .map((w) => (
            <button
              key={w.id}
              title={w.name}
              disabled={locked}
              aria-current={!p.appActive && w.id === p.workspace.id ? 'page' : undefined}
              onClick={() => {
                if (w.id === p.workspace.id) p.showDesktop?.();
                else
                  void run(async () => {
                    await p.change({ operation: 'switch', targetId: w.id });
                    p.showDesktop?.();
                  });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!locked) setMenu(w.id);
              }}
            >
              {w.name}
            </button>
          ))}
        <button
          className="desktop-tab-add"
          disabled={locked}
          title={t('新建桌面')}
          aria-label={t('新建桌面')}
          onClick={() => {
            setMenu(null);
            setEdit('new');
            setName('');
          }}
        >
          <Icon name="plus" size={15} />
        </button>
        <span className="desktop-tab-divider" aria-hidden="true" />
        {p.children}
      </nav>
      <button
        className="desktop-tab-options"
        disabled={locked}
        title={t('桌面选项')}
        aria-label={t('桌面选项')}
        aria-expanded={menu === p.workspace.id}
        onClick={() => setMenu(menu === p.workspace.id ? null : p.workspace.id)}
      >
        <Icon name="more" size={16} />
      </button>
      {edit && (
        <form
          className="desktop-tab-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (edit === 'new') await p.change({ operation: 'create', name: name.trim() });
              else {
                await p.action('workspace_rename', {
                  requestId: crypto.randomUUID(),
                  name: name.trim(),
                  expectedName: p.workspace.name,
                });
                await p.updated();
              }
              setEdit(null);
            });
          }}
        >
          <input
            autoFocus
            aria-label={t('桌面名称')}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEdit(null);
            }}
          />
          <button disabled={locked || !name.trim()}>{t('保存')}</button>
          <button type="button" onClick={() => setEdit(null)}>
            {t('取消')}
          </button>
        </form>
      )}
      {menu === p.workspace.id && (
        <div className="desktop-tab-menu">
          <button
            disabled={locked}
            onClick={() => {
              setEdit('new');
              setName('');
              setMenu(null);
            }}
          >
            {t('新建桌面')}
          </button>
          <button
            disabled={locked}
            onClick={() => {
              setName(p.workspace.name);
              setEdit('rename');
              setMenu(null);
            }}
          >
            {t('重命名桌面')}
          </button>
          <button disabled={locked} onClick={() => void run(duplicate)}>
            {t('复制当前桌面')}
          </button>
          <button
            className="desktop-tab-destructive"
            disabled={locked || !replacement}
            title={!replacement ? t('请保留至少一个可用桌面。') : undefined}
            onClick={() => offerDelete(p.workspace.id)}
          >
            {t('删除桌面')}
          </button>
          {deleted.map((item) => (
            <button key={item.id} disabled={locked} onClick={() => void run(async () => {
              await p.action('workspace_trash', {
                operation: 'restore', targetId: item.id, requestId: crypto.randomUUID(),
              });
              unhide(item.id);
              setDeleted((rows) => rows.filter((row) => row.id !== item.id));
              await list();
            })}>
              {t('恢复已删除的桌面：{0}', { '0': item.name })}
            </button>
          ))}
          {items
            .filter((w) => archived.includes(w.id) && w.id !== p.workspace.id)
            .map((w) => (
              <button
                key={w.id}
                disabled={locked}
                onClick={() => {
                  unhide(w.id);
                  setMenu(null);
                }}
              >
                {t('恢复桌面：{0}', { '0': w.name })}
              </button>
            ))}
          {items
            .filter((w) => w.id !== p.workspace.id && !archived.includes(w.id))
            .map((w) => (
              <button
                key={w.id}
                disabled={locked}
                title={w.name}
                onClick={() =>
                  void run(async () => {
                    await p.change({ operation: 'switch', targetId: w.id });
                    setMenu(null);
                  })
                }
              >
                {t('打开桌面：{0}', { '0': w.name })}
              </button>
            ))}
          <button
            onClick={() => {
              setMenu(null);
              p.manage();
            }}
          >
            {t('管理桌面')}
          </button>
          <button onClick={() => setMenu(null)}>{t('关闭')}</button>
        </div>
      )}
      {menu && menu !== p.workspace.id && (
        <div className="desktop-tab-menu">
          <button className="desktop-tab-destructive" disabled={locked} onClick={() => offerDelete(menu)}>
            {t('删除桌面')}
          </button>
          <button onClick={() => setMenu(null)}>{t('关闭')}</button>
        </div>
      )}
      {removing && createPortal(
        <dialog
          ref={confirmation}
          className="rename-overlay desktop-delete-confirmation"
          data-desktop-overlay
          aria-labelledby="desktop-delete-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!locked) setRemoving(null);
          }}
        >
          <div className="rename-dialog">
            <header><h2 id="desktop-delete-title">{t('删除「{0}」？', { '0': removing.name })}</h2></header>
            <div className="rename-body">
              <p>{t('可以在「桌面选项」中恢复。桌面中的材料和本机原文件会保留。')}</p>
              {error && <p className="rename-error" role="alert">{error}</p>}
            </div>
            <footer>
              <button type="button" autoFocus disabled={locked} onClick={() => setRemoving(null)}>{t('取消')}</button>
              <button type="button" className="desktop-tab-destructive" disabled={locked}
                onClick={() => void run(deleteDesktop)}>{t('删除桌面')}</button>
            </footer>
          </div>
        </dialog>,
        document.body,
      )}
      {error && !removing && (
        <div className="desktop-tab-error" role="alert">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
    </div>
  );
}
