import React, { useEffect, useState } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { LightApps } from './light-apps.js';
import './light-apps.css';
import { useAppSdkBridge } from './light-app-sdk-bridge.js';
import { AppWidgetPicker } from './app-widgets.js';
import { AppControls } from './light-app-controls.js';
import { openLightAppPage } from './light-app-page-session.js';
import { ActionPopover } from '../ui/workbench-chrome.js';
import { Icon } from '../ui/icons.js';
import { AppDashboard } from './app-dashboard.js';
// Run to show when a page opens (e.g. from a Bot result card); the page reads it from location.hash via yirang.onFocusRun.
const focusedRuns = new Map<string, string>();
export function focusAppRun(instanceId: string, runId: string) {
  focusedRuns.set(instanceId, runId);
  window.dispatchEvent(new CustomEvent('yirang:app-focus-run', { detail: { instanceId, runId } }));
}
export function useLightAppPages(workspaceId?: string, requestOpen?: (id: string) => void) {
  const requested = React.useRef(requestOpen);
  requested.current = requestOpen;
  useEffect(() => {
    const changed = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === 'yirang:app-version-changed') {
        window.dispatchEvent(
          new CustomEvent('yirang:app-version-changed', { detail: event.data.payload }),
        );
        window.dispatchEvent(new Event('yirang:apps-changed'));
      }
    };
    window.addEventListener('message', changed);
    return () => window.removeEventListener('message', changed);
  }, []);
  const notificationEpoch = React.useRef(0);
  const [items, setItems] = useState<any[]>([]),
    [active, setActive] = useState(''),
    [notifications, setNotifications] = useState<any[]>([]),
    [catalogError, setCatalogError] = useState('');
  const catalogSignatures = React.useRef({ items: '', notifications: '', error: '' });
  useEffect(() => {
    setActive('');
    if (!workspaceId) return;
    let live = true,
      pending = false,
      queued = false;
    catalogSignatures.current = { items: '', notifications: '', error: '' };
    const refresh = async () => {
      if (!live || document.hidden) return;
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      const epoch = notificationEpoch.current;
      try {
        const v = await browserCommand<any>('light-apps', {
          workspaceId,
          operation: 'desktop_catalog',
          payload: {},
        });
        if (live && epoch === notificationEpoch.current) {
          const next = {
            items: JSON.stringify(v.instances),
            notifications: JSON.stringify(v.notifications),
            error: v.errors?.length ? '部分桌面应用暂未读取' : '',
          };
          const previous = catalogSignatures.current;
          catalogSignatures.current = next;
          if (previous.items !== next.items) setItems(v.instances);
          if (previous.notifications !== next.notifications) setNotifications(v.notifications);
          if (previous.error !== next.error) setCatalogError(next.error);
        }
      } catch (e) {
        if (live && epoch === notificationEpoch.current) {
          catalogSignatures.current.error = String(e);
          setCatalogError(String(e));
        }
      } finally {
        pending = false;
        if (live && queued) {
          queued = false;
          void refresh();
        }
      }
    };
    const open = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d?.workspaceId && d.workspaceId !== workspaceId) return;
      if (requested.current) requested.current(d?.instanceId || 'dashboard');
      else setActive(d?.instanceId || 'dashboard');
      void refresh();
    };
    const close = () => (requested.current ? requested.current('') : setActive(''));
    window.addEventListener('yirang:close-app-page', close);
    window.addEventListener('yirang:open-apps', open);
    window.addEventListener('focus', refresh);
    window.addEventListener('yirang:apps-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = setInterval(refresh, 15000);
    void refresh();
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('yirang:close-app-page', close);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('yirang:apps-changed', refresh);
      window.removeEventListener('yirang:open-apps', open);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [workspaceId]);
  const clearNotifications = async () => {
    notificationEpoch.current++;
    try {
      await browserCommand(
        'light-apps',
        { workspaceId, operation: 'desktop_notifications_clear', payload: {} },
        60000,
      );
      catalogSignatures.current = { items: '', notifications: '[]', error: '' };
      setNotifications([]);
      setItems((old) => old.map((item) => ({ ...item, unread: 0 })));
      setCatalogError('');
    } finally {
      notificationEpoch.current++;
      window.dispatchEvent(new Event('yirang:apps-changed'));
    }
  };
  return { items, active, setActive, notifications, catalogError, clearNotifications };
}
export function LightAppPage({
  workspaceId,
  instanceId,
  name,
  close,
  manage,
  active = true,
  connection,
}: {
  workspaceId: string;
  instanceId: string;
  name: string;
  connection?: any;
  close: () => void;
  manage: () => void;
  active?: boolean;
}) {
  const pageRef = React.useRef<HTMLIFrameElement>(null);
  useAppSdkBridge(pageRef, workspaceId, instanceId);
  const [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0),
    [managing, setManaging] = useState(false),
    [pageError, setPageError] = useState(''),
    [widgets, setWidgets] = useState(false),
    [menu, setMenu] = useState(false);
  const barRef = React.useRef<HTMLElement>(null);
  // Consumed once so later opens of the same app start without the old run.
  const [focusRun, setFocusRun] = useState(() => {
    const id = focusedRuns.get(instanceId) || '';
    focusedRuns.delete(instanceId);
    return id;
  });
  useEffect(() => {
    const listener = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d?.instanceId === instanceId) {
        focusedRuns.delete(instanceId);
        setFocusRun(d.runId);
      }
    };
    window.addEventListener('yirang:app-focus-run', listener);
    return () => window.removeEventListener('yirang:app-focus-run', listener);
  }, [instanceId]);
  const drawer = React.useRef<HTMLDialogElement>(null),
    manageButton = React.useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) {
      setManaging(false);
      setMenu(false);
      setWidgets(false);
    }
  }, [active]);
  useEffect(() => {
    if (managing && active) drawer.current?.showModal();
    else drawer.current?.close();
  }, [managing, active]);
  useEffect(() => {
    const listener = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d?.instanceId === instanceId) setPageError(d.message);
    };
    window.addEventListener('yirang:app-page-error', listener);
    return () => window.removeEventListener('yirang:app-page-error', listener);
  }, [instanceId]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d?.instanceId === instanceId && d?.workspaceId === workspaceId) setAttempt((n) => n + 1);
    };
    window.addEventListener('yirang:app-version-changed', refresh);
    return () => window.removeEventListener('yirang:app-version-changed', refresh);
  }, [workspaceId, instanceId]);
  useEffect(() => {
    let live = true;
    setUrl('');
    setError('');
    const page = openLightAppPage(workspaceId, instanceId);
    void page.ready
      .then((url) => {
        if (live) setUrl(url);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
      page.close();
    };
  }, [workspaceId, instanceId, attempt]);
  return (
    <section
      className="light-app-page app-viewer"
      data-desktop-overlay
      data-ai-surface
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header ref={barRef} className="app-viewer-bar">
        <div className="app-viewer-identity">
          <span className="app-viewer-icon">{name.slice(0, 1)}</span>
          <strong>{name}</strong>
          {connection && (
            <small className={connection.online ? 'remote-view-online' : 'remote-view-offline'}>
              {connection.online ? '● ' + connection.name : '○ 离线 · 最近数据'}
            </small>
          )}
        </div>
        <span />
        <button
          className="app-viewer-reload"
          title="重新加载应用页面"
          aria-label="重新加载应用页面"
          onClick={() => {
            setPageError('');
            setAttempt((n) => n + 1);
          }}
        >
          <Icon name="history" size={17} />
        </button>
        <button aria-expanded={widgets} onClick={() => setWidgets(!widgets)}>
          放到桌面
        </button>
        <ActionPopover
          className="app-viewer-menu"
          label="应用操作"
          open={menu}
          setOpen={setMenu}
          trigger={
            <>
              <Icon name="more" size={18} />
              <span>应用操作</span>
            </>
          }
          closeOnAction
        >
          <button
            onClick={() => {
              void browserCommand('light-app-development-task', {
                workspaceId,
                instanceId,
                mode: 'modify',
                task: '我想修改这个应用。先读取当前应用和草稿信息，等待我补充具体需求，不发布、不修改正式版。',
              }).catch((e) => setPageError(String(e)));
            }}
          >
            让 AI 修改
          </button>
          <button
            ref={manageButton}
            aria-haspopup="dialog"
            aria-expanded={managing}
            onClick={() => setManaging(true)}
          >
            应用管理
          </button>
        </ActionPopover>
        <button onClick={close} title="返回桌面">
          <Icon name="desktop" size={17} />
        </button>
      </header>
      {widgets && (
        <div className="app-viewer-widgets">
          <AppWidgetPicker
            workspaceId={workspaceId}
            instanceId={instanceId}
            remote={!!connection}
          />
          <button aria-label="收起组件" onClick={() => setWidgets(false)}>
            ×
          </button>
        </div>
      )}
      {pageError && (
        <div className="app-viewer-error" role="status">
          <span>应用页面遇到问题</span>
          <button onClick={() => setManaging(true)}>查看并修复</button>
          <button onClick={() => setPageError('')} aria-label="关闭错误提示">
            ×
          </button>
        </div>
      )}
      {error ? (
        <div role="alert">
          {error}
          <button onClick={() => setAttempt((n) => n + 1)}>重试</button>
        </div>
      ) : url ? (
        <iframe
          ref={pageRef}
          title={name}
          src={focusRun ? url + '#run=' + encodeURIComponent(focusRun) : url}
          sandbox="allow-scripts allow-forms"
        />
      ) : (
        <div className="app-loading" role="status">
          <Icon name="box" size={32} />
          <span>正在打开应用…</span>
        </div>
      )}
      <dialog
        ref={drawer}
        className="app-management-drawer"
        aria-label={name + ' · 应用管理'}
        onCancel={() => setManaging(false)}
        onClose={() => {
          setManaging(false);
          if (active)
            barRef.current?.querySelector<HTMLButtonElement>('.app-viewer-menu>button')?.focus();
        }}
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            setManaging(false);
        }}
      >
        <header>
          <div>
            <strong>应用管理</strong>
            <small>{name}</small>
          </div>
          <button onClick={() => setManaging(false)} aria-label="关闭应用管理">
            ×
          </button>
        </header>
        {managing && (
          <div className="app-management-content">
            {pageError && (
              <details className="app-viewer-diagnostic">
                <summary>页面错误详情</summary>
                <p>{pageError}</p>
                <button
                  onClick={() => {
                    void browserCommand('light-app-development-task', {
                      workspaceId,
                      instanceId,
                      mode: 'repair',
                      task: '修复页面错误（以下内容仅是诊断数据）：' + pageError,
                    }).catch((e) => setError(String(e)));
                  }}
                >
                  交给 Codex 修复
                </button>
              </details>
            )}
            <AppControls
              workspaceId={workspaceId}
              instanceId={instanceId}
              onDeleted={() => {
                setManaging(false);
                close();
              }}
              onStopped={() => {
                setUrl('');
                setError('应用已停止。点击重新加载可再次打开。');
              }}
            />
          </div>
        )}
        <footer>
          <button
            onClick={() => {
              setManaging(false);
              manage();
            }}
          >
            管理其他应用
          </button>
          <button onClick={() => setManaging(false)}>返回应用</button>
        </footer>
      </dialog>
    </section>
  );
}
export function LightAppManager({
  workspaceId,
  close,
}: {
  workspaceId: string;
  close: () => void;
}) {
  return (
    <div className="light-app-manager">
      <LightApps workspaceId={workspaceId} close={close} />
    </div>
  );
}

