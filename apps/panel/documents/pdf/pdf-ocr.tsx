import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { DesktopObject } from '../../../../packages/contracts/index.js';
import { browserCommand } from '../../browser/electron-browser-bridge.js';
import { isIntegratedDesktop } from '../../workspace/workspace-mode.js';
import { scheduleDraftWrite, flushDraftStorage, writeDraftNow } from '../draft-storage.js';
export function PdfOcr({
  object,
  page,
  canvas,
  rendering,
  action,
  updated,
}: {
  object: DesktopObject;
  page: number;
  canvas: React.RefObject<HTMLCanvasElement | null>;
  rendering: boolean;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
}) {
  useUiLocale();
  const slot = `pdf-ocr:${object.id}:${object.revision}:${page}`,
    [text, setText] = useState(''),
    [language, setLanguage] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [visible, setVisible] = useState(false),
    [result, setResult] = useState<any>(null);
  const active = useRef(slot),
    request = useRef<any>(null),
    alive = useRef(true);
  active.current = slot;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      flushDraftStorage(slot);
    };
  }, [slot]);
  useEffect(() => {
    setVisible(false);
    setText('');
    setResult(null);
    setError('');
    request.current = null;
    try {
      const saved = JSON.parse(localStorage.getItem(slot) || 'null');
      if (saved) {
        setText(saved.text || '');
        setLanguage(saved.language || '');
        setVisible(true);
        setResult(saved.result || null);
        request.current = saved.pending || null;
      }
    } catch {}
  }, [slot]);
  useEffect(() => {
    if (!visible) return;
    scheduleDraftWrite(
      slot,
      () => JSON.stringify({ text, language, result, pending: request.current }),
      (error) => {
        if (error && alive.current) setError(uiText('识别草稿无法保存到本机，请先复制文字。'));
      },
      600,
    );
  }, [slot, text, visible, language, result]);
  async function recognize() {
    if (!canvas.current || busy || rendering) return;
    const key = slot;
    setBusy(true);
    setError('');
    try {
      const result = await browserCommand<{ text: string; language: string }>(
        'document-ocr',
        { image: canvas.current.toDataURL('image/png'), language },
        90000,
      );
      if (!alive.current || active.current !== key) return;
      setText(result.text);
      setLanguage(result.language);
      setVisible(true);
      request.current = null;
    } catch (error) {
      if (alive.current && active.current === key) setError(String(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const payload = request.current ?? {
        operation: 'ocr_result',
        requestId: crypto.randomUUID(),
        objectId: object.id,
        expectedRevision: object.revision,
        page,
        text,
        language,
        ...(result ? { resultObjectId: result.id, resultRevision: result.revision } : {}),
      };
      request.current = payload;
      writeDraftNow(slot, JSON.stringify({ text, language, result, pending: payload }));
      const saved = await action('native_workbench', payload);
      request.current = null;
      writeDraftNow(slot, JSON.stringify({ text, language, result: saved, pending: null }));
      if (alive.current) setResult(saved);
      await updated();
    } catch (error) {
      if (alive.current) setError(String(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!isIntegratedDesktop) return null;
  return (
    <section className="pdf-ocr">
      <button disabled={busy || rendering} onClick={() => void recognize()}>
        {busy ? uiText('处理中…') : uiText('识别本页文字')}
      </button>
      <select
        aria-label={uiText('OCR 语言')}
        disabled={busy}
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
      >
        <option value="">{uiText('系统语言')}</option>
        {[...new Set(['zh-Hans-CN', 'en-US', ...(language ? [language] : [])])].map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      {error && <p role="alert">{error}</p>}
      {visible && (
        <>
          <p>
            {uiText('第')}
            {page} {uiText('页识别结果，可校正后保存为桌面 Markdown 文件。')}
          </p>
          <textarea
            aria-label={uiText('识别文字')}
            value={text}
            disabled={busy || !!request.current}
            onChange={(e) => setText(e.target.value)}
            rows={8}
          />
          <button disabled={!text || busy} onClick={() => void save()}>
            {request.current
              ? uiText('重试保存')
              : result
                ? uiText('更新识别文件')
                : uiText('保存识别文件到桌面')}
          </button>
          <button
            disabled={!text}
            onClick={() =>
              void navigator.clipboard.writeText(text).catch((e) => setError(String(e)))
            }
          >
            {uiText('复制文字')}
          </button>
          {result && (
            <small>
              {uiText('已保存 · v')}
              {result.revision}
            </small>
          )}
          {!text && <small>{uiText('未识别到文字，可调整语言后重试。')}</small>}
        </>
      )}
    </section>
  );
}
