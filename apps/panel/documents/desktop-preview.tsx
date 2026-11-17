import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWorkbenchLayer } from '../ui/workbench-layers.js';
import type {
  DesktopObject,
  Deck,
  Diagram,
  Table,
  Workbook,
} from '../../../packages/contracts/index.js';
import type { NativeTextPage } from '../../../packages/contracts/native-text.js';
import { columnLabel, cellPosition, type XlsxPage } from '../../../packages/contracts/xlsx.js';
import type { OfficePage, OfficeParagraph } from '../../../packages/contracts/office.js';
import { diagramSvg } from '../../../packages/components/structured.js';
import { NativeMarkdownPreview, NativeHtmlPreview } from './native/native-markup-preview.js';
import { SvgImagePreview } from './svg-image-preview.js';
import { NativePreview } from './native/native-preview.js';
import { ImagePreview } from './images.js';
import { SlidePreview } from './structured-editors.js';
import { previewDiagnostic } from './preview-diagnostic.js';
import './native/native-text-editor.css';
import './desktop-preview.css';

type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export type DesktopPreviewProps = {
  object: DesktopObject;
  action: Action;
  close: () => void;
  edit: () => void;
  draft?: boolean;
  ask?: () => void;
  askDisabled?: boolean;
  position?: { index: number; total: number; previous: () => void; next: () => void };
};
const ignore = () => {};
const resolved = async () => {};
const noReference = async () => false;
// Keep native navigation, text selection and embedded viewers in charge of their own keys.
const previewControl =
  'button,a[href],input,select,textarea,summary,iframe,object,embed,audio,video,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="slider"],[role="scrollbar"],[role="spinbutton"],[role="textbox"],[role="combobox"],[role="listbox"],[role="grid"],[role="tab"],[tabindex]:not([tabindex="-1"]),[data-preview-shortcuts="off"]';

