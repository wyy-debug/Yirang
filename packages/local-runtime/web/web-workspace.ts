import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { FileContent, fail, type DesktopObject } from '../../contracts/index.js';
import {
  WebWorkspaceAction,
  WebCaptureInput,
  WebUrl,
  webFieldSensitive,
  WEB_PAGE_LIMIT,
  WEB_CAPTURE_LIMIT,
  WEB_CAPTURE_BYTE_LIMIT,
  WEB_HISTORY_BYTE_LIMIT,
  WEB_NOTE_LIMIT,
  WEB_FORM_LIMIT,
  type WebWorkspaceActionValue,
  type WebPage,
  type WebCapture,
  type WebCaptureReceipt,
  type WebCaptureResult,
  type WebNote,
  type WebFormDraft,
  type WebSession,
  type WebPageDetail,
} from '../../contracts/web-workspace.js';
import type { WorkbenchAPI } from '../work/workbench.js';

type Api = {
  auth: (w: string, c: string, s: string | null) => { owner: string };
  object: (w: string, id: string) => DesktopObject;
  assertReady: (w: string, id: string, owner: string) => void;
  workbench: (w: string, c: string, s: string | null) => WorkbenchAPI;
  tx: <T>(fn: () => T) => T;
  once: <T>(w: string, id: string, payload: unknown, fn: () => T) => T;
  event: (
    w: string,
    type: string,
    id: string | null,
    revision: number | null,
    actor: string,
  ) => void;
};
export type WebCaptureJobContext = {
  pageId: string;
  expectedPageRevision: number;
  sourceUrl: string;
  sourceJobId: string;
  requestId: string;
};
type Materialization = {
  separate?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  signature: string;
  pageId: string;
  captureId: string;
  format: 'md' | 'html';
  targetId?: string;
  expectedObjectRevision?: number;
  fileName: string;
  text?: string;
  sha256: string;
  createdAt: string;
  complete?: boolean;
  objectId?: string;
  objectRevision?: number;
};
const now = () => new Date().toISOString(),
  hash = (value: string) => createHash('sha256').update(value).digest('hex'),
  size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8'),
  escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
const JobContext = z
  .object({
    pageId: z.string().min(1).max(150),
    expectedPageRevision: z.number().int().positive(),
    sourceUrl: WebUrl,
    sourceJobId: z.string().min(1).max(150),
    requestId: z.string().min(1).max(150),
  })
  .strict();

