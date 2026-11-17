import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { DesktopObject } from '../../../packages/contracts/index.js';
import type { CanvasPreview } from '../../../packages/contracts/canvas-preview.js';
import type { OfficePage } from '../../../packages/contracts/office.js';
import { columnLabel, cellPosition, type XlsxPage } from '../../../packages/contracts/xlsx.js';
import { Icon, materialAppearance } from '../ui/icons.js';
import { HtmlMiniBrowser } from '../browser/html-mini-browser.js';
import { SlideThumbnail } from '../documents/office/slide-thumbnail.js';
import { SvgImagePreview } from '../documents/svg-image-preview.js';
import { LightAppCard } from '../light-apps/light-apps.js';

type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
class PreviewPool {
  private cache = new Map<string, { value: CanvasPreview; cost: number }>();
  private pending = new Map<string, Promise<CanvasPreview>>();
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private bytes = 0;
  private closed = false;
  dispose() {
    this.closed = true;
    this.cache.clear();
    this.bytes = 0;
    this.pump();
  }
  private pump() {
    while (this.running < 3 && this.queue.length) {
      this.running++;
      void this.queue.shift()!().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
  load(key: string, read: () => Promise<CanvasPreview>): Promise<CanvasPreview> {
    if (this.closed) return Promise.reject(new Error(uiText('面板已关闭')));
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached.value);
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const job = new Promise<CanvasPreview>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          if (this.closed) throw new Error(uiText('面板已关闭'));
          const value = await read();
          if (!this.closed) {
            const cost = JSON.stringify(value).length * 2;
            while (this.bytes + cost > 12 * 1024 * 1024 && this.cache.size) {
              const oldest = this.cache.keys().next().value!;
              this.bytes -= this.cache.get(oldest)!.cost;
              this.cache.delete(oldest);
            }
            if (cost <= 12 * 1024 * 1024) {
              this.cache.set(key, { value, cost });
              this.bytes += cost;
            }
          }
          resolve(value);
        } catch (error) {
          reject(error);
        } finally {
          this.pending.delete(key);
        }
      });
    });
    this.pending.set(key, job);
    this.pump();
    return job;
  }
}
const PreviewContext = createContext<PreviewPool | null>(null);
export const CanvasDetailContext = createContext<'overview' | 'preview' | 'detail'>('detail');
export function CanvasPreviewProvider({ children }: { children: React.ReactNode }) {
  useUiLocale();
  const [pool] = useState(() => new PreviewPool());
  useEffect(() => () => pool.dispose(), [pool]);
  return <PreviewContext.Provider value={pool}>{children}</PreviewContext.Provider>;
}