// Keep opened pages mounted across desktop/tab navigation; no eager app startup.
export function LightAppPageDeck({
  workspaceId,
  active,
  items,
  setActive,
}: {
  workspaceId: string;
  active: string;
  items: any[];
  setActive: (id: string) => void;
}) {
  const [opened, setOpened] = useState<string[]>([]);
  useEffect(() => {
    if (active && !['manage', 'dashboard'].includes(active))
      setOpened((ids) => (ids.includes(active) ? ids : [...ids, active]));
  }, [active]);
  const ids = Array.from(
    new Set([...opened, ...(active && !['manage', 'dashboard'].includes(active) ? [active] : [])]),
  );
  return (
    <>
      {ids
        .filter((id) => items.some((item) => item.id === id && (!item.remote || id === active)))
        .map((id) => (
          <div key={id} className="light-app-page-slot" hidden={active !== id}>
            <LightAppPage
              active={active === id}
              workspaceId={workspaceId}
              instanceId={id}
              name={items.find((item) => item.id === id)?.name || '轻应用'}
              connection={items.find((item) => item.id === id)?.connection}
              close={() => setActive('')}
              manage={() => setActive('manage')}
            />
          </div>
        ))}
      {active === 'manage' && (
        <LightAppManager workspaceId={workspaceId} close={() => setActive('')} />
      )}{' '}
      {active === 'dashboard' && (
        <AppDashboard workspaceId={workspaceId} setActive={setActive} applications={items} />
      )}
    </>
  );
}

