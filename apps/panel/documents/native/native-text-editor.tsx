import { getUiLanguage as interfaceLocale } from '../../../../packages/components/ui-language.js';
import { subscribeUiLanguage as onUiLocale } from '../../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import { useTransientNotice } from '../../ui/use-transient-notice.js';
import React, { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { DesktopObject, MaterialRange } from '../../../../packages/contracts/index.js';
import {
  TextFileSave,
  TextNewline,
  TEXT_FILE_LIMIT,
  type NativeTextPage,
} from '../../../../packages/contracts/native-text.js';
import { PanelActionError } from '../../host.js';
import { scheduleDraftWrite, flushDraftStorage, writeDraftNow } from '../draft-storage.js';
import {
  NativeMarkdownPreview,
  NativeHtmlPreview,
  useSettledPreview,
} from './native-markup-preview.js';
import { NativeSvgEditor } from './native-svg-editor.js';
import { NativeSourceArea } from './native-source-area.js';
import './native-text-editor.css';

type Props = {
  object: DesktopObject;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  details: () => void;
  dirtyChanged: (value: boolean) => void;
  reference: (range?: MaterialRange) => Promise<boolean>;
  comment?: (range?: MaterialRange) => void;
  canReference: boolean;
};
const Draft = z
  .object({
    revision: z.number().int().positive(),
    text: z.string().max(TEXT_FILE_LIMIT),
    newline: TextNewline,
    pending: TextFileSave.nullable(),
  })
  .strict();
const Backup = z
  .object({
    format: z.literal('ai-desktop-text-draft'),
    version: z.literal(1),
    objectId: z.string(),
    draft: Draft,
  })
  .strict();
function parseBackup(value: unknown, objectId: string) {
  const backup = Backup.parse(value),
    draft = backup.draft;
  if (backup.objectId !== objectId)
    throw Error(uiText('草稿属于另一份桌面文件，请打开原文件后导入。'));
  if (
    draft.pending &&
    (draft.pending.objectId !== objectId ||
      draft.pending.expectedRevision !== draft.revision ||
      draft.pending.text !== draft.text ||
      draft.pending.newline !== draft.newline)
  )
    throw Error(uiText('草稿与待确认保存请求不一致。'));
  return draft;
}
let newlineLabel = {
  none: uiText('无换行'),
  lf: 'LF',
  crlf: 'CRLF',
  cr: 'CR',
  mixed: uiText('混合换行'),
};
export function NativeTextEditor({
  object,
  action,
  updated,
  details,
  dirtyChanged,
  reference,
  comment,
  canReference,
}: Props) {
  useUiLocale();
  const fileName = (object.content as { fileName: string }).fileName,
    extension = fileName.split('.').pop()?.toLowerCase();
  const format =
    extension === 'md' || extension === 'markdown'
      ? 'markdown'
      : extension === 'html' || extension === 'htm'
        ? 'html'
        : extension === 'svg'
          ? 'svg'
          : 'text';
  const formatLabel = { markdown: 'Markdown', html: 'HTML', svg: 'SVG', text: uiText('文本') }[
    format
  ];
  const storageKey = `ai-desktop:text-file-draft:${object.id}`;
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return { draft: raw ? parseBackup(JSON.parse(raw), object.id) : null, error: '' };
    } catch {
      return { draft: null, error: uiText('本地草稿无法读取，可从已下载的草稿文件恢复。') };
    }
  });
  const [draft, setDraft] = useState<z.infer<typeof Draft> | null>(initial.draft),
    [revision, setRevision] = useState(initial.draft?.revision ?? object.revision);
  const [page, setPage] = useState<NativeTextPage | null>(null),
    [latest, setLatest] = useState<NativeTextPage | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  const [error, setError] = useState(initial.error),
    [notice, setNotice] = useTransientNotice(initial.draft ? uiText('已恢复本地草稿。') : ''),
    [storageError, setStorageError] = useState(''),
    [discard, setDiscard] = useState(false);
  const [find, setFind] = useState(''),
    [replacement, setReplacement] = useState(''),
    [line, setLine] = useState('1'),
    [wrap, setWrap] = useState(false),
    [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [selection, setSelection] = useState({ start: 0, end: 0 }),
    [merged, setMerged] = useState<string | null>(null);
  const [mode, setMode] = useState<'source' | 'split' | 'preview'>(
      format === 'text' ? 'source' : format === 'html' ? 'preview' : 'split',
    ),
    [composing, setComposing] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null),
    importInput = useRef<HTMLInputElement>(null),
    actions = useRef(action),
    inFlight = useRef(false),
    cursorFrame = useRef<number | null>(null);
  actions.current = action;
  const [focus] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`native-focus:${object.id}`) ?? 'null');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!loading && page && focus?.offset >= 0 && area.current) {
      area.current.focus();
      area.current.setSelectionRange(focus.offset, focus.offset + 40);
      area.current.scrollTop = page.text.slice(0, focus.offset).split('\n').length * 20 - 80;
    }
  }, [loading, focus]);
  const pending = draft?.pending ?? null,
    text = draft?.text ?? page?.text ?? '',
    newline = draft?.newline ?? 'preserve',
    dirty = !!draft,
    blocked = busy || loading || !!pending,
    conflict = object.revision !== revision;
  const showSource = mode !== 'preview' || format === 'text' || !!latest,
    showPreview = format !== 'text' && mode !== 'source' && !latest;
  const preview = useSettledPreview(text, showPreview && format !== 'svg', composing);
  function backup(value: z.infer<typeof Draft>) {
    return { format: 'ai-desktop-text-draft', version: 1, objectId: object.id, draft: value };
  }
  useEffect(() => {
    if (!dirty && !loading && !busy && revision !== object.revision) {
      setRevision(object.revision);
      setReload((n) => n + 1);
    }
  }, [object.revision, revision, dirty, loading, busy]);
  useEffect(() => {
    dirtyChanged(dirty || busy);
    return () => dirtyChanged(false);
  }, [dirty, busy, dirtyChanged]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, busy]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setPage(null);
    void actions
      .current('text_file_read', { objectId: object.id, expectedRevision: revision })
      .then((result: NativeTextPage) => {
        if (live) setPage(result);
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [object.id, revision, reload]);
  useEffect(() => {
    if (!draft && initial.error) return;
    scheduleDraftWrite(
      storageKey,
      () => (draft ? JSON.stringify(backup(draft)) : null),
      (error) =>
        setStorageError(
          error ? uiText('本地草稿空间不足或不可用，请保存或下载草稿后再关闭。') : '',
        ),
    );
  }, [draft, storageKey]);
  useEffect(() => () => flushDraftStorage(storageKey), [storageKey]);
  useEffect(
    () => () => {
      if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
    },
    [],
  );
  function change(value: string, nextNewline = newline) {
    if (blocked || !page) return;
    if (value.length > TEXT_FILE_LIMIT) {
      setError(uiText('编辑内容超过 1 MiB 字符上限。'));
      return;
    }
    setDraft(
      value === page.text && nextNewline === 'preserve'
        ? null
        : { revision, text: value, newline: nextNewline, pending: null },
    );
    setDiscard(false);
  }
  function locate() {
    if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
    cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = null;
      const input = area.current;
      if (!input) return;
      const start = input.selectionStart,
        end = input.selectionEnd,
        value = input.value;
      let rows = 1,
        previous = -1,
        index = value.indexOf('\n');
      while (index >= 0 && index < start) {
        rows++;
        previous = index;
        index = value.indexOf('\n', index + 1);
      }
      setCursor((current) =>
        current.line === rows && current.column === start - previous
          ? current
          : { line: rows, column: start - previous },
      );
      setSelection((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    });
  }
  function selectSource(start: number, end = start) {
    if (mode === 'preview') setMode('split');
    requestAnimationFrame(() => {
      const input = area.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(start, end);
      if (!wrap) {
        let row = 0,
          index = input.value.indexOf('\n');
        while (index >= 0 && index < start) {
          row++;
          index = input.value.indexOf('\n', index + 1);
        }
        const top = 18 + row * 22;
        if (top < input.scrollTop || top + 22 > input.scrollTop + input.clientHeight)
          input.scrollTop = Math.max(0, top - input.clientHeight / 2);
      }
      locate();
    });
  }
  function formatSelection(
    kind:
      | 'heading'
      | 'bold'
      | 'italic'
      | 'code'
      | 'quote'
      | 'list'
      | 'ordered'
      | 'task'
      | 'link'
      | 'fence',
  ) {
    if (blocked || !page || composing) return;
    const start = area.current?.selectionStart ?? selection.start,
      end = area.current?.selectionEnd ?? selection.end,
      selected = text.slice(start, end);
    let from = start,
      to = end,
      value = '',
      selectedStart = 0,
      selectedEnd = 0;
    if (['heading', 'quote', 'list', 'ordered', 'task'].includes(kind)) {
      from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
      const last = text.indexOf(
        '\n',
        Math.max(start, end - (end > start && text[end - 1] === '\n' ? 1 : 0)),
      );
      to = last < 0 ? text.length : last;
      value = text
        .slice(from, to)
        .split('\n')
        .map((line, index) => {
          if (kind === 'heading') return '## ' + line.replace(/^#{1,6}\s+/, '');
          if (kind === 'quote') return '> ' + line.replace(/^>\s?/, '');
          const prefix = kind === 'ordered' ? `${index + 1}. ` : kind === 'task' ? '- [ ] ' : '- ';
          return prefix + line.replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
        })
        .join('\n');
      selectedStart = from;
      selectedEnd = from + value.length;
    } else {
      const wrappers = {
        bold: ['**', '**', uiText('加粗文字')],
        italic: ['*', '*', uiText('斜体文字')],
        code: ['`', '`', uiText('代码')],
        link: ['[', '](https://example.com)', uiText('链接文字')],
        fence: ['```\n', '\n```', uiText('代码内容')],
      } as const;
      const [prefix, suffix, placeholder] = wrappers[kind as keyof typeof wrappers],
        content = selected || placeholder;
      value = prefix + content + suffix;
      selectedStart = from + prefix.length;
      selectedEnd = selectedStart + content.length;
    }
    const next = text.slice(0, from) + value + text.slice(to);
    if (next.length > TEXT_FILE_LIMIT) {
      setError(uiText('编辑内容超过 1 MiB 字符上限。'));
      return;
    }
    change(next);
    selectSource(selectedStart, selectedEnd);
  }
  function merge() {
    if (!latest || !page) return;
    const base = page.text;
    const delta = (value: string) => {
      let start = 0,
        end = base.length,
        tail = value.length;
      while (start < end && start < tail && base[start] === value[start]) start++;
      while (end > start && tail > start && base[end - 1] === value[tail - 1]) {
        end--;
        tail--;
      }
      return { start, end, value: value.slice(start, tail) };
    };
    const a = delta(text),
      b = delta(latest.text);
    let result: string | null = null;
    if (text === base) result = latest.text;
    else if (latest.text === base || text === latest.text) result = text;
    else if (
      (a.end <= b.start && !(a.start === a.end && a.start === b.start)) ||
      (b.end <= a.start && !(b.start === b.end && a.start === b.start))
    ) {
      result = base;
      for (const d of [a, b].sort((x, y) => y.start - x.start))
        result = result.slice(0, d.start) + d.value + result.slice(d.end);
    }
    setMerged(result ?? text);
    setNotice(
      result === null
        ? uiText('修改区间重叠，合并框保留你的草稿；请对照最新文本手工调整后采用。')
        : uiText('已合并互不重叠的修改。请查看合并结果后采用。'),
    );
  }
  function adoptMerge() {
    if (merged === null || !latest || pending || busy) return;
    if (merged.length > TEXT_FILE_LIMIT) {
      setError(uiText('合并结果过大。'));
      return;
    }
    setRevision(latest.revision);
    setDraft({ revision: latest.revision, text: merged, newline, pending: null });
    setPage(latest);
    setLatest(null);
    setMerged(null);
    setNotice(uiText('合并结果已成为草稿；保存时仍检查最新版本。'));
  }
  function findNext() {
    if (!find) return;
    const start = area.current?.selectionEnd ?? selection.end,
      index = text.indexOf(find, start),
      next = index < 0 ? text.indexOf(find) : index;
    if (next < 0) {
      setNotice(uiText('没有找到匹配内容。'));
      return;
    }
    selectSource(next, next + find.length);
    setNotice(uiText('已选中匹配内容。'));
  }
  function replaceOne() {
    if (blocked || !find || composing) return;
    const start = area.current?.selectionStart ?? selection.start,
      end = area.current?.selectionEnd ?? selection.end;
    if (text.slice(start, end) !== find) {
      findNext();
      return;
    }
    if (text.length - find.length + replacement.length > TEXT_FILE_LIMIT) {
      setError(uiText('替换后的文本过大，未修改草稿。'));
      return;
    }
    change(text.slice(0, start) + replacement + text.slice(end));
    selectSource(start, start + replacement.length);
    setNotice(uiText('已替换此处，保存后写回原文件。'));
  }
  function sourceKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (
      blocked ||
      composing ||
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const input = event.currentTarget,
      start = input.selectionStart,
      end = input.selectionEnd;
    if (!event.shiftKey && start === end) {
      if (text.length + 4 > TEXT_FILE_LIMIT) return;
      change(text.slice(0, start) + '    ' + text.slice(end));
      selectSource(start + 4);
      return;
    }
    const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1,
      toEnd = text.indexOf(
        '\n',
        Math.max(start, end - (end > start && text[end - 1] === '\n' ? 1 : 0)),
      ),
      to = toEnd < 0 ? text.length : toEnd,
      lines = text.slice(from, to).split('\n');
    const amounts = lines.map((line) =>
        event.shiftKey
          ? -(line.startsWith('\t') ? 1 : (line.match(/^ {1,4}/)?.[0].length ?? 0))
          : 4,
      ),
      value = lines
        .map((line, i) =>
          amounts[i] < 0 ? line.slice(-amounts[i]) : ' '.repeat(amounts[i]) + line,
        )
        .join('\n'),
      next = text.slice(0, from) + value + text.slice(to);
    if (next.length > TEXT_FILE_LIMIT) {
      setError(uiText('缩进后的文本过大，未修改草稿。'));
      return;
    }
    change(next);
    const selectedStart = Math.max(from, start + amounts[0]);
    selectSource(
      selectedStart,
      start === end
        ? selectedStart
        : Math.max(selectedStart, end + amounts.reduce((a, b) => a + b, 0)),
    );
  }
  function replaceAll() {
    if (blocked || !find || composing) return;
    const parts = text.split(find),
      count = parts.length - 1;
    if (!count) {
      setNotice(uiText('没有找到匹配内容。'));
      return;
    }
    if (text.length + count * (replacement.length - find.length) > TEXT_FILE_LIMIT) {
      setError(uiText('替换后的文本过大，未修改草稿。'));
      return;
    }
    change(parts.join(replacement));
    setNotice(uiText('已替换 {0} 处，保存后写回原文件。', { '0': count }));
  }
  function jump() {
    const target = Number(line);
    if (!Number.isInteger(target) || target < 1) return;
    let offset = 0;
    for (let n = 1; n < target; n++) {
      const next = text.indexOf('\n', offset);
      if (next < 0) {
        offset = text.length;
        break;
      }
      offset = next + 1;
    }
    selectSource(offset);
  }
  async function save() {
    if (inFlight.current || (!pending && (loading || !draft))) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    let request = pending;
    try {
      if (!request) {
        if (conflict) throw Error(uiText('文件已有新版本，请下载草稿并比较最新文件后合并。'));
        request = TextFileSave.parse({
          requestId: crypto.randomUUID(),
          objectId: object.id,
          expectedRevision: revision,
          text,
          newline,
        });
        const next = { revision, text, newline, pending: request };
        setDraft(next);
        try {
          writeDraftNow(storageKey, JSON.stringify(backup(next)));
        } catch {
          setStorageError(uiText('无法保留待确认请求，请勿关闭页面，可下载草稿保留请求。'));
        }
      }
      const result = await action('text_file_save', request);
      setDraft(null);
      setRevision(result.revision);
      setLatest(null);
      setReload((n) => n + 1);
      setNotice(
        result.changed
          ? uiText('已保存回原文件 · v{0}，原对象及历史版本保留。', { '0': result.revision })
          : uiText('文件内容未变，未新增版本。'),
      );
      try {
        writeDraftNow(storageKey, null);
      } catch {}
      await updated();
    } catch (e) {
      if (
        e instanceof PanelActionError &&
        [
          'TEXT_FILE',
          'TEXT_LIMIT',
          'TEXT_ENCODING',
          'TEXT_BINARY',
          'TEXT_NEWLINE',
          'REVISION_CONFLICT',
          'DRAFT_ACTIVE',
          'VALIDATION_FAILED',
          'REQUEST_ID_REUSED',
        ].includes(e.code)
      )
        setDraft((current) => (current ? { ...current, pending: null } : null));
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function download() {
    if (!draft) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup(draft), null, 2)], { type: 'application/json' }),
      ),
      link = document.createElement('a');
    link.href = url;
    link.download = uiText('{0}.编辑草稿.json', {
      '0': (object.content as { fileName: string }).fileName,
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importDraft(file: File) {
    if (inFlight.current || dirty) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (file.size > 12 * 1024 * 1024) throw Error(uiText('草稿文件过大。'));
      const value = parseBackup(JSON.parse(await file.text()), object.id);
      await action('text_file_read', { objectId: object.id, expectedRevision: value.revision });
      setDraft(value);
      setRevision(value.revision);
      setReload((n) => n + 1);
      setLatest(null);
      setNotice(
        value.pending
          ? uiText('已恢复待确认请求，请重试同一次保存。')
          : uiText('已导入草稿，保存后更新原文件。'),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function compare() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      setLatest(
        await action('text_file_read', { objectId: object.id, expectedRevision: object.revision }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function reset() {
    setMerged(null);
    setDraft(null);
    setRevision(object.revision);
    setReload((n) => n + 1);
    setDiscard(false);
    setLatest(null);
    setError('');
    setNotice(uiText('已载入最新文件。'));
    try {
      writeDraftNow(storageKey, null);
    } catch {}
  }
  return (
    <div
      className="native-text-editor"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === 's') {
          event.preventDefault();
          event.stopPropagation();
          void save();
        } else if (key === 'f') {
          event.preventDefault();
          event.stopPropagation();
          if (selection.end > selection.start && selection.end - selection.start < 500)
            setFind(text.slice(selection.start, selection.end));
          findInput.current?.focus();
          findInput.current?.select();
        }
      }}
    >
      <div className="native-text-toolbar">
        <div>
          <strong>{fileName}</strong>
          <small>
            {formatLabel} {uiText('原生文件 · v')}
            {revision}
          </small>
        </div>
        <div className="native-text-buttons">
          <button
            className="primary"
            disabled={busy || (!pending && (loading || !dirty))}
            onClick={() => void save()}
          >
            {busy ? uiText('处理中…') : pending ? uiText('重试同一次保存') : uiText('保存回原文件')}
          </button>
          <button disabled={!dirty} onClick={download}>
            {uiText('下载草稿')}
          </button>
          <button disabled={busy || loading || dirty} onClick={() => importInput.current?.click()}>
            {uiText('导入草稿')}
          </button>
          <input
            hidden
            type="file"
            accept=".json,application/json"
            ref={importInput}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importDraft(file);
            }}
          />
          <button disabled={busy} onClick={() => (dirty ? setDiscard(true) : reset())}>
            {uiText('载入最新')}
          </button>
          <button disabled={dirty || busy} onClick={details}>
            {uiText('文件详情')}
          </button>
          <button
            disabled={
              !showSource ||
              blocked ||
              dirty ||
              conflict ||
              !canReference ||
              selection.end <= selection.start ||
              selection.end - selection.start > 24000
            }
            onClick={() =>
              void action('native_workbench', {
                operation: 'reference',
                objectId: object.id,
                expectedRevision: revision,
                selection: { kind: 'text', ...selection },
              })
                .then(reference)
                .catch((e) => setError(String(e)))
            }
          >
            {uiText('引用选中文本')}
          </button>
          {comment && (
            <button
              disabled={
                !showSource ||
                blocked ||
                dirty ||
                conflict ||
                selection.end <= selection.start ||
                selection.end - selection.start > 24000
              }
              title={
                dirty ? uiText('先保存修改，再评论原文件选区') : uiText('评论当前选中的原文件文字')
              }
              onClick={() =>
                void action('native_workbench', {
                  operation: 'reference',
                  objectId: object.id,
                  expectedRevision: revision,
                  selection: { kind: 'text', ...selection },
                })
                  .then((range) => comment(range))
                  .catch((e) => setError(String(e)))
              }
            >
              {uiText('评论选中文本')}
            </button>
          )}
        </div>
      </div>
      {discard && (
        <div className="native-text-message">
          {uiText('载入最新将丢弃本页草稿。')}
          {pending && uiText('待确认请求可能已保存，请先重试同一次保存。')}
          <button onClick={download}>{uiText('先下载草稿')}</button>
          <button disabled={busy} onClick={reset}>
            {uiText('丢弃草稿并载入')}
          </button>
          <button onClick={() => setDiscard(false)}>{uiText('取消')}</button>
        </div>
      )}
      {conflict && (
        <div className="native-text-message">
          {uiText('桌面文件已更新至 v')}
          {object.revision}
          {uiText('；本页保留 v')}
          {revision} {uiText('的编辑。')}
          <button disabled={busy} onClick={() => void compare()}>
            {uiText('查看最新文本')}
          </button>
        </div>
      )}
      {format !== 'text' && (
        <div className="native-text-viewbar">
          <div className="native-text-modes" role="group" aria-label={uiText('编辑视图')}>
            {(['source', 'split', 'preview'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={mode === value}
                className={mode === value ? 'active' : ''}
                onClick={() => {
                  setMode(value);
                  if (latest) {
                    setLatest(null);
                    setMerged(null);
                  }
                }}
              >
                {value === 'source'
                  ? uiText('源码')
                  : value === 'split'
                    ? uiText('并排')
                    : format === 'svg'
                      ? uiText('图形')
                      : uiText('预览')}
              </button>
            ))}
          </div>
          <span>
            {format === 'html'
              ? uiText('静态预览 · 支持受控文内样式 · 禁止外部资源与脚本')
              : format === 'markdown'
                ? uiText('Markdown 排版 · 文内锚点可跳转 · 外部资源仅展示')
                : uiText('源码与图形同步编辑')}
            {showPreview && format !== 'svg' && preview.pending ? uiText(' · 预览更新中…') : ''}
          </span>
        </div>
      )}
      {format === 'markdown' && (
        <div className="native-markdown-tools" role="group" aria-label={uiText('Markdown 格式')}>
          {(
            [
              { kind: 'heading', label: 'H₂', title: uiText('二级标题') },
              { kind: 'bold', label: 'B', title: uiText('加粗') },
              { kind: 'italic', label: 'I', title: uiText('斜体') },
              { kind: 'code', label: '</>', title: uiText('行内代码') },
              { kind: 'quote', label: uiText('引用'), title: uiText('引用段落') },
              { kind: 'list', label: uiText('列表'), title: uiText('无序列表') },
              { kind: 'ordered', label: uiText('1. 列表'), title: uiText('有序列表') },
              { kind: 'task', label: uiText('☑ 待办'), title: uiText('任务列表') },
              { kind: 'link', label: uiText('链接'), title: uiText('插入链接') },
              { kind: 'fence', label: uiText('代码块'), title: uiText('插入代码块') },
            ] as const
          ).map((item) => (
            <button
              key={item.kind}
              title={item.title}
              aria-label={item.title}
              disabled={blocked || !page || composing}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => formatSelection(item.kind)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div className="native-text-options">
        <label>
          {uiText('换行')}
          <select
            value={newline}
            disabled={blocked || !page}
            onChange={(e) => change(text, TextNewline.parse(e.target.value))}
          >
            <option value="preserve">
              {uiText('保留原换行')}
              {page ? `（${newlineLabel[page.newline]}）` : ''}
            </option>
            <option value="lf">LF</option>
            <option value="crlf">CRLF</option>
            <option value="cr">CR</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
          {uiText('自动折行')}
        </label>
        <label>
          {uiText('行')}
          <input
            type="number"
            min="1"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') jump();
            }}
          />
        </label>
        <button disabled={loading} onClick={jump}>
          {uiText('跳转')}
        </button>
      </div>
      <div className="native-text-find">
        <input
          ref={findInput}
          aria-label={uiText('查找文本')}
          placeholder={uiText('查找文本（区分大小写）')}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') findNext();
          }}
        />
        <button disabled={loading || !find} onClick={findNext}>
          {uiText('下一个')}
        </button>
        <input
          aria-label={uiText('替换为')}
          placeholder={uiText('替换为')}
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
        />
        <button disabled={blocked || !find || !page || composing} onClick={replaceOne}>
          {uiText('替换此处')}
        </button>
        <button disabled={blocked || !find || !page || composing} onClick={replaceAll}>
          {uiText('全部替换')}
        </button>
      </div>
      {page?.newline === 'mixed' && (
        <div className="native-text-message">
          {uiText('原文件混用换行符，修改后请选择一种换行方式再保存。')}
        </div>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {storageError && (
        <p role="alert" className="error-text">
          {storageError}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div
        className={`native-text-content ${showSource && showPreview ? 'is-split' : ''} ${latest ? 'has-comparison' : ''}`}
      >
        {showSource && (
          <section className="native-text-source">
            <header>
              <span>{format === 'text' ? uiText('文本') : uiText('源码')}</span>
              <small>
                {wrap ? uiText('自动折行') : uiText('Tab / Shift Tab 缩进 · Ctrl F 查找')} ·{' '}
                {dirty ? uiText('本地草稿') : uiText('原文件')}
              </small>
            </header>
            <NativeSourceArea
              textareaRef={area}
              text={text}
              wrap={wrap}
              currentLine={cursor.line}
              composing={composing}
              readOnly={blocked || !page}
              change={(value) => change(value)}
              locate={locate}
              composition={setComposing}
              keyDown={sourceKeyDown}
              placeholder={loading ? uiText('正在读取原文件…') : ''}
            />
          </section>
        )}
        {showPreview && (
          <section className={`native-text-preview native-text-preview-${format}`}>
            <header>
              <span>
                {format === 'svg'
                  ? uiText('图形编辑')
                  : format === 'html'
                    ? uiText('静态预览')
                    : uiText('阅读预览')}
              </span>
              <small>
                {loading
                  ? uiText('读取中')
                  : format !== 'svg' && preview.pending
                    ? uiText('正在更新')
                    : ''}
              </small>
            </header>
            <div className="native-text-preview-body">
              {loading ? (
                <div className="native-preview-empty">{uiText('正在读取原文件…')}</div>
              ) : format === 'markdown' ? (
                <NativeMarkdownPreview source={preview.source} />
              ) : format === 'html' ? (
                <NativeHtmlPreview source={preview.source} />
              ) : (
                <NativeSvgEditor
                  source={text}
                  change={(value) => change(value)}
                  readOnly={blocked || !page}
                />
              )}
            </div>
          </section>
        )}
        {latest && (
          <section className="native-text-comparison">
            <header>
              <span>
                {uiText('最新文件 · v')}
                {latest.revision}
              </span>
              <button disabled={blocked} onClick={merge}>
                {uiText('辅助合并')}
              </button>
              <button
                onClick={() => {
                  setLatest(null);
                  setMerged(null);
                }}
              >
                {uiText('关闭比较')}
              </button>
            </header>
            <textarea
              aria-label={uiText('最新文件只读文本')}
              readOnly
              spellCheck={false}
              wrap={wrap ? 'soft' : 'off'}
              value={latest.text}
            />
          </section>
        )}
      </div>
      {merged !== null && (
        <section className="native-text-merge">
          <strong>{uiText('合并结果（可编辑）')}</strong>
          <textarea
            aria-label={uiText('合并结果')}
            value={merged}
            onChange={(e) => setMerged(e.target.value)}
            spellCheck={false}
          />
          <button disabled={blocked} onClick={adoptMerge}>
            {uiText('采用合并结果，继续编辑')}
          </button>
          <button onClick={() => setMerged(null)}>{uiText('取消合并')}</button>
        </section>
      )}
      <div className="native-text-status">
        <span>
          {cursor.line}:{cursor.column} · {text.length.toLocaleString(interfaceLocale())}{' '}
          {uiText('字符')}
        </span>
        <span>
          {page
            ? `${page.encoding.toUpperCase()}${page.bom ? ' + BOM' : ''} · ${newlineLabel[page.newline]}`
            : uiText('读取中')}{' '}
          · {pending ? uiText('保存结果待确认') : dirty ? uiText('草稿未保存') : uiText('已保存')}
        </span>
      </div>
    </div>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  newlineLabel = {
    none: uiText('无换行'),
    lf: 'LF',
    crlf: 'CRLF',
    cr: 'CR',
    mixed: uiText('混合换行'),
  };
});
