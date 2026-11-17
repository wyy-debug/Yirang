import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import { previewDiagnostic } from '../preview-diagnostic.js';
import type {
  DesktopObject,
  MaterialRange,
  RectAnnotation,
} from '../../../../packages/contracts/index.js';
import type { CanvasPreview } from '../../../../packages/contracts/canvas-preview.js';
import { ImagePreview, type AnnotationTool } from '../images.js';
import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { NativePdfSource, nativeByteChunk } from './native-pdf-source.js';
import { PdfOcr } from '../pdf/pdf-ocr.js';
import { PdfBatchOcr } from '../pdf/pdf-batch-ocr.js';
import { readingKey, readPosition, rememberPosition, flushPosition } from './native-reading.js';
(globalThis as any).pdfjsWorker = pdfWorker;

type Props = {
  readOnly?: boolean;
  updated: () => Promise<void>;
  object: DesktopObject;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  reference: (range?: MaterialRange) => Promise<boolean>;
  comment?: (range?: MaterialRange) => void;
  canReference: boolean;
  dirtyChanged: (dirty: boolean) => void;
};
export async function readNativeBytes(
  object: DesktopObject,
  action: Props['action'],
  alive = () => true,
  progress?: (loaded: number, size: number) => void,
) {
  let result: Uint8Array | undefined,
    offset = 0,
    hash = '';
  do {
    if (!alive()) throw Error(uiText('已关闭文件。'));
    const part = await nativeByteChunk(object, action, offset);
    if (!alive()) throw Error(uiText('已关闭文件。'));
    if (!result) {
      result = new Uint8Array(part.size);
      hash = part.sha256;
    }
    if (part.size !== result.length || part.sha256 !== hash)
      throw Error(uiText('文件内容在读取过程中发生变化，请重新打开。'));
    result.set(part.bytes, offset);
    offset += part.bytes.length;
    progress?.(offset, result.length);
  } while (offset < result.length);
  return result;
}
export function NativePreview(props: Props) {
  useUiLocale();
  return <NativePreviewSession key={`${props.object.workspaceId}:${props.object.id}`} {...props} />;
}
function NativePreviewSession({
  object,
  action,
  reference,
  comment,
  canReference,
  dirtyChanged,
  updated,
  readOnly = false,
}: Props) {
  useUiLocale();
  const content = object.content as { fileName: string; mime: string; size: number },
    pdf = /\.pdf$/i.test(content.fileName),
    key = readingKey(object.workspaceId, object.id);
  const [initial] = useState(() => {
    const value = readPosition(key, object.id, object.revision);
    try {
      const target = JSON.parse(sessionStorage.getItem(`native-focus:${object.id}`) || 'null');
      sessionStorage.removeItem(`native-focus:${object.id}`);
      if (Number.isInteger(target?.page) && target.page > 0) return { ...value, page: target.page };
    } catch {}
    return value;
  });
  const [url, setUrl] = useState(''),
    [pdfDocument, setPdfDocument] = useState<any>(null),
    [page, setPage] = useState(initial.page),
    [zoom, setZoom] = useState(initial.zoom);
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [rendering, setRendering] = useState(false),
    [reading, setReading] = useState<{ loaded: number; size: number } | null>(null);
  const [annotations, setAnnotations] = useState<RectAnnotation[]>([]),
    [saved, setSaved] = useState<RectAnnotation[]>([]),
    [tool, setTool] = useState<AnnotationTool | 'view'>('view'),
    [note, setNote] = useState('');
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 }),
    [quality, setQuality] = useState<'none' | 'thumbnail' | 'original'>('none'),
    [loadOriginal, setLoadOriginal] = useState(false),
    [originalAttempt, setOriginalAttempt] = useState(0);
  const [revision, setRevision] = useState(object.revision),
    pending = useRef<any>(null);
  const canvas = useRef<HTMLCanvasElement>(null),
    textArea = useRef<HTMLTextAreaElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    actions = useRef(action);
  actions.current = action;
  const position = useRef(initial),
    restoreScroll = useRef(true),
    alive = useRef(true),
    imageUrl = useRef('');
  const [ocrDirty, setOcrDirty] = useState(false);
  const dirty = ocrDirty || JSON.stringify(saved) !== JSON.stringify(annotations);
  useEffect(() => {
    dirtyChanged(dirty);
    return () => dirtyChanged(false);
  }, [dirty, dirtyChanged]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      flushPosition(key);
    };
  }, [key]);
  useEffect(() => {
    if (!dirty && !busy && revision !== object.revision) setRevision(object.revision);
  }, [object.revision, revision, dirty, busy]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    position.current = { ...position.current, page, zoom, revision, updatedAt: Date.now() };
    rememberPosition(key, position.current);
  }, [page, zoom, revision, key]);
  function restore() {
    if (restoreScroll.current && viewport.current) {
      viewport.current.scrollLeft = position.current.left;
      viewport.current.scrollTop = position.current.top;
      restoreScroll.current = false;
    }
  }
  function rememberScroll() {
    if (!viewport.current || restoreScroll.current) return;
    position.current = {
      ...position.current,
      left: viewport.current.scrollLeft,
      top: viewport.current.scrollTop,
      updatedAt: Date.now(),
    };
    rememberPosition(key, position.current);
  }
  function choosePage(next: number) {
    setPage(Math.max(1, Math.min(pdfDocument?.numPages ?? 100000, next)));
    position.current = { ...position.current, left: 0, top: 0 };
    restoreScroll.current = true;
  }

  useEffect(() => {
    let live = true,
      loading: ReturnType<typeof getDocument> | undefined,
      transport: NativePdfSource | undefined;
    setError('');
    setBusy(true);
    setText('');
    setPdfDocument(null);
    setUrl('');
    setQuality('none');
    setLoadOriginal(false);
    setOriginalAttempt(0);
    setReading(null);
    restoreScroll.current = true;
    const current = { ...object, revision };
    void (async () => {
      if (pdf) {
        const initial = await nativeByteChunk(current, actions.current, 0, 256 * 1024);
        if (!live) return;
        setReading({ loaded: initial.bytes.length, size: initial.size });
        transport = new NativePdfSource(
          current,
          actions.current,
          initial,
          () => live,
          (error) => {
            if (live) {
              setError(String(error));
              setBusy(false);
              setRendering(false);
              void loading?.destroy();
            }
          },
          (loaded, size) => {
            if (live) setReading({ loaded, size });
          },
        );
        loading = getDocument({
          range: transport,
          rangeChunkSize: 256 * 1024,
          disableStream: true,
          disableAutoFetch: true,
          useSystemFonts: true,
          enableXfa: false,
          maxImageSize: 40000000,
        });
        const document = await loading.promise;
        if (!live) return;
        setPdfDocument(document);
        setPage((value: number) => Math.min(document.numPages, Math.max(1, value)));
      } else {
        // The thumbnail and annotation metadata arrive before the optional full image.
        const [preview, marks] = await Promise.all([
          actions.current('native_workbench', {
            operation: 'preview',
            objectId: object.id,
            expectedRevision: revision,
          }) as Promise<CanvasPreview>,
          actions.current('native_workbench', {
            operation: 'annotations',
            objectId: object.id,
            expectedRevision: revision,
          }),
        ]);
        if (!live) return;
        setAnnotations(marks);
        setSaved(marks);
        if (preview.kind === 'image') {
          setUrl(preview.dataUrl);
          setQuality(preview.quality ?? 'original');
          if (preview.sourceWidth && preview.sourceHeight)
            setDimensions({ width: preview.sourceWidth, height: preview.sourceHeight });
          else if (preview.width && preview.height)
            setDimensions({ width: preview.width, height: preview.height });
        } else
          setError(
            preview.kind === 'file'
              ? (preview.reason ?? uiText('缩略预览不可用，可按需载入原图。'))
              : uiText('缩略预览不可用，可按需载入原图。'),
          );
        if (content.size <= 3 * 1024 * 1024) setLoadOriginal(true);
      }
    })()
      .catch((error) => {
        if (live) setError(String(error));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      transport?.abort();
      void loading?.destroy();
    };
  }, [object.id, revision, pdf]);
  useEffect(() => {
    if (pdf || !loadOriginal) return;
    let live = true,
      localUrl = '';
    setBusy(true);
    setReading({ loaded: 0, size: content.size });
    void readNativeBytes(
      { ...object, revision },
      actions.current,
      () => live,
      (loaded, size) => {
        if (live) setReading({ loaded, size });
      },
    )
      .then((bytes) => {
        if (!live) return;
        localUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: content.mime }));
        imageUrl.current = localUrl;
        setUrl(localUrl);
        setQuality('original');
        setError('');
        restoreScroll.current = true;
      })
      .catch((error) => {
        if (live) setError(String(error));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      if (localUrl) URL.revokeObjectURL(localUrl);
      if (imageUrl.current === localUrl) imageUrl.current = '';
    };
  }, [loadOriginal, originalAttempt, object.id, revision, pdf]);
  useEffect(() => {
    if (!pdfDocument) return;
    let live = true,
      render: any;
    setText('');
    setRendering(true);
    void pdfDocument
      .getPage(page)
      .then(async (pdfPage: any) => {
        if (!live || !canvas.current) return;
        const view = pdfPage.getViewport({ scale: zoom }),
          surface = canvas.current;
        if (
          !Number.isFinite(view.width) ||
          !Number.isFinite(view.height) ||
          Math.min(view.width, view.height) <= 0 ||
          Math.max(view.width, view.height) > 100000
        )
          throw Error(uiText('本页尺寸过大，无法在桌面中渲染。'));
        // Bound backing-store pixels while preserving CSS zoom and scroll dimensions.
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          2,
          8192 / Math.max(view.width, view.height),
          Math.sqrt(12000000 / (view.width * view.height)),
        );
        surface.width = Math.max(1, Math.floor(view.width * ratio));
        surface.height = Math.max(1, Math.floor(view.height * ratio));
        surface.style.width = `${view.width}px`;
        surface.style.height = `${view.height}px`;
        render = pdfPage.render({
          canvas: surface,
          canvasContext: surface.getContext('2d'),
          viewport: view,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          background: 'rgb(255,255,255)',
        });
        const extracted = await pdfPage.getTextContent();
        if (live) setText(extracted.items.map((item: any) => item.str ?? '').join(' '));
        await render.promise;
        if (live) {
          setError('');
          restore();
        }
      })
      .catch((error: any) => {
        if (live && error.name !== 'RenderingCancelledException') setError(String(error));
      })
      .finally(() => {
        if (live) setRendering(false);
      });
    return () => {
      live = false;
      render?.cancel();
    };
  }, [pdfDocument, page, zoom]);
  function fit() {
    if (!viewport.current) return;
    if (pdf && pdfDocument)
      void pdfDocument
        .getPage(page)
        .then((value: any) => {
          if (alive.current && viewport.current)
            setZoom(
              Math.max(
                0.25,
                Math.min(
                  3,
                  (viewport.current.clientWidth - 24) / value.getViewport({ scale: 1 }).width,
                ),
              ),
            );
        })
        .catch((error: unknown) => setError(String(error)));
    else setZoom(1);
  }
  async function quote(toComment = false) {
    if (
      (readOnly && !toComment) ||
      (toComment && !comment) ||
      dirty ||
      busy ||
      rendering ||
      revision !== object.revision
    )
      return;
    try {
      const area = textArea.current;
      if (!area || area.selectionStart === area.selectionEnd)
        throw Error(uiText('请在本页文字中选中需要引用或评论的部分。'));
      const range = await action('native_workbench', {
        operation: 'reference',
        objectId: object.id,
        expectedRevision: revision,
        selection: { kind: 'pdf', page, start: area.selectionStart, end: area.selectionEnd },
      });
      if (toComment) comment?.(range);
      else await reference(range);
    } catch (error) {
      setError(String(error));
    }
  }
  async function save() {
    if (readOnly) return;
    setBusy(true);
    try {
      const request = pending.current ?? {
        operation: 'annotate',
        requestId: crypto.randomUUID(),
        objectId: object.id,
        expectedRevision: revision,
        annotations,
      };
      pending.current = request;
      await action('native_workbench', request);
      pending.current = null;
      setSaved(request.annotations);
      setError('');
      await updated();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  function downloadAnnotations() {
    const draft = URL.createObjectURL(
        new Blob([JSON.stringify({ objectId: object.id, revision, annotations }, null, 2)], {
          type: 'application/json',
        }),
      ),
      link = window.document.createElement('a');
    link.href = draft;
    link.download = uiText('图片批注草稿.json');
    link.click();
    setTimeout(() => URL.revokeObjectURL(draft), 1000);
  }
  return (
    <section className="native-preview">
      <header>
        <strong>
          {pdf ? uiText('PDF 阅读') : readOnly ? uiText('图片预览') : uiText('图片与批注')}
        </strong>
        <button
          aria-label={uiText('缩小预览')}
          onClick={() => {
            const next = Math.max(0.25, zoom - 0.25);
            previewDiagnostic('zoom', object, next);
            setZoom(next);
          }}
        >
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          aria-label={uiText('放大预览')}
          onClick={() => {
            const next = Math.min(3, zoom + 0.25);
            previewDiagnostic('zoom', object, next);
            setZoom(next);
          }}
        >
          ＋
        </button>
        <button onClick={fit}>{uiText('适合宽度')}</button>
        {!pdf && comment && (
          <button
            disabled={dirty || busy || !!pending.current || revision !== object.revision}
            title={
              dirty ? uiText('先保存批注，再评论原图片') : uiText('讨论这张图片并查看 AI 回复')
            }
            onClick={() => comment()}
          >
            {uiText('评论此图片')}
          </button>
        )}
        {pdf && pdfDocument && (
          <>
            <button disabled={page <= 1} onClick={() => choosePage(page - 1)}>
              {uiText('上一页')}
            </button>
            <input
              aria-label={uiText('PDF 页码')}
              type="number"
              min="1"
              max={pdfDocument.numPages}
              value={page}
              onChange={(event) => choosePage(Number(event.target.value) || 1)}
            />
            <span>/ {pdfDocument.numPages}</span>
            <button disabled={page >= pdfDocument.numPages} onClick={() => choosePage(page + 1)}>
              {uiText('下一页')}
            </button>
          </>
        )}
        {!pdf && !readOnly && (
          <>
            <select
              aria-label={uiText('图片批注工具')}
              value={tool}
              onChange={(event) => setTool(event.target.value as any)}
            >
              {['view', 'rect', 'ellipse', 'arrow', 'pen', 'text'].map((value) => (
                <option value={value} key={value}>
                  {
                    (
                      {
                        view: uiText('查看'),
                        rect: uiText('矩形'),
                        ellipse: uiText('椭圆'),
                        arrow: uiText('箭头'),
                        pen: uiText('画笔'),
                        text: uiText('文字'),
                      } as any
                    )[value]
                  }
                </option>
              ))}
            </select>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={uiText('批注说明')}
            />
            <button disabled={!dirty || busy} onClick={() => void save()}>
              {uiText('保存批注')}
            </button>
            <button
              disabled={busy || !!pending.current || !annotations.length}
              onClick={() => setAnnotations((items) => items.slice(0, -1))}
            >
              {uiText('撤销末条')}
            </button>
          </>
        )}
      </header>
      <p className="muted">
        {uiText('页码、缩放和阅读位置保存在此设备。')}
        {pdf
          ? uiText('按需读取当前页面。')
          : quality === 'original'
            ? uiText('正在显示原图。')
            : uiText('正在显示轻量预览。{0}', {
                '0': content.size
                  ? uiText('原文件 {0} MiB。', { '0': (content.size / 1024 / 1024).toFixed(1) })
                  : '',
              })}
        {!pdf && quality !== 'original' && (
          <button
            disabled={busy}
            onClick={() => {
              setError('');
              setLoadOriginal(true);
              setOriginalAttempt((value) => value + 1);
            }}
          >
            {uiText('载入原图')}
          </button>
        )}
      </p>
      {revision !== object.revision && (
        <p role="alert">
          {uiText('文件已有新版本，当前批注保留在 v')}
          {revision}。<button onClick={downloadAnnotations}>{uiText('下载批注草稿')}</button>
          <button
            onClick={() => {
              pending.current = null;
              setAnnotations([]);
              setSaved([]);
              setRevision(object.revision);
            }}
          >
            {uiText('放弃本页批注并载入最新')}
          </button>
        </p>
      )}
      {(busy || rendering) && (
        <p role="status">
          {rendering ? uiText('正在绘制页面…') : uiText('正在读取文件…')}
          {reading &&
            ` ${Math.round(reading.loaded / 1024)} / ${Math.round(reading.size / 1024)} KiB`}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {pdf && pdfDocument && !readOnly && (
        <>
          <PdfOcr
            key={`${object.revision}:${page}`}
            object={object}
            page={page}
            canvas={canvas}
            rendering={rendering}
            action={action}
            updated={updated}
          />
          <PdfBatchOcr
            dirtyChanged={setOcrDirty}
            key={`${object.id}:${object.revision}`}
            object={object}
            document={pdfDocument}
            action={action}
            updated={updated}
          />
        </>
      )}
      <div
        className="native-preview-viewport"
        ref={viewport}
        onScroll={rememberScroll}
        style={{
          overflow: 'auto',
          maxHeight: '65vh',
          minHeight: 120,
          background: '#f1f2f5',
          padding: 12,
          borderRadius: 12,
        }}
      >
        {pdf ? (
          <canvas ref={canvas} style={{ display: 'block', boxShadow: '0 3px 16px #00000012' }} />
        ) : (
          url && (
            <div style={{ width: `${zoom * 100}%` }}>
              <img
                hidden
                src={url}
                onLoad={(event) => {
                  if (quality === 'original')
                    setDimensions({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    });
                  requestAnimationFrame(restore);
                }}
              />
              <ImagePreview
                object={{ ...object, dataUrl: url, content: { ...dimensions, annotations } as any }}
                tool={tool === 'view' ? 'rect' : tool}
                note={note}
                annotate={
                  readOnly || tool === 'view' || busy || !!pending.current
                    ? undefined
                    : (value) => setAnnotations((items) => [...items, value])
                }
              />
            </div>
          )
        )}
      </div>
      {pdf && (
        <details open={!readOnly}>
          <summary>
            {readOnly ? uiText('本页完整文字') : uiText('本页文字 · 选择后引用或评论')}
          </summary>
          <textarea ref={textArea} readOnly value={text} style={{ width: '100%', height: 130 }} />
          {!readOnly && (
            <button disabled={!canReference || !text || rendering} onClick={() => void quote()}>
              {uiText('引用选中文字（第')}
              {page} {uiText('页）')}
            </button>
          )}
          {comment && (
            <>
              <button
                disabled={!text || rendering || busy || dirty || revision !== object.revision}
                onClick={() => void quote(true)}
              >
                {uiText('评论选中文字（第')}
                {page} {uiText('页）')}
              </button>
              <small>{uiText('PDF 选区用于阅读与讨论，不直接修改原 PDF。')}</small>
            </>
          )}
          {!text && !rendering && <small>{uiText('本页没有可直接提取的文字。')}</small>}
        </details>
      )}
    </section>
  );
}
