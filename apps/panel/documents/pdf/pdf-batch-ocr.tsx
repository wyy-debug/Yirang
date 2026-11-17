import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { DesktopObject } from '../../../../packages/contracts/index.js';
import { browserCommand } from '../../browser/electron-browser-bridge.js';
import { scheduleDraftWrite, flushDraftStorage, writeDraftNow } from '../draft-storage.js';
import { isIntegratedDesktop } from '../../workspace/workspace-mode.js';
type Props = {
  dirtyChanged: (dirty: boolean) => void;
  object: DesktopObject;
  document: any;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
};
export function PdfBatchOcr({ object, document: pdf, action, updated, dirtyChanged }: Props) {
  useUiLocale();
  const [job, setJob] = useState<any>(null),
    [from, setFrom] = useState(1),
    [to, setTo] = useState(pdf.numPages),
    [language, setLanguage] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [page, setPage] = useState(0),
    [text, setText] = useState(''),
    [dirty, setDirty] = useState(false);
  const live = useRef(true),
    stop = useRef(false),
    current = useRef<any>(null),
    request = useRef<string | null>(null),
    working = useRef(false);
  const slot = `pdf-ocr-batch:${object.id}:${object.revision}`,
    draftVersion = useRef(0);
  const call = (command: string, payload: Record<string, unknown> = {}) =>
    action('native_workbench', {
      operation: 'ocr_batch',
      command,
      objectId: object.id,
      expectedRevision: object.revision,
      ...payload,
    });
  const adopt = (value: any) => {
    current.current = value;
    if (live.current) setJob(value);
    return value;
  };
  useEffect(() => {
    live.current = true;
    void call('get')
      .then((value) => {
        adopt(value);
        try {
          const saved = JSON.parse(localStorage.getItem(slot) || 'null');
          if (saved && value?.id === saved.jobId) {
            setPage(saved.page);
            setText(saved.text);
            setDirty(true);
            draftVersion.current = saved.version;
            setMessage(
              saved.version === value.version
                ? uiText('已恢复本页校正草稿。')
                : uiText('校正草稿对应旧进度，请复制文字后重新载入页面。'),
            );
          }
        } catch {}
      })
      .catch((error) => {
        if (live.current) setMessage(String(error));
      });
    return () => {
      live.current = false;
      stop.current = true;
      flushDraftStorage(slot);
    };
  }, [object.id, object.revision]);
  useEffect(() => {
    dirtyChanged(dirty || busy);
    return () => dirtyChanged(false);
  }, [dirty, busy, dirtyChanged]);
  useEffect(() => {
    if (dirty && job)
      scheduleDraftWrite(
        slot,
        () => JSON.stringify({ jobId: job.id, page, text, version: draftVersion.current }),
        (error) => {
          if (error && live.current) setMessage(uiText('校正草稿暂存失败，请复制文字后保存。'));
        },
        500,
      );
  }, [dirty, job, page, text, slot]);
  const clearDraft = () => {
    writeDraftNow(slot, null);
    setDirty(false);
  };
  async function run(fresh = false) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    stop.current = false;
    setMessage('');
    try {
      let value = current.current;
      if (fresh || !value) {
        if (from < 1 || to > pdf.numPages || from > to) throw Error(uiText('页码范围无效'));
        request.current ??= crypto.randomUUID();
        value = adopt(await call('start', { requestId: request.current, from, to, language }));
        request.current = null;
        setPage(0);
        setText('');
        clearDraft();
      }
      if (value.pending) throw Error(uiText('请先重试合并保存，再继续识别。'));
      for (let number = value.from; number <= value.to; number++) {
        if (stop.current || !live.current) break;
        if (value.pages.includes(number)) continue;
        setMessage(
          uiText('正在识别第 {0} 页 · {1}/{2}', {
            '0': number,
            '1': value.pages.length,
            '2': value.to - value.from + 1,
          }),
        );
        const source = await pdf.getPage(number),
          base = source.getViewport({ scale: 1 }),
          scale = Math.min(2, 2400 / Math.max(base.width, base.height)),
          view = source.getViewport({ scale }),
          canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(view.width);
        canvas.height = Math.ceil(view.height);
        try {
          await source.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
          if (stop.current || !live.current) break;
          const result = await browserCommand<{ text: string }>(
            'document-ocr',
            { image: canvas.toDataURL('image/png'), language: value.language },
            90000,
          );
          value = adopt(
            await call('page', {
              jobId: value.id,
              page: number,
              text: result.text,
              version: value.version,
            }),
          );
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
      if (live.current)
        setMessage(
          stop.current
            ? uiText('已暂停，已完成页面会保留；可继续识别。')
            : uiText('识别完成，可合并保存到桌面。'),
        );
    } catch (error) {
      if (live.current) setMessage(String(error));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function read(number: number) {
    if (dirty && !confirm(uiText('放弃当前页尚未保存的校正？'))) return;
    const result = await call('read_page', { jobId: job.id, page: number });
    setPage(number);
    setText(result.text);
    draftVersion.current = job.version;
    clearDraft();
  }
  const operate = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!isIntegratedDesktop) return null;
  return (
    <details className="pdf-ocr pdf-batch-ocr">
      <summary>{uiText('整份 PDF 识别与断点继续')}</summary>
      <div className="settings-actions">
        <label>
          {uiText('从')}
          <input
            type="number"
            min={1}
            max={pdf.numPages}
            value={from}
            disabled={busy}
            onChange={(e) => setFrom(Number(e.target.value))}
          />
        </label>
        <label>
          {uiText('到')}
          <input
            type="number"
            min={from}
            max={pdf.numPages}
            value={to}
            disabled={busy}
            onChange={(e) => setTo(Number(e.target.value))}
          />
        </label>
        <select value={language} disabled={busy} onChange={(e) => setLanguage(e.target.value)}>
          <option value="">{uiText('系统语言')}</option>
          <option value="zh-Hans-CN">{uiText('中文')}</option>
          <option value="en-US">English</option>
        </select>
        <button disabled={busy || dirty} onClick={() => void run(true)}>
          {uiText('开始新识别')}
        </button>
        {job && (
          <button disabled={busy || dirty || !!job.pending} onClick={() => void run()}>
            {uiText('继续未完成页')}
          </button>
        )}
        {busy && (
          <button
            onClick={() => {
              stop.current = true;
              setMessage(uiText('将在当前页处理结束后暂停'));
            }}
          >
            {uiText('暂停')}
          </button>
        )}
      </div>
      {job && (
        <>
          <p>
            {job.pages.length} / {job.to - job.from + 1} {uiText('页已保存进度 · 来源 v')}
            {job.revision}
          </p>
          <button
            disabled={busy || dirty || !job.pages.length}
            onClick={() =>
              void operate(async () => {
                adopt(await call('save', { jobId: job.id }));
                await updated();
                setMessage(uiText('已合并保存，继续校正会更新同一结果文件。'));
              })
            }
          >
            {job.pending
              ? uiText('重试合并保存')
              : job.result
                ? uiText('更新原识别文件')
                : uiText('合并保存到桌面')}
          </button>
          <select
            aria-label={uiText('校正已识别页')}
            disabled={busy}
            value={page}
            onChange={(e) => void operate(() => read(Number(e.target.value)))}
          >
            <option value={0}>{uiText('选择已识别页')}</option>
            {job.pages.map((number: number) => (
              <option key={number} value={number}>
                {uiText('第')}
                {number} {uiText('页')}
              </option>
            ))}
          </select>
          {job.pages.includes(page) && (
            <>
              <textarea
                rows={5}
                value={text}
                disabled={busy || !!job.pending}
                onChange={(e) => {
                  setText(e.target.value);
                  setDirty(true);
                }}
              />
              <button
                disabled={busy || !dirty || !!job.pending}
                onClick={() =>
                  void operate(async () => {
                    adopt(
                      await call('page', {
                        jobId: job.id,
                        page,
                        text,
                        version: draftVersion.current,
                      }),
                    );
                    clearDraft();
                  })
                }
              >
                {uiText('保存本页校正')}
              </button>
            </>
          )}
        </>
      )}
      <p role="status">{message}</p>
    </details>
  );
}