/** Local web records contain inert source data. No network, browser or script execution. */
export class WebWorkspace {
  constructor(
    private db: DatabaseSync,
    private api: Api,
  ) {}
  private get<T>(w: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(w, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  private put(w: string, key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(w, key, JSON.stringify(value));
  }
  private page(w: string, id: string) {
    const page = this.get<WebPage>(w, `web-page:${id}`);
    if (!page) fail('NOT_FOUND', '网页记录不存在。');
    return page;
  }
  private writable(w: string, id: string, revision: number, allowArchived = false) {
    const page = this.page(w, id);
    if (page.revision !== revision)
      fail('REVISION_CONFLICT', '网页记录已在另一处更新，请刷新后继续。');
    if (page.archived && !allowArchived) fail('WEB_ARCHIVED', '网页已归档，请先恢复后编辑。');
    return page;
  }
  private savePage(w: string, page: WebPage, actor = 'human') {
    page.revision++;
    page.updatedAt = now();
    this.put(w, `web-page:${page.id}`, page);
    this.api.event(w, 'web.updated', null, null, actor);
    return page;
  }
  private captures(w: string, id: string) {
    return this.get<WebCapture[]>(w, `web-captures:${id}`) ?? [];
  }
  private notes(w: string, id: string) {
    return this.get<WebNote[]>(w, `web-notes:${id}`) ?? [];
  }
  private forms(w: string, id: string) {
    return this.get<WebFormDraft[]>(w, `web-forms:${id}`) ?? [];
  }
  private capture(w: string, pageId: string, captureId: string) {
    const capture = this.captures(w, pageId).find((item) => item.id === captureId);
    if (!capture)
      fail('WEB_CAPTURE_MISSING', '快照不存在或已按历史容量上限移除，请选择仍保留的快照。');
    return capture;
  }
  private sessionKey(s: string | null) {
    return `web-session:${hash(s ?? 'local-panel').slice(0, 40)}`;
  }
  private session(w: string, s: string | null): WebSession {
    return (
      this.get<WebSession>(w, this.sessionKey(s)) ?? {
        revision: 0,
        tabs: [],
        history: [],
        updatedAt: now(),
      }
    );
  }
  private detail(w: string, pageId: string): WebPageDetail {
    const page = this.page(w, pageId),
      captures = this.captures(w, pageId),
      ids = new Set(captures.map((capture) => capture.id));
    return {
      page,
      captures,
      notes: this.notes(w, pageId)
        .filter((note) => !note.deletedAt)
        .map((note) => ({ ...note, orphaned: !ids.has(note.captureId) })),
      formDrafts: this.forms(w, pageId),
    };
  }
  readPage(w: string, c: string, s: string | null, pageId: string): WebPageDetail {
    this.api.auth(w, c, s);
    return this.detail(w, pageId);
  }
  private captureReceipt(capture: WebCapture): WebCaptureReceipt {
    const {
      id,
      pageId,
      url,
      title,
      capturedAt,
      method,
      sourceJobId,
      sourceUrl,
      sha256,
      excludedFieldCount,
    } = capture;
    return {
      id,
      pageId,
      url,
      title,
      capturedAt,
      method,
      sourceJobId,
      sourceUrl,
      sha256,
      excludedFieldCount,
    };
  }
  private captureResult(w: string, receipt: WebCaptureReceipt): WebCaptureResult {
    const page = this.page(w, receipt.pageId),
      capture = this.captures(w, receipt.pageId).find((item) => item.id === receipt.id);
    return capture
      ? { page, capture, captureRetained: true }
      : { page, capture: receipt, captureRetained: false };
  }
  private appendCapture(
    w: string,
    page: WebPage,
    input: unknown,
    provenance: { method: WebCapture['method']; sourceJobId?: string; sourceUrl?: string },
  ) {
    const parsed = WebCaptureInput.parse(input);
    if (size(parsed) > WEB_CAPTURE_BYTE_LIMIT)
      fail('WEB_CAPTURE_LIMIT', '单次网页快照最多 384 KiB，请缩小页面范围或省略 HTML 后再收取。');
    const fields = parsed.fields.filter((field) => !webFieldSensitive(field)),
      keys = new Set<string>();
    for (const field of fields) {
      if (keys.has(field.key)) fail('WEB_FIELD', '表单字段 key 不能重复。');
      keys.add(field.key);
    }
    const data = { ...parsed, fields },
      capture: WebCapture = {
        ...data,
        id: `web_capture_${randomUUID()}`,
        pageId: page.id,
        capturedAt: now(),
        ...provenance,
        sha256: hash(JSON.stringify(data)),
        excludedFieldCount: parsed.fields.length - fields.length,
      };
    const history = [capture, ...this.captures(w, page.id)].slice(0, WEB_CAPTURE_LIMIT);
    while (history.length > 1 && size(history) > WEB_HISTORY_BYTE_LIMIT) history.pop();
    this.put(w, `web-captures:${page.id}`, history);
    page.latestCaptureId = capture.id;
    this.savePage(w, page, provenance.method === 'browser' ? 'ai' : 'human');
    return { page, capture };
  }
  /** The caller must already validate the original-session job credential and scope.
   * Receipt lookup precedes revision checks so a lost parent-job response is recoverable. */
  captureFromJob(w: string, jobContext: WebCaptureJobContext, input: unknown) {
    const context = JobContext.parse(jobContext),
      capture = WebCaptureInput.parse(input);
    const receipt = this.api.tx(() =>
      this.api.once(w, context.requestId, { type: 'web.capture.job', context, capture }, () =>
        this.captureReceipt(
          this.appendCapture(
            w,
            this.writable(w, context.pageId, context.expectedPageRevision),
            capture,
            { method: 'browser', sourceJobId: context.sourceJobId, sourceUrl: context.sourceUrl },
          ).capture,
        ),
      ),
    );
    // Receipts keep only metadata: pruned snapshot bodies must not survive in a retry log.
    return this.captureResult(w, receipt);
  }
  action(w: string, c: string, s: string | null, input: unknown) {
    const auth = this.api.auth(w, c, s),
      p = WebWorkspaceAction.parse(input);
    if (p.operation === 'list') {
      const pages = (
        this.db
          .prepare("SELECT value FROM settings WHERE workspace=? AND key LIKE 'web-page:%'")
          .all(w) as { value: string }[]
      )
        .map((row) => JSON.parse(row.value) as WebPage)
        .filter((page) => p.includeArchived || !page.archived)
        .sort(
          (a, b) =>
            Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt),
        );
      return { pages, session: this.session(w, s) };
    }
    if (p.operation === 'read') return this.detail(w, p.pageId);
    if (p.operation === 'compare') {
      const page = this.page(w, p.pageId),
        before = this.capture(w, p.pageId, p.beforeCaptureId),
        after = this.capture(w, p.pageId, p.afterCaptureId);
      return { page, before, after, sameContent: before.sha256 === after.sha256 };
    }
    if (p.operation === 'materialize') return this.materialize(w, c, s, auth.owner, p);
    if (p.operation === 'capture') {
      const receipt = this.api.tx(() =>
        this.api.once(w, p.requestId, { type: 'web.capture', ...p }, () =>
          this.captureReceipt(
            this.appendCapture(w, this.writable(w, p.pageId, p.expectedRevision), p.capture, {
              method: p.source ?? 'manual',
            }).capture,
          ),
        ),
      );
      return this.captureResult(w, receipt);
    }
    return this.api.tx(() =>
      this.api.once(
        w,
        p.requestId,
        { type: `web.${p.operation}`, ...p, ...(p.operation === 'session' ? { session: s } : {}) },
        () => {
          if (p.operation === 'create') {
            const total = this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM settings WHERE workspace=? AND key LIKE 'web-page:%'",
              )
              .get(w) as { count: number };
            if (total.count >= WEB_PAGE_LIMIT)
              fail('WEB_LIMIT', `网页收藏最多 ${WEB_PAGE_LIMIT} 项（包括归档记录）。`);
            const at = now(),
              page: WebPage = {
                id: `web_page_${randomUUID()}`,
                revision: 1,
                title: p.title,
                url: p.url,
                group: p.group,
                tags: [...new Set(p.tags)],
                favorite: p.favorite,
                archived: false,
                createdAt: at,
                updatedAt: at,
                linkedObjects: {},
              };
            this.put(w, `web-page:${page.id}`, page);
            this.api.event(w, 'web.created', null, null, 'human');
            return { page };
          }
          if (p.operation === 'session') {
            const previous = this.session(w, s);
            if (previous.revision !== p.expectedRevision)
              fail('REVISION_CONFLICT', '网页标签状态已在另一处更新，请刷新后继续。');
            if (
              new Set(p.tabs.map((tab) => tab.id)).size !== p.tabs.length ||
              (p.activeTabId && !p.tabs.some((tab) => tab.id === p.activeTabId))
            )
              fail('WEB_TABS', '标签 ID 重复或当前标签不存在。');
            for (const tab of p.tabs) if (tab.pageId) this.page(w, tab.pageId);
            if (p.visit?.pageId) this.page(w, p.visit.pageId);
            let history = p.clearHistory ? [] : previous.history;
            if (p.visit) {
              const entry = { ...p.visit, visitedAt: now() };
              history = [
                entry,
                ...history.filter((item, index) => index !== 0 || item.url !== entry.url),
              ].slice(0, 100);
            }
            const session: WebSession = {
              revision: previous.revision + 1,
              tabs: p.tabs,
              activeTabId: p.activeTabId,
              history,
              updatedAt: now(),
            };
            this.put(w, this.sessionKey(s), session);
            return { session };
          }
          const page = this.writable(w, p.pageId, p.expectedRevision, p.operation === 'archive');
          if (p.operation === 'update') {
            for (const key of ['title', 'url', 'group', 'favorite'] as const)
              if (p[key] !== undefined) Object.assign(page, { [key]: p[key] });
            if (p.tags) page.tags = [...new Set(p.tags)];
            return { page: this.savePage(w, page) };
          }
          if (p.operation === 'archive') {
            page.archived = p.archived;
            return { page: this.savePage(w, page) };
          }
          if (p.operation === 'note') {
            const notes = this.notes(w, page.id),
              at = now();
            let note: WebNote;
            if (p.action === 'create') {
              if (!p.captureId || p.start === undefined || p.end === undefined || !p.quote)
                fail('WEB_NOTE', '摘录需要快照、选区起止位置与原文。');
              const capture = this.capture(w, page.id, p.captureId);
              if (
                p.end <= p.start ||
                capture.text.slice(p.start, p.end) !== p.quote ||
                p.end > capture.text.length
              )
                fail('WEB_NOTE', '摘录位置与快照原文不一致，请重新选择文字。');
              if (notes.filter((note) => !note.deletedAt).length >= WEB_NOTE_LIMIT)
                fail('WEB_NOTE_LIMIT', `每页最多 ${WEB_NOTE_LIMIT} 条摘录或批注。`);
              note = {
                id: `web_note_${randomUUID()}`,
                revision: 1,
                pageId: page.id,
                captureId: capture.id,
                captureUrl: capture.url,
                capturedAt: capture.capturedAt,
                start: p.start,
                end: p.end,
                quote: p.quote,
                body: p.body ?? '',
                resolved: false,
                createdAt: at,
                updatedAt: at,
              };
              notes.push(note);
            } else {
              const found = notes.find((note) => note.id === p.noteId && !note.deletedAt);
              if (!found) fail('NOT_FOUND', '摘录不存在或已删除。');
              note = found;
              note.revision++;
              note.updatedAt = at;
              if (p.action === 'update') {
                if (p.body === undefined) fail('WEB_NOTE', '请输入批注正文。');
                note.body = p.body;
              } else if (p.action === 'resolve') note.resolved = p.resolved ?? true;
              else note.deletedAt = at;
            }
            const kept = notes
              .filter((note) => !note.deletedAt)
              .concat(notes.filter((note) => !!note.deletedAt).slice(-50));
            this.put(w, `web-notes:${page.id}`, kept);
            return { page: this.savePage(w, page), note };
          }
          if (p.operation === 'form') {
            const forms = this.forms(w, page.id),
              existing = p.formId ? forms.find((form) => form.id === p.formId) : undefined;
            if (p.formId && !existing) fail('NOT_FOUND', '表单草稿不存在。');
            if (p.action === 'delete') {
              if (!existing) fail('WEB_FORM', '请选择要删除的表单草稿。');
              this.put(
                w,
                `web-forms:${page.id}`,
                forms.filter((form) => form.id !== existing.id),
              );
              return { page: this.savePage(w, page), formId: existing.id };
            }
            const captureId = p.captureId ?? existing?.captureId;
            if (!captureId) fail('WEB_FORM', '请先选择网页快照。');
            const capture = this.capture(w, page.id, captureId),
              values = p.values ?? existing?.values ?? {},
              allowed = new Map(
                capture.fields
                  .filter((field) => !field.disabled && !webFieldSensitive(field))
                  .map((field) => [field.key, field]),
              );
            const safe: WebFormDraft['values'] = {};
            for (const [key, value] of Object.entries(values)) {
              if (!allowed.has(key))
                fail(
                  'WEB_FORM_FIELD',
                  '草稿包含未知、隐藏、密码或支付字段，未保存；请移除后重试。',
                );
              Object.defineProperty(safe, key, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
              });
            }
            if (size(safe) > 64 * 1024) fail('WEB_FORM_LIMIT', '表单草稿最多 64 KiB。');
            if (!existing && forms.length >= WEB_FORM_LIMIT)
              fail('WEB_FORM_LIMIT', `每页最多 ${WEB_FORM_LIMIT} 份表单草稿。`);
            const at = now(),
              form: WebFormDraft = {
                id: existing?.id ?? `web_form_${randomUUID()}`,
                revision: (existing?.revision ?? 0) + 1,
                pageId: page.id,
                captureId,
                name: p.name ?? existing?.name ?? '表单草稿',
                values: safe,
                createdAt: existing?.createdAt ?? at,
                updatedAt: at,
              };
            this.put(
              w,
              `web-forms:${page.id}`,
              existing
                ? forms.map((item) => (item.id === form.id ? form : item))
                : [...forms, form],
            );
            return { page: this.savePage(w, page), form };
          }
          fail('WEB_ACTION', '未知网页操作。');
        },
      ),
    );
  }
  private materialText(
    page: WebPage,
    capture: WebCapture,
    format: 'md' | 'html',
    notes: WebNote[],
    excerpt = false,
  ) {
    const title = capture.title || page.title,
      method =
        capture.method === 'browser'
          ? '原对话浏览器采集'
          : capture.method === 'desktop-browser'
            ? '桌面内置浏览器采集'
            : '手动保存',
      annotations = notes.filter((note) => !note.deletedAt && note.captureId === capture.id);
    if (format === 'md')
      return `# ${title.replace(/[\r\n]/g, ' ')}\n\n来源：<${capture.url}>\n\n采集时间：${capture.capturedAt}\n采集方式：${method}\n快照：${capture.id}\n\n## ${excerpt ? '网页摘录' : '网页正文'}\n\n${capture.text.replace(/</g, '&lt;')}\n\n${capture.links.length ? `## 页面链接\n\n${capture.links.map((link) => `- ${link.text.replace(/[\r\n<>]/g, ' ')}：<${link.url}>`).join('\n')}\n\n` : ''}${annotations.length ? `## 摘录与批注\n\n${annotations.map((note) => `> ${note.quote.replace(/</g, '&lt;').replace(/\n/g, '\n> ')}\n\n${note.body.replace(/</g, '&lt;')}${note.resolved ? '\n\n已解决' : ''}`).join('\n\n')}\n` : ''}`;
    // Keep captured HTML as escaped source. The exported document never executes it.
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>${escape(title)}</title><style>body{font:16px/1.65 system-ui;max-width:960px;margin:40px auto;padding:0 24px;color:#243046}pre{white-space:pre-wrap;overflow-wrap:anywhere}aside{color:#68758b;font-size:13px}blockquote{border-left:3px solid #a9b9d1;margin-left:0;padding-left:16px}a{color:#245a91}</style></head><body><h1>${escape(title)}</h1><aside>来源：${escape(capture.url)}<br>采集时间：${escape(capture.capturedAt)} · ${method}<br>快照：${escape(capture.id)}</aside><h2>${excerpt ? '网页摘录' : '网页正文'}</h2><pre>${escape(capture.text)}</pre>${capture.links.length ? `<h2>页面链接</h2><ul>${capture.links.map((link) => `<li><a href="${escape(link.url)}" rel="noreferrer noopener">${escape(link.text || link.url)}</a></li>`).join('')}</ul>` : ''}${annotations.map((note) => `<blockquote>${escape(note.quote)}<p>${escape(note.body)}</p>${note.resolved ? '<small>已解决</small>' : ''}</blockquote>`).join('')}${capture.html ? `<details><summary>采集的 HTML 源码（仅文本）</summary><pre>${escape(capture.html)}</pre></details>` : ''}</body></html>\n`;
  }
  private materialize(
    w: string,
    c: string,
    s: string | null,
    owner: string,
    p: Extract<WebWorkspaceActionValue, { operation: 'materialize' }>,
  ) {
    const wb = this.api.workbench(w, c, s),
      key = `web-materialize:${hash(p.requestId)}`,
      signature = JSON.stringify(p);
    let record = this.get<Materialization>(w, key);
    if (record && record.signature !== signature)
      fail('REQUEST_ID_REUSED', '此请求已用于其他网页保存，请继续原请求。');
    if (!record) {
      const page = this.writable(w, p.pageId, p.expectedRevision),
        capture = this.capture(w, page.id, p.captureId),
        targetId = p.separate ? undefined : page.linkedObjects[p.format];
      if (targetId) {
        const target = this.api.object(w, targetId);
        if (target.archived) fail('OBJECT_ARCHIVED', '关联材料已删除，请先从回收站恢复。');
        this.api.assertReady(w, targetId, owner);
        if (p.expectedObjectRevision !== target.revision)
          fail('REVISION_CONFLICT', '原文件已有修改，请读取最新文件版本后再保存网页。');
        const content = FileContent.parse(target.content);
        if (!content.fileName.toLowerCase().endsWith(`.${p.format}`))
          fail('WEB_MATERIAL', '关联材料的文件类型已改变，请先恢复原文件格式。');
      }
      const text = this.materialText(page, capture, p.format, this.notes(w, page.id), p.separate);
      if (Buffer.byteLength(text) > 1024 * 1024)
        fail('WEB_MATERIAL_LIMIT', '导出内容超过 1 MiB，请减少 HTML 或摘录后再保存。');
      record = {
        signature,
        separate: p.separate,
        bounds: p.bounds,
        pageId: page.id,
        captureId: capture.id,
        format: p.format,
        targetId,
        expectedObjectRevision: p.expectedObjectRevision,
        fileName: `${page.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || '网页快照'}${p.separate ? ' · 摘录' : ''}.${p.format}`,
        text,
        sha256: hash(text),
        createdAt: now(),
      };
      this.api.tx(() => this.put(w, key, record));
    }
    if (record.complete) {
      const object = this.api.object(w, record.objectId!);
      return {
        page: this.page(w, record.pageId),
        object,
        captureId: record.captureId,
        format: record.format,
        materializedRevision: record.objectRevision,
        reused: true,
      };
    }
    const page = this.page(w, record.pageId);
    if (page.archived) fail('WEB_ARCHIVED', '网页已归档，已准备的文件保存保持待处理。');
    if (!record.separate && page.linkedObjects[record.format] !== record.targetId)
      fail('REVISION_CONFLICT', '网页关联的原文件已改变，旧保存请求不会覆盖新关联。');
    const bytes = Buffer.from(record.text!, 'utf8');
    if (hash(record.text!) !== record.sha256) fail('WEB_MATERIAL', '保存准备记录不完整。');
    if (record.targetId) this.api.assertReady(w, record.targetId, owner);
    // Workbench create/save own their native-file transaction. Never nest them here.
    const object = record.targetId
      ? wb.save(
          `web_material_${hash(p.requestId).slice(0, 48)}`,
          record.targetId,
          record.expectedObjectRevision!,
          bytes,
          '更新同一网页快照材料',
          { type: 'web-capture', pageId: record.pageId, captureId: record.captureId },
        )
      : wb.create(
          `web_material_${hash(p.requestId).slice(0, 48)}`,
          record.fileName,
          bytes,
          record.bounds ?? { x: 220, y: 180, width: 420, height: 320 },
        );
    const completed = record;
    return this.api.tx(() => {
      const current = this.page(w, completed.pageId);
      if (
        current.archived ||
        (!completed.separate && current.linkedObjects[completed.format] !== completed.targetId)
      )
        fail('REVISION_CONFLICT', '网页记录已变化；生成的原生文件保留，旧请求不会替换新关联。');
      if (!completed.separate) {
        current.linkedObjects[completed.format] = object.id;
        this.savePage(w, current);
      }
      completed.complete = true;
      completed.objectId = object.id;
      completed.objectRevision = object.revision;
      delete completed.text;
      this.put(w, key, completed);
      return {
        page: current,
        object,
        captureId: completed.captureId,
        format: completed.format,
        materializedRevision: object.revision,
      };
    });
  }
}
