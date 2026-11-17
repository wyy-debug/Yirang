import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import type { WebPage } from '../../../packages/contracts/web-workspace.js';
import {
  browserCommand,
  onBrowserEvent,
  takeBrowserCollect,
  type BrowserState,
  type BrowserCapture,
} from './electron-browser-bridge.js';
import { writeDraftNow } from '../documents/draft-storage.js';
import { observeBrowserGeometry } from './browser-geometry.js';
import { Icon } from '../ui/icons.js';
import './browser-workspace.css';
import { useBrowserWindow } from './use-browser-window.js';
import { freePosition, type Rect } from '../../../packages/components/canvas-spatial.js';

type SaveMode = 'capture' | 'material' | 'reference' | 'selection';
type CollectTarget = { id: string; url: string; selection?: string };
type SaveJob = {
  mode: SaveMode;
  snapshot: BrowserCapture;
  page?: WebPage;
  create?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  captureId?: string;
  material?: Record<string, unknown>;
  objectId?: string;
};
type Props = {
  pinTabs: (ids: string[]) => Promise<void>;
  floating: boolean;
  toggleFloating: () => void;
  close: () => void;
  locate: (id: string) => void;
  visibleRect: () => Rect;
  workspace: Workspace;
  currentWorkspace: () => Workspace;
  initialUrl?: { id: string; url: string };
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  reference: (id: string) => Promise<boolean>;
  canReference: boolean;
  openLibrary: () => void;
  dirtyChanged: (value: boolean) => void;
};
const emptyState: BrowserState = { activeId: '', tabs: [] };
function destination(value: string) {
  const input = value.trim();
  if (!input) throw Error(uiText('输入网址或搜索内容'));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return new URL(input).href;
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(input) &&
    !/^localhost:\d+/i.test(input) &&
    !/^\[.*\]:\d+/.test(input) &&
    !/^\d+\.\d+\.\d+\.\d+:\d+/.test(input)
  )
    throw Error(uiText('请输入 HTTP / HTTPS 网址'));
  if (
    !/\s/.test(input) &&
    (/^[^/]+\.[^/]+/.test(input) ||
      /^localhost(?::\d+)?(?:\/|$)/i.test(input) ||
      /^\[.+\]/.test(input))
  )
    return new URL(`${/^(localhost|127\.|\[::1\])/.test(input) ? 'http' : 'https'}://${input}`)
      .href;
  return `https://www.bing.com/search?q=${encodeURIComponent(input)}`;
}
function domain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return uiText('新标签页');
  }
}
const uid = () => crypto.randomUUID();

