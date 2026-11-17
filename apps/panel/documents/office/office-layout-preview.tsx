import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { readNativeBytes } from '../native/native-preview.js';
import { browserCommand } from '../../browser/electron-browser-bridge.js';
import { isIntegratedDesktop } from '../../workspace/workspace-mode.js';
import type { DesktopObject } from '../../../../packages/contracts/index.js';
export function OfficeLayoutPreview({
  object,
  action,
  dirty,
}: {
  object: DesktopObject;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  dirty: boolean;
}) {
  useUiLocale();
  const [open, setOpen] = useState(false),
    [pdf, setPdf] = useState<any>(null),
    [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null),
    alive = useRef(true),
    attempt = useRef(0),
    loading = useRef<any>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      attempt.current++;
      void loading.current?.destroy();
    };
  }, []);
  useEffect(() => {
    attempt.current++;
    setPdf(null);
    setPage(1);
    setOpen(false);
    setBusy(false);
    void loading.current?.destroy();
    loading.current = null;
  }, [object.revision]);
  useEffect(() => {
    if (!pdf || !open || !canvas.current) return;
    let cancelled = false,
      render: any;
    void pdf
      .getPage(page)
      .then((item: any) => {
        if (cancelled || !canvas.current) return;
        const viewport = item.getViewport({ scale: zoom }),
          ratio = Math.min(2, window.devicePixelRatio || 1),
          surface = canvas.current;
        surface.width = Math.round(viewport.width * ratio);
        surface.height = Math.round(viewport.height * ratio);
        surface.style.width = `${viewport.width}px`;
        surface.style.height = `${viewport.height}px`;
        render = item.render({
          canvas: surface,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          background: 'white',
        });
        return render.promise;
      })
      .catch((error: any) => {
        if (!cancelled && error.name !== 'RenderingCancelledException') setError(String(error));
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [pdf, page, zoom, open]);
  async function show() {
    if (dirty || busy) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (pdf) return;
    setBusy(true);
    setError('');
    const id = ++attempt.current;
    try {
      const bytes = await readNativeBytes(
        object,
        action,
        () => alive.current && attempt.current === id,
      );
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      const result = await browserCommand<{ data: string }>(
        'document-office-preview',
        { fileName: (object.content as any).fileName, data: btoa(binary) },
        180000,
      );
      if (!alive.current || attempt.current !== id) return;
      const data = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
      loading.current = getDocument({ data });
      const document = await loading.current.promise;
      if (alive.current && attempt.current === id) setPdf(document);
    } catch (error) {
      if (alive.current && attempt.current === id) setError(String(error));
    } finally {
      if (alive.current && attempt.current === id) setBusy(false);
    }
  }
  if (!isIntegratedDesktop) return null;
  return (
    <section className="office-layout-preview">
      <button
        disabled={dirty || busy}
        onClick={() => void show()}
        title={
          dirty
            ? uiText('保存修改后预览最新排版')
            : uiText('通过本地排版引擎查看分页、表格、图片与母版')
        }
      >
        {open ? uiText('收起分页预览') : uiText('分页预览')}
      </button>
      {dirty && <small>{uiText('保存后可预览最新排版')}</small>}
      {open && (
        <>
          {busy && <p role="status">{uiText('正在生成分页预览…')}</p>}
          {error && (
            <p role="alert">
              {error}
              <button
                onClick={() =>
                  void browserCommand('document-choose-office')
                    .then(() => {
                      setOpen(false);
                      setError('');
                    })
                    .catch((e) => setError(String(e)))
                }
              >
                {uiText('选择 LibreOffice')}
              </button>
            </p>
          )}
          {pdf && (
            <>
              <nav>
                <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                  {uiText('上一页')}
                </button>
                <span>
                  {page} / {pdf.numPages}
                </span>
                <button disabled={page === pdf.numPages} onClick={() => setPage((p) => p + 1)}>
                  {uiText('下一页')}
                </button>
                <select
                  aria-label={uiText('预览缩放')}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
                    <option key={value} value={value}>
                      {value * 100}%
                    </option>
                  ))}
                </select>
                <small>{uiText('LibreOffice 排版 · 当前已保存版本')}</small>
              </nav>
              <div className="office-layout-pages">
                <canvas ref={canvas} />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
