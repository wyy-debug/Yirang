import React, { useEffect, useRef, useState } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { WidgetPage } from './app-widgets.js';
import { ActionPopover } from '../ui/workbench-chrome.js';
import './app-dashboard.css';
const call = (workspaceId: string, operation: string, payload: any = {}) =>
  browserCommand<any>('light-apps', { workspaceId, operation, payload }, 120000);
const time = (value: number) => (value ? new Date(value).toLocaleString() : '尚未同步');

export function RemoteConnections({
  workspaceId,
  close,
}: {
  workspaceId: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [items, setItems] = useState<any[]>([]),
    [form, setForm] = useState<any>({ name: '', endpoint: '', token: '', allowActions: false }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let live = true,
      pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const v = await call(workspaceId, 'connections_list');
        if (live) setItems(v);
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [workspaceId]);
  async function run(op: string, p: any) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await call(workspaceId, op, p);
      setItems(await call(workspaceId, 'connections_list'));
      window.dispatchEvent(new Event('yirang:apps-changed'));
      if (op === 'connections_save')
        setForm({ name: '', endpoint: '', token: '', allowActions: false });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="remote-connections"
      onCancel={close}
      onClose={close}
      data-desktop-overlay
      onKeyDown={(e) => e.stopPropagation()}
    >
      <header>
        <div>
          <strong>远程服务</strong>
          <p>连接你的 Mac 或其他服务主机，在这里查看应用。</p>
        </div>
        <button aria-label="关闭" onClick={close}>
          ×
        </button>
      </header>
      <div className="remote-connections-content">
        {items.map((c) => (
          <article className="remote-connection" key={c.id}>
            <div>
              <strong>
                <i className={c.online ? 'online' : ''} />
                {c.name}
              </strong>
              <small>{c.endpoint}</small>
              <small>
                {c.connecting ? '正在连接…' : c.online ? '已连接' : '离线 · 保留最近数据'} ·{' '}
                {c.apps} 个应用 ·{' '}
                {c.allowActions && c.access === 'control' ? '可执行动作' : '仅查看'}
              </small>
              {c.error && <small className="remote-error">{c.error}</small>}
              <small>最近连接：{time(c.lastSeen)}</small>
            </div>
            <div>
              <button disabled={busy} onClick={() => setForm({ ...c, token: '' })}>
                编辑
              </button>
              <button disabled={busy} onClick={() => void run('connections_retry', { id: c.id })}>
                重连
              </button>
              <button disabled={busy} onClick={() => void run('connections_remove', { id: c.id })}>
                移除此连接
              </button>
            </div>
          </article>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run('connections_save', form);
          }}
        >
          <h3>{form.id ? '编辑连接' : '添加服务'}</h3>
          <label>
            显示名称
            <input
              required
              maxLength={120}
              placeholder="我的 Mac"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            服务地址
            <input
              required
              disabled={!!form.id}
              placeholder="https://mac.example.com"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            />
          </label>
          <label>
            连接令牌
            <input
              type="password"
              autoComplete="off"
              required={!form.id}
              placeholder={form.id ? '留空保留现有令牌' : '服务提供的查看或控制令牌'}
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
          </label>
          <label className="remote-toggle">
            <input
              type="checkbox"
              checked={form.allowActions}
              onChange={(e) => setForm({ ...form, allowActions: e.target.checked })}
            />
            允许在本机执行应用动作 <small>需服务提供控制令牌</small>
          </label>
          <p>业务密钥保存在服务主机。移除连接、关闭组件或退出一壤，都不会停止远程任务。</p>
          {error && <p role="alert">{error}</p>}
          <footer>
            {form.id && (
              <button
                type="button"
                onClick={() => setForm({ name: '', endpoint: '', token: '', allowActions: false })}
              >
                取消编辑
              </button>
            )}
            <button className="primary" disabled={busy}>
              {busy ? '正在保存…' : form.id ? '保存连接' : '连接服务'}
            </button>
          </footer>
        </form>
      </div>
    </dialog>
  );
}

function DashboardWidget({
  workspaceId,
  item,
  definition,
  save,
  remove,
  open,
  move,
  dragStart,
  drop,
}: {
  workspaceId: string;
  item: any;
  definition: any;
  save: (p: any) => void;
  remove: () => void;
  open: () => void;
  move: (n: number) => void;
  dragStart: () => void;
  drop: () => void;
}) {
  const ref = useRef<HTMLElement>(null),
    [visible, setVisible] = useState(false),
    [menu, setMenu] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '160px',
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const c = definition?.connection;
  return (
    <article
      ref={ref}
      className={'dashboard-widget size-' + item.size}
      data-file-ai-object={item.id}
      data-app-widget-instance={item.instanceId}
      data-app-widget-title={definition?.name || '小组件'}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-yirang-dashboard-widget'))
          e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes('application/x-yirang-dashboard-widget')) {
          e.preventDefault();
          drop();
        }
      }}
    >
      <header
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-yirang-dashboard-widget', item.id);
          e.dataTransfer.effectAllowed = 'move';
          dragStart();
        }}
      >
        <div>
          <strong>{definition?.name || '组件声明已移除'}</strong>
          <small>{definition?.appName}</small>
        </div>
        <select
          aria-label="组件大小"
          value={item.size}
          onChange={(e) => save({ size: Number(e.target.value) })}
        >
          {(definition?.sizes || [item.size]).map((n: number) => (
            <option key={n} value={n}>
              {n} 格
            </option>
          ))}
        </select>
        <ActionPopover
          label="组件操作"
          className="dashboard-widget-menu"
          open={menu}
          setOpen={setMenu}
          trigger="···"
          closeOnAction
        >
          <button onClick={open}>打开应用</button>
          <button
            onClick={(e) =>
              window.dispatchEvent(
                new CustomEvent('ai-desktop:ask-region', {
                  detail: { node: e.currentTarget.closest('.dashboard-widget') },
                }),
              )
            }
          >
            问 AI
          </button>
          <button onClick={() => move(-1)}>向前排列</button>
          <button onClick={() => move(1)}>向后排列</button>
          <button onClick={() => save({ surface: 'canvas', pinned: false, x: 0, y: 0 })}>
            移到画布
          </button>
          <button onClick={remove}>移除组件</button>
        </ActionPopover>
      </header>
      {c && (
        <div className={'dashboard-widget-status ' + (c.online ? 'online' : 'offline')}>
          <span>{c.online ? '● ' + c.name : '○ 离线 · 最近数据'}</span>
          <time>{time(definition.stateAt || c.lastSeen)}</time>
        </div>
      )}
      <div className="dashboard-widget-content">
        {definition ? (
          visible ? (
            <WidgetPage workspaceId={workspaceId} definition={definition} size={item.size} />
          ) : (
            <span>进入可视区域后显示</span>
          )
        ) : (
          <span>请在应用中恢复组件声明，或移除此组件。</span>
        )}
      </div>
    </article>
  );
}