export function BrowserWorkspace(props: Props) {
  useUiLocale();
  const floating = useBrowserWindow(props.floating),
    movingRef = useRef(false);
  movingRef.current = floating.moving;
  const collectRef = useRef<(mode: SaveMode, target?: CollectTarget) => void>(() => {});
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [state, setState] = useState<BrowserState>(emptyState),
    [address, setAddress] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [findOpen, setFindOpen] = useState(false),
    [findText, setFindText] = useState('');
  const addressInput = useRef<HTMLInputElement>(null),
    findInput = useRef<HTMLInputElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    root = useRef<HTMLElement>(null),
    callbacks = useRef(props),
    live = useRef(true),
    working = useRef(false),
    stateRef = useRef(state),
    openedRequest = useRef('');
  callbacks.current = props;
  stateRef.current = state;
  const pendingKey = `ai-desktop:browser-save:${props.workspace.id}`;
  const [pending, setPending] = useState<SaveJob | null>(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(pendingKey) || 'null');
        return saved &&
          ['capture', 'material', 'reference', 'selection'].includes(saved.mode) &&
          saved.snapshot?.url
          ? saved
          : null;
      } catch {
        return null;
      }
    }),
    pendingRef = useRef(pending);
  const active = state.tabs.find((tab) => tab.id === state.activeId),
    available = !!active?.url && active.documentReady && !active.error;
  async function run(action: string, payload: Record<string, unknown> = {}) {
    try {
      setError('');
      return await browserCommand(action, payload);
    } catch (problem) {
      if (live.current) setError(String((problem as Error).message));
      return null;
    }
  }
  function focusAddress() {
    addressInput.current?.focus();
    addressInput.current?.select();
  }
  useEffect(() => {
    live.current = true;
    const unsubscribe = onBrowserEvent((type, payload) => {
      if (type === 'browser-state') setState(payload);
      if (
        type === 'browser-collect' &&
        (payload?.mode === 'material' || payload?.mode === 'selection')
      )
        collectRef.current(payload.mode, payload);
      if (type === 'browser-notice') setNotice(String(payload));
      if (type === 'browser-focus') {
        if (payload === 'address') focusAddress();
        else setFindOpen(true);
      }
    });
    void browserCommand('state')
      .then((value) => {
        if (live.current) setState(value);
      })
      .catch((problem) => {
        if (live.current) setError(problem.message);
      });
    const collect = takeBrowserCollect();
    if (collect) collectRef.current(collect.mode, collect);
    return () => {
      live.current = false;
      unsubscribe();
      callbacks.current.dirtyChanged(false);
      void browserCommand('layout', { visible: false }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    setAddress(active?.url || '');
    setFindOpen(false);
    setFindText('');
  }, [active?.id, active?.url]);
  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);
  useEffect(() => {
    if (!props.initialUrl || openedRequest.current === props.initialUrl.id) return;
    openedRequest.current = props.initialUrl.id;
    void run('open', { url: props.initialUrl.url });
  }, [props.initialUrl]);
  useEffect(() => {
    let queued = 0,
      last = '';
    const blockers =
      '[role="dialog"],[role="alertdialog"],[data-desktop-overlay],.render-performance,.render-performance-open,.desk-popover-panel,.banner,.connection-recovery,.workspace-manager,.backup-desk,.layout-library,.annotation-recovery-desk,.revision-view,.context-preview,.full-view';
    const measure = () => {
      queued = 0;
      if (!viewport.current) return;
      const rect = viewport.current.getBoundingClientRect(),
        tab = stateRef.current.tabs.find((item) => item.id === stateRef.current.activeId);
      const covered = [...document.querySelectorAll<HTMLElement>(blockers)].some((element) => {
        if (
          root.current?.contains(element) ||
          !element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
        )
          return false;
        const bounds = element.getBoundingClientRect();
        return (
          bounds.right > rect.left &&
          bounds.left < rect.right &&
          bounds.bottom > rect.top &&
          bounds.top < rect.bottom
        );
      });
      const layout = {
        visible:
          !movingRef.current &&
          !document.hidden &&
          !covered &&
          !!tab?.url &&
          !tab.error &&
          !!viewport.current.checkVisibility({ checkVisibilityCSS: true }),
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: rect.width,
        height: rect.height,
      };
      const key = JSON.stringify(layout);
      if (key === last) return;
      last = key;
      void browserCommand('layout', layout).catch((problem) => {
        if (live.current) setError(problem.message);
      });
    };
    const schedule = () => {
      if (!queued) queued = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    if (viewport.current) observer.observe(viewport.current);
    const mutations = observeBrowserGeometry(() => root.current, blockers, schedule);
    const unsubscribe = onBrowserEvent((type) => {
      if (type === 'browser-layout') {
        last = '';
        schedule();
      } else if (type === 'browser-state') schedule();
    });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    schedule();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      unsubscribe();
      cancelAnimationFrame(queued);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, []);
  function remember(job: SaveJob | null) {
    writeDraftNow(pendingKey, job ? JSON.stringify(job) : null);
    pendingRef.current = job;
    if (live.current) setPending(job);
  }
  async function save(mode: SaveMode, retry = false, target?: CollectTarget) {
    if (working.current || (pendingRef.current && !retry)) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    callbacks.current.dirtyChanged(true);
    const api = callbacks.current;
    const ensureLive = () => {
      if (!live.current) throw Error(uiText('保存步骤已保留，返回浏览器可继续'));
    };
    try {
      let job = retry ? pendingRef.current : null;
      if (!job) {
        let snapshot = await browserCommand<BrowserCapture>(
          'capture',
          target ? { id: target.id } : {},
        );
        ensureLive();
        if (target && snapshot.url !== target.url) throw Error(uiText('网页已跳转，请重新收集'));
        if (mode === 'selection') {
          const selection = (target?.selection ?? snapshot.selection).trim();
          if (!selection)
            throw Error(uiText('先在网页中选中文字，再点击摘录；也可以右键收集选中内容'));
          snapshot = { ...snapshot, selection, text: selection, links: [] };
        }
        job = { mode, snapshot };
        remember(job);
      }
      if (!job) throw Error(uiText('没有待恢复的保存请求'));
      if (!job.page) {
        if (!job.create) {
          const result = await api.action('web_workspace', { operation: 'list' });
          ensureLive();
          const existing = (result.pages as WebPage[]).find(
            (page) => page.url === job!.snapshot.url && !page.archived,
          );
          if (existing) job = { ...job, page: existing };
          else
            job = {
              ...job,
              create: {
                operation: 'create',
                requestId: uid(),
                url: job.snapshot.url,
                title: (job.snapshot.title || domain(job.snapshot.url)).slice(0, 300),
              },
            };
          remember(job);
        }
        if (!job.page) {
          const result = await api.action('web_workspace', job.create);
          job = { ...job, page: result.page };
          remember(job);
          ensureLive();
        }
      }
      if (!job.captureId) {
        const { selection: _, ...capture } = job.snapshot;
        if (!job.capture) {
          job = {
            ...job,
            capture: {
              operation: 'capture',
              requestId: uid(),
              pageId: job.page!.id,
              expectedRevision: job.page!.revision,
              source: 'desktop-browser',
              capture,
            },
          };
          remember(job);
        }
        const result = await api.action('web_workspace', job.capture);
        job = { ...job, page: result.page, captureId: result.capture.id };
        remember(job);
        ensureLive();
        if (result.captureRetained === false)
          throw Error(uiText('这份快照已移出历史保留范围，请结束此请求后重新保存当前网页'));
      }
      if (job.mode !== 'capture' && !job.objectId) {
        if (!job.material) {
          const id = job.mode === 'selection' ? undefined : job.page!.linkedObjects.md;
          // Read the current original object's revision; never silently replace a local draft.
          await api.updated();
          ensureLive();
          const original = api.currentWorkspace().objects.find((object) => object.id === id);
          if (id && !original) throw Error(uiText('关联桌面文件尚未载入，请稍后继续保存'));
          job = {
            ...job,
            material: {
              operation: 'materialize',
              requestId: uid(),
              pageId: job.page!.id,
              expectedRevision: job.page!.revision,
              captureId: job.captureId,
              format: 'md',
              ...(job.mode === 'selection' ? { separate: true } : {}),
              ...(!original
                ? {
                    bounds: freePosition(
                      { width: 420, height: 320 },
                      api
                        .currentWorkspace()
                        .objects.filter((item) => !item.archived)
                        .map((item) => ({ ...item.bounds, height: item.bounds.height + 40 })),
                      api.visibleRect(),
                    ),
                  }
                : {}),
              ...(original ? { expectedObjectRevision: original.revision } : {}),
            },
          };
          remember(job);
        }
        const result = await api.action('web_workspace', job.material);
        job = { ...job, objectId: result.object.id, page: result.page };
        remember(job);
        ensureLive();
      }
      if (job.objectId) {
        await api.updated();
        ensureLive();
      }
      if (job.mode === 'reference' && job.objectId) {
        const attached = await api.reference(job.objectId);
        ensureLive();
        if (!attached) throw Error(uiText('网页已保存，引用尚未完成；可继续原请求'));
      }
      if (job.objectId) setLastSaved(job.objectId);
      remember(null);
      setNotice(
        job.mode === 'selection'
          ? uiText('选中文字已放到桌面，来源链接与采集时间一并保留')
          : job.mode === 'capture'
            ? uiText('网页快照已保存到网页资料')
            : job.mode === 'reference'
              ? uiText('网页已保存并引用到 Codex，在对话区输入你的要求即可')
              : uiText('已保存为桌面 Markdown 文件；后续保存更新同一文件'),
      );
    } catch (problem) {
      if (live.current) setError((problem as Error).message);
    } finally {
      working.current = false;
      if (live.current) {
        setBusy(false);
        callbacks.current.dirtyChanged(false);
      }
    }
  }
  collectRef.current = (mode, target) => {
    void save(mode, false, target);
  };
  async function navigate() {
    try {
      await run('navigate', { url: destination(address) });
    } catch (problem) {
      setError((problem as Error).message);
    }
  }
  function find(forward = true) {
    void run('find', { text: findText, forward, findNext: true });
  }
  function closeFind() {
    setFindOpen(false);
    void run('find', { text: '' });
  }
  return (
    <section
      ref={root}
      className={`browser-workspace ${props.floating ? 'browser-floating' : ''} ${floating.moving ? 'browser-moving' : ''}`}
      style={floating.style}
      aria-label={uiText('浏览器')}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (!(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (['l', 't', 'w', 'r', 'f'].includes(key)) {
          event.preventDefault();
          if (key === 'l') focusAddress();
          if (key === 't') void run('new').then(focusAddress);
          if (key === 'w') void run('close');
          if (key === 'r') void run('reload');
          if (key === 'f') setFindOpen(true);
        }
      }}
    >
      <header
        className="browser-window-bar"
        onPointerDown={(event) => floating.start(event)}
        onDoubleClick={(event) => {
          if (!(event.target as Element).closest('button')) props.toggleFloating();
        }}
      >
        <Icon name="compass" size={14} />
        <strong>{uiText('浏览器')}</strong>
        <button
          title={props.floating ? uiText('展开浏览器') : uiText('小窗浏览')}
          aria-label={props.floating ? uiText('展开浏览器') : uiText('小窗浏览')}
          onClick={props.toggleFloating}
        >
          <Icon name={props.floating ? 'expand' : 'layout'} size={14} />
        </button>
        <button
          title={uiText('收起浏览器，保留标签页')}
          aria-label={uiText('收起浏览器')}
          disabled={busy}
          onClick={props.close}
        >
          <Icon name="minus" size={15} />
        </button>
      </header>
      <div className="browser-tabs" role="tablist" aria-label={uiText('浏览器标签')}>
        {state.tabs.map((tab) => (
          <div className={`browser-tab${tab.id === state.activeId ? ' active' : ''}`} key={tab.id}>
            <button
              role="tab"
              aria-selected={tab.id === state.activeId}
              onClick={() => void run('switch', { id: tab.id })}
              title={tab.url || uiText('新标签页')}
            >
              <span className={`browser-site-letter${tab.loading ? ' loading' : ''}`}>
                {tab.url ? (
                  domain(tab.url)
                    .replace(/^www\./, '')[0]
                    .toUpperCase()
                ) : (
                  <Icon name="compass" size={13} />
                )}
              </span>
              <span>{tab.title || domain(tab.url)}</span>
            </button>
            <button
              title={uiText('关闭 {0}', { '0': tab.title })}
              aria-label={uiText('关闭 {0}', { '0': tab.title })}
              onClick={() => void run('close', { id: tab.id })}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <button
          className="browser-new"
          aria-label={uiText('新标签页')}
          title={uiText('新标签页 · Ctrl / ⌘ T')}
          disabled={state.tabs.length >= 20}
          onClick={() => void run('new').then(focusAddress)}
        >
          <Icon name="plus" size={17} />
        </button>
      </div>
      <div className="browser-address-row">
        <div className="browser-nav-buttons">
          <button
            title={uiText('后退')}
            aria-label={uiText('后退')}
            disabled={!active?.canGoBack}
            onClick={() => void run('back')}
          >
            <Icon name="arrow" className="browser-back" size={17} />
          </button>
          <button
            title={uiText('前进')}
            aria-label={uiText('前进')}
            disabled={!active?.canGoForward}
            onClick={() => void run('forward')}
          >
            <Icon name="arrow" size={17} />
          </button>
          <button
            title={active?.loading ? uiText('停止载入') : uiText('重新载入')}
            aria-label={active?.loading ? uiText('停止载入') : uiText('重新载入')}
            disabled={!active?.url}
            onClick={() => void run(active?.loading ? 'stop' : 'reload')}
          >
            <Icon name={active?.loading ? 'close' : 'history'} size={17} />
          </button>
        </div>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <Icon name="compass" size={15} />
          <input
            ref={addressInput}
            aria-label={uiText('网址或搜索内容')}
            value={address}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={uiText('搜索，或输入网址')}
            spellCheck={false}
            autoComplete="off"
          />
          <button aria-label={uiText('访问')} title={uiText('访问')} disabled={!address.trim()}>
            <Icon name="arrow" size={15} />
          </button>
        </form>
        <button
          className="browser-icon-button"
          title={uiText('在系统浏览器打开')}
          aria-label={uiText('在系统浏览器打开')}
          disabled={!active?.url}
          onClick={() => void run('external')}
        >
          <Icon name="expand" size={17} />
        </button>
      </div>
      {!!active?.url && (
        <div className="browser-material-actions">
          <button
            disabled={!active?.url || busy || !!pending}
            onClick={() => void props.pinTabs([state.activeId])}
          >
            <Icon name="desktop" size={14} />
            {uiText('当前页放到画布')}
          </button>
          <button
            disabled={!state.tabs.some((tab) => tab.url) || busy || !!pending}
            onClick={() =>
              void props.pinTabs(state.tabs.filter((tab) => tab.url).map((tab) => tab.id))
            }
          >
            {uiText('全部页面放到画布')}
          </button>
          <span>{uiText('收集资料')}</span>
          <button onClick={() => void run('files-open')}>{uiText('下载与上传')}</button>
          <button disabled={!available || busy || !!pending} onClick={() => void save('capture')}>
            <Icon name="star" size={14} />
            {uiText('保存到网页资料')}
          </button>
          <button disabled={!available || busy || !!pending} onClick={() => void save('material')}>
            <Icon name="plus" size={14} />
            {uiText('整页保存为文档')}
          </button>
          <button disabled={!available || busy || !!pending} onClick={() => void save('selection')}>
            <Icon name="pen" size={14} />
            {uiText('摘录选中文字')}
          </button>
          <button
            className="browser-reference"
            disabled={!available || busy || !!pending || !props.canReference}
            onClick={() => void save('reference')}
          >
            <Icon name="link" size={14} />
            {uiText('引用到 Codex')}
          </button>
          <button className="browser-library" disabled={busy} onClick={props.openLibrary}>
            {uiText('网页资料')}
            <Icon name="arrow" size={13} />
          </button>
        </div>
      )}
      {findOpen && (
        <form
          className="browser-find"
          onSubmit={(event) => {
            event.preventDefault();
            find();
          }}
        >
          <Icon name="search" size={14} />
          <input
            ref={findInput}
            value={findText}
            onChange={(event) => {
              setFindText(event.target.value);
              void run('find', { text: event.target.value, findNext: false });
            }}
            placeholder={uiText('在网页中查找')}
            aria-label={uiText('在网页中查找')}
          />
          <button type="button" onClick={() => find(false)}>
            {uiText('上一处')}
          </button>
          <button type="submit">{uiText('下一处')}</button>
          <button type="button" onClick={closeFind} aria-label={uiText('关闭查找')}>
            <Icon name="close" size={13} />
          </button>
        </form>
      )}
      {(error || notice || pending || busy || state.persistError) && (
        <div className={`browser-feedback${error ? ' attention' : ''}`} role="status">
          <span>
            {busy
              ? uiText('正在保存当前网页…')
              : error || notice || state.persistError || uiText('有一份未完成的网页保存请求')}
          </span>
          {lastSaved && !busy && (
            <button onClick={() => props.locate(lastSaved)}>
              {uiText('定位桌面文件')}
              <Icon name="arrow" size={12} />
            </button>
          )}
          {pending && !busy && (
            <>
              <button onClick={() => void save(pending.mode, true)}>{uiText('继续保存')}</button>
              <button
                onClick={() => {
                  remember(null);
                  setError('');
                  setNotice(uiText('已结束此请求，已完成的保存仍保留在网页资料中'));
                }}
              >
                {uiText('结束此请求')}
              </button>
            </>
          )}
          {!pending && !busy && (
            <button
              title={uiText('关闭提示')}
              aria-label={uiText('关闭提示')}
              onClick={() => {
                setError('');
                setNotice('');
              }}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      )}
      <div className="browser-viewport" ref={viewport}>
        {active?.error ? (
          <div className="browser-empty">
            <Icon name="compass" size={38} />
            <h2>{uiText('这个网页暂时打不开')}</h2>
            <p>{active.error}</p>
            <div>
              <button onClick={() => void run('reload')}>{uiText('重新载入')}</button>
              <button onClick={() => void run('external')}>{uiText('在系统浏览器打开')}</button>
            </div>
          </div>
        ) : !active?.url ? (
          <div className="browser-empty">
            <span className="browser-empty-icon">
              <Icon name="compass" size={34} />
            </span>
            <h2>{uiText('从一个网页开始。')}</h2>
            <p>{uiText('浏览、收集，再把内容带回桌面。')}</p>
            <button className="browser-empty-search" onClick={focusAddress}>
              <Icon name="search" size={17} />
              <span>{uiText('搜索，或在地址栏输入网址')}</span>
              <kbd>Ctrl / ⌘ L</kbd>
            </button>
            <button className="browser-open-library" onClick={props.openLibrary}>
              {uiText('查看已保存的网页')}
              <Icon name="arrow" size={14} />
            </button>
          </div>
        ) : (
          <div className="browser-native-placeholder" aria-hidden="true">
            {active.loading ? uiText('正在载入网页…') : ''}
          </div>
        )}
      </div>
      {props.floating && (
        <button
          className="browser-window-resize"
          title={uiText('拖动调整浏览器大小')}
          aria-label={uiText('调整浏览器大小')}
          onPointerDown={(event) => floating.start(event, true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') props.toggleFloating();
          }}
        >
          ◢
        </button>
      )}
    </section>
  );
}
