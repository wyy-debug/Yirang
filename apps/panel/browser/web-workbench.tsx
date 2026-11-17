import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { retainEqual } from '../workspace/workspace-refresh.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  WebUrl,
  type WebNote,
  type WebPage,
  type WebPageDetail,
  type WebSession,
} from '../../../packages/contracts/web-workspace.js';
import { Icon } from '../ui/icons.js';
import { PanelActionError } from '../host.js';
import {
  flushDraftStorage,
  writeDraftNow,
} from '../documents/draft-storage.js';
import { WebPlayground } from './web-playground.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import './web-workbench.css';
import {
  date,
  domain,
  Empty,
  local,
  message,
  uid,
  urlFor,
} from './web-workbench-shared.js';
import type {
  Dirty,
  Mutate,
  Pending,
  Selection,
  Task,
  WebTaskRequest,
  WebWorkbenchProps,
} from './web-workbench-shared.js';
import { PageEditor } from './web-page-editor.js';
import { CaptureCompare, CaptureEditor, NotesPanel } from './web-capture.js';
import { FormsPanel } from './web-forms.js';
import { TasksPanel } from './web-workbench-tasks.js';

export type { WebTaskRequest, WebWorkbenchProps } from './web-workbench-shared.js';

export function WebWorkbench(props: WebWorkbenchProps) {
  useUiLocale();
  const content = <Workbench key={props.workspace.id} {...props} />;
  return isIntegratedDesktop ? content : createPortal(content, document.body);
}
function Workbench(props: WebWorkbenchProps) {
  useUiLocale();
  const callbacks = useRef(props);
  callbacks.current = props;
  const live = useRef(true),
    working = useRef(false),
    reading = useRef(false),
    initialized = useRef(false),
    requestSequence = useRef(0);
  const pendingKey = `ai-desktop:web-pending:${props.workspace.id}`;
  const [pages, setPages] = useState<WebPage[]>([]),
    [session, setSession] = useState<WebSession>({
      revision: 0,
      tabs: [],
      history: [],
      updatedAt: '',
    }),
    [selected, setSelected] = useState<string>(),
    [detail, setDetail] = useState<WebPageDetail>();
  const selectedRef = useRef(selected),
    detailRef = useRef(detail),
    sessionRef = useRef(session);
  selectedRef.current = selected;
  detailRef.current = detail;
  sessionRef.current = session;
  const [pending, setPending] = useState<Pending | null>(() => local(pendingKey, null)),
    pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [address, setAddress] = useState('');
  const [view, setView] = useState<'read' | 'compare' | 'forms' | 'playground'>('read'),
    [inspector, setInspector] = useState<'notes' | 'tasks'>('tasks'),
    [inspectorOpen, setInspectorOpen] = useState(false),
    [captureId, setCaptureId] = useState<string>(),
    [tasks, setTasks] = useState<Task[]>([]);
  const [editor, setEditor] = useState<{ page?: WebPage } | null>(null),
    [captureOpen, setCaptureOpen] = useState(false),
    [showHistory, setShowHistory] = useState(false),
    [pageListOpen, setPageListOpen] = useState(() => window.innerWidth > 1000),
    [selection, setSelection] = useState<Selection | null>(null),
    [highlight, setHighlight] = useState<Selection | null>(null);
  const [playgroundDirty, setPlaygroundDirty] = useState(false),
    playgroundDirtyRef = useRef(false),
    dirtyKeys = useRef(new Set<string>()),
    reader = useRef<HTMLPreElement>(null);
  const dirty = useCallback<Dirty>((key, value) => {
    if (value) dirtyKeys.current.add(key);
    else dirtyKeys.current.delete(key);
    callbacks.current.dirtyChanged?.(
      playgroundDirtyRef.current ||
        dirtyKeys.current.size > 0 ||
        working.current ||
        !!pendingRef.current,
    );
  }, []);
  const nativeDirty = useCallback((value: boolean) => {
    playgroundDirtyRef.current = value;
    setPlaygroundDirty(value);
    callbacks.current.dirtyChanged?.(
      value || dirtyKeys.current.size > 0 || working.current || !!pendingRef.current,
    );
  }, []);
  useEffect(() => {
    callbacks.current.dirtyChanged?.(
      playgroundDirtyRef.current || dirtyKeys.current.size > 0 || busy || !!pending,
    );
  }, [busy, pending]);
  const locked = busy || !!pending,
    matching = detail?.page.id === selected ? detail : undefined,
    page = matching?.page,
    captures = matching?.captures ?? [],
    capture =
      captures.find((item) => item.id === captureId) ??
      captures.find((item) => item.id === page?.latestCaptureId) ??
      captures[0];
  const groups = [
      ...new Set(pages.filter((item) => !item.archived && item.group).map((item) => item.group)),
    ].sort(),
    tags = [...new Set(pages.filter((item) => !item.archived).flatMap((item) => item.tags))].sort();
  const filtered = pages.filter(
    (item) =>
      (filter === 'archive' ? item.archived : !item.archived) &&
      (filter !== 'favorites' || item.favorite) &&
      (!filter.startsWith('group:') || item.group === filter.slice(6)) &&
      (!filter.startsWith('tag:') || item.tags.includes(filter.slice(4))) &&
      (!search ||
        [item.title, item.url, item.group, ...item.tags]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())),
  );

  function mergePage(next: WebPage) {
    setPages((previous) =>
      [next, ...previous.filter((item) => item.id !== next.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    );
    if (
      detailRef.current?.page.id === next.id &&
      detailRef.current.page.revision <= next.revision
    ) {
      const value = { ...detailRef.current, page: next };
      detailRef.current = value;
      setDetail(value);
    }
  }
  function choose(id?: string) {
    selectedRef.current = id;
    setSelected(id);
    setCaptureId(undefined);
    setSelection(null);
    setHighlight(null);
    setTasks([]);
    if (id !== detailRef.current?.page.id) {
      detailRef.current = undefined;
      setDetail(undefined);
    }
    setShowHistory(false);
  }
  async function readPage(id: string) {
    const sequence = ++requestSequence.current;
    const value = (await callbacks.current.action('web_workspace', {
      operation: 'read',
      pageId: id,
    })) as WebPageDetail;
    if (!live.current || selectedRef.current !== id || sequence !== requestSequence.current) return;
    if (detailRef.current?.page.id === id && detailRef.current.page.revision > value.page.revision)
      return;
    detailRef.current = value;
    setDetail(value);
    mergePage(value.page);
  }
  async function refresh(quiet = false) {
    if (reading.current) return;
    reading.current = true;
    try {
      const result = await callbacks.current.action('web_workspace', {
        operation: 'list',
        includeArchived: true,
      });
      if (!live.current) return;
      setPages((previous) => retainEqual(previous, result.pages ?? []));
      if (result.session.revision >= sessionRef.current.revision) {
        sessionRef.current = retainEqual(sessionRef.current, result.session);
        setSession(sessionRef.current);
      }
      if (!initialized.current) {
        initialized.current = true;
        const tab = result.session.tabs.find((item: any) => item.id === result.session.activeTabId),
          id = tab?.pageId ?? result.pages.find((item: WebPage) => !item.archived)?.id;
        if (id) choose(id);
      }
      const id = selectedRef.current,
        known = detailRef.current,
        latest = result.pages.find((item: WebPage) => item.id === id);
      if (id && (!quiet || known?.page.id !== id || latest?.revision !== known?.page.revision))
        await readPage(id);
      if (id) {
        const work = await callbacks.current.action('web_task', { operation: 'list', pageId: id });
        if (live.current && selectedRef.current === id)
          setTasks((previous) => retainEqual(previous, work.tasks ?? []));
      } else setTasks((previous) => (previous.length ? [] : previous));
    } catch (problem) {
      if (!quiet && live.current) setError(message(problem));
    } finally {
      reading.current = false;
      if (live.current) setLoading(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden && !working.current) void refresh(true);
    }, 4000);
    return () => {
      live.current = false;
      clearInterval(timer);
      requestSequence.current++;
      flushDraftStorage();
      callbacks.current.dirtyChanged?.(false);
    };
  }, []);
  useEffect(() => {
    if (selected)
      void readPage(selected).catch((problem) => {
        if (live.current) setError(message(problem));
      });
  }, [selected]);
  useEffect(() => {
    setAddress(page?.url ?? '');
  }, [page?.id, page?.url]);
  useEffect(() => {
    if (highlight && capture?.id === highlight.captureId)
      reader.current
        ?.querySelector('mark')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight, capture?.id]);
  function persistPending(next: Pending | null) {
    writeDraftNow(pendingKey, next ? JSON.stringify(next) : null);
    pendingRef.current = next;
    setPending(next);
  }
  async function perform(payload: Record<string, unknown>, label: string, retry = false) {
    if (working.current || (pendingRef.current && !retry)) return null;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    let acknowledged = false;
    try {
      if (!retry) persistPending({ payload, label });
      const result = await callbacks.current.action('web_workspace', payload);
      acknowledged = true;
      if (result.page) mergePage(result.page);
      if (result.session) {
        sessionRef.current = result.session;
        setSession(result.session);
      }
      if (detailRef.current && result.page?.id === detailRef.current.page.id) {
        let value = detailRef.current;
        if (
          result.capture &&
          result.captureRetained !== false &&
          typeof result.capture.text === 'string'
        ) {
          value = {
            ...value,
            captures: [
              result.capture,
              ...value.captures.filter((item) => item.id !== result.capture.id),
            ],
          };
          setCaptureId(result.capture.id);
        }
        if (result.note)
          value = {
            ...value,
            notes: [
              {
                ...result.note,
                orphaned: !value.captures.some((item) => item.id === result.note.captureId),
              },
              ...value.notes.filter((item) => item.id !== result.note.id),
            ],
          };
        if (result.form)
          value = {
            ...value,
            formDrafts: [
              result.form,
              ...value.formDrafts.filter((item) => item.id !== result.form.id),
            ],
          };
        if (result.formId)
          value = {
            ...value,
            formDrafts: value.formDrafts.filter((item) => item.id !== result.formId),
          };
        detailRef.current = value;
        setDetail(value);
      }
      if (payload.operation === 'create') choose(result.page.id);
      persistPending(null);
      setNotice(
        result.captureRetained === false
          ? uiText('原快照已保存过，现已移出历史保留范围；本次没有重复采集。')
          : uiText('{0}已保存', { '0': label }),
      );
      try {
        if (result.object) await callbacks.current.updated();
        await refresh();
      } catch (problem) {
        setNotice(uiText('{0}已保存，刷新暂未完成：{1}', { '0': label, '1': message(problem) }));
      }
      return result;
    } catch (problem) {
      setError(message(problem));
      if (
        !acknowledged &&
        problem instanceof PanelActionError &&
        !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(problem.code)
      ) {
        try {
          persistPending(null);
        } catch {}
      }
      return null;
    } finally {
      working.current = false;
      callbacks.current.dirtyChanged?.(
        playgroundDirtyRef.current || dirtyKeys.current.size > 0 || !!pendingRef.current,
      );
      if (live.current) setBusy(false);
    }
  }
  const mutate: Mutate = (payload, label) =>
    perform({ ...payload, requestId: payload.requestId ?? uid() }, label);
  async function saveSession(
    tabs: WebSession['tabs'],
    activeTabId?: string,
    visit?: { url: string; title: string; pageId?: string },
  ) {
    return mutate(
      {
        operation: 'session',
        expectedRevision: sessionRef.current.revision,
        tabs,
        activeTabId,
        ...(visit ? { visit } : {}),
      },
      uiText('浏览会话'),
    );
  }
  async function activate(target: WebPage) {
    if (locked || playgroundDirtyRef.current) return;
    if (window.innerWidth < 1000) setPageListOpen(false);
    choose(target.id);
    setView('read');
    const found = sessionRef.current.tabs.find((tab) => tab.pageId === target.id),
      tab = found ?? { id: uid(), pageId: target.id, url: target.url, title: target.title };
    if (!found && sessionRef.current.tabs.length >= 20) {
      setError(uiText('最多打开 20 个页签，请先关闭一个。'));
      return;
    }
    await saveSession(
      found ? sessionRef.current.tabs : sessionRef.current.tabs.concat(tab),
      tab.id,
    );
  }
  async function navigate(openExternal = false) {
    if (locked || playgroundDirtyRef.current) return;
    try {
      const url = urlFor(address);
      let target = pages.find((item) => item.url === url && !item.archived);
      if (!target) {
        const result = await mutate(
          { operation: 'create', url, title: domain(url) },
          uiText('网页书签'),
        );
        if (!result) return;
        target = result.page;
      }
      if (!target) return;
      const existing = sessionRef.current.tabs.find((item) => item.pageId === target!.id),
        tab = existing ?? { id: uid(), pageId: target.id, url: target.url, title: target.title };
      if (!existing && sessionRef.current.tabs.length >= 20)
        throw new Error(uiText('最多打开 20 个页签，请先关闭一个。'));
      choose(target.id);
      setView('read');
      const saved = await saveSession(
        existing ? sessionRef.current.tabs : sessionRef.current.tabs.concat(tab),
        tab.id,
        { url, title: target.title, pageId: target.id },
      );
      if (saved && openExternal) await callbacks.current.openUrl(url);
    } catch (problem) {
      setError(message(problem));
    }
  }
  async function closeTab(id: string) {
    if (locked || playgroundDirtyRef.current) return;
    const tabs = sessionRef.current.tabs.filter((tab) => tab.id !== id),
      active =
        sessionRef.current.activeTabId === id
          ? tabs[tabs.length - 1]?.id
          : sessionRef.current.activeTabId;
    const result = await saveSession(tabs, active);
    if (result && sessionRef.current.activeTabId === active)
      choose(tabs.find((tab) => tab.id === active)?.pageId);
  }
  function changeView(next: typeof view) {
    if (playgroundDirtyRef.current && next !== 'playground') {
      setError(uiText('本地网页还有未保存的文件，请先在网页设计中保存。'));
      return;
    }
    setView(next);
    setSelection(null);
  }
  function close() {
    flushDraftStorage();
    if (playgroundDirtyRef.current || dirtyKeys.current.size) {
      setError(uiText('还有未保存的本地草稿，请先保存后回到桌面。'));
      return;
    }
    callbacks.current.close();
  }
  async function openUrl(url: string) {
    try {
      await callbacks.current.openUrl(WebUrl.parse(url));
    } catch (problem) {
      setError(message(problem));
    }
  }
  function openObject(id: string) {
    flushDraftStorage();
    if (playgroundDirtyRef.current || dirtyKeys.current.size) {
      setError(uiText('还有未保存的本地草稿，请先保存。'));
      return;
    }
    try {
      callbacks.current.openObject(id);
    } catch (problem) {
      setError(message(problem));
    }
  }
  function readSelection() {
    if (!capture || !reader.current) return;
    const selectedText = window.getSelection();
    if (!selectedText || selectedText.isCollapsed || !selectedText.rangeCount) return;
    const range = selectedText.getRangeAt(0);
    if (
      !reader.current.contains(range.startContainer) ||
      !reader.current.contains(range.endContainer)
    )
      return;
    const before = range.cloneRange();
    before.selectNodeContents(reader.current);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length,
      end = start + range.toString().length,
      quote = capture.text.slice(start, end);
    if (!quote.trim() || quote.length > 6000) {
      if (quote.length > 6000) setError(uiText('单次摘录最多 6,000 个字符，请缩小选区。'));
      return;
    }
    setSelection({ captureId: capture.id, quote, start, end });
    setInspector('notes');
    setInspectorOpen(true);
  }
  function locate(note: WebNote) {
    setCaptureId(note.captureId);
    setHighlight({
      captureId: note.captureId,
      quote: note.quote,
      start: note.start,
      end: note.end,
    });
    changeView('read');
  }
  async function materialize(format: 'md' | 'html') {
    if (!page || !capture) return;
    const id = page.linkedObjects[format],
      object = props.workspace.objects.find((item) => item.id === id);
    if (id && !object) {
      setError(uiText('关联桌面文件尚未载入，请刷新桌面后重试。'));
      return;
    }
    const result = await mutate(
      {
        operation: 'materialize',
        pageId: page.id,
        expectedRevision: page.revision,
        captureId: capture.id,
        format,
        ...(object ? { expectedObjectRevision: object.revision } : {}),
      },
      uiText('{0} 文件', { '0': format.toUpperCase() }),
    );
    if (result)
      setNotice(
        uiText('已{0}桌面 {1} 文件', {
          '0': id ? uiText('更新原') : uiText('添加'),
          '1': format.toUpperCase(),
        }),
      );
  }
  async function run(request: WebTaskRequest) {
    flushDraftStorage();
    if (
      working.current ||
      pendingRef.current ||
      playgroundDirtyRef.current ||
      dirtyKeys.current.size
    )
      return false;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const sent = await callbacks.current.runTask(request);
      setNotice(
        sent
          ? uiText('任务已交给当前 Codex 对话，进展会回到这里。')
          : uiText('任务尚未确认发送，请在任务记录中查看状态并继续。'),
      );
      await refresh();
      return sent;
    } catch (problem) {
      setError(message(problem));
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function continueTask(id: string) {
    flushDraftStorage();
    if (
      working.current ||
      pendingRef.current ||
      playgroundDirtyRef.current ||
      dirtyKeys.current.size
    )
      return false;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const sent = await callbacks.current.continueTask(id);
      if (!sent) setError(uiText('继续任务尚未确认发送，请查看任务记录；原任务会保留。'));
      await refresh();
      return sent;
    } catch (problem) {
      setError(message(problem));
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const pageTasks = tasks.filter((task) => task.pageId === page?.id),
    taskRunning = pageTasks.some(
      (task) => !task.restoredAt && ['queued', 'running'].includes(task.status),
    );

  return (
    <section
      className={`web-workbench${!loading && !pages.length ? ' is-empty' : ''}${pageListOpen ? '' : ' is-list-collapsed'}`}
      role="region"
      aria-label={isIntegratedDesktop ? uiText('网页资料') : uiText('Web 工作区')}
      data-desktop-overlay="web-workbench"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="ww-header">
        {!!pages.length && (
          <button
            className="ww-list-toggle"
            aria-expanded={pageListOpen}
            title={uiText('展开或收起网页列表')}
            onClick={() => setPageListOpen(!pageListOpen)}
          >
            <Icon name="layout" size={17} />
            <span>{uiText('网页列表')}</span>
          </button>
        )}
        <div className="ww-brand">
          <span>
            <Icon name="link" size={22} />
          </span>
          <div>
            <strong>{isIntegratedDesktop ? uiText('网页资料') : uiText('Web 工作区')}</strong>
          </div>
        </div>
        <div className="ww-header-status">
          <i className={taskRunning ? 'is-active' : ''} />
          {taskRunning ? uiText('浏览任务进行中') : uiText('与工作桌面同步')}
        </div>
        <button onClick={() => void refresh()} disabled={busy}>
          <Icon name="history" size={15} />
          {uiText('刷新')}
        </button>
        <button className="ww-back" onClick={close}>
          <Icon name="desktop" size={16} />
          {uiText('返回桌面')}
        </button>
      </header>
      <div className="ww-layout">
        <aside className="ww-sidebar">
          <label className="ww-search">
            <Icon name="search" size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={uiText('搜索网页、标签')}
            />
          </label>
          <div className="ww-nav">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              <Icon name="grid" size={17} />
              {uiText('全部网页')}
              <span>{pages.filter((item) => !item.archived).length}</span>
            </button>
            <button
              className={filter === 'favorites' ? 'active' : ''}
              onClick={() => setFilter('favorites')}
            >
              <Icon name="star" size={17} />
              {uiText('个人收藏')}
              <span>{pages.filter((item) => !item.archived && item.favorite).length}</span>
            </button>
            <button
              className={filter === 'archive' ? 'active' : ''}
              onClick={() => setFilter('archive')}
            >
              <Icon name="box" size={17} />
              {uiText('归档')}
            </button>
          </div>
          <div className="ww-section-title">
            <span>{uiText('我的网页')}</span>
            <button
              title={uiText('添加网页')}
              aria-label={uiText('添加网页')}
              disabled={locked}
              onClick={() => setEditor({})}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          <div className="ww-bookmarks">
            {loading && !pages.length ? (
              <p className="ww-muted">{uiText('正在读取工作区…')}</p>
            ) : (
              filtered.map((item) => (
                <button
                  key={item.id}
                  className={`ww-bookmark ${item.id === selected ? 'selected' : ''}`}
                  disabled={locked || playgroundDirty}
                  onClick={() => void activate(item)}
                >
                  <span className="ww-site-icon">
                    {domain(item.url)
                      .replace(/^www\./, '')
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{domain(item.url)}</small>
                  </span>
                  {item.favorite && <Icon name="star" size={12} />}
                </button>
              ))
            )}
            {!loading && !filtered.length && (
              <p className="ww-muted">
                {search ? uiText('没有匹配的网页') : uiText('添加网页，开始收集资料')}
              </p>
            )}
          </div>
          {!!groups.length && (
            <>
              <div className="ww-section-title">{uiText('分组')}</div>
              <div className="ww-nav">
                {groups.map((group) => (
                  <button
                    key={group}
                    className={filter === `group:${group}` ? 'active' : ''}
                    onClick={() => setFilter(`group:${group}`)}
                  >
                    <Icon name="folder" size={16} />
                    {group}
                  </button>
                ))}
              </div>
            </>
          )}
          {!!tags.length && (
            <>
              <div className="ww-section-title">{uiText('标签')}</div>
              <div className="ww-tags">
                {tags.map((tag) => (
                  <button
                    key={tag}
                    className={filter === `tag:${tag}` ? 'active' : ''}
                    onClick={() => setFilter(`tag:${tag}`)}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            </>
          )}
          <button className="ww-new-page" disabled={locked} onClick={() => setEditor({})}>
            <Icon name="plus" size={16} />
            {uiText('添加网页')}
          </button>
          <button
            className={`ww-design-entry ${view === 'playground' ? 'active' : ''}`}
            onClick={() => changeView('playground')}
          >
            <Icon name="code" size={17} />
            <span>
              {uiText('本地网页设计')}
              <small>HTML · CSS · JavaScript</small>
            </span>
            <Icon name="arrow" size={15} />
          </button>
        </aside>
        <main className="ww-main">
          {view !== 'playground' && pages.length > 0 && (
            <>
              <div className="ww-tabs">
                {session.tabs.map((tab) => (
                  <div className={`ww-tab ${tab.pageId === selected ? 'active' : ''}`} key={tab.id}>
                    <button
                      disabled={locked || playgroundDirty}
                      onClick={() => {
                        const target = pages.find((item) => item.id === tab.pageId);
                        if (target) void activate(target);
                      }}
                    >
                      <Icon name="link" size={13} />
                      <span>{tab.title || domain(tab.url)}</span>
                    </button>
                    <button
                      disabled={locked || playgroundDirty}
                      onClick={() => void closeTab(tab.id)}
                      title={uiText('关闭页签')}
                      aria-label={uiText('关闭 {0}', { '0': tab.title })}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
                <button
                  className="ww-icon-button"
                  disabled={locked}
                  title={uiText('新网页')}
                  aria-label={uiText('新网页')}
                  onClick={() => setEditor({})}
                >
                  <Icon name="plus" size={16} />
                </button>
              </div>
              <form
                className="ww-address"
                onSubmit={(event) => {
                  event.preventDefault();
                  void navigate();
                }}
              >
                <button
                  type="button"
                  className={showHistory ? 'active' : ''}
                  title={uiText('访问记录')}
                  aria-label={uiText('访问记录')}
                  onClick={() => setShowHistory(!showHistory)}
                >
                  <Icon name="history" size={17} />
                </button>
                <div>
                  <Icon name="link" size={15} />
                  <input
                    aria-label={uiText('网页地址')}
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder={uiText('输入网址，添加到网页资料')}
                  />
                  <span>{uiText('网页地址')}</span>
                </div>
                <button type="submit" disabled={locked || !address.trim() || playgroundDirty}>
                  {uiText('保存网址')}
                </button>
                <button
                  type="button"
                  disabled={locked || !address.trim() || playgroundDirty}
                  onClick={() => void navigate(true)}
                >
                  {uiText('在浏览器打开')}
                  <Icon name="expand" size={14} />
                </button>
              </form>
            </>
          )}
          {showHistory && (
            <div className="ww-history">
              <header>
                <strong>{uiText('访问记录')}</strong>
                <button
                  disabled={locked || !session.history.length}
                  onClick={() =>
                    void mutate(
                      {
                        operation: 'session',
                        expectedRevision: session.revision,
                        tabs: session.tabs,
                        activeTabId: session.activeTabId,
                        clearHistory: true,
                      },
                      uiText('访问记录'),
                    )
                  }
                >
                  {uiText('清空')}
                </button>
              </header>
              {session.history
                .slice()
                .reverse()
                .slice(0, 50)
                .map((entry, index) => (
                  <button
                    key={`${entry.visitedAt}:${index}`}
                    onClick={() => {
                      setAddress(entry.url);
                      setShowHistory(false);
                      const target = pages.find((item) => item.id === entry.pageId);
                      if (target) void activate(target);
                    }}
                  >
                    <span>
                      <strong>{entry.title || domain(entry.url)}</strong>
                      <small>{entry.url}</small>
                    </span>
                    <time>{date(entry.visitedAt)}</time>
                  </button>
                ))}
              {!session.history.length && (
                <p>{uiText('在地址栏打开网页后，访问记录会保存在这里。')}</p>
              )}
            </div>
          )}
          {(pending || error || notice) && (
            <div className={`ww-feedback ${pending || error ? 'attention' : ''}`} role="status">
              {pending ? (
                <>
                  <Icon name="history" size={16} />
                  <span>
                    “{pending.label}
                    {uiText('”的结果尚未确认，原请求已保留。')}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() => void perform(pending.payload, pending.label, true)}
                  >
                    {uiText('继续原请求')}
                  </button>
                </>
              ) : (
                <>
                  <span>{error || notice}</span>
                  <button
                    aria-label={uiText('关闭提示')}
                    onClick={() => {
                      setError('');
                      setNotice('');
                    }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </>
              )}
              {pending && error && <small>{error}</small>}
            </div>
          )}
          {view === 'playground' ? (
            <div className="ww-playground">
              <WebPlayground
                workspace={props.workspace}
                action={props.action}
                updated={props.updated}
                close={() => changeView('read')}
                dirtyChanged={nativeDirty}
                openObject={openObject}
              />
            </div>
          ) : (
            <>
              {page ? (
                <>
                  <header className="ww-page-header">
                    <div>
                      <div className="ww-eyebrow">
                        {page.archived ? uiText('已归档') : uiText('网页资料库')} <span>·</span>{' '}
                        {domain(page.url)}
                      </div>
                      <h1>{page.title}</h1>
                      <div className="ww-page-tags">
                        {page.group && (
                          <span>
                            <Icon name="folder" size={12} />
                            {page.group}
                          </span>
                        )}
                        {page.tags.map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </div>
                    </div>
                    <div className="ww-page-actions">
                      <button
                        className={page.favorite ? 'active' : ''}
                        disabled={locked || page.archived}
                        title={page.favorite ? uiText('取消收藏') : uiText('收藏网页')}
                        aria-label={page.favorite ? uiText('取消收藏') : uiText('收藏网页')}
                        onClick={() =>
                          void mutate(
                            {
                              operation: 'update',
                              pageId: page.id,
                              expectedRevision: page.revision,
                              favorite: !page.favorite,
                            },
                            uiText('收藏状态'),
                          )
                        }
                      >
                        <Icon name="star" size={17} />
                      </button>
                      <button
                        disabled={locked || page.archived}
                        title={uiText('编辑网页信息')}
                        aria-label={uiText('编辑网页信息')}
                        onClick={() => setEditor({ page })}
                      >
                        <Icon name="settings" size={17} />
                      </button>
                      <button
                        disabled={locked}
                        title={page.archived ? uiText('恢复归档') : uiText('归档网页')}
                        aria-label={page.archived ? uiText('恢复归档') : uiText('归档网页')}
                        onClick={() =>
                          void mutate(
                            {
                              operation: 'archive',
                              pageId: page.id,
                              expectedRevision: page.revision,
                              archived: !page.archived,
                            },
                            page.archived ? uiText('恢复网页') : uiText('网页归档'),
                          )
                        }
                      >
                        <Icon name="box" size={17} />
                      </button>
                      <button
                        className="ww-primary"
                        disabled={locked || page.archived}
                        onClick={() => setCaptureOpen(true)}
                      >
                        <Icon name="plus" size={15} />
                        {uiText('粘贴快照')}
                      </button>
                    </div>
                  </header>
                  <div className="ww-content-toolbar">
                    <div className="ww-segments">
                      {(
                        [
                          ['read', uiText('正文'), 'document'],
                          ['compare', uiText('版本对比'), 'layers'],
                          ['forms', uiText('表单草稿'), 'sheet'],
                        ] as const
                      ).map(([id, label, icon]) => (
                        <button
                          key={id}
                          className={view === id ? 'active' : ''}
                          onClick={() => changeView(id)}
                        >
                          <Icon name={icon} size={14} />
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="ww-capture-controls">
                      <button
                        className={inspectorOpen ? 'active' : ''}
                        aria-expanded={inspectorOpen}
                        onClick={() => setInspectorOpen(!inspectorOpen)}
                      >
                        <Icon name="comment" size={14} />
                        {uiText('任务与批注')}
                      </button>
                      <select
                        aria-label={uiText('选择网页快照')}
                        value={capture?.id ?? ''}
                        disabled={!captures.length}
                        onChange={(event) => {
                          setCaptureId(event.target.value);
                          setHighlight(null);
                          setSelection(null);
                        }}
                      >
                        {!captures.length && <option value="">{uiText('尚无快照')}</option>}
                        {captures.map((item) => (
                          <option value={item.id} key={item.id}>
                            {date(item.capturedAt)} ·{' '}
                            {item.method === 'desktop-browser'
                              ? uiText('桌面浏览器')
                              : item.method === 'browser'
                                ? uiText('浏览器捕获')
                                : uiText('手动保存')}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={locked || !capture || page.archived}
                        onClick={() => void materialize('md')}
                        title={uiText('保存到桌面 Markdown 文件')}
                      >
                        <Icon name="document" size={14} />
                        MD
                      </button>
                      <button
                        disabled={locked || !capture || !capture.html || page.archived}
                        onClick={() => void materialize('html')}
                        title={uiText('保存到桌面 HTML 文件')}
                      >
                        <Icon name="code" size={14} />
                        HTML
                      </button>
                    </div>
                  </div>
                  <div className={`ww-work-area${inspectorOpen ? '' : ' is-inspector-hidden'}`}>
                    <section className="ww-reading-area">
                      {view === 'read' ? (
                        capture ? (
                          <>
                            <div className="ww-snapshot-banner">
                              <span>
                                <i />
                                {capture.method === 'desktop-browser'
                                  ? uiText('桌面浏览器保存的网页快照')
                                  : capture.method === 'browser'
                                    ? uiText('浏览器捕获的网页快照')
                                    : uiText('手动保存的网页快照')}
                              </span>
                              <span>
                                {date(capture.capturedAt)} ·{' '}
                                {capture.text.length.toLocaleString(interfaceLocale())}{' '}
                                {uiText('字符')}
                              </span>
                            </div>
                            <div className="ww-reader-scroll">
                              <article className="ww-reader">
                                <h2>{capture.title || page.title}</h2>
                                <button
                                  className="ww-source-link"
                                  onClick={() => void openUrl(capture.url)}
                                >
                                  {capture.url}
                                  <Icon name="expand" size={12} />
                                </button>
                                <pre ref={reader} onMouseUp={readSelection} onKeyUp={readSelection}>
                                  {highlight &&
                                  highlight.captureId === capture.id &&
                                  capture.text.slice(highlight.start, highlight.end) ===
                                    highlight.quote ? (
                                    <>
                                      {capture.text.slice(0, highlight.start)}
                                      <mark>{highlight.quote}</mark>
                                      {capture.text.slice(highlight.end)}
                                    </>
                                  ) : (
                                    capture.text ||
                                    uiText('此快照没有正文。可以粘贴正文，或发起浏览任务捕获页面。')
                                  )}
                                </pre>
                                {!!capture.links.length && (
                                  <details className="ww-links">
                                    <summary>
                                      {uiText('页面中的链接')}
                                      <span>{capture.links.length}</span>
                                    </summary>
                                    {capture.links.map((link, index) => (
                                      <button
                                        key={`${index}:${link.url}`}
                                        onClick={() => void openUrl(link.url)}
                                      >
                                        <Icon name="link" size={13} />
                                        <span>
                                          {link.text || link.url}
                                          <small>{link.url}</small>
                                        </span>
                                        <Icon name="expand" size={12} />
                                      </button>
                                    ))}
                                  </details>
                                )}
                              </article>
                            </div>
                            <footer className="ww-reader-footer">
                              <span>{uiText('选择正文可创建摘录批注')}</span>
                              <div>
                                {page.linkedObjects.md && (
                                  <button onClick={() => openObject(page.linkedObjects.md!)}>
                                    {uiText('打开桌面 MD')}
                                  </button>
                                )}
                                {page.linkedObjects.html && (
                                  <button onClick={() => openObject(page.linkedObjects.html!)}>
                                    {uiText('打开桌面 HTML')}
                                  </button>
                                )}
                              </div>
                            </footer>
                          </>
                        ) : (
                          <Empty
                            title={uiText('网址已保存，下一步收集内容')}
                            icon="link"
                            actions={
                              <>
                                <button
                                  className="ww-primary"
                                  disabled={locked || page.archived}
                                  onClick={() => {
                                    setInspector('tasks');
                                    setInspectorOpen(true);
                                  }}
                                >
                                  <Icon name="tasks" size={15} />
                                  {uiText('让 Codex 收集')}
                                </button>
                                <button
                                  disabled={locked || page.archived}
                                  onClick={() => setCaptureOpen(true)}
                                >
                                  {uiText('粘贴网页内容')}
                                </button>
                                <button onClick={() => void openUrl(page.url)}>
                                  {uiText('在浏览器打开')}
                                  <Icon name="expand" size={14} />
                                </button>
                              </>
                            }
                          >
                            {uiText(
                              '这里显示保存的网页内容。收集后可以阅读、批注、比较版本，并保存为桌面文件。',
                            )}
                          </Empty>
                        )
                      ) : view === 'compare' ? (
                        <CaptureCompare captures={captures} selected={capture?.id} />
                      ) : (
                        <FormsPanel
                          key={`${page.id}:${capture?.id ?? 'none'}`}
                          workspaceId={props.workspace.id}
                          page={page}
                          capture={capture}
                          drafts={matching?.formDrafts ?? []}
                          mutate={mutate}
                          disabled={locked || page.archived}
                          dirty={dirty}
                          run={run}
                          canSend={props.canSend}
                        />
                      )}
                    </section>
                    <aside className="ww-inspector" hidden={!inspectorOpen}>
                      <div className="ww-inspector-tabs">
                        <button
                          className={inspector === 'tasks' ? 'active' : ''}
                          onClick={() => setInspector('tasks')}
                        >
                          <Icon name="tasks" size={15} />
                          {uiText('浏览任务')}
                          <span>{pageTasks.length}</span>
                        </button>
                        <button
                          className={inspector === 'notes' ? 'active' : ''}
                          onClick={() => setInspector('notes')}
                        >
                          <Icon name="comment" size={15} />
                          {uiText('摘录批注')}
                          <span>
                            {matching?.notes.filter((note) => !note.deletedAt && !note.resolved)
                              .length ?? 0}
                          </span>
                        </button>
                      </div>
                      {inspector === 'notes' ? (
                        <NotesPanel
                          key={page.id}
                          workspaceId={props.workspace.id}
                          page={page}
                          notes={matching?.notes ?? []}
                          selection={selection}
                          consumed={() => setSelection(null)}
                          locate={locate}
                          mutate={mutate}
                          disabled={locked || page.archived}
                          dirty={dirty}
                        />
                      ) : (
                        <TasksPanel
                          key={page.id}
                          workspaceId={props.workspace.id}
                          page={page}
                          capture={capture}
                          tasks={pageTasks}
                          drafts={matching?.formDrafts ?? []}
                          action={props.action}
                          run={run}
                          resume={continueTask}
                          refresh={() => refresh()}
                          disabled={locked || page.archived}
                          canSend={props.canSend}
                          dirty={dirty}
                          showCapture={(id) => {
                            setCaptureId(id);
                            changeView('read');
                          }}
                        />
                      )}
                    </aside>
                  </div>
                </>
              ) : (
                <Empty
                  icon="link"
                  title={loading ? uiText('正在打开网页资料…') : uiText('把网页留在工作区')}
                  actions={
                    !loading && (
                      <>
                        <form
                          className="ww-start-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void navigate();
                          }}
                        >
                          <input
                            aria-label={uiText('添加网页地址')}
                            placeholder={uiText('粘贴网址，例如 example.com')}
                            value={address}
                            onChange={(event) => setAddress(event.target.value)}
                          />
                          <button
                            type="submit"
                            className="ww-primary"
                            disabled={locked || !address.trim()}
                          >
                            {uiText('添加网页')}
                          </button>
                        </form>
                        <div className="ww-start-secondary">
                          <button disabled={locked} onClick={() => setEditor({})}>
                            {uiText('填写网页信息')}
                          </button>
                          <span>{uiText('或')}</span>
                          <button disabled={locked} onClick={() => changeView('playground')}>
                            <Icon name="code" size={15} />
                            {uiText('创建本地网页')}
                          </button>
                        </div>
                      </>
                    )
                  }
                >
                  {uiText('网页资料和本地网页都保存在当前工作区，可以交给 Codex 继续处理。')}
                </Empty>
              )}
            </>
          )}
        </main>
      </div>
      {editor && (
        <PageEditor
          key={editor.page?.id ?? 'new'}
          workspaceId={props.workspace.id}
          page={editor.page}
          mutate={mutate}
          disabled={locked}
          close={() => setEditor(null)}
          dirty={dirty}
          created={(target) => void activate(target)}
        />
      )}
      {captureOpen && page && (
        <CaptureEditor
          key={page.id}
          workspaceId={props.workspace.id}
          page={page}
          mutate={mutate}
          disabled={locked || page.archived}
          close={() => setCaptureOpen(false)}
          dirty={dirty}
        />
      )}
    </section>
  );
}