/** Native files are read-only; supplied legacy drafts stay in memory. No editor lease is acquired. */
export function DesktopPreview(props: DesktopPreviewProps) {
  useUiLocale();
  const { object, close, edit, position } = props,
    heading = useId(),
    help = useId(),
    dialog = useRef<HTMLElement>(null),
    callbacks = useRef(props);
  callbacks.current = props;
  useEffect(() => {
    previewDiagnostic('open', object);
    return () => previewDiagnostic('close', object);
  }, [object.id, object.revision]);
  useWorkbenchLayer(true, dialog, () => callbacks.current.close(), 'preview');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[data-desktop-overlay][open]')) return;
      if (document.querySelector('.screenshot-ai-select, .screenshot-ai-composer')) return;
      if (event.isComposing) return;
      if (event.defaultPrevented || event.key === 'Escape') return;
      if (!dialog.current) return;
      if (event.key !== 'Tab') {
        if (
          event.defaultPrevented ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.repeat
        )
          return;
        const target = event.target instanceof Element ? event.target : null;
        const selection = window.getSelection();
        if (
          !target ||
          !dialog.current.contains(target) ||
          target.closest(previewControl) ||
          (selection && !selection.isCollapsed && dialog.current.contains(selection.anchorNode))
        )
          return;
        const current = callbacks.current,
          position = current.position;
        if (event.key === 'ArrowLeft' && position && position.index > 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          position.previous();
        } else if (event.key === 'ArrowRight' && position && position.index < position.total - 1) {
          event.preventDefault();
          event.stopImmediatePropagation();
          position.next();
        } else if (event.key === ' ') {
          event.preventDefault();
          event.stopImmediatePropagation();
          current.close();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopImmediatePropagation();
          current.edit();
        }
        return;
      }
      const items = Array.from(
          dialog.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ),
        ).filter((item) => item.getClientRects().length > 0),
        first = items[0],
        last = items.at(-1);
      if (!first) return;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialog.current ||
          !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === dialog.current ||
          !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (document.activeElement === document.body) dialog.current?.focus();
  }, [object.id]);
  const file =
    object.kind === 'file' ? (object.content as { fileName: string; size: number }) : null;
  return createPortal(
    <div
      className="desktop-preview-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="desktop-preview-window"
        data-file-ai-object={object.id}
        data-file-ai-revision={object.revision}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        aria-describedby={help}
        tabIndex={-1}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="desktop-preview-header">
          <button
            className="desktop-preview-close"
            aria-label={uiText('关闭预览')}
            title={uiText('关闭预览（Esc / 空格）')}
            onClick={close}
          >
            ×
          </button>
          <div className="desktop-preview-heading">
            <strong id={heading}>{object.title}</strong>
            <span>
              {file?.fileName ??
                (
                  {
                    text: uiText('文本'),
                    code: uiText('代码'),
                    table: uiText('表格'),
                    image: uiText('图片'),
                    diagram: uiText('图形'),
                    deck: uiText('演示文稿'),
                    workbook: uiText('工作簿'),
                  } as Record<string, string>
                )[object.kind]}{' '}
              ·{' '}
              {props.draft && object.kind !== 'file'
                ? uiText('当前草稿（未保存）')
                : uiText('已保存 v{0}', { '0': object.revision })}{' '}
              {uiText('· 只读预览')}
            </span>
          </div>
          {position && position.total > 1 && (
            <nav className="desktop-preview-switch" aria-label={uiText('切换预览材料')}>
              <button
                disabled={position.index <= 0}
                onClick={position.previous}
                aria-label={uiText('上一份材料')}
                title={uiText('上一份材料（←）')}
              >
                ‹
              </button>
              <span aria-live="polite">
                {position.index + 1} / {position.total}
              </span>
              <button
                disabled={position.index >= position.total - 1}
                onClick={position.next}
                aria-label={uiText('下一份材料')}
                title={uiText('下一份材料（→）')}
              >
                ›
              </button>
            </nav>
          )}
          {props.ask && (
            <button
              className="desktop-preview-ask"
              disabled={props.askDisabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.ask}
            >
              {uiText('问 AI')}
            </button>
          )}
          <button
            className="desktop-preview-edit"
            title={uiText('打开编辑（Enter）')}
            onClick={edit}
          >
            {uiText('打开编辑')}
          </button>
        </header>
        <PreviewContent key={`${object.id}:${object.revision}`} {...props} />
        <footer className="desktop-preview-keyboard" id={help}>
          {position && position.total > 1 && (
            <span>
              <kbd>←</kbd>
              <kbd>→</kbd> {uiText('切换材料')}
            </span>
          )}
          <span>
            <kbd>Enter</kbd> {uiText('打开编辑')}
          </span>
          <span>
            <kbd>{uiText('空格')}</kbd> / <kbd>Esc</kbd> {uiText('关闭')}
          </span>
          <small>{uiText('输入、选区和控件保留原有按键操作')}</small>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function PreviewContent({ object, action, edit }: DesktopPreviewProps) {
  useUiLocale();
  const [zoom, setZoom] = useState(1),
    [mode, setMode] = useState<'preview' | 'source'>('preview'),
    [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [text, setText] = useState<NativeTextPage | null>(null);
  const file =
      object.kind === 'file'
        ? (object.content as { fileName: string; mime: string; size: number })
        : null,
    extension = file?.fileName.split('.').pop()?.toLowerCase() ?? '';
  const image = object.kind === 'image' || (!!file && /^(image\/(?!svg))/.test(file.mime)),
    media = !!file && (extension === 'pdf' || image),
    sheet = extension === 'xlsx',
    office = extension === 'docx' || extension === 'pptx';
  const textFile =
    !!file &&
    !media &&
    !sheet &&
    !office &&
    (/^(text\/|application\/(?:json|xml|javascript))/.test(file.mime) ||
      /^(?:txt|md|markdown|html?|svg|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|log|py|js|jsx|ts|tsx|css|scss|c|cc|cpp|h|hpp|cs|java|rs|go|sh|ps1|sql)$/.test(
        extension,
      ));
  const source =
    text?.text ??
    (object.kind === 'text'
      ? (object.content as { blocks: { text: string }[] }).blocks
          .map((block) => block.text)
          .join('\n')
      : object.kind === 'code'
        ? (object.content as { code: string }).code
        : '');
  const format =
    extension === 'svg'
      ? 'svg'
      : extension === 'md' ||
          extension === 'markdown' ||
          object.kind === 'text' ||
          (object.kind === 'code' &&
            (object.content as { language: string }).language === 'markdown')
        ? 'markdown'
        : extension === 'html' || extension === 'htm'
          ? 'html'
          : 'text';
  const nativeZoom = media;
  const actions = useRef(action);
  actions.current = action;
  useEffect(() => {
    if (!textFile) return;
    let live = true;
    setLoading(true);
    setError('');
    void actions
      .current('text_file_read', { objectId: object.id, expectedRevision: object.revision })
      .then((page: NativeTextPage) => {
        if (live) setText(page);
      })
      .catch((value) => {
        if (live) setError(String(value));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [textFile, object.id, object.revision, retry]);
  return (
    <div className="desktop-preview-content">
      {!media && (
        <div className="desktop-preview-toolbar">
          {(textFile || object.kind === 'text' || object.kind === 'code') && format !== 'text' && (
            <div className="desktop-preview-segments" role="group" aria-label={uiText('预览方式')}>
              <button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
                {format === 'svg'
                  ? uiText('图形')
                  : format === 'html'
                    ? uiText('页面')
                    : uiText('排版')}
              </button>
              <button aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
                {uiText('完整源码')}
              </button>
            </div>
          )}
          <span className="desktop-preview-toolbar-note">
            {sheet
              ? uiText('可横向、纵向滚动，翻页或跳转至任意单元格。')
              : office
                ? uiText('分页读取原文件内容。')
                : textFile
                  ? uiText('{0}打开编辑后可修改原文件。', {
                      '0': text
                        ? uiText('{0} 个字符 · ', {
                            '0': text.text.length.toLocaleString(interfaceLocale()),
                          })
                        : '',
                    })
                  : uiText('滚动查看完整内容。')}
          </span>
          {!nativeZoom && (
            <div className="desktop-preview-zoom">
              <button
                disabled={zoom <= 0.5}
                aria-label={uiText('缩小')}
                onClick={() => {
                  const next = Math.max(0.5, zoom - 0.1);
                  previewDiagnostic('zoom', object, next);
                  setZoom(next);
                }}
              >
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                disabled={zoom >= 3}
                aria-label={uiText('放大')}
                onClick={() => {
                  const next = Math.min(3, zoom + 0.1);
                  previewDiagnostic('zoom', object, next);
                  setZoom(next);
                }}
              >
                ＋
              </button>
              <button
                onClick={() => {
                  previewDiagnostic('zoom', object, 1);
                  setZoom(1);
                }}
              >
                {uiText('重置')}
              </button>
            </div>
          )}
        </div>
      )}
      {loading && (
        <p className="desktop-preview-status" role="status">
          {uiText('正在读取完整文件…')}
        </p>
      )}
      {error && (
        <div className="desktop-preview-status" role="alert">
          <p>{error}</p>
          <button onClick={() => setRetry((n) => n + 1)}>{uiText('重新读取')}</button>
          <button onClick={edit}>{uiText('打开文件详情')}</button>
        </div>
      )}
      {media ? (
        <NativePreview
          object={object}
          action={action}
          updated={resolved}
          reference={noReference}
          canReference={false}
          dirtyChanged={ignore}
          readOnly
        />
      ) : sheet ? (
        <SheetPreview object={object} action={action} zoom={zoom} />
      ) : office ? (
        <OfficePreview object={object} action={action} zoom={zoom} />
      ) : textFile || object.kind === 'text' || object.kind === 'code' ? (
        <div
          className={`desktop-preview-scroll desktop-preview-text ${format === 'svg' && mode === 'preview' ? 'desktop-preview-svg' : ''}`}
        >
          {!loading &&
            !error &&
            (mode === 'source' || format === 'text' ? (
              <pre className="desktop-preview-source" style={{ fontSize: 14 * zoom }}>
                {source || uiText('（空文件）')}
              </pre>
            ) : format === 'svg' ? (
              <SvgImagePreview source={source} title={object.title} zoom={zoom} expanded />
            ) : (
              <div
                className="desktop-preview-document"
                style={
                  format === 'markdown'
                    ? ({ '--preview-markdown-scale': zoom } as React.CSSProperties)
                    : ({ zoom } as React.CSSProperties)
                }
              >
                {format === 'html' ? (
                  <NativeHtmlPreview source={source} />
                ) : (
                  <NativeMarkdownPreview source={source} />
                )}
              </div>
            ))}
        </div>
      ) : object.kind === 'table' ? (
        <div className="desktop-preview-scroll">
          <TablePreview table={object.content as Table} zoom={zoom} />
        </div>
      ) : object.kind === 'workbook' ? (
        <WorkbookPreview workbook={object.content as Workbook} zoom={zoom} />
      ) : object.kind === 'deck' ? (
        <DeckPreview deck={object.content as Deck} zoom={zoom} />
      ) : object.kind === 'diagram' ? (
        <div className="desktop-preview-scroll">
          <img
            className="desktop-preview-diagram"
            alt={object.title}
            style={{ width: (object.content as Diagram).width * zoom }}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagramSvg(object.content as Diagram))}`}
          />
        </div>
      ) : object.kind === 'image' ? (
        <div className="desktop-preview-scroll">
          <div style={{ width: `${zoom * 100}%` }}>
            <ImagePreview object={object} />
          </div>
        </div>
      ) : (
        <div className="desktop-preview-empty">
          <span>▧</span>
          <h2>{file?.fileName ?? object.title}</h2>
          <p>{uiText('此格式暂不支持桌面内完整预览。')}</p>
          <button onClick={edit}>{uiText('打开文件详情')}</button>
        </div>
      )}
    </div>
  );
}

function TablePreview({ table, zoom }: { table: Table; zoom: number }) {
  useUiLocale();
  return (
    <table className="desktop-preview-grid" style={{ zoom } as React.CSSProperties}>
      <thead>
        <tr>
          <th>#</th>
          {table.columns.map((column) => (
            <th key={column.id}>{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, index) => (
          <tr key={row.id}>
            <th>{index + 1}</th>
            {row.cells.map((cell, i) => (
              <td key={i}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function WorkbookPreview({ workbook, zoom }: { workbook: Workbook; zoom: number }) {
  useUiLocale();
  const [active, setActive] = useState(workbook.sheets[0].id),
    sheet = workbook.sheets.find((item) => item.id === active) ?? workbook.sheets[0];
  return (
    <>
      <nav className="desktop-preview-tabs">
        {workbook.sheets.map((item) => (
          <button
            key={item.id}
            aria-pressed={active === item.id}
            onClick={() => setActive(item.id)}
          >
            {item.name}
          </button>
        ))}
      </nav>
      <div className="desktop-preview-scroll">
        <TablePreview table={sheet.table} zoom={zoom} />
      </div>
    </>
  );
}
function DeckPreview({ deck, zoom }: { deck: Deck; zoom: number }) {
  useUiLocale();
  const [page, setPage] = useState(0),
    slide = deck.slides[page];
  return (
    <>
      <nav className="desktop-preview-pages">
        <button disabled={!page} onClick={() => setPage((n) => n - 1)}>
          {uiText('上一页')}
        </button>
        <select
          aria-label={uiText('演示页')}
          value={page}
          onChange={(event) => setPage(Number(event.target.value))}
        >
          {deck.slides.map((item, i) => (
            <option key={item.id} value={i}>
              {i + 1}. {item.title}
            </option>
          ))}
        </select>
        <span>
          {page + 1} / {deck.slides.length}
        </span>
        <button disabled={page >= deck.slides.length - 1} onClick={() => setPage((n) => n + 1)}>
          {uiText('下一页')}
        </button>
      </nav>
      <div className="desktop-preview-scroll">
        <div className="desktop-preview-deck" style={{ width: `${zoom * 100}%` }}>
          <SlidePreview slide={slide} accent={deck.accent} footer={deck.footer} index={page} />
          {slide.notes && (
            <details>
              <summary>{uiText('演讲备注')}</summary>
              <pre>{slide.notes}</pre>
            </details>
          )}
        </div>
      </div>
    </>
  );
}

function SheetPreview({
  object,
  action,
  zoom,
}: {
  object: DesktopObject;
  action: Action;
  zoom: number;
}) {
  useUiLocale();
  const [sheetId, setSheetId] = useState<string>(),
    [row, setRow] = useState(1),
    [column, setColumn] = useState(1),
    [target, setTarget] = useState('A1'),
    [cell, setCell] = useState(''),
    [data, setData] = useState<XlsxPage | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const actions = useRef(action);
  actions.current = action;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    setCell('');
    void actions
      .current('xlsx_read', {
        objectId: object.id,
        expectedRevision: object.revision,
        sheetId,
        row,
        column,
        rows: 80,
        columns: 30,
      })
      .then((value: XlsxPage) => {
        if (live) setData(value);
      })
      .catch((value) => {
        if (live) setError(String(value));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [object.id, object.revision, sheetId, row, column, retry]);
  const sheet = data?.sheets.find((item) => item.id === data.sheetId),
    selected = data?.cells[cell];
  function go() {
    const position = cellPosition(target.trim());
    if (!position) {
      setError(uiText('请输入有效单元格位置，例如 A1 或 AZ1200。'));
      return;
    }
    setRow(position.row);
    setColumn(position.column);
    setTarget(`${columnLabel(position.column)}${position.row}`);
  }
  return (
    <div className="desktop-preview-sheet">
      <nav className="desktop-preview-pages">
        <select
          aria-label={uiText('工作表')}
          disabled={loading}
          value={data?.sheetId ?? ''}
          onChange={(event) => {
            setSheetId(event.target.value);
            setRow(1);
            setColumn(1);
          }}
        >
          {data?.sheets.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
              {item.hidden ? uiText('（隐藏）') : ''}
            </option>
          ))}
        </select>
        <span>
          {sheet
            ? uiText('{0} 行 × {1} 列', {
                '0': sheet.rows.toLocaleString(interfaceLocale()),
                '1': sheet.columns.toLocaleString(interfaceLocale()),
              })
            : ''}
        </span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            go();
          }}
        >
          <input
            aria-label={uiText('跳转单元格')}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="A1"
          />
          <button disabled={loading}>{uiText('跳转')}</button>
        </form>
        <button disabled={loading || row === 1} onClick={() => setRow((n) => Math.max(1, n - 80))}>
          {uiText('上 80 行')}
        </button>
        <button
          disabled={loading || row + 80 > Math.max(sheet?.rows ?? 0, 80) || row + 80 > 1048576}
          onClick={() => setRow((n) => n + 80)}
        >
          {uiText('下 80 行')}
        </button>
        <button
          disabled={loading || column === 1}
          onClick={() => setColumn((n) => Math.max(1, n - 30))}
        >
          {uiText('左 30 列')}
        </button>
        <button
          disabled={
            loading || column + 30 > Math.max(sheet?.columns ?? 0, 30) || column + 30 > 16384
          }
          onClick={() => setColumn((n) => n + 30)}
        >
          {uiText('右 30 列')}
        </button>
      </nav>
      {loading && (
        <p className="desktop-preview-status" role="status">
          {uiText('正在读取工作表…')}
        </p>
      )}
      {error && (
        <p className="desktop-preview-status" role="alert">
          {error} <button onClick={() => setRetry((n) => n + 1)}>{uiText('重试')}</button>
        </p>
      )}
      {data && !loading && !error && (
        <>
          <div className="desktop-preview-scroll">
            <table
              className="desktop-preview-grid desktop-preview-xlsx"
              style={{ zoom } as React.CSSProperties}
            >
              <colgroup>
                <col style={{ width: 48 }} />
                {Array.from({ length: data.columns }, (_, i) => (
                  <col
                    key={i}
                    style={{ width: Math.max(90, Math.min(600, data.widths[i] ?? 120)) }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th>#</th>
                  {Array.from({ length: data.columns }, (_, i) => (
                    <th key={i}>{columnLabel(data.column + i)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: data.rows }, (_, r) => (
                  <tr key={r} style={{ height: Math.max(26, data.heights[r] ?? 26) }}>
                    <th>{data.row + r}</th>
                    {Array.from({ length: data.columns }, (_, c) => {
                      const address = `${columnLabel(data.column + c)}${data.row + r}`,
                        value = data.cells[address];
                      return (
                        <td
                          key={c}
                          tabIndex={0}
                          role="button"
                          aria-label={`${address} ${value?.display ?? uiText('空白')}`}
                          className={cell === address ? 'selected' : ''}
                          onClick={() => setCell(address)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setCell(address);
                            }
                          }}
                          style={{
                            fontWeight: value?.bold ? 700 : 400,
                            fontStyle: value?.italic ? 'italic' : 'normal',
                            textDecoration: value?.underline ? 'underline' : undefined,
                            fontSize: value?.fontSize ? `${value.fontSize}pt` : undefined,
                            color: value?.color,
                            background: value?.background,
                            textAlign: value?.align as React.CSSProperties['textAlign'],
                          }}
                        >
                          {value?.display ?? ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="desktop-preview-cell">
            <strong>
              {cell ||
                `${columnLabel(data.column)}${data.row} – ${columnLabel(data.column + data.columns - 1)}${data.row + data.rows - 1}`}
            </strong>
            {cell ? (
              <pre>
                {selected?.formula
                  ? uiText('{0}\n文件内值：{1}', { '0': selected.input, '1': selected.display })
                  : selected?.input || selected?.display || uiText('（空白单元格）')}
              </pre>
            ) : (
              <span>
                {uiText('点击单元格可在此查看完整值和公式。隐藏行列在只读预览中仍可查看。')}
              </span>
            )}
          </div>
          {data.warnings.length > 0 && (
            <details className="desktop-preview-warnings">
              <summary>{uiText('格式与计算说明')}</summary>
              {data.warnings.map((value, i) => (
                <p key={i}>{value}</p>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Paragraph({ paragraph }: { paragraph: OfficeParagraph }) {
  useUiLocale();
  return (
    <p
      style={{
        textAlign:
          paragraph.align === 'both'
            ? 'justify'
            : (paragraph.align as React.CSSProperties['textAlign']),
        marginTop: `${paragraph.before}pt`,
        marginBottom: `${paragraph.after}pt`,
      }}
    >
      {paragraph.runs.map((run) => (
        <span
          key={run.id}
          style={{
            fontWeight: run.bold ? 700 : 400,
            fontStyle: run.italic ? 'italic' : 'normal',
            textDecoration: run.underline ? 'underline' : undefined,
            fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
            fontFamily: run.fontFamily,
            color: run.color,
          }}
        >
          {run.text}
        </span>
      ))}
      {!paragraph.runs.some((run) => run.text) && <br />}
    </p>
  );
}
function OfficePreview({
  object,
  action,
  zoom,
}: {
  object: DesktopObject;
  action: Action;
  zoom: number;
}) {
  useUiLocale();
  const [page, setPage] = useState(0),
    [data, setData] = useState<OfficePage | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0),
    viewport = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(800),
    actions = useRef(action);
  actions.current = action;
  const docx = /\.docx$/i.test((object.content as { fileName: string }).fileName),
    step = docx ? 25 : 1;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void actions
      .current('office_read', {
        objectId: object.id,
        expectedRevision: object.revision,
        page,
        pageCount: step,
      })
      .then((value: OfficePage) => {
        if (live) {
          setData(value);
          if (viewport.current) viewport.current.scrollTop = 0;
        }
      })
      .catch((value) => {
        if (live) setError(String(value));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [object.id, object.revision, page, step, retry]);
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(200, target.clientWidth - 48)));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const count = data?.loadedPages ?? step,
    end = data ? Math.min(data.pages, page + count) : page + step,
    slideScale = data ? Math.min(1, width / Math.max(1, data.width)) * zoom : zoom;
  return (
    <div className="desktop-preview-office">
      <nav className="desktop-preview-pages">
        <button
          disabled={loading || page === 0}
          onClick={() => setPage((n) => Math.max(0, n - step))}
        >
          {docx ? uiText('上一段内容') : uiText('上一页')}
        </button>
        <select
          aria-label={docx ? uiText('文档起始段落') : uiText('幻灯片页')}
          disabled={loading}
          value={page}
          onChange={(event) => setPage(Number(event.target.value))}
        >
          {data?.labels.map((label, i) => (
            <option value={i} key={i}>
              {label}
            </option>
          ))}
        </select>
        <span>
          {data
            ? docx
              ? uiText('第 {0} – {1} 段', {
                  '0': page * 40 + 1,
                  '1': page * 40 + data.paragraphs.length,
                })
              : uiText('{0} / {1} 页', { '0': page + 1, '1': data.pages })
            : ''}
        </span>
        <button disabled={loading || !data || end >= data.pages} onClick={() => setPage(end)}>
          {docx ? uiText('继续查看后续内容') : uiText('下一页')}
        </button>
      </nav>
      {loading && (
        <p className="desktop-preview-status" role="status">
          {uiText('正在读取原文档…')}
        </p>
      )}
      {error && (
        <p className="desktop-preview-status" role="alert">
          {error} <button onClick={() => setRetry((n) => n + 1)}>{uiText('重试')}</button>
        </p>
      )}
      <div className="desktop-preview-scroll" ref={viewport}>
        {data &&
          !loading &&
          !error &&
          (data.kind === 'docx' ? (
            <article className="desktop-preview-word" style={{ zoom } as React.CSSProperties}>
              {data.shapes
                .filter((shape) => shape.image)
                .map((shape) => (
                  <figure key={shape.id}>
                    <img src={shape.image} alt={shape.name} />
                  </figure>
                ))}
              {data.paragraphs.map((paragraph) => (
                <Paragraph key={paragraph.id} paragraph={paragraph} />
              ))}
              {end < data.pages && (
                <button className="desktop-preview-continue" onClick={() => setPage(end)}>
                  {uiText('继续查看后续段落 →')}
                </button>
              )}
            </article>
          ) : (
            <>
              <div
                className="desktop-preview-ppt-holder"
                style={{ width: data.width * slideScale, height: data.height * slideScale }}
              >
                <div
                  className="desktop-preview-ppt"
                  style={{
                    width: data.width,
                    height: data.height,
                    transform: `scale(${slideScale})`,
                    background: data.background ?? 'white',
                  }}
                >
                  {data.shapes.map((shape) => (
                    <div
                      key={shape.id}
                      title={shape.name}
                      style={{
                        position: 'absolute',
                        boxSizing: 'border-box',
                        overflow: 'hidden',
                        padding: shape.padding?.map((v) => v + 'px').join(' '),
                        ...(shape.cell
                          ? {
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent:
                                shape.verticalAlign === 'center'
                                  ? 'center'
                                  : shape.verticalAlign === 'end'
                                    ? 'flex-end'
                                    : 'flex-start',
                              borderTop: shape.borderTop,
                              borderRight: shape.borderRight,
                              borderBottom: shape.borderBottom,
                              borderLeft: shape.borderLeft,
                            }
                          : {}),
                        left: shape.x,
                        top: shape.y,
                        width: shape.width,
                        height: shape.height,
                        transform: `rotate(${shape.rotation ?? 0}deg)`,
                        background:
                          shape.fill && shape.fill !== 'none' ? shape.fill : 'transparent',
                        border:
                          shape.stroke && shape.stroke !== 'none'
                            ? `${shape.strokeWidth ?? 1}px solid ${shape.stroke}`
                            : undefined,
                      }}
                    >
                      {shape.image ? (
                        <img src={shape.image} alt={shape.name} />
                      ) : (
                        data.paragraphs
                          .filter((paragraph) => paragraph.shapeId === shape.id)
                          .map((paragraph) => (
                            <Paragraph key={paragraph.id} paragraph={paragraph} />
                          ))
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <details className="desktop-preview-slide-text">
                <summary>{uiText('本页完整文字')}</summary>
                {data.paragraphs.map((paragraph) => (
                  <Paragraph key={paragraph.id} paragraph={paragraph} />
                ))}
              </details>
            </>
          ))}
      </div>
      {data && (
        <details className="desktop-preview-warnings">
          <summary>
            {docx
              ? uiText('内容阅读视图，非打印分页排版')
              : uiText('幻灯片内容视图，母版与复杂对象以原文件为准')}
          </summary>
          {data.warnings.map((value, i) => (
            <p key={i}>{value}</p>
          ))}
        </details>
      )}
    </div>
  );
}
