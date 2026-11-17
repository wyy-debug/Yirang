import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState, type RefObject } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import {
  browserCommand,
  onBrowserEvent,
  queueBrowserCollect,
  type BrowserState,
  type BrowserTab,
  type BrowserPlacement,
} from './electron-browser-bridge.js';
import { freePosition, extent, type Rect } from '../../../packages/components/canvas-spatial.js';
import { Icon } from '../ui/icons.js';
import './browser-canvas.css';
import { observeBrowserGeometry } from './browser-geometry.js';

type Options = {
  enabled: boolean;
  workspace: Workspace | null;
  view: Rect;
  occupied: Rect[];
  showCanvas: () => Promise<boolean>;
  fit: (bounds: Rect) => void;
  notice: (message: string) => void;
};
export function useBrowserCanvas(options: Options) {
  const [state, setState] = useState<BrowserState>({ activeId: '', tabs: [] }),
    latest = useRef(options),
    current = useRef(state),
    pinning = useRef(false);
  latest.current = options;
  current.current = state;
  useEffect(() => {
    if (!options.enabled || !options.workspace) return;
    let live = true;
    const off = onBrowserEvent((type, payload) => {
      if (type === 'browser-state') setState(payload);
      if (type === 'browser-pin') void pinTabs([payload.id]);
    });
    void browserCommand('state')
      .then((value) => {
        if (live) setState(value);
      })
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, [options.enabled, options.workspace?.id]);
  useEffect(() => {
    if (state.persistError) latest.current.notice(state.persistError);
  }, [state.persistError]);
  async function pinTabs(ids: string[]) {
    const context = latest.current,
      workspace = context.workspace;
    if (!workspace || pinning.current) return;
    pinning.current = true;
    const placed: Rect[] = [],
      occupied = [...context.occupied];
    try {
      const snapshot = await browserCommand('state');
      current.current = snapshot;
      setState(snapshot);
      occupied.push(
        ...snapshot.tabs
          .filter((tab) => tab.canvas?.workspaceId === workspace.id)
          .map((tab) => tab.canvas!),
      );
      for (const id of [...new Set(ids)]) {
        if (latest.current.workspace?.id !== workspace.id)
          throw Error(uiText('工作区已切换，请在当前工作区重新放置网页'));
        const tab = current.current.tabs.find((tab) => tab.id === id);
        if (!tab?.url) continue;
        if (tab.canvas?.workspaceId === workspace.id) {
          placed.push(tab.canvas);
          continue;
        }
        const bounds = freePosition({ width: 620, height: 460 }, occupied, context.view);
        const result = await browserCommand('pin', {
          id,
          bounds: { ...bounds, workspaceId: workspace.id },
        });
        current.current = result;
        setState(result);
        occupied.push(bounds);
        placed.push(bounds);
      }
      if (
        placed.length &&
        latest.current.workspace?.id === workspace.id &&
        (await latest.current.showCanvas())
      )
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (latest.current.workspace?.id !== workspace.id) return;
            const bounds = extent(placed);
            if (bounds) latest.current.fit(bounds);
          }),
        );
    } catch (error) {
      latest.current.notice((error as Error).message);
    } finally {
      pinning.current = false;
    }
  }
  return { state, pinTabs };
}