export function AppDashboard({
  workspaceId,
  setActive,
  applications = [],
}: {
  workspaceId: string;
  setActive: (id: string) => void;
  applications?: any[];
}) {
  const [data, setData] = useState<any>({ items: [], catalog: [] }),
    [connections, setConnections] = useState<any[]>([]),
    [services, setServices] = useState(false),
    [adding, setAdding] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const dragging = useRef('');
  useEffect(() => {
    let live = true,
      pending = false;
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const [d, c] = await Promise.all([
          call(workspaceId, 'widgets_list'),
          call(workspaceId, 'connections_list'),
        ]);
        if (live) {
          setData((old: any) => (JSON.stringify(old) === JSON.stringify(d) ? old : d));
          setConnections(c);
        }
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        pending = false;
      }
    }
    void refresh();
    const t = setInterval(refresh, 5000);
    window.addEventListener('yirang:apps-changed', refresh);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('yirang:apps-changed', refresh);
    };
  }, [workspaceId]);
  async function perform(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      setData(await call(workspaceId, 'widgets_list'));
      window.dispatchEvent(new Event('yirang:apps-changed'));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const items = data.items
    .filter((w: any) => w.surface === 'dashboard')
    .sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
  function reorder(id: string, before: string) {
    const from = items.findIndex((w: any) => w.id === id),
      to = items.findIndex((w: any) => w.id === before);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...items];
    next.splice(to, 0, next.splice(from, 1)[0]);
    void perform(async () => {
      for (let i = 0; i < next.length; i++)
        await call(workspaceId, 'widget_save', {
          id: next[i].id,
          instanceId: next[i].instanceId,
          order: i,
        });
    });
  }
  return (
    <section
      className="app-dashboard"
      data-desktop-overlay
      data-ai-surface
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <header className="dashboard-topbar">
        <div>
          <strong>应用与组件</strong>
          <small>
            {items.length} 个组件
            {connections.length
              ? ` · ${connections.filter((c) => c.online).length}/${connections.length} 个服务在线`
              : ' · 本地应用'}
          </small>
        </div>
        <button onClick={() => setServices(true)}>
          远程服务{connections.some((c) => !c.online) ? ' · 离线' : ''}
        </button>
        <button onClick={() => setActive('manage')}>应用管理</button>
        {(items.length > 0 || adding) && (
          <button className="primary" aria-expanded={adding} onClick={() => setAdding(!adding)}>
            ＋ 添加组件
          </button>
        )}
      </header>
      {error && (
        <div role="alert" className="dashboard-error">
          {error}
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
      {!!applications.length && (
        <nav className="dashboard-apps" aria-label="打开应用">
          {applications.map((app) => (
            <button key={app.id} onClick={() => setActive(app.id)}>
              <span className="dashboard-app-icon">{app.name.slice(0, 1)}</span>
              <strong>{app.name}</strong>
              {app.unread > 0 && <small>{app.unread} 条通知</small>}
            </button>
          ))}
        </nav>
      )}
      {adding && (
        <div className="dashboard-picker">
          <header>
            <strong>选择组件</strong>
            <small>拖动标题排序；大小可随时调整</small>
            <button onClick={() => setAdding(false)}>×</button>
          </header>
          {!data.catalog.length && (
            <p>
              还没有可添加的组件。打开应用，在“应用管理”中选择“让 AI
              创建小组件”。远程应用的组件由服务主机提供。
            </p>
          )}
          <div>
            {data.catalog.map((d: any) => (
              <article key={d.instanceId + ':' + d.id}>
                <strong>{d.name}</strong>
                <small>
                  {d.appName}
                  {d.connection ? ' · ' + d.connection.name : ' · 本地'}
                </small>
                <div>
                  {d.sizes.map((n: number) => (
                    <button
                      disabled={busy}
                      key={n}
                      onClick={() =>
                        void perform(() =>
                          call(workspaceId, 'widget_save', {
                            instanceId: d.instanceId,
                            widgetId: d.id,
                            size: n,
                            surface: 'dashboard',
                            order: items.length
                              ? Math.max(...items.map((w: any) => w.order || 0)) + 1
                              : 0,
                          }),
                        )
                      }
                    >
                      ＋ {n} 格
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
      <div className="dashboard-scroll">
        {items.length ? (
          <div className="dashboard-grid" aria-busy={busy}>
            {items.map((w: any, index: number) => (
              <DashboardWidget
                key={w.id}
                workspaceId={workspaceId}
                item={w}
                definition={data.catalog.find(
                  (d: any) => d.instanceId === w.instanceId && d.id === w.widgetId,
                )}
                save={(p) =>
                  void perform(() =>
                    call(workspaceId, 'widget_save', { instanceId: w.instanceId, id: w.id, ...p }),
                  )
                }
                remove={() =>
                  void perform(() =>
                    call(workspaceId, 'widget_remove', { instanceId: w.instanceId, id: w.id }),
                  )
                }
                open={() => setActive(w.instanceId)}
                dragStart={() => {
                  dragging.current = w.id;
                }}
                drop={() => {
                  reorder(dragging.current, w.id);
                  dragging.current = '';
                }}
                move={(delta) => {
                  if (items[index + delta]) reorder(w.id, items[index + delta].id);
                }}
              />
            ))}
          </div>
        ) : (
          <div className="dashboard-empty">
            <div className="dashboard-empty-symbol">▦</div>
            <h2>把关注的事，放在一起</h2>
            <p>
              从应用添加小组件，或连接 Mac 上的服务。
              <br />
              任务在服务主机运行，这里只展示你想看的信息。
            </p>
            <button className="primary" onClick={() => setAdding(true)}>
              添加组件
            </button>
            <button onClick={() => setServices(true)}>连接远程服务</button>
          </div>
        )}
      </div>
      {services && <RemoteConnections workspaceId={workspaceId} close={() => setServices(false)} />}
    </section>
  );
}
