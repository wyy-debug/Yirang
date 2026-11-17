import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import type { NativeTextPage } from '../../../packages/contracts/native-text.js';
import {
  WebProjectSchema,
  WEB_SOURCE_LIMIT,
  defaultWebSources,
  isWebProjectName,
  isWebSourceName,
  webSourceRoles,
  type WebSourceRole,
} from '../../../packages/contracts/web-projects.js';
import { PanelActionError } from '../host.js';
import {
  scheduleDraftWrite,
  writeDraftNow,
  flushDraftStorage,
} from '../documents/draft-storage.js';
import {
  webPreviewDocument,
  standaloneWebDocument,
  acceptedWebPreviewMessage,
  utf8Base64,
  type WebPreviewMessage,
} from './web-preview.js';
import './web-playground.css';

type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export type WebPlaygroundProps = {
  workspace: Workspace;
  action: Action;
  updated: () => Promise<void>;
  close: () => void;
  object?: DesktopObject;
  dirtyChanged?: (value: boolean) => void;
  openObject?: (id: string) => void;
};
const sourceSchema = z.string().max(WEB_SOURCE_LIMIT),
  sourcesSchema = z.object({ html: sourceSchema, css: sourceSchema, js: sourceSchema }).strict();
const pageSchema = z
  .object({
    objectId: z.string().min(1),
    revision: z.number().int().positive(),
    fileName: z.string(),
    text: z.string().max(1024 * 1024),
    encoding: z.enum(['utf-8', 'utf-16le', 'utf-16be']),
    bom: z.boolean(),
    newline: z.enum(['lf', 'crlf', 'cr', 'mixed', 'none']),
    bytes: z.number().nonnegative(),
  })
  .strict();
const sessionSchema = z
  .object({
    name: z.string().max(80),
    started: z.boolean(),
    manifest: pageSchema.optional(),
    pages: z
      .object({
        html: pageSchema.optional(),
        css: pageSchema.optional(),
        js: pageSchema.optional(),
      })
      .strict(),
    source: sourcesSchema,
  })
  .strict();
type Session = z.infer<typeof sessionSchema>;
const payloadSchema = z.union([
  z
    .object({
      requestId: z.string(),
      fileName: z.string(),
      data: z.string().max(8000000),
      bounds: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .strict(),
      relativePath: z.string().optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.string(),
      objectId: z.string(),
      expectedRevision: z.number().int().positive(),
      text: z.string().max(1024 * 1024),
      newline: z.enum(['preserve', 'lf']),
    })
    .strict(),
]);
const jobSchema = z
  .object({
    role: z.enum(['html', 'css', 'js', 'manifest', 'export']),
    action: z.enum(['import_attachment', 'text_file_save']),
    payload: payloadSchema,
    result: z
      .object({ id: z.string(), revision: z.number().int().positive(), fileName: z.string() })
      .strict()
      .optional(),
  })
  .strict();
const pendingSchema = z
  .object({
    kind: z.enum(['project', 'export', 'import']),
    session: sessionSchema,
    jobs: z.array(jobSchema).max(8),
    finalized: z.boolean(),
  })
  .strict();
type Pending = z.infer<typeof pendingSchema>;
type Job = z.infer<typeof jobSchema>;
const savedSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string(),
    session: sessionSchema,
    pending: pendingSchema.nullable(),
  })
  .strict();
const uid = () => crypto.randomUUID(),
  message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const names: Record<WebSourceRole, string> = { html: 'HTML', css: 'CSS', js: 'JavaScript' };
const extensions: Record<WebSourceRole, string> = {
  html: 'index.html',
  css: 'styles.css',
  js: 'script.js',
};
const emptySession = (): Session => ({
  name: uiText('我的网页'),
  started: false,
  pages: {},
  source: { ...defaultWebSources },
});
const fileName = (object: DesktopObject) =>
  (object.content as { fileName?: string }).fileName ?? object.title;
const safeName = (name: string) =>
  name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .slice(0, 64) || uiText('我的网页');