type Props = {
  state: BrowserState;
  workspaceId: string;
  viewport: { x: number; y: number; zoom: number };
  canvas: RefObject<HTMLElement | null>;
  visible: boolean;
  interactive: boolean;
  notice: (text: string) => void;
  open: (id: string) => void;
  locate: (bounds: Rect) => void;
};
export function BrowserCanvas(props: Props) {
  useUiLocale();
  const root = useRef<HTMLDivElement>(null),
    latest = useRef(props),
    cleanup = useRef<() => void>(() => {});
  latest.current = props;
  const measureRequest = useRef<() => void>(() => {}),
    viewportMoving = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, BrowserPlacement>>({}),
    [moving, setMoving] = useState(false),
    [front, setFront] = useState('');
  const live = useRef({ moving, drafts, front });
  live.current = { moving, drafts, front };
  const tabs = props.state.tabs.filter((tab) => tab.canvas?.workspaceId === props.workspaceId),
    ordered = front
      ? [...tabs.filter((tab) => tab.id !== front), ...tabs.filter((tab) => tab.id === front)]
      : tabs;
  async function run(action: string, payload: Record<string, unknown>) {
    try {
      return await browserCommand(action, payload);
    } catch (error) {
      latest.current.notice((error as Error).message);
    }
  }
  async function save(id: string, bounds: BrowserPlacement) {
    const result = await run('pin', { id, bounds });
    if (result)
      setDrafts((previous) => {
        if (previous[id] !== bounds) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      });
    else latest.current.notice(uiText('网页位置未保存，可再次拖动重试。'));
  }
  function drag(event: React.PointerEvent<HTMLElement>, tab: BrowserTab, resize = false) {
    if (
      !props.interactive ||
      event.button !== 0 ||
      (!resize && (event.target as Element).closest('button,input'))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    cleanup.current();
    setFront(tab.id);
    setMoving(true);
    const start = drafts[tab.id] || tab.canvas!,
      x = event.clientX,
      y = event.clientY,
      node = event.currentTarget,
      pointer = event.pointerId,
      zoom = props.viewport.zoom;
    let value = start;
    node.setPointerCapture(pointer);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      const dx = (next.clientX - x) / zoom,
        dy = (next.clientY - y) / zoom;
      value = resize
        ? {
            ...start,
            width: Math.min(2000, Math.max(360, start.width + dx)),
            height: Math.min(1600, Math.max(240, start.height + dy)),
          }
        : {
            ...start,
            x: Math.max(-100000, Math.min(100000, start.x + dx)),
            y: Math.max(-100000, Math.min(100000, start.y + dy)),
          };
      setDrafts((previous) => ({ ...previous, [tab.id]: value }));
    };
    const clean = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', cancel);
      if (node.hasPointerCapture(pointer)) node.releasePointerCapture(pointer);
      cleanup.current = () => {};
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      clean();
      setMoving(false);
      if (value !== start) void save(tab.id, value);
    };
    const cancel = () => {
      clean();
      setMoving(false);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[tab.id];
        return next;
      });
    };
    cleanup.current = cancel;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', cancel);
  }
  useEffect(() => () => cleanup.current(), []);
  useEffect(() => {
    measureRequest.current();
  }, [props.visible, props.interactive, props.state, drafts, moving, front]);
  useEffect(() => {
    viewportMoving.current = true;
    measureRequest.current();
    const timer = setTimeout(() => {
      viewportMoving.current = false;
      measureRequest.current();
    }, 140);
    return () => clearTimeout(timer);
  }, [props.viewport.x, props.viewport.y, props.viewport.zoom]);
  useEffect(() => {
    let queued = 0,
      last = '';
    const blockerSelector =
      '[role="dialog"],[role="alertdialog"],[data-desktop-overlay],.render-performance,.render-performance-open,.desk-popover-panel,.banner,.browser-workspace,.material-dock,.canvas-board-toolbar,.canvas-navigation,.canvas-group-strip,.file-browser,.desk-navigator,.canvas-browser-overview[open]';
    const measure = () => {
      queued = 0;
      const p = latest.current,
        canvas = p.canvas.current,
        items: Record<string, unknown>[] = [];
      if (
        canvas &&
        root.current &&
        p.visible &&
        p.interactive &&
        !live.current.moving &&
        !viewportMoving.current &&
        !document.hidden &&
        p.state.tabs.some((tab) => tab.canvas?.workspaceId === p.workspaceId)
      ) {
        const boundary = canvas.getBoundingClientRect(),
          windows = [...root.current.querySelectorAll<HTMLElement>('.canvas-browser-window')];
        const blockers = [...document.querySelectorAll<HTMLElement>(blockerSelector)]
          .filter((element) =>
            element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
          )
          .map((element) => element.getBoundingClientRect());
        const windowRects = windows.map((element) => element.getBoundingClientRect());
        windows.forEach((window, index) => {
          const body = window.querySelector<HTMLElement>('.canvas-browser-page');
          if (!body) return;
          const rect = body.getBoundingClientRect();
          const overlaps = (other: DOMRect) =>
            other.right > rect.left &&
            other.left < rect.right &&
            other.bottom > rect.top &&
            other.top < rect.bottom;
          const covered = blockers.some(overlaps) || windowRects.slice(index + 1).some(overlaps);
          const inside =
            rect.left >= boundary.left &&
            rect.top >= boundary.top &&
            rect.right <= boundary.right &&
            rect.bottom <= boundary.bottom;
          if (!covered && inside && rect.width > 30 && rect.height > 30)
            items.push({
              id: window.dataset.tabId,
              workspaceId: p.workspaceId,
              visible: true,
              x: Math.max(0, rect.x),
              y: Math.max(0, rect.y),
              width: rect.width,
              height: rect.height,
            });
        });
      }
      const key = JSON.stringify(items);
      if (last === key) return;
      last = key;
      void browserCommand('canvas-layout', { items }).catch(() => {});
    };
    const schedule = () => {
      if (!queued) queued = requestAnimationFrame(measure);
    };
    measureRequest.current = schedule;
    const resize = new ResizeObserver(schedule);
    if (props.canvas.current) resize.observe(props.canvas.current);
    const mutations = observeBrowserGeometry(
      () => root.current,
      blockerSelector,
      () => {
        if (
          latest.current.visible &&
          latest.current.state.tabs.some(
            (tab) => tab.canvas?.workspaceId === latest.current.workspaceId,
          )
        )
          schedule();
      },
    );
    const off = onBrowserEvent((type, payload) => {
      if (type === 'browser-layout') {
        last = '';
        schedule();
      }
      if (!latest.current.visible) return;
      if (
        type === 'browser-collect' &&
        (payload?.mode === 'material' || payload?.mode === 'selection')
      ) {
        queueBrowserCollect(payload);
        latest.current.open(payload.id);
      }
      if (type === 'browser-focus') {
        const id = latest.current.state.activeId,
          tab = latest.current.state.tabs.find((tab) => tab.id === id);
        if (!tab?.canvas || tab.canvas.workspaceId !== latest.current.workspaceId) return;
        if (payload === 'address') {
          latest.current.locate(tab.canvas);
          const window = [
              ...(root.current?.querySelectorAll<HTMLElement>('.canvas-browser-window') ?? []),
            ].find((element) => element.dataset.tabId === id),
            input = window?.querySelector<HTMLInputElement>('input');
          input?.focus();
          input?.select();
        } else latest.current.open(id);
      }
    });
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      measureRequest.current = () => {};
      cancelAnimationFrame(queued);
      resize.disconnect();
      mutations.disconnect();
      off();
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('resize', schedule);
      void browserCommand('canvas-layout', { items: [] }).catch(() => {});
    };
  }, [props.workspaceId]);
  return (
    <div
      ref={root}
      className="browser-canvas-layer"
      hidden={!props.visible}
      style={{ pointerEvents: 'none' }}
    >
      {tabs.length > 0 && (
        <details className="canvas-browser-overview" onKeyDown={(event) => event.stopPropagation()}>
          <summary>
            {uiText('网页 ·')}
            {tabs.length}
          </summary>
          <button
            onClick={() => {
              const bounds = extent(tabs.map((tab) => drafts[tab.id] || tab.canvas!));
              if (bounds) props.locate(bounds);
            }}
          >
            {uiText('查看全部网页')}
          </button>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              title={tab.url}
              onClick={(event) => {
                setFront(tab.id);
                event.currentTarget.closest('details')?.removeAttribute('open');
                props.locate(drafts[tab.id] || tab.canvas!);
              }}
            >
              <Icon name="compass" size={13} />
              <span>{tab.title || tab.url}</span>
            </button>
          ))}
        </details>
      )}
      {ordered.map((tab) => {
        const bounds = drafts[tab.id] || tab.canvas!;
        return (
          <article
            key={tab.id}
            data-tab-id={tab.id}
            className="canvas-browser-window"
            style={{
              left: props.viewport.x + bounds.x * props.viewport.zoom,
              top: props.viewport.y + bounds.y * props.viewport.zoom,
              width: bounds.width,
              height: bounds.height,
              transform: `scale(${props.viewport.zoom})`,
              pointerEvents: props.interactive ? 'auto' : 'none',
            }}
            onPointerDown={() => setFront(tab.id)}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <header
              onPointerDown={(event) => drag(event, tab)}
              onDoubleClick={(event) => {
                if (!(event.target as Element).closest('button')) props.open(tab.id);
              }}
            >
              <Icon name="compass" size={15} />
              <strong title={tab.title}>{tab.title || uiText('浏览器')}</strong>
              <button
                title={uiText('展开浏览器')}
                aria-label={uiText('展开浏览器')}
                onClick={() => props.open(tab.id)}
              >
                <Icon name="expand" size={14} />
              </button>
              <button
                title={uiText('从画布收起，保留浏览器标签')}
                aria-label={uiText('收起网页窗口')}
                onClick={() => void run('unpin', { id: tab.id, workspaceId: props.workspaceId })}
              >
                <Icon name="minus" size={14} />
              </button>
            </header>
            <div className="canvas-browser-address">
              <button
                disabled={!tab.canGoBack}
                title={uiText('后退')}
                onClick={() => void run('back', { id: tab.id })}
              >
                ←
              </button>
              <button
                disabled={!tab.canGoForward}
                title={uiText('前进')}
                onClick={() => void run('forward', { id: tab.id })}
              >
                →
              </button>
              <button
                title={tab.loading ? uiText('停止加载') : uiText('刷新')}
                onClick={() => void run(tab.loading ? 'stop' : 'reload', { id: tab.id })}
              >
                <Icon name={tab.loading ? 'close' : 'history'} size={13} />
              </button>
              <form
                key={tab.url}
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = event.currentTarget.elements.namedItem('url') as HTMLInputElement;
                  let url = input.value.trim();
                  if (!/^https?:\/\//i.test(url))
                    url = /^[^\s]+\.[^\s]+$/.test(url)
                      ? 'https://' + url
                      : 'https://www.bing.com/search?q=' + encodeURIComponent(url);
                  void run('navigate', { id: tab.id, url });
                }}
              >
                <input
                  name="url"
                  defaultValue={tab.url}
                  aria-label={uiText('网页地址')}
                  spellCheck={false}
                />
              </form>
            </div>
            <div className="canvas-browser-page">
              <div>
                <Icon name="compass" size={26} />
                <p>
                  {tab.error ||
                    (moving
                      ? uiText('移动网页窗口…')
                      : tab.loading
                        ? uiText('正在载入…')
                        : uiText('网页窗口'))}
                </p>
                <button onClick={() => props.locate(bounds)}>{uiText('定位网页')}</button>
                <button onClick={() => props.open(tab.id)}>{uiText('展开浏览')}</button>
              </div>
            </div>
            <footer>
              <span>
                {drafts[tab.id] ? uiText('位置待保存') : uiText('浏览器网页 · 拖动标题移动')}
              </span>
              <button
                className="canvas-browser-resize"
                aria-label={uiText('拖动调整网页大小')}
                title={uiText('拖动调整大小')}
                onPointerDown={(event) => drag(event, tab, true)}
              >
                ◢
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
