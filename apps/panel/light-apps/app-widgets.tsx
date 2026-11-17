import { Icon } from '../ui/icons.js';
import { createPortal } from 'react-dom';
import React, { useEffect, useRef, useState } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { openLightAppPage } from './light-app-page-session.js';
import { useAppSdkBridge } from './light-app-sdk-bridge.js';
import './app-widgets.css';
const dimensions = (size: number) => ({
  width: (size === 8 ? 4 : size === 1 ? 1 : 2) * 236 - 16,
  height: (size >= 4 ? 2 : 1) * 236 - 16,
});
const call = (workspaceId: string, operation: string, payload: any = {}) =>
  browserCommand<any>('light-apps', { workspaceId, operation, payload }, 120000);
export function AppWidgetPicker({
  workspaceId,
  instanceId,
  remote = false,
}: {
  workspaceId: string;
  instanceId: string;
  remote?: boolean;
}) {
  const [catalog, setCatalog] = useState<any[] | null>(null),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [message, setMessage] = useState('');
  return (
    <div className="app-widget-entry">
      <strong>桌面小组件</strong>
      <small>1 / 2 / 4 / 8 格 · 放到桌面观察</small>
      <button
        onClick={() => {
          if (catalog) {
            setCatalog(null);
            return;
          }
          void call(workspaceId, 'widgets_list')
            .then((v) => setCatalog(v.catalog.filter((w: any) => w.instanceId === instanceId)))
            .catch((e) => setError(String(e)));
        }}
      >
        添加小组件
      </button>
      {error && <small role="alert">{error}</small>}
      {message && <small role="status">{message}</small>}
      {catalog && (
        <div className="app-widget-picker">
          {!catalog.length && (
            <span>
              {remote ? '请在服务主机为应用添加 widgets 声明。' : '此应用尚未提供小组件。'}
              <button
                disabled={creating || remote}
                onClick={() => {
                  setCreating(true);
                  setError('');
                  void browserCommand('light-app-development-task', {
                    workspaceId,
                    instanceId,
                    mode: 'modify',
                    task: '请先调用 apps_widgets_contract 读取一壤桌面小组件规范，为这个轻应用在独立草稿中开发适合现有业务的桌面观察小组件，支持 1、2、4、8 格（最大 8 格），共享已有后台状态，不重复启动监控或发送通知。补齐 widgets 声明及响应式页面；提供草稿预览，发布仍由我确认。',
                  })
                    .then(() => setMessage('需求已带入右侧 Codex 对话，发送后开始创建。'))
                    .catch((e) => setError(String(e)))
                    .finally(() => setCreating(false));
                }}
              >
                {creating ? '正在准备…' : '让 Codex 创建小组件'}
              </button>
            </span>
          )}
          {catalog.map((w) => (
            <div key={w.id}>
              <strong>{w.name}</strong>
              {w.sizes.map((size: number) => (
                <button
                  key={size}
                  draggable
                  title="点击选择位置，或直接拖到桌面"
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData(
                      'application/x-yirang-app-widget',
                      JSON.stringify({ workspaceId, instanceId, widgetId: w.id, size }),
                    );
                    window.dispatchEvent(new Event('yirang:widget-drag-start'));
                    setTimeout(() => window.dispatchEvent(new Event('yirang:close-app-page')), 0);
                  }}
                  onDragEnd={() => window.dispatchEvent(new Event('yirang:widget-drag-end'))}
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('yirang:place-widget', {
                        detail: { workspaceId, definition: w, size },
                      }),
                    );
                    window.dispatchEvent(new Event('yirang:close-app-page'));
                    setCatalog(null);
                  }}
                >
                  {size} 格
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export function WidgetPage({
  workspaceId,
  definition,
  size,
}: {
  workspaceId: string;
  definition: any;
  size: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  useAppSdkBridge(ref, workspaceId, definition.instanceId);
  const [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const listener = (e: Event) => {
      if ((e as CustomEvent).detail?.instanceId === definition.instanceId) setAttempt((n) => n + 1);
    };
    window.addEventListener('yirang:app-version-changed', listener);
    return () => window.removeEventListener('yirang:app-version-changed', listener);
  }, [definition.instanceId]);
  useEffect(() => {
    let live = true;
    setUrl('');
    setError('');
    const page = openLightAppPage(workspaceId, definition.instanceId);
    page.ready
      .then((base) => {
        if (live) {
          const u = new URL(definition.entry, base);
          u.searchParams.set('widget', definition.id);
          u.searchParams.set('size', String(size));
          setUrl(u.href);
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
      page.close();
    };
  }, [workspaceId, definition.instanceId, definition.entry, definition.id, size, attempt]);
  return error ? (
    <div className="app-widget-error">
      {error}
      <button onClick={() => setAttempt((n) => n + 1)}>重新加载</button>
    </div>
  ) : url ? (
    <iframe ref={ref} src={url} title={definition.name} sandbox="allow-scripts allow-forms" />
  ) : (
    <p>正在加载…</p>
  );
}
export function AppWidgets({
  workspaceId,
  viewport,
  visible,
  canvas,
  notice,
  locate,
}: {
  workspaceId: string;
  viewport: { x: number; y: number; zoom: number };
  visible: boolean;
  canvas: React.RefObject<HTMLElement | null>;
  notice: (s: string) => void;
  locate: (bounds: { x: number; y: number; width: number; height: number }) => void;
}) {
  const [data, setData] = useState<any>({ items: [], catalog: [] }),
    [placing, setPlacing] = useState<any>(null),
    [point, setPoint] = useState({ x: 0, y: 0 }),
    [moving, setMoving] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [dock, setDock] = useState<HTMLElement | null>(null),
    [snap, setSnap] = useState(false);
  useEffect(() => setDock(document.getElementById('desktop-widget-dock')), []);
  const drag = useRef<any>(null),
    alive = useRef(true),
    dropping = useRef(false);
  const [dragging, setDragging] = useState(false),
    [choices, setChoices] = useState<any>(null);
  useEffect(() => {
    const start = () => setDragging(true),
      end = () => setDragging(false);
    window.addEventListener('yirang:widget-drag-start', start);
    window.addEventListener('yirang:widget-drag-end', end);
    return () => {
      window.removeEventListener('yirang:widget-drag-start', start);
      window.removeEventListener('yirang:widget-drag-end', end);
    };
  }, []);
  async function drop(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (dropping.current || busy) return;
    const raw = event.dataTransfer.getData('application/x-yirang-app-widget');
    if (!raw) return;
    const r = canvas.current!.getBoundingClientRect(),
      point = {
        x: (event.clientX - r.left - viewport.x) / viewport.zoom,
        y: (event.clientY - r.top - viewport.y) / viewport.zoom,
      };
    dropping.current = true;
    try {
      const source = JSON.parse(raw);
      if (source.workspaceId !== workspaceId) throw Error('请在原工作区放置组件');
      const next = await call(workspaceId, 'widgets_list');
      if (!alive.current) return;
      setData(next);
      const catalog = next.catalog.filter((w: any) => w.instanceId === source.instanceId);
      if (!catalog.length)
        throw Error(
          '此应用尚未声明桌面小组件。请打开应用 → 桌面小组件 → 让 Codex 创建小组件；应用页面里的指标卡不会自动成为桌面组件。',
        );
      const chosen = source.widgetId ? catalog.find((w: any) => w.id === source.widgetId) : null;
      if (source.widgetId && !chosen) throw Error('小组件定义已变化，请重新选择');
      if (chosen || catalog.length === 1) {
        const w = chosen || catalog[0];
        await save({
          instanceId: w.instanceId,
          widgetId: w.id,
          size: w.sizes.includes(source.size) ? source.size : Math.max(...w.sizes),
          ...point,
        });
      } else setChoices({ catalog, point });
    } catch (error) {
      notice(String(error));
    } finally {
      dropping.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    let live = true,
      pending = false;
    setData({ items: [], catalog: [] });
    setMoving(null);
    setPlacing(null);
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const next = await call(workspaceId, 'widgets_list');
        if (live)
          setData((old: any) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
      } catch (e) {
        if (live) notice(String(e));
      } finally {
        pending = false;
      }
    };
    const place = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.workspaceId === workspaceId) {
        setPlacing(d);
        setPoint({ x: 40, y: 80 });
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlacing(null);
    };
    window.addEventListener('yirang:place-widget', place);
    window.addEventListener('yirang:apps-changed', refresh);
    window.addEventListener('keydown', escape);
    const timer = setInterval(refresh, 15000);
    void refresh();
    return () => {
      live = false;
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener('yirang:place-widget', place);
      window.removeEventListener('yirang:apps-changed', refresh);
      window.removeEventListener('keydown', escape);
    };
  }, [workspaceId]);
  async function save(payload: any) {
    setBusy(true);
    try {
      const value = await call(workspaceId, 'widget_save', payload);
      if (alive.current)
        setData((d: any) => ({
          ...d,
          items: [...d.items.filter((w: any) => w.id !== value.id), value],
        }));
      setEnabled((v) => ({ ...v, [value.id]: true }));
      return true;
    } catch (e) {
      notice(String(e));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const relative = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <>
      {snap && <div className="app-widget-snap-hint">松手固定到顶部 · 不随画布移动</div>}
      {dragging && visible && (
        <div
          className="app-widget-drag-target"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => void drop(e)}
        >
          <span>松手，把小组件放在这里</span>
        </div>
      )}
      {choices && visible && (
        <div
          className="app-widget-drop-choices"
          style={{
            left: Math.max(
              8,
              Math.min(
                viewport.x + choices.point.x * viewport.zoom,
                (canvas.current?.clientWidth || 500) - 300,
              ),
            ),
            top: Math.max(
              8,
              Math.min(
                viewport.y + choices.point.y * viewport.zoom,
                (canvas.current?.clientHeight || 400) - 240,
              ),
            ),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <header>
            选择桌面小组件<button onClick={() => setChoices(null)}>×</button>
          </header>
          {choices.catalog.map((w: any) => (
            <div key={w.id}>
              <strong>{w.name}</strong>
              {w.sizes.map((size: number) => (
                <button
                  disabled={busy}
                  key={size}
                  onClick={() =>
                    void save({
                      instanceId: w.instanceId,
                      widgetId: w.id,
                      size,
                      ...choices.point,
                    }).then((ok) => {
                      if (ok) setChoices(null);
                    })
                  }
                >
                  {size} 格
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {data.items
        .filter((w: any) => w.surface !== 'dashboard')
        .map((w: any) => {
          const def = data.catalog.find(
              (d: any) => d.instanceId === w.instanceId && d.id === w.widgetId,
            ),
            pos = moving?.id === w.id ? moving : w,
            bounds = {
              ...dimensions(w.size),
              ...(pos.width ? { width: pos.width } : {}),
              ...(pos.height ? { height: pos.height } : {}),
            },
            scale = w.pinned ? 1 : viewport.zoom,
            left = viewport.x + pos.x * viewport.zoom,
            top = viewport.y + pos.y * viewport.zoom,
            r = canvas.current?.getBoundingClientRect(),
            inView =
              visible &&
              (w.pinned ||
                (left + bounds.width * scale > 0 &&
                  top + bounds.height * scale > 0 &&
                  left < (r?.width || 0) &&
                  top < (r?.height || 0)));
          const article = (
            <article
              key={w.id}
              className={`app-widget ${w.pinned ? 'is-pinned' : ''}`}
              data-file-ai-object={w.id}
              data-app-widget-instance={w.instanceId}
              data-app-widget-title={def?.name || '小组件'}
              style={{
                left: w.pinned ? undefined : left,
                top: w.pinned ? undefined : top,
                width: Math.round(bounds.width * scale),
                height: Math.round(bounds.height * scale),
                transform: 'none',
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <header
                onPointerDown={(e) => {
                  if (
                    w.pinned ||
                    busy ||
                    e.button !== 0 ||
                    (e.target as HTMLElement).closest('button,select')
                  )
                    return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { ...w, startX: e.clientX, startY: e.clientY };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (d?.id === w.id) {
                    setSnap(e.clientY <= (canvas.current?.getBoundingClientRect().top ?? 0) + 48);
                    setMoving({
                      ...w,
                      x: d.x + (e.clientX - d.startX) / viewport.zoom,
                      y: d.y + (e.clientY - d.startY) / viewport.zoom,
                    });
                  }
                }}
                onPointerUp={(e) => {
                  const d = drag.current;
                  if (d?.id !== w.id) return;
                  drag.current = null;
                  setSnap(false);
                  void save({
                    id: w.id,
                    instanceId: w.instanceId,
                    pinned: e.clientY <= (canvas.current?.getBoundingClientRect().top ?? 0) + 48,
                    x: d.x + (e.clientX - d.startX) / viewport.zoom,
                    y: d.y + (e.clientY - d.startY) / viewport.zoom,
                  }).finally(() => setMoving(null));
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  setMoving(null);
                  setSnap(false);
                }}
              >
                <strong>{def?.name || '组件已移除声明'}</strong>
                <select
                  disabled={busy || !def}
                  value={w.size}
                  aria-label="组件大小"
                  onChange={(e) =>
                    void save({
                      id: w.id,
                      instanceId: w.instanceId,
                      size: Number(e.target.value),
                      ...dimensions(Number(e.target.value)),
                    })
                  }
                >
                  {(def?.sizes || [w.size]).map((n: number) => (
                    <option key={n} value={n}>
                      {n} 格
                    </option>
                  ))}
                </select>
                <button
                  title={w.pinned ? '取消固定，回到画布' : '固定到顶部，不随画布移动'}
                  disabled={busy}
                  onClick={() =>
                    void save({ id: w.id, instanceId: w.instanceId, pinned: !w.pinned })
                  }
                >
                  {w.pinned ? '取消固定' : '固定'}
                </button>
                {!w.pinned && (
                  <button
                    title="完整查看小组件"
                    aria-label="完整查看小组件"
                    onClick={() => locate({ x: pos.x, y: pos.y, ...bounds })}
                  >
                    <Icon name="expand" size={14} />
                  </button>
                )}
                <button
                  title="询问小组件"
                  aria-label="询问小组件"
                  onClick={(e) =>
                    window.dispatchEvent(
                      new CustomEvent('ai-desktop:ask-region', {
                        detail: { node: e.currentTarget.closest('.app-widget') },
                      }),
                    )
                  }
                >
                  问 AI
                </button>
                <button
                  title="打开应用"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent('yirang:open-apps', {
                        detail: { workspaceId, instanceId: w.instanceId },
                      }),
                    )
                  }
                >
                  ↗
                </button>
                <button
                  title="移除小组件"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void call(workspaceId, 'widget_remove', { instanceId: w.instanceId, id: w.id })
                      .then(() =>
                        setData((d: any) => ({
                          ...d,
                          items: d.items.filter((i: any) => i.id !== w.id),
                        })),
                      )
                      .catch((e) => notice(String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  ×
                </button>
              </header>
              <div className="app-widget-body">
                {def && inView && (enabled[w.id] || w.pinned) ? (
                  <WidgetPage workspaceId={workspaceId} definition={def} size={w.size} />
                ) : (
                  <button
                    className="app-widget-load"
                    onClick={() => setEnabled((v) => ({ ...v, [w.id]: true }))}
                  >
                    {def
                      ? enabled[w.id]
                        ? '离开可视区域 · 暂停绘制'
                        : '显示小组件'
                      : '请打开应用更新组件声明'}
                  </button>
                )}
              </div>
              <button
                className="app-widget-resize"
                aria-label="调整小组件大小"
                title="拖动调整大小"
                disabled={busy}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = {
                    id: w.id,
                    mode: 'resize',
                    startX: e.clientX,
                    startY: e.clientY,
                    width: bounds.width,
                    height: bounds.height,
                  };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (d?.id !== w.id || d.mode !== 'resize') return;
                  setMoving({
                    ...w,
                    width: Math.max(220, Math.min(1920, d.width + (e.clientX - d.startX) / scale)),
                    height: Math.max(
                      160,
                      Math.min(1200, d.height + (e.clientY - d.startY) / scale),
                    ),
                  });
                }}
                onPointerUp={(e) => {
                  const d = drag.current;
                  if (d?.id !== w.id || d.mode !== 'resize') return;
                  drag.current = null;
                  void save({
                    id: w.id,
                    instanceId: w.instanceId,
                    width: Math.max(220, Math.min(1920, d.width + (e.clientX - d.startX) / scale)),
                    height: Math.max(
                      160,
                      Math.min(1200, d.height + (e.clientY - d.startY) / scale),
                    ),
                  }).finally(() => setMoving(null));
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  setMoving(null);
                }}
              >
                ⌟
              </button>
            </article>
          );
          return w.pinned && dock ? createPortal(article, dock, w.id) : article;
        })}
      {placing && visible && (
        <div
          className="app-widget-placement"
          onPointerMove={(e) => setPoint(relative(e))}
          onPointerDown={(e) => {
            if (busy || e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const p = relative(e);
            void save({
              instanceId: placing.definition.instanceId,
              widgetId: placing.definition.id,
              size: placing.size,
              x: (p.x - viewport.x) / viewport.zoom,
              y: (p.y - viewport.y) / viewport.zoom,
            }).then((ok) => {
              if (ok) setPlacing(null);
            });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setPlacing(null);
          }}
        >
          <div
            style={{
              left: point.x,
              top: point.y,
              width: dimensions(placing.size).width * viewport.zoom,
              height: dimensions(placing.size).height * viewport.zoom,
            }}
          >
            {placing.definition.name} · {placing.size} 格
          </div>
          <span>点击摆放 · Esc 取消</span>
        </div>
      )}
    </>
  );
}