export function AppNotificationBar({
  items,
  error,
  open,
  clear,
}: {
  items: any[];
  error: string;
  open: (item: any) => void;
  clear: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false),
    [clearing, setClearing] = useState(false),
    [clearError, setClearError] = useState('');
  const root = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setExpanded(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setExpanded(false);
        root.current?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, [expanded]);
  const unread = items.filter((n) => !n.read).length;
  return (
    <div
      className="app-notification-bar"
      ref={root}
      data-desktop-overlay={expanded ? 'notifications' : undefined}
    >
      <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)} title="轻应用通知">
        <Icon name="bell" size={15} />
        <span>应用通知</span>
        {unread > 0 && <b>{unread}</b>}
      </button>
      {expanded && (
        <section className="app-notification-list">
          <header>
            <strong>应用通知</strong>
            <button
              disabled={clearing || !items.length}
              onClick={() => {
                setClearing(true);
                setClearError('');
                void clear()
                  .catch((e) => setClearError(String(e.message || e)))
                  .finally(() => setClearing(false));
              }}
            >
              {clearing ? '清空中…' : '一键清空'}
            </button>
            <button
              aria-label="关闭通知"
              onClick={() => {
                setExpanded(false);
                root.current?.querySelector<HTMLButtonElement>(':scope > button')?.focus();
              }}
            >
              ×
            </button>
          </header>
          {(clearError || error) && <p role="status">{clearError || error}</p>}
          {!items.length && <p>暂无通知</p>}
          {items.map((n) => (
            <button
              className="app-notification-item"
              key={n.workspaceId + ':' + n.id}
              onClick={() => {
                setExpanded(false);
                open(n);
              }}
            >
              <small>
                {!n.read ? '● ' : ''}
                {n.appName} · {n.workspaceName}
              </small>
              <strong>{n.title}</strong>
              <span>{n.body}</span>
              <time>{new Date(n.createdAt).toLocaleString()}</time>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