function dirtySession(session: Session) {
  if (!session.manifest) return session.started;
  try {
    const project = WebProjectSchema.parse(JSON.parse(session.manifest.text));
    return (
      project.name !== session.name ||
      webSourceRoles.some(
        (role) =>
          !session.pages[role] ||
          project.files[role] !== session.pages[role]!.objectId ||
          session.source[role] !== session.pages[role]!.text,
      )
    );
  } catch {
    return true;
  }
}
function initial(key: string, workspaceId: string) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { session: emptySession(), pending: null, error: '' };
    const saved = savedSchema.parse(JSON.parse(raw));
    if (saved.workspaceId !== workspaceId) throw Error();
    return { session: saved.session, pending: saved.pending, error: '' };
  } catch {
    return {
      session: emptySession(),
      pending: null,
      error: uiText('本地网页草稿无法读取；原生文件未修改。'),
    };
  }
}
function nativePage(
  id: string,
  revision: number,
  name: string,
  text: string,
  old?: NativeTextPage,
): NativeTextPage {
  return {
    ...old,
    objectId: id,
    revision,
    fileName: name,
    text,
    encoding: old?.encoding ?? 'utf-8',
    bom: old?.bom ?? false,
    newline: old?.newline ?? 'lf',
    bytes: new TextEncoder().encode(text).length,
  };
}
function sessionAfterJobs(pending: Pending) {
  const session = structuredClone(pending.session);
  for (const job of pending.jobs) {
    if (!job.result || job.role === 'export') continue;
    const text =
      'text' in job.payload
        ? job.payload.text
        : job.role === 'manifest'
          ? new TextDecoder().decode(
              Uint8Array.from(atob(job.payload.data), (c) => c.charCodeAt(0)),
            )
          : session.source[job.role];
    const old = job.role === 'manifest' ? session.manifest : session.pages[job.role],
      page = nativePage(job.result.id, job.result.revision, job.result.fileName, text, old);
    if (job.role === 'manifest') session.manifest = page;
    else session.pages[job.role] = page;
  }
  return session;
}
function importJob(role: Job['role'], name: string, text: string, index = 0, folder?: string): Job {
  return {
    role,
    action: 'import_attachment',
    payload: {
      requestId: uid(),
      fileName: name,
      data: utf8Base64(text),
      bounds: { x: 80 + index * 340, y: 100, width: 320, height: 230 },
      ...(folder ? { relativePath: `${folder}/${name}` } : {}),
    },
  };
}
function saveJob(role: Job['role'], page: NativeTextPage, text: string): Job {
  return {
    role,
    action: 'text_file_save',
    payload: {
      requestId: uid(),
      objectId: page.objectId,
      expectedRevision: page.revision,
      text,
      newline: page.newline === 'mixed' ? 'lf' : 'preserve',
    },
  };
}

