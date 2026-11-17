import { useEffect, useState } from 'react';
import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { Icon } from '../ui/icons.js';
import {
  WebCaptureInput,
  WebUrl,
  webFieldSensitive,
  type WebCapture,
  type WebCaptureInputValue,
  type WebField,
  type WebNote,
  type WebPage,
  type WebPageDetail,
} from '../../../packages/contracts/web-workspace.js';
import {
  date,
  Empty,
  message,
  urlFor,
  useDraft,
} from './web-workbench-shared.js';
import type { Dirty, Mutate, Selection } from './web-workbench-shared.js';

export function captureFromPaste(
  url: string,
  title: string,
  text: string,
  html: string,
): WebCaptureInputValue {
  const value: WebCaptureInputValue = {
    url: urlFor(url),
    title,
    text,
    links: [],
    fields: [],
    ...(html ? { html } : {}),
  };
  if (html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    parsed
      .querySelectorAll('script,style,noscript,template')
      .forEach((element) => element.remove());
    if (!title) value.title = parsed.title.slice(0, 300);
    if (!text) {
      parsed.querySelectorAll('br').forEach((element) => element.replaceWith('\n'));
      parsed
        .querySelectorAll('p,div,section,article,li,h1,h2,h3,h4,tr')
        .forEach((element) => element.append('\n'));
      value.text = (parsed.body.textContent ?? '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    const links = new Map<string, { url: string; text: string }>();
    parsed.querySelectorAll('a[href]').forEach((element) => {
      try {
        const address = WebUrl.parse(new URL(element.getAttribute('href') ?? '', value.url).href);
        if (links.size < 200 && !links.has(address))
          links.set(address, {
            url: address,
            text: (element.textContent ?? '').trim().slice(0, 500),
          });
      } catch {}
    });
    value.links = [...links.values()];
    const seen = new Set<string>();
    parsed.querySelectorAll('input,select,textarea').forEach((element, index) => {
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
        type =
          element.tagName === 'SELECT'
            ? element.hasAttribute('multiple')
              ? 'select-multiple'
              : 'select'
            : element.tagName === 'TEXTAREA'
              ? 'textarea'
              : (element.getAttribute('type') ?? 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(type)) return;
      const name = element.getAttribute('name') ?? undefined,
        id = element.id,
        key = (name || id || `field_${index + 1}`).slice(0, 140);
      if (seen.has(key) || value.fields.length >= 100) return;
      const labelled = id
          ? [...parsed.querySelectorAll('label')].find((label) => label.htmlFor === id)
          : element.closest('label'),
        field: WebField = {
          key,
          name: name?.slice(0, 200),
          label: (
            labelled?.textContent?.trim() ||
            element.getAttribute('aria-label') ||
            name ||
            id ||
            uiText('字段 {0}', { '0': index + 1 })
          ).slice(0, 300),
          type,
          required: element.hasAttribute('required'),
          disabled: element.hasAttribute('disabled'),
          hidden: element.hasAttribute('hidden'),
          autocomplete: element.getAttribute('autocomplete')?.slice(0, 200),
          placeholder: element.getAttribute('placeholder')?.slice(0, 500),
        };
      if (type.startsWith('select'))
        field.options = [...(input as HTMLSelectElement).options]
          .map((option) => option.value)
          .slice(0, 100);
      if (type === 'radio') {
        field.type = 'select';
        field.options = [...parsed.querySelectorAll('input')]
          .filter((radio) => radio.type === 'radio' && radio.name === name)
          .map((radio) => radio.value)
          .slice(0, 100);
      }
      if (webFieldSensitive(field)) return;
      seen.add(key);
      value.fields.push(field);
    });
  }
  return WebCaptureInput.parse(value);
}
export function CaptureEditor({
  workspaceId,
  page,
  mutate,
  disabled,
  close,
  dirty,
}: {
  workspaceId: string;
  page: WebPage;
  mutate: Mutate;
  disabled: boolean;
  close: () => void;
  dirty: Dirty;
}) {
  useUiLocale();
  const [draft, setDraft, storageError] = useDraft(
      `ai-desktop:web-capture-draft:${workspaceId}:${page.id}`,
      () => ({ url: page.url, title: page.title, text: '', html: '' }),
      dirty,
    ),
    [tab, setTab] = useState<'text' | 'html'>('text'),
    [error, setError] = useState('');
  async function save() {
    try {
      const capture = captureFromPaste(draft.url, draft.title, draft.text, draft.html);
      if (!capture.text && !capture.html) throw new Error(uiText('请粘贴正文或 HTML 内容。'));
      const result = await mutate(
        { operation: 'capture', pageId: page.id, expectedRevision: page.revision, capture },
        uiText('网页快照'),
      );
      if (result) {
        setDraft({ ...draft, text: '', html: '' });
        close();
      }
    } catch (problem) {
      setError(message(problem));
    }
  }
  return (
    <div className="ww-modal-scrim">
      <section className="ww-modal ww-capture-modal">
        <header>
          <div>
            <small>SAVE A SNAPSHOT</small>
            <h2>{uiText('保存网页内容')}</h2>
          </div>
          <button onClick={close} aria-label={uiText('关闭')}>
            <Icon name="close" />
          </button>
        </header>
        <div className="ww-form-columns">
          <label>
            {uiText('来源网址')}
            <input
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              maxLength={4096}
            />
          </label>
          <label>
            {uiText('快照标题')}
            <input
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              maxLength={300}
            />
          </label>
        </div>
        <div className="ww-segments">
          <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>
            {uiText('粘贴正文')}
          </button>
          <button className={tab === 'html' ? 'active' : ''} onClick={() => setTab('html')}>
            {uiText('粘贴 HTML')}
          </button>
        </div>
        <textarea
          className={tab === 'html' ? 'ww-code-input' : ''}
          value={draft[tab]}
          maxLength={tab === 'text' ? 200000 : 350000}
          onChange={(event) => setDraft({ ...draft, [tab]: event.target.value })}
          placeholder={
            tab === 'text'
              ? uiText('从浏览器复制网页正文，粘贴在这里…')
              : uiText('粘贴页面 HTML。保存时会提取正文、链接和可填写字段。')
          }
        />
        <p className="ww-muted">
          {uiText(
            'HTML 作为资料保存，不在此执行脚本。留空正文时会从 HTML 提取文字。粘贴前请移除不需要保存的个人信息。',
          )}
        </p>
        {(error || storageError) && <p className="ww-inline-error">{error || storageError}</p>}
        <footer>
          <span>
            {draft.text.length.toLocaleString(interfaceLocale())} {uiText('正文字符 ·')}
            {draft.html.length.toLocaleString(interfaceLocale())} {uiText('HTML 字符')}
          </span>
          <button
            className="ww-primary"
            disabled={disabled || (!draft.text.trim() && !draft.html.trim())}
            onClick={() => void save()}
          >
            <Icon name="save" size={15} />
            {uiText('保存快照')}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function NotesPanel({
  workspaceId,
  page,
  notes,
  selection,
  consumed,
  locate,
  mutate,
  disabled,
  dirty,
}: {
  workspaceId: string;
  page: WebPage;
  notes: WebPageDetail['notes'];
  selection: Selection | null;
  consumed: () => void;
  locate: (note: WebNote) => void;
  mutate: Mutate;
  disabled: boolean;
  dirty: Dirty;
}) {
  useUiLocale();
  const [draft, setDraft, storageError] = useDraft<{
      selection?: Selection;
      body: string;
      noteId?: string;
    }>(`ai-desktop:web-note-draft:${workspaceId}:${page.id}`, () => ({ body: '' }), dirty),
    [showResolved, setShowResolved] = useState(false);
  useEffect(() => {
    if (selection) {
      setDraft({ selection, body: '' });
      consumed();
    }
  }, [selection]);
  async function save() {
    if (!draft.selection) return;
    const result = await mutate(
      {
        operation: 'note',
        action: draft.noteId ? 'update' : 'create',
        pageId: page.id,
        expectedRevision: page.revision,
        ...(draft.noteId ? { noteId: draft.noteId } : { ...draft.selection }),
        body: draft.body,
      },
      uiText('摘录批注'),
    );
    if (result) setDraft({ body: '' });
  }
  const visible = notes.filter((note) => !note.deletedAt && (showResolved || !note.resolved));
  return (
    <div className="ww-inspector-body">
      <header className="ww-panel-intro">
        <h3>{uiText('留下思考，找到原文')}</h3>
        <p>{uiText('选择左侧正文，将文字和批注一起保存。')}</p>
      </header>
      {draft.selection && (
        <div className="ww-note-composer">
          <blockquote>{draft.selection.quote}</blockquote>
          <textarea
            value={draft.body}
            maxLength={8000}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            placeholder={uiText('写下你的批注…')}
          />
          <footer>
            <button disabled={disabled} onClick={() => setDraft({ body: '' })}>
              {uiText('取消')}
            </button>
            <button disabled={disabled} className="ww-primary" onClick={() => void save()}>
              {uiText('保存批注')}
            </button>
          </footer>
        </div>
      )}
      {storageError && <p className="ww-inline-error">{storageError}</p>}
      <label className="ww-checkbox ww-resolved-toggle">
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(event) => setShowResolved(event.target.checked)}
        />
        {uiText('显示已解决批注')}
      </label>
      {visible.map((note) => (
        <article className={`ww-note ${note.resolved ? 'resolved' : ''}`} key={note.id}>
          <header>
            <span>{date(note.createdAt)}</span>
            <span>
              {note.orphaned
                ? uiText('原快照已移出保留范围')
                : note.resolved
                  ? uiText('已解决')
                  : uiText('待处理')}
            </span>
          </header>
          <button
            className="ww-quote"
            disabled={note.orphaned}
            onClick={() => locate(note)}
            title={uiText('定位到原文')}
          >
            {note.quote}
          </button>
          {note.body && <p>{note.body}</p>}
          <footer>
            <button
              disabled={disabled}
              onClick={() =>
                setDraft({
                  noteId: note.id,
                  selection: {
                    captureId: note.captureId,
                    quote: note.quote,
                    start: note.start,
                    end: note.end,
                  },
                  body: note.body,
                })
              }
            >
              <Icon name="pen" size={12} />
              {uiText('编辑')}
            </button>
            <button
              disabled={disabled}
              onClick={() =>
                void mutate(
                  {
                    operation: 'note',
                    action: 'resolve',
                    pageId: page.id,
                    expectedRevision: page.revision,
                    noteId: note.id,
                    resolved: !note.resolved,
                  },
                  uiText('批注状态'),
                )
              }
            >
              <Icon name="check" size={12} />
              {note.resolved ? uiText('重新打开') : uiText('解决')}
            </button>
            <button
              disabled={disabled}
              title={uiText('删除批注')}
              aria-label={uiText('删除批注')}
              onClick={() =>
                void mutate(
                  {
                    operation: 'note',
                    action: 'delete',
                    pageId: page.id,
                    expectedRevision: page.revision,
                    noteId: note.id,
                  },
                  uiText('删除批注'),
                )
              }
            >
              <Icon name="trash" size={12} />
            </button>
          </footer>
        </article>
      ))}
      {!visible.length && !draft.selection && (
        <Empty icon="comment" title={uiText('还没有摘录')}>
          {uiText('选择正文中的一段文字，即可开始。')}
        </Empty>
      )}
    </div>
  );
}

export function lineDiff(before: string, after: string) {
  const a = before.split('\n').slice(0, 1800),
    b = after.split('\n').slice(0, 1800),
    rows: { kind: 'same' | 'remove' | 'add'; text: string }[] = [];
  let x = 0,
    y = 0;
  while (x < a.length || y < b.length) {
    if (x < a.length && y < b.length && a[x] === b[y]) {
      rows.push({ kind: 'same', text: a[x++] });
      y++;
      continue;
    }
    let aheadA = -1,
      aheadB = -1;
    for (let offset = 1; offset <= 18; offset++) {
      if (aheadA < 0 && y < b.length && a[x + offset] === b[y]) aheadA = offset;
      if (aheadB < 0 && x < a.length && b[y + offset] === a[x]) aheadB = offset;
    }
    if (aheadA > 0 && (aheadB < 0 || aheadA <= aheadB)) {
      for (let i = 0; i < aheadA; i++) rows.push({ kind: 'remove', text: a[x++] });
    } else if (aheadB > 0) {
      for (let i = 0; i < aheadB; i++) rows.push({ kind: 'add', text: b[y++] });
    } else {
      if (x < a.length) rows.push({ kind: 'remove', text: a[x++] });
      if (y < b.length) rows.push({ kind: 'add', text: b[y++] });
    }
  }
  return { rows, truncated: before.split('\n').length > 1800 || after.split('\n').length > 1800 };
}
export function CaptureCompare({ captures, selected }: { captures: WebCapture[]; selected?: string }) {
  useUiLocale();
  const [beforeId, setBeforeId] = useState(captures[1]?.id ?? captures[0]?.id ?? ''),
    [afterId, setAfterId] = useState(selected ?? captures[0]?.id ?? ''),
    [changesOnly, setChangesOnly] = useState(true);
  const before = captures.find((item) => item.id === beforeId),
    after = captures.find((item) => item.id === afterId),
    diff = before && after ? lineDiff(before.text, after.text) : undefined;
  if (captures.length < 2)
    return (
      <Empty icon="document" title={uiText('保存第二个快照后即可比较')}>
        {uiText('对同一个网页再次捕获，查看正文在哪些地方发生变化。')}
      </Empty>
    );
  return (
    <div className="ww-compare">
      <header>
        <label>
          {uiText('之前')}
          <select value={beforeId} onChange={(event) => setBeforeId(event.target.value)}>
            {captures.map((item) => (
              <option key={item.id} value={item.id}>
                {date(item.capturedAt)} · {item.title}
              </option>
            ))}
          </select>
        </label>
        <Icon name="arrow" size={17} />
        <label>
          {uiText('之后')}
          <select value={afterId} onChange={(event) => setAfterId(event.target.value)}>
            {captures.map((item) => (
              <option key={item.id} value={item.id}>
                {date(item.capturedAt)} · {item.title}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="ww-compare-summary">
        <span>
          <b>{diff?.rows.filter((row) => row.kind === 'add').length ?? 0}</b> {uiText('行增加')}
        </span>
        <span>
          <b>{diff?.rows.filter((row) => row.kind === 'remove').length ?? 0}</b> {uiText('行删除')}
        </span>
        <label className="ww-checkbox">
          <input
            type="checkbox"
            checked={changesOnly}
            onChange={(event) => setChangesOnly(event.target.checked)}
          />
          {uiText('仅看变化')}
        </label>
      </div>
      {diff?.truncated && (
        <p className="ww-muted">
          {uiText('为保持编辑流畅，仅比较各快照前 1,800 行；完整内容可保存到桌面文件。')}
        </p>
      )}
      <div className="ww-diff">
        {diff?.rows
          .filter((row) => !changesOnly || row.kind !== 'same')
          .map((row, index) => (
            <pre key={index} className={row.kind}>
              <span>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}</span>
              {row.text || ' '}
            </pre>
          ))}
        {diff && !diff.rows.some((row) => row.kind !== 'same') && (
          <Empty title={uiText('正文没有变化')}>
            {uiText('两个快照的正文相同。来源时间、链接和表单字段可以在各自的快照中查看。')}
          </Empty>
        )}
      </div>
    </div>
  );
}