export function CodeThumbnail({ text }: { text: string }) {
  useUiLocale();
  return (
    <div className="paper-code">
      <ol>
        {text
          .slice(0, 16000)
          .split('\n')
          .slice(0, 300)
          .map((line, i) => (
            <li key={i}>
              <code>
                {line
                  .split(
                    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|\/\/.*$|\b(?:import|from|as|def|return|const|let|function|class|if|else|for|in|await|async|true|false|None)\b)/g,
                  )
                  .map((part, j) => (
                    <span
                      key={j}
                      className={
                        /^['"]/.test(part)
                          ? 'syntax-string'
                          : /^(#|\/\/)/.test(part)
                            ? 'syntax-comment'
                            : /^(import|from|as|def|return|const|let|function|class|if|else|for|in|await|async|true|false|None)$/.test(
                                  part,
                                )
                              ? 'syntax-keyword'
                              : ''
                      }
                    >
                      {part}
                    </span>
                  )) || ' '}
              </code>
            </li>
          ))}
      </ol>
      {!text && <span className="paper-placeholder">{uiText('空白代码文件')}</span>}
    </div>
  );
}

function TextThumbnail({ text }: { text: string }) {
  useUiLocale();
  const lines = text.split('\n');
  return (
    <div className="paper-document">
      <div className="paper-document-body">
        {lines.map((line, i) =>
          /^#{1,3}\s/.test(line) ? (
            <h3 key={i}>{line.replace(/^#{1,3}\s+/, '')}</h3>
          ) : /^\s*[-*] \[[ xX]\]/.test(line) ? (
            <div className="paper-check" key={i}>
              <span className={/\[[xX]\]/.test(line) ? 'checked' : ''}>
                {/\[[xX]\]/.test(line) && <Icon name="check" size={10} />}
              </span>
              {line.replace(/^\s*[-*] \[[ xX]\]\s*/, '')}
            </div>
          ) : (
            <p key={i}>{line || '\u00a0'}</p>
          ),
        )}
      </div>
      {!text && <span className="paper-placeholder">{uiText('空白文档')}</span>}
    </div>
  );
}
function SheetThumbnail({ sheet }: { sheet: XlsxPage }) {
  useUiLocale();
  const rows = Array.from({ length: sheet.rows }, (_, i) => i + sheet.row).filter(
      (r) => !sheet.hiddenRows?.includes(r),
    ),
    columns = Array.from({ length: sheet.columns }, (_, i) => i + sheet.column).filter(
      (c) => !sheet.hiddenColumns?.includes(c),
    );
  return (
    <div className="paper-sheet">
      <div className="paper-sheet-title">
        {sheet.sheets.find((s) => s.id === sheet.sheetId)?.name}
      </div>
      <table>
        <thead>
          <tr>
            <th />
            {columns.map((c) => (
              <th key={c}>{columnLabel(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th>{r}</th>
              {columns.map((c) => {
                const address = columnLabel(c) + r,
                  cell = sheet.cells[address];
                if (cell?.merged && cell.merged !== address) return null;
                const end = cell?.mergeBounds && cellPosition(cell.mergeBounds.to);
                return (
                  <td
                    key={c}
                    colSpan={
                      end ? columns.filter((v) => v >= c && v <= end.column).length : undefined
                    }
                    rowSpan={end ? rows.filter((v) => v >= r && v <= end.row).length : undefined}
                    style={{
                      background: cell?.background,
                      color: cell?.color,
                      fontWeight: cell?.bold ? 600 : undefined,
                      fontStyle: cell?.italic ? 'italic' : undefined,
                      textAlign: (['left', 'center', 'right'].includes(cell?.align ?? '')
                        ? cell?.align
                        : undefined) as React.CSSProperties['textAlign'],
                    }}
                  >
                    {cell?.display ?? ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function OfficeThumbnail({ page }: { page: OfficePage }) {
  useUiLocale();
  const paragraphs = page.paragraphs.filter((p) => p.runs.some((r) => r.text.trim()));
  if (page.kind === 'docx')
    return (
      <div className="paper-document">
        <div className="paper-document-body">
          {paragraphs.map((p, i) => (
            <p
              key={p.id}
              className={i === 0 ? 'paper-document-title' : ''}
              style={{
                textAlign: (p.align === 'both'
                  ? 'justify'
                  : p.align) as React.CSSProperties['textAlign'],
              }}
            >
              {p.runs.map((r) => (
                <span
                  key={r.id}
                  style={{
                    fontWeight: r.bold ? 650 : undefined,
                    fontStyle: r.italic ? 'italic' : undefined,
                  }}
                >
                  {r.text}
                </span>
              ))}
            </p>
          ))}
          {page.shapes
            .filter((s) => s.image)
            .slice(0, 2)
            .map((s) => (
              <img key={s.id} src={s.image} alt={s.name} />
            ))}
        </div>
        {!paragraphs.length && !page.shapes.some((s) => s.image) && (
          <span className="paper-placeholder">{uiText('空白文档')}</span>
        )}
      </div>
    );
  return <SlideThumbnail page={page} />;
}

function CanvasSlidePages({
  initial,
  object,
  action,
}: {
  initial: OfficePage;
  object: DesktopObject;
  action: Action;
}) {
  const pool = useContext(PreviewContext),
    [page, setPage] = useState(initial),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function turn(index: number) {
    if (loading || index < 0 || index >= page.pages || index === page.page) return;
    const ticket = ++request.current;
    setLoading(true);
    setError('');
    try {
      const read = async (): Promise<CanvasPreview> => ({
        kind: 'office',
        page: await action('office_read', {
          objectId: object.id,
          expectedRevision: object.revision,
          page: index,
          pageCount: 1,
        }),
      });
      const result = await (pool
        ? pool.load(object.id + ':' + object.revision + ':slide:' + index, read)
        : read());
      if (request.current === ticket && result.kind === 'office') setPage(result.page);
    } catch (reason) {
      if (request.current === ticket)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request.current === ticket) setLoading(false);
    }
  }
  return (
    <div className="canvas-ppt-preview">
      <SlideThumbnail page={page} />
      <nav
        className="canvas-ppt-pages nodrag nopan nowheel"
        aria-label={uiText('幻灯片翻页')}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            void turn(page.page + (['ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 1));
          }
        }}
      >
        <button
          disabled={loading || page.page === 0}
          aria-label={uiText('上一页')}
          onClick={(e) => {
            e.stopPropagation();
            void turn(page.page - 1);
          }}
        >
          ‹
        </button>
        <span aria-live="polite">
          {loading ? uiText('加载中…') : page.page + 1 + ' / ' + page.pages}
        </span>
        <button
          disabled={loading || page.page + 1 >= page.pages}
          aria-label={uiText('下一页')}
          onClick={(e) => {
            e.stopPropagation();
            void turn(page.page + 1);
          }}
        >
          ›
        </button>
      </nav>
      {error && (
        <div className="canvas-ppt-error" role="alert">
          {uiText('翻页失败，请重试。')}
          <span title={error}> ⓘ</span>
        </div>
      )}
    </div>
  );
}

export function CanvasFilePreview({
  object,
  action,
  interactive = false,
}: {
  object: DesktopObject;
  action: Action;
  interactive?: boolean;
}) {
  useUiLocale();
  const pool = useContext(PreviewContext),
    root = useRef<HTMLDivElement>(null),
    reader = useRef(action);
  reader.current = action;
  const [visible, setVisible] = useState(false),
    [preview, setPreview] = useState<CanvasPreview | null>(null),
    [error, setError] = useState('');
  const fileName = (object.content as { fileName: string }).fileName,
    look = materialAppearance('file', fileName);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    if (!('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) {
      setPreview(null);
      return;
    }
    if (!pool) return;
    let live = true;
    setPreview(null);
    setError('');
    void pool
      .load(`${object.id}:${object.revision}`, () =>
        reader.current('native_workbench', {
          operation: 'preview',
          objectId: object.id,
          expectedRevision: object.revision,
        }),
      )
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch((reason) => {
        if (live) setError(String(reason));
      });
    return () => {
      live = false;
    };
  }, [visible, object.id, object.revision, pool]);
  return (
    <div
      ref={root}
      className={`canvas-file-preview ${interactive && preview?.kind !== 'html' && preview?.kind !== 'image' && preview?.kind !== 'svg' ? 'is-interactive nodrag nopan nowheel' : ''} ${preview ? `preview-${preview.kind}` : ''}`}
      title={
        error ||
        (preview?.kind === 'html'
          ? uiText('拖动标题栏移动 · 点击网页直接操作')
          : preview?.kind === 'image' || preview?.kind === 'svg'
            ? isIntegratedDesktop
              ? uiText('拖动图片移动原卡片 · 双击用系统应用打开 · 空格预览')
              : uiText('拖动图片移动原卡片 · 双击或按空格打开大预览')
            : isIntegratedDesktop
              ? uiText('选中后滚动预览 · 双击用系统应用打开 · 空格预览')
              : uiText('选中后滚动预览 · 双击或按空格打开大预览'))
      }
    >
      {fileName.endsWith('.yirang-app.json') && preview && 'text' in preview ? (
        <LightAppCard text={preview.text} />
      ) : preview?.kind === 'image' ? (
        <img
          className="paper-image"
          src={preview.dataUrl}
          alt={object.title}
          decoding="async"
          draggable={false}
        />
      ) : preview?.kind === 'pdf' ? (
        <div className="paper-slides">
          <img
            className="paper-image"
            style={{ objectFit: 'contain', background: '#fff' }}
            src={preview.dataUrl}
            alt={uiText('{0} · 第 {1} 页', { '0': object.title, '1': preview.page })}
            decoding="async"
            draggable={false}
          />
          <span className="paper-page-count">
            {preview.page} / {preview.pages} {uiText('页')}
          </span>
        </div>
      ) : preview?.kind === 'sheet' ? (
        <SheetThumbnail sheet={preview.sheet} />
      ) : preview?.kind === 'office' ? (
        preview.page.kind === 'pptx' ? (
          <CanvasSlidePages
            key={object.id + ':' + object.revision}
            initial={preview.page}
            object={object}
            action={action}
          />
        ) : (
          <OfficeThumbnail page={preview.page} />
        )
      ) : preview?.kind === 'text' ? (
        <TextThumbnail text={preview.text} />
      ) : preview?.kind === 'html' ? (
        <HtmlMiniBrowser source={preview.text} fileName={fileName} />
      ) : preview?.kind === 'svg' ? (
        <SvgImagePreview source={preview.text} title={object.title} />
      ) : preview?.kind === 'code' ? (
        <CodeThumbnail text={preview.text} />
      ) : (
        <div className={`paper-file-placeholder tone-${look.tone}`}>
          <span className="file-preview-symbol">
            <Icon name={look.icon} size={38} />
          </span>
          <strong>{look.label}</strong>
          <small>
            {error
              ? uiText('预览暂不可用 · 可展开文件')
              : preview?.kind === 'file'
                ? (preview.reason ?? preview.label)
                : visible
                  ? uiText('正在读取预览…')
                  : uiText('文件预览')}
          </small>
        </div>
      )}
    </div>
  );
}