export function WebPlayground(props: WebPlaygroundProps) {
  useUiLocale();
  return <WebPlaygroundSession key={props.workspace.id} {...props} />;
}
function WebPlaygroundSession({
  workspace,
  action,
  updated,
  close,
  object,
  dirtyChanged,
  openObject,
}: WebPlaygroundProps) {
  useUiLocale();
  const storageKey = `ai-desktop:web-playground:${workspace.id}`,
    [start] = useState(() => initial(storageKey, workspace.id));
  const [session, setSession] = useState<Session>(start.session),
    [pending, setPending] = useState<Pending | null>(start.pending),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(start.error),
    [notice, setNotice] = useState(
      start.pending
        ? uiText('已恢复未确认请求，请重试同一次操作。')
        : dirtySession(start.session)
          ? uiText('已恢复本地网页草稿。')
          : '',
    ),
    [storageError, setStorageError] = useState('');
  const [tab, setTab] = useState<WebSourceRole>('html'),
    [projectId, setProjectId] = useState(start.session.manifest?.objectId ?? ''),
    [linkId, setLinkId] = useState(''),
    [newName, setNewName] = useState(uiText('新网页'));
  const [size, setSize] = useState<'desktop' | 'tablet' | 'phone'>('desktop'),
    [run, setRun] = useState(false),
    [refresh, setRefresh] = useState(0),
    [preview, setPreview] = useState<{ url: string; token: string; run: boolean } | null>(null),
    [previewState, setPreviewState] = useState(uiText('准备静态预览')),
    [logs, setLogs] = useState<WebPreviewMessage[]>([]),
    [consoleOpen, setConsoleOpen] = useState(true),
    [wrap, setWrap] = useState(false),
    [discard, setDiscard] = useState(false),
    [exportId, setExportId] = useState('');
  const [fit, setFit] = useState(true),
    [viewportSize, setViewportSize] = useState({ width: 640, height: 420 });
  const actions = useRef(action),
    state = useRef({ session, pending }),
    flight = useRef(false),
    frame = useRef<HTMLIFrameElement>(null),
    input = useRef<HTMLInputElement>(null),
    area = useRef<HTMLTextAreaElement>(null),
    objectOpened = useRef('');
  const viewport = useRef<HTMLDivElement>(null);
  const [leaseError, setLeaseError] = useState('');
  actions.current = action;
  state.current = { session, pending };
  const dirty = dirtySession(session) || !!pending,
    blocked = busy || !!pending || !!leaseError,
    liveFiles = workspace.objects.filter((o) => o.kind === 'file' && !o.archived),
    projects = liveFiles.filter((o) => isWebProjectName(fileName(o))),
    roleFiles = liveFiles.filter((o) => isWebSourceName(fileName(o), tab));
  const leaseIds = [
    session.manifest?.objectId,
    ...webSourceRoles.map((role) => session.pages[role]?.objectId),
  ]
    .filter((value): value is string => !!value)
    .sort()
    .join('|');
  const conflicts = [session.manifest, ...webSourceRoles.map((role) => session.pages[role])]
    .filter((page): page is NativeTextPage => !!page)
    .filter((page) => {
      const object = workspace.objects.find((o) => o.id === page.objectId);
      return object && (object.archived || object.revision > page.revision);
    });
  const selectedPage = session.pages[tab];
  const deviceWidth = size === 'desktop' ? 1280 : size === 'tablet' ? 820 : 390,
    previewScale = fit ? Math.max(0.12, Math.min(1, (viewportSize.width - 36) / deviceWidth)) : 1,
    deviceHeight = Math.max(330, Math.round((viewportSize.height - 36) / previewScale));
  function persist(value: Session, job: Pending | null) {
    writeDraftNow(
      storageKey,
      JSON.stringify({ version: 1, workspaceId: workspace.id, session: value, pending: job }),
    );
  }
  function change(next: Session) {
    setSession(next);
    setError('');
    setRun(false);
  }
  useEffect(() => {
    dirtyChanged?.(dirty || busy);
    return () => dirtyChanged?.(false);
  }, [dirty, busy, dirtyChanged]);
  useEffect(() => {
    scheduleDraftWrite(
      storageKey,
      () => JSON.stringify({ version: 1, workspaceId: workspace.id, ...state.current }),
      (e) => setStorageError(e ? uiText('本地草稿存储不可用，请下载草稿保留修改。') : ''),
      900,
    );
  }, [session, pending, storageKey, workspace.id]);
  useEffect(() => () => flushDraftStorage(storageKey), [storageKey]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewportSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, busy]);
  useEffect(() => {
    if (!leaseIds) {
      setLeaseError('');
      return;
    }
    let live = true;
    const ids = leaseIds.split('|');
    const renew = async () => {
      try {
        const results = await Promise.all(
          ids.map((objectId) =>
            actions.current('native_workbench', {
              operation: 'editor_lease',
              objectId,
              command: 'acquire',
              dirty: dirtySession(state.current.session) || !!state.current.pending,
            }),
          ),
        );
        if (live)
          setLeaseError(
            results.some((result) => !result?.acquired)
              ? uiText('这些文件正在另一个面板编辑，暂时保留只读。')
              : '',
          );
      } catch (e) {
        if (live) setLeaseError(uiText('编辑占用续期失败：{0}', { '0': message(e) }));
      }
    };
    void renew();
    const timer = setInterval(() => void renew(), 20000);
    return () => {
      live = false;
      clearInterval(timer);
      for (const objectId of ids)
        void actions
          .current('native_workbench', { operation: 'editor_lease', objectId, command: 'release' })
          .catch(() => {});
    };
  }, [leaseIds]);
  useEffect(() => {
    if (!leaseIds) return;
    for (const objectId of leaseIds.split('|'))
      void actions
        .current('native_workbench', {
          operation: 'editor_lease',
          objectId,
          command: 'renew',
          dirty,
        })
        .then((result) => {
          if (!result?.acquired)
            setLeaseError(uiText('这些文件已被另一面板占用；草稿保留在本地。'));
        })
        .catch((e) => setLeaseError(message(e)));
  }, [dirty, leaseIds]);
  useEffect(() => {
    setPreview(null);
    setPreviewState(run ? uiText('正在启动脚本预览…') : uiText('正在更新静态预览…'));
    let url = '';
    const timer = setTimeout(
      () => {
        const token = uid();
        url = URL.createObjectURL(
          new Blob([webPreviewDocument(session.source, { run, token })], { type: 'text/html' }),
        );
        setPreview({ url, token, run });
      },
      run ? 0 : 500,
    );
    return () => {
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [session.source.html, session.source.css, session.source.js, run, refresh]);
  useEffect(() => {
    if (!preview) return;
    let ready = false,
      received = 0;
    const handler = (event: MessageEvent) => {
      if (received >= 160) return;
      const value = acceptedWebPreviewMessage(event, frame.current, preview.token);
      if (!value) return;
      received++;
      if (value.kind === 'ready') {
        ready = true;
        setPreviewState(uiText('JS 容器已启动'));
      }
      setLogs((current) => [...current.slice(-119), value]);
    };
    window.addEventListener('message', handler);
    const timer = setTimeout(() => {
      if (preview.run && !ready)
        setPreviewState(uiText('宿主未确认脚本容器可运行，可导出 HTML 后手动打开。'));
    }, 3500);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', handler);
    };
  }, [preview]);
  useEffect(() => {
    if (!object || objectOpened.current === object.id || dirty || busy) return;
    objectOpened.current = object.id;
    if (isWebProjectName(fileName(object))) void loadProject(object.id);
    else if (isWebSourceName(fileName(object), 'html')) void linkFile('html', object.id);
  }, [object?.id]);
  async function readObject(id: string, role?: WebSourceRole) {
    const object = liveFiles.find((o) => o.id === id);
    if (!object) throw Error(uiText('关联文件不存在或已移入废纸篓。'));
    if (role && !isWebSourceName(fileName(object), role))
      throw Error(uiText('{0} 文件扩展名不匹配。', { '0': names[role] }));
    const page = (await actions.current('text_file_read', {
      objectId: id,
      expectedRevision: object.revision,
    })) as NativeTextPage;
    if (role && page.text.length > WEB_SOURCE_LIMIT)
      throw Error(uiText('单份网页源码限 256 Ki 字符，请缩小文件后编辑。'));
    return page;
  }
  async function loadProject(id: string, force = false) {
    if (flight.current || pending || (!force && dirty)) {
      setNotice(uiText('当前有未保存草稿，请先保存或下载草稿后载入最新。'));
      return;
    }
    if (!id) return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      const manifest = await readObject(id),
        project = WebProjectSchema.parse(JSON.parse(manifest.text)),
        pages = await Promise.all(
          webSourceRoles.map((role) => readObject(project.files[role], role)),
        ),
        next: Session = {
          name: project.name,
          started: false,
          manifest,
          pages: { html: pages[0], css: pages[1], js: pages[2] },
          source: { html: pages[0].text, css: pages[1].text, js: pages[2].text },
        };
      persist(next, null);
      setSession(next);
      setProjectId(id);
      setRun(false);
      setLogs([]);
      setDiscard(false);
      setNotice(uiText('已读取原生项目文件。编辑在本地留草稿，保存时写回原对象。'));
    } catch (e) {
      setError(message(e));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  async function linkFile(role: WebSourceRole, id: string) {
    if (flight.current || blocked || !id) return;
    if (session.pages[role] && session.source[role] !== session.pages[role]!.text) {
      setNotice(uiText('此文件有草稿，请先保存再更换关联。'));
      return;
    }
    if (webSourceRoles.some((other) => other !== role && session.pages[other]?.objectId === id))
      return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      const page = await readObject(id, role);
      change({
        ...session,
        started: true,
        pages: { ...session.pages, [role]: page },
        source: { ...session.source, [role]: page.text },
      });
      setLinkId('');
      setNotice(uiText('已载入关联文件；保存项目后会记住这份文件关系。'));
    } catch (e) {
      setError(message(e));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  async function execute(job: Pending) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    let current = structuredClone(job),
      dispatched = false;
    try {
      persist(current.session, current);
      setSession(current.session);
      setPending(current);
      setRun(false);
      while (true) {
        const next = current.jobs.find((item) => !item.result);
        if (next) {
          dispatched = true;
          const result = await actions.current(next.action, next.payload),
            oldPage =
              next.role === 'manifest'
                ? current.session.manifest
                : next.role === 'export'
                  ? undefined
                  : current.session.pages[next.role];
          next.result = {
            id: 'objectId' in next.payload ? next.payload.objectId : result.id,
            revision: result.revision,
            fileName:
              'fileName' in next.payload ? next.payload.fileName : (oldPage?.fileName ?? 'file'),
          };
          persist(current.session, current);
          setPending(structuredClone(current));
          continue;
        }
        if (current.kind === 'project' && !current.finalized) {
          const saved = sessionAfterJobs(current),
            project = WebProjectSchema.parse({
              schemaVersion: 1,
              kind: 'ai-desktop-web-project',
              name: saved.name,
              files: Object.fromEntries(
                webSourceRoles.map((role) => [role, saved.pages[role]?.objectId]),
              ),
            }),
            text = JSON.stringify(project, null, 2);
          current.finalized = true;
          if (!saved.manifest)
            current.jobs.push(
              importJob(
                'manifest',
                `${safeName(saved.name)}.web-project.json`,
                text,
                3,
                safeName(saved.name),
              ),
            );
          else if (text !== saved.manifest.text)
            current.jobs.push(saveJob('manifest', saved.manifest, text));
          persist(current.session, current);
          setPending(structuredClone(current));
          continue;
        }
        break;
      }
      const next = sessionAfterJobs(current);
      if (current.kind === 'project') next.started = false;
      persist(next, null);
      setSession(next);
      setPending(null);
      setProjectId(next.manifest?.objectId ?? '');
      if (current.kind === 'export') {
        setExportId(current.jobs[0]?.result?.id ?? '');
        setNotice(uiText('独立 HTML 已导出到桌面，包含当前 HTML、CSS 和 JS；尚未执行导出文件。'));
      } else if (current.kind === 'import')
        setNotice(uiText('文件已导入并关联；保存项目后更新项目清单。'));
      else setNotice(uiText('项目已保存回原文件对象，文件历史保留。多文件依次保存完成。'));
      await updated();
    } catch (e) {
      if (!dispatched && !job.jobs.some((item) => item.result)) {
        setPending(job);
        setError(
          uiText('{0} 本地请求备份未完成，本次没有发出写入。可下载草稿后释放本地存储，再重试。', {
            '0': message(e),
          }),
        );
      } else if (
        e instanceof PanelActionError &&
        [
          'TEXT_FILE',
          'TEXT_LIMIT',
          'TEXT_ENCODING',
          'TEXT_BINARY',
          'TEXT_NEWLINE',
          'REVISION_CONFLICT',
          'DRAFT_ACTIVE',
          'INVALID_FILE',
          'VALIDATION_FAILED',
          'REQUEST_ID_REUSED',
          'IMPORT_LIMIT',
        ].includes(e.code)
      ) {
        const next = sessionAfterJobs(current);
        try {
          persist(next, null);
          setSession(next);
          setPending(null);
        } catch {}
        setError(
          uiText('{0} 已确认成功的文件保留；未完成文件的草稿仍在本地。', { '0': message(e) }),
        );
      } else {
        setPending(current);
        setError(
          uiText('{0} 操作结果待确认，请使用同一次请求重试，避免重复创建文件。', {
            '0': message(e),
          }),
        );
      }
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  function save() {
    if (pending) {
      void execute(pending);
      return;
    }
    if (blocked) return;
    if (!session.name.trim()) {
      setError(uiText('请填写项目名称。'));
      return;
    }
    if (conflicts.length) {
      setError(uiText('原生文件已更新，请先下载当前草稿，再载入最新版本比较；未覆盖原文件。'));
      return;
    }
    const jobs: Job[] = [];
    webSourceRoles.forEach((role, index) => {
      const page = session.pages[role];
      if (!page)
        jobs.push(
          importJob(role, extensions[role], session.source[role], index, safeName(session.name)),
        );
      else if (page.text !== session.source[role])
        jobs.push(saveJob(role, page, session.source[role]));
    });
    void execute({
      kind: 'project',
      session: { ...structuredClone(session), name: session.name.trim() },
      jobs,
      finalized: false,
    });
  }
  function exportHTML() {
    if (blocked) return;
    void execute({
      kind: 'export',
      session: structuredClone(session),
      jobs: [
        importJob(
          'export',
          `${safeName(session.name)}.html`,
          standaloneWebDocument(session.source),
        ),
      ],
      finalized: true,
    });
  }
  function downloadDraft() {
    const url = URL.createObjectURL(
        new Blob(
          [JSON.stringify({ version: 1, workspaceId: workspace.id, ...state.current }, null, 2)],
          { type: 'application/json' },
        ),
      ),
      link = document.createElement('a');
    link.href = url;
    link.download = uiText('{0}.网页草稿.json', { '0': safeName(session.name) });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importSources(files: File[]) {
    if (blocked || flight.current || !files.length) return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      if (files.length > 3) throw Error(uiText('每次最多导入 HTML、CSS、JS 各一份。'));
      const next = structuredClone(session),
        jobs: Job[] = [],
        roles = new Set<WebSourceRole>();
      for (const file of files) {
        const role = webSourceRoles.find((role) => isWebSourceName(file.name, role));
        if (!role || roles.has(role))
          throw Error(uiText('请选择 HTML、CSS、JS 文件，且同类只保留一份。'));
        if (next.pages[role] && next.source[role] !== next.pages[role]!.text)
          throw Error(uiText('{0} 有未保存草稿，请先保存再替换关联。', { '0': names[role] }));
        if (file.size > WEB_SOURCE_LIMIT * 3)
          throw Error(uiText('文件过大，请使用 256 Ki 字符以内的源码。'));
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (text.length > WEB_SOURCE_LIMIT) throw Error(uiText('单份源码最多 256 Ki 字符。'));
        roles.add(role);
        next.source[role] = text;
        delete next.pages[role];
        jobs.push(importJob(role, file.name, text, jobs.length, safeName(next.name)));
      }
      next.started = true;
      flight.current = false;
      await execute({ kind: 'import', session: next, jobs, finalized: true });
    } catch (e) {
      setError(message(e));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  function newProject() {
    if (dirty || busy) {
      setNotice(uiText('请先保存当前项目，或下载草稿后清空编辑。'));
      return;
    }
    const next = { ...emptySession(), name: newName.trim() || uiText('新网页') };
    change(next);
    setProjectId('');
    setLogs([]);
    setNotice(uiText('新项目准备好了；点击「创建原生项目」生成三份源码和项目清单。'));
  }
  function discardDraft() {
    if (pending || busy) return;
    if (session.manifest) {
      void loadProject(session.manifest.objectId, true);
      return;
    }
    const next = emptySession();
    try {
      persist(next, null);
      setSession(next);
      setDiscard(false);
      setRun(false);
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }
  function sourceKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      save();
      return;
    }
    if (event.key !== 'Tab' || event.nativeEvent.isComposing || blocked) return;
    event.preventDefault();
    const element = event.currentTarget,
      start = element.selectionStart,
      end = element.selectionEnd,
      value = session.source[tab];
    if (value.length + 2 > WEB_SOURCE_LIMIT) return;
    change({
      ...session,
      started: true,
      source: { ...session.source, [tab]: value.slice(0, start) + '  ' + value.slice(end) },
    });
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(start + 2, start + 2);
    });
  }
  return (
    <section
      className="web-playground"
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          event.stopPropagation();
          void importSources(Array.from(event.dataTransfer.files));
        }
      }}
    >
      <header className="web-playground-header">
        <div>
          <span className="web-playground-eyebrow">LOCAL WEB STUDIO</span>
          <h2>{uiText('本地网页')}</h2>
          <p>{uiText('原生 HTML · CSS · JavaScript，源文件和作品都留在桌面。')}</p>
        </div>
        <div className="web-playground-header-actions">
          <button disabled={busy} onClick={downloadDraft}>
            {uiText('下载草稿')}
          </button>
          <button
            disabled={busy || !!pending}
            onClick={() => {
              if (dirty) setNotice(uiText('草稿尚未写回文件，已在本地保留；请保存后再返回。'));
              else close();
            }}
          >
            {uiText('返回')}
          </button>
          <button className="primary" disabled={busy || (!pending && !!leaseError)} onClick={save}>
            {busy
              ? uiText('正在处理…')
              : pending
                ? uiText('重试同一次操作')
                : session.manifest
                  ? uiText('保存回原文件')
                  : uiText('创建原生项目')}
          </button>
        </div>
      </header>
      <div className="web-playground-projects">
        <label>
          {uiText('项目')}
          <select
            value={projectId}
            disabled={blocked || dirty}
            onChange={(event) => {
              setProjectId(event.target.value);
              void loadProject(event.target.value);
            }}
          >
            <option value="">{uiText('未保存的新项目')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
            {session.manifest && !projects.some((p) => p.id === session.manifest!.objectId) && (
              <option value={session.manifest.objectId}>{session.name}</option>
            )}
          </select>
        </label>
        <label>
          {uiText('名称')}
          <input
            value={session.name}
            disabled={blocked}
            maxLength={80}
            onChange={(event) => change({ ...session, started: true, name: event.target.value })}
          />
        </label>
        <div className="web-playground-new">
          <input
            aria-label={uiText('新项目名称')}
            placeholder={uiText('新项目名称')}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            maxLength={80}
          />
          <button disabled={busy || !!pending || dirty} onClick={newProject}>
            {uiText('＋ 新建')}
          </button>
        </div>
        <button disabled={blocked} onClick={() => input.current?.click()}>
          {uiText('导入源码')}
        </button>
        <input
          hidden
          ref={input}
          type="file"
          multiple
          accept=".html,.htm,.css,.js"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void importSources(files);
          }}
        />
      </div>
      {(error || storageError || leaseError) && (
        <div className="web-playground-alert" role="alert">
          {[error, storageError, leaseError].filter(Boolean).join(' ')}
        </div>
      )}
      {notice && (
        <div className="web-playground-notice" role="status">
          {notice}
          <button aria-label={uiText('关闭提示')} onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="web-playground-alert">
          {uiText('文件已有新版本：')}
          {conflicts.map((page) => page.fileName).join('、')}
          {uiText('。本页草稿保留原基础版本。')}
          <button onClick={downloadDraft}>{uiText('下载草稿')}</button>
          <button disabled={busy || !!pending} onClick={() => setDiscard(true)}>
            {uiText('载入最新')}
          </button>
        </div>
      )}
      {discard && (
        <div className="web-playground-alert">
          {uiText('载入最新会替换当前编辑内容；请先下载草稿保留修改。')}
          <button onClick={downloadDraft}>{uiText('下载草稿')}</button>
          <button disabled={busy || !!pending} onClick={discardDraft}>
            {uiText('丢弃本页草稿并载入')}
          </button>
          <button onClick={() => setDiscard(false)}>{uiText('取消')}</button>
        </div>
      )}
      <div className="web-playground-body">
        <section className="web-playground-source">
          <header className="web-playground-source-tabs">
            {webSourceRoles.map((role) => (
              <button
                key={role}
                aria-pressed={tab === role}
                className={tab === role ? 'active' : ''}
                onClick={() => {
                  setTab(role);
                  setLinkId('');
                }}
              >
                {names[role]}
                {session.pages[role] && session.source[role] !== session.pages[role]!.text && <i />}
              </button>
            ))}
            <label>
              <input
                type="checkbox"
                checked={wrap}
                onChange={(event) => setWrap(event.target.checked)}
              />
              {uiText('折行')}
            </label>
          </header>
          <div className="web-playground-file">
            <div>
              <strong>{selectedPage?.fileName ?? extensions[tab]}</strong>
              <span>
                {selectedPage
                  ? `v${selectedPage.revision} · ${selectedPage.encoding.toUpperCase()}`
                  : uiText('保存时创建原生文件')}
              </span>
              {selectedPage && openObject && (
                <button
                  disabled={dirty || busy}
                  title={uiText('在桌面打开原文件')}
                  onClick={() => openObject(selectedPage.objectId)}
                >
                  ↗
                </button>
              )}
            </div>
            <div>
              <select
                aria-label={uiText('关联 {0} 原生文件', { '0': names[tab] })}
                value={linkId}
                disabled={blocked || (!!selectedPage && session.source[tab] !== selectedPage.text)}
                onChange={(event) => setLinkId(event.target.value)}
              >
                <option value="">
                  {uiText('关联桌面中的')}
                  {names[tab]} {uiText('文件…')}
                </option>
                {roleFiles.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.title}
                  </option>
                ))}
              </select>
              <button disabled={blocked || !linkId} onClick={() => void linkFile(tab, linkId)}>
                {uiText('载入')}
              </button>
            </div>
          </div>
          <textarea
            ref={area}
            aria-label={uiText('{0} 源码', { '0': names[tab] })}
            value={session.source[tab]}
            maxLength={WEB_SOURCE_LIMIT}
            readOnly={blocked}
            spellCheck={false}
            wrap={wrap ? 'soft' : 'off'}
            onKeyDown={sourceKey}
            onChange={(event) =>
              change({
                ...session,
                started: true,
                source: { ...session.source, [tab]: event.target.value },
              })
            }
          />
          <footer>
            <span>
              {session.source[tab].length.toLocaleString(interfaceLocale())}{' '}
              {uiText('/ 262,144 字符')}
            </span>
            <span>
              {dirty
                ? uiText('本地草稿 · 保存后写回')
                : session.manifest
                  ? uiText('原生文件已同步')
                  : uiText('尚未创建原生项目')}
            </span>
            <button disabled={busy || !!pending} onClick={() => setDiscard(true)}>
              {uiText('载入最新')}
            </button>
          </footer>
        </section>
        <section className="web-playground-preview">
          <header>
            <div className="web-playground-devices" role="group" aria-label={uiText('预览宽度')}>
              {(['desktop', 'tablet', 'phone'] as const).map((value) => (
                <button
                  key={value}
                  className={size === value ? 'active' : ''}
                  aria-pressed={size === value}
                  onClick={() => setSize(value)}
                >
                  {value === 'desktop'
                    ? uiText('电脑 1280')
                    : value === 'tablet'
                      ? uiText('平板 820')
                      : uiText('手机 390')}
                </button>
              ))}
            </div>
            <div>
              <button title={uiText('切换自动适应与实际尺寸')} onClick={() => setFit(!fit)}>
                {fit ? uiText('适应 {0}%', { '0': Math.round(previewScale * 100) }) : '100%'}
              </button>
              <button
                onClick={() => {
                  setLogs([]);
                  setRefresh((value) => value + 1);
                }}
              >
                {uiText('刷新')}
              </button>
              <button
                className={run ? 'is-running' : ''}
                onClick={() => {
                  setLogs([]);
                  setRun(!run);
                  setRefresh((value) => value + 1);
                }}
              >
                {run ? uiText('■ 暂停 JS') : uiText('▶ 运行 JS')}
              </button>
            </div>
          </header>
          <div className="web-playground-preview-status">
            <span className={run ? 'running' : ''} />
            {previewState}
            <small>{run ? uiText('编辑后恢复静态预览') : uiText('静态预览 · 脚本未运行')}</small>
          </div>
          <div ref={viewport} className={`web-playground-viewport is-${size}`}>
            <div
              className="web-playground-device-shell"
              style={{ width: deviceWidth * previewScale, height: deviceHeight * previewScale }}
            >
              <div
                className="web-playground-device"
                style={{
                  width: deviceWidth,
                  height: deviceHeight,
                  transform: `scale(${previewScale})`,
                  transformOrigin: '0 0',
                }}
              >
                {preview ? (
                  <iframe
                    key={preview.url}
                    ref={frame}
                    title={uiText('本地网页隔离预览')}
                    src={preview.url}
                    sandbox={preview.run ? 'allow-scripts' : ''}
                    referrerPolicy="no-referrer"
                    onLoad={() => {
                      if (!preview.run) setPreviewState(uiText('静态预览容器已载入'));
                    }}
                  />
                ) : (
                  <div className="web-playground-preview-empty">{uiText('正在生成预览…')}</div>
                )}
              </div>
            </div>
          </div>
          <div className="web-playground-console">
            <header>
              <button onClick={() => setConsoleOpen(!consoleOpen)}>
                <span className={'ui-chevron' + (consoleOpen ? '' : ' right')} aria-hidden="true" />{' '}
                {uiText('控制台')}
                <span>{logs.length}</span>
              </button>
              <button onClick={() => setLogs([])}>{uiText('清空')}</button>
            </header>
            {consoleOpen && (
              <div role="log" aria-label={uiText('网页脚本控制台')}>
                {logs.length ? (
                  logs.map((log, index) => (
                    <p key={`${preview?.token}:${index}`} className={`level-${log.level}`}>
                      <span>{log.level}</span>
                      <code>{log.message}</code>
                    </p>
                  ))
                ) : (
                  <p className="empty">
                    {uiText('点击运行后，脚本日志和错误会显示在这里。仅接收当前预览的消息。')}
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
      <footer className="web-playground-footer">
        <div>
          <strong>{uiText('拖入 HTML / CSS / JS 即可关联')}</strong>
          <span>
            {uiText('预览禁用联网、外部资源和表单提交。宿主可能限制嵌入或脚本，可导出后手动打开。')}
          </span>
        </div>
        <div>
          {exportId && openObject && (
            <button disabled={dirty || busy} onClick={() => openObject(exportId)}>
              {uiText('查看已导出文件 ↗')}
            </button>
          )}
          <button disabled={blocked} onClick={exportHTML}>
            {uiText('导出独立 HTML')}
          </button>
        </div>
      </footer>
    </section>
  );
}
