import { getUiLanguage as interfaceLocale } from '../../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import { useTransientNotice } from '../../ui/use-transient-notice.js';
import React, { useEffect, useRef, useState } from 'react';
import type {
  DesktopObject,
  NativeFileSessionView,
  MaterialRange,
} from '../../../../packages/contracts/index.js';
import { NativePreview } from './native-preview.js';
import { FilePreview } from '../materials.js';
import {
  NATIVE_FILE_LIMIT,
  isNativeTextFile,
} from '../../../../packages/components/native-files.js';
import { XlsxFileEditor } from '../spreadsheet/xlsx-editor.js';
import { NativeTextEditor } from './native-text-editor.js';
import { OfficeFileEditor } from '../office/office-editor.js';
import { useNativeDraftRecovery } from './native-drafts.js';
type Props = {
  object: DesktopObject;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  exportFile: () => void;
  reference: (range?: MaterialRange) => Promise<boolean>;
  comment?: (range?: MaterialRange) => void;
  canReference: boolean;
  history: (revision?: number) => void;
  dirtyChanged: (dirty: boolean) => void;
};
export function NativeFileDetails({
  object,
  action,
  updated,
  exportFile,
  reference,
  comment,
  canReference,
  history,
  dirtyChanged,
}: Props) {
  useUiLocale();
  const recovery = useNativeDraftRecovery(object.id, action);
  const fileName = (object.content as { fileName: string }).fileName,
    isXlsx = /\.xlsx$/i.test(fileName),
    isOffice = /\.(docx|pptx)$/i.test(fileName),
    isText = isNativeTextFile(fileName),
    [editing, setEditing] = useState(isXlsx || isText || isOffice);
  const input = useRef<HTMLInputElement>(null),
    pending = useRef<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useTransientNotice();
  const actionRef = useRef(action);
  actionRef.current = action;
  const [sessions, setSessions] = useState<NativeFileSessionView[]>([]),
    [sessionError, setSessionError] = useState('');
  useEffect(() => {
    let active = true,
      inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await actionRef.current('file_sessions', { objectId: object.id });
        if (active) {
          setSessions(result);
          setSessionError('');
        }
      } catch (e) {
        if (active) setSessionError(String(e));
      } finally {
        inFlight = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [object.id, object.revision]);
  async function attach() {
    setBusy(true);
    try {
      if (await reference())
        setNotice(uiText('已引用此文件。请在 Codex 原消息框说明读取、修改或继续回写的要求。'));
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!pending.current) return;
    await action('file_replace', pending.current);
    pending.current = null;
    await updated();
    setNotice(uiText('已保存为同一文件的新版本，原有版本保留。'));
  }
  async function replace(file: File) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (file.size > NATIVE_FILE_LIMIT) throw new Error(uiText('单文件最多 50 MiB。'));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      pending.current = {
        requestId: crypto.randomUUID(),
        objectId: object.id,
        expectedRevision: object.revision,
        fileName: file.name,
        lastModified: file.lastModified,
        data: btoa(binary),
      };
      await submit();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError('');
    try {
      await submit();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (recovery.blocked)
    return (
      <div>
        <p>{recovery.error}</p>
        <button onClick={recovery.retry}>{uiText('重新取得编辑权限')}</button>
      </div>
    );
  if (!recovery.ready) return <p>{uiText('正在恢复文件编辑草稿…')}</p>;
  const warning = recovery.error && (
    <p className="error-text" role="alert">
      {recovery.error}
    </p>
  );
  if (isXlsx && editing)
    return (
      <>
        {warning}
        <XlsxFileEditor
          reference={reference}
          comment={comment}
          canReference={canReference && !object.policy?.private}
          object={object}
          action={action}
          updated={updated}
          details={() => setEditing(false)}
          dirtyChanged={dirtyChanged}
        />
      </>
    );
  if (isText && editing)
    return (
      <>
        {warning}
        <NativeTextEditor
          reference={reference}
          comment={comment}
          canReference={canReference && !object.policy?.private}
          object={object}
          action={action}
          updated={updated}
          details={() => setEditing(false)}
          dirtyChanged={dirtyChanged}
        />
      </>
    );
  if (isOffice && editing)
    return (
      <>
        {warning}
        <OfficeFileEditor
          reference={reference}
          comment={comment}
          canReference={canReference && !object.policy?.private}
          object={object}
          action={action}
          updated={updated}
          details={() => setEditing(false)}
          dirtyChanged={dirtyChanged}
        />
      </>
    );
  return (
    <div className="native-file-details">
      {/\.(pdf|png|jpe?g|webp|gif)$/i.test(fileName) && (
        <NativePreview
          updated={updated}
          object={object}
          action={action}
          reference={reference}
          comment={comment}
          canReference={canReference && !object.policy?.private}
          dirtyChanged={dirtyChanged}
        />
      )}
      {(isXlsx || isText || isOffice) && (
        <button className="primary" onClick={() => setEditing(true)}>
          {isXlsx
            ? uiText('在桌面内编辑工作簿')
            : isOffice
              ? uiText('在桌面内编辑文档')
              : uiText('在桌面内编辑文本')}
        </button>
      )}
      <FilePreview object={object} exportFile={exportFile} />
      <section className="native-file-workflow">
        <div>
          <strong>{uiText('评论与 AI 处理')}</strong>
          <small>{uiText('在这份文件上讨论要求、查看回复和处理结果，保存后仍更新原文件。')}</small>
        </div>
        {comment && (
          <button
            className="primary"
            disabled={busy || !!pending.current}
            onClick={() => comment()}
          >
            {uiText('评论与 AI 处理')}
          </button>
        )}
        <button
          className="primary"
          disabled={busy || !canReference || !!object.policy?.private}
          onClick={() => void attach()}
        >
          {uiText('引用到原对话')}
        </button>
        {!canReference && <small>{uiText('需要在支持材料引用的 Codex 桌面面板中打开。')}</small>}
      </section>
      <div className="native-file-actions">
        <input
          ref={input}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void replace(file);
          }}
        />
        <button disabled={busy} onClick={() => input.current?.click()}>
          {busy ? uiText('正在保存文件…') : uiText('选择文件更新此版本')}
        </button>
        <small>{uiText('文件内容按原格式保存，目录位置、桌面位置和分组关系保留。')}</small>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {pending.current && error && (
          <button disabled={busy} onClick={() => void retry()}>
            {uiText('重试同一次保存')}
          </button>
        )}
      </div>
      <section className="native-file-sessions">
        <h3>{uiText('文件处理记录')}</h3>
        <button onClick={() => history()}>{uiText('查看版本历史')}</button>
        {sessionError && (
          <p role="alert" className="error-text">
            {sessionError}
          </p>
        )}
        {!sessions.length && !sessionError && (
          <p>{uiText('在原对话提出修改要求后，这里会显示回写进度。')}</p>
        )}
        {[...sessions]
          .sort((a, b) => Number(b.state === 'prepared') - Number(a.state === 'prepared'))
          .slice(0, 8)
          .map((record) => (
            <article key={record.id}>
              <div>
                <strong>
                  {record.state === 'committed'
                    ? uiText('已更新原文件')
                    : record.state === 'unchanged'
                      ? uiText('内容未变')
                      : record.state === 'discarded'
                        ? uiText('已放弃回写')
                        : record.writeBlocked
                          ? uiText('文件暂不可回写')
                          : record.conflict
                            ? uiText('需要合并新版本')
                            : record.lastError
                              ? uiText('回写待处理')
                              : uiText('等待原对话保存')}
                </strong>
                <small>
                  v{record.baseRevision}
                  {record.result
                    ? ` → v${record.result.revision}`
                    : uiText(' · 当前 v{0}', { '0': record.currentRevision })}{' '}
                  · {new Date(record.createdAt).toLocaleString(interfaceLocale())}
                </small>
              </div>
              <p>{record.nextAction}</p>
              <button onClick={() => history(record.result?.revision ?? record.baseRevision)}>
                {uiText('定位此版本')}
              </button>
              {record.lastError && <p className="error-text">{record.lastError.message}</p>}
              {record.state === 'prepared' && (
                <button
                  disabled={busy || !canReference || !!object.policy?.private}
                  onClick={() => void attach()}
                >
                  {record.conflict ? uiText('引用最新文件进行合并') : uiText('交给原对话继续处理')}
                </button>
              )}
            </article>
          ))}
        {sessions.length > 8 && (
          <small>{uiText('显示待处理优先的最近 8 条记录；完整版本保存在修改历史中。')}</small>
        )}
      </section>
    </div>
  );
}
