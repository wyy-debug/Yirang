import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t as uiText } from '../../../packages/components/ui-language.js';
import type { WorkspaceSummary } from '../../../packages/contracts/index.js';
import { PanelActionError } from '../host.js';
import { Icon } from './icons.js';
import { useUiLanguage } from './ui-language.js';
import './batch-rename.css';

export type FileTransfer = {
  objectId: string;
  title: string;
  expectedRevision: number;
  operation: 'copy' | 'cut';
};

export function FileTransferDialog({
  file,
  workspaceId,
  list,
  transfer,
  done,
  close,
}: {
  file: FileTransfer;
  workspaceId: string;
  list: () => Promise<WorkspaceSummary[]>;
  transfer: (targetWorkspaceId: string, requestId: string) => Promise<{ targetName: string }>;
  done: (targetName: string) => void;
  close: () => void;
}) {
  useUiLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const [targets, setTargets] = useState<WorkspaceSummary[]>();
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [retryId, setRetryId] = useState('');
  const cut = file.operation === 'cut';

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let active = true;
    void list().then(
      (items) => {
        if (active) setTargets(items.filter((item) => item.id !== workspaceId));
      },
      (failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [list, workspaceId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!target || sending) return;
    setSending(true);
    setError('');
    const requestId = retryId || crypto.randomUUID();
    let result: { targetName: string };
    try {
      result = await transfer(target, requestId);
    } catch (failure) {
      const uncertain =
        !(failure instanceof PanelActionError) ||
        ['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(failure.code);
      setRetryId(uncertain ? requestId : '');
      setError(failure instanceof Error ? failure.message : String(failure));
      setSending(false);
      return;
    }
    done(result.targetName);
  }

  return createPortal(
    <dialog
      className="rename-overlay"
      data-desktop-overlay
      aria-labelledby="file-transfer-title"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!sending) close();
      }}
    >
      <form className="rename-dialog" onSubmit={submit}>
        <header>
          <span className="rename-symbol">
            <Icon name="desktop" />
          </span>
          <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            <h2 id="file-transfer-title">
              {cut ? uiText('剪切到另一个桌面') : uiText('复制到另一个桌面')}
            </h2>
            <p>{file.title}</p>
          </div>
        </header>
        <div className="rename-body">
          {cut && (
            <p className="rename-scope">
              {uiText('文件转入目标桌面后，源卡片可在原桌面的回收站恢复。')}
            </p>
          )}
          {targets?.length ? (
            <label className="rename-field">
              {uiText('目标桌面')}
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                disabled={sending || !!retryId}
              >
                <option value="">{uiText('请选择目标桌面')}</option>
                {targets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            !error && (
              <p role="status">
                {targets ? uiText('暂无其他可用桌面。') : uiText('正在读取桌面列表…')}
              </p>
            )
          )}
          {error && (
            <p className="rename-error" role="alert">
              {error}
            </p>
          )}
          {retryId && (
            <p className="rename-scope">{uiText('暂时无法确认结果。重试会继续同一次操作。')}</p>
          )}
        </div>
        <footer>
          <button type="button" onClick={close} disabled={sending}>
            {uiText('关闭')}
          </button>
          <button type="submit" className="rename-primary" disabled={!target || sending}>
            {sending
              ? uiText('正在转移…')
              : retryId
                ? uiText('重试')
                : cut
                  ? uiText('剪切')
                  : uiText('复制')}
          </button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
