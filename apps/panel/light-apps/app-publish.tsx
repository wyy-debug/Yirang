import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { browserCommand } from '../browser/electron-browser-bridge.js';
export function AppPublish({
  workspaceId,
  instanceId,
  preview,
  draftId,
}: {
  workspaceId: string;
  instanceId: string;
  preview: boolean;
  draftId?: string;
}) {
  const [context, setContext] = useState<any>(null),
    [review, setReview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState('');
  const pending = useRef(false),
    live = useRef(true),
    dialog = useRef<HTMLDialogElement>(null);
  const call = (operation: string, payload: any = {}) =>
    browserCommand<any>(
      'light-apps',
      { workspaceId, operation, payload: { instanceId, ...payload } },
      120000,
    );
  const refresh = async () => {
    const value = await call('development_context');
    if (live.current) setContext(value);
    return value;
  };
  async function prepare() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const c = await refresh();
      if (c.draft?.state !== 'editing')
        throw Error('当前正式应用没有待发布草稿，请刷新或重新创建草稿');
      const changes = await call('draft_changes', { draftId: c.draft.id });
      if (live.current) setReview({ ...changes, appName: c.name, baseVersion: c.version });
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void refresh().catch((e) => {
      if (live.current) setError(String(e));
    });
    const request = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.instanceId === instanceId) void prepare();
    };
    window.addEventListener('yirang:publish-review', request);
    return () => {
      live.current = false;
      window.removeEventListener('yirang:publish-review', request);
    };
  }, [workspaceId, instanceId, draftId]);
  useEffect(() => {
    if (review) dialog.current?.showModal();
  }, [review]);
  async function publish() {
    if (pending.current || !review) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await call('release_publish', { draftId: review.draftId, expectedDigest: review.digest });
      if (!live.current) return;
      setReview(null);
      setDone(`已发布 ${review.version}。重新打开正式应用后使用新版；定时任务需手动恢复。`);
      await refresh();
      window.dispatchEvent(new Event('yirang:apps-changed'));
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  const available = context?.draft?.state === 'editing';
  return (
    <>
      <div className={`app-publish-banner ${available ? 'has-draft' : ''}`}>
        <div>
          <strong>
            {done
              ? '发布完成'
              : available
                ? '待发布更新'
                : preview
                  ? '草稿预览 · 发布到正式应用'
                  : '正式应用'}
          </strong>
          <small>
            {done ||
              (available
                ? `${context.name} · 正式版本 ${context.version}，有一份待发布草稿`
                : context
                  ? '当前没有待发布更新'
                  : '正在读取发布状态…')}
          </small>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            setError('');
            void refresh().catch((e) => setError(String(e)));
          }}
        >
          刷新
        </button>
        {available && (
          <button className="primary" disabled={busy} onClick={() => void prepare()}>
            {busy ? '正在读取…' : '查看并发布更新'}
          </button>
        )}
      </div>
      {error && !review && <p role="alert">{error}</p>}
      {review &&
        createPortal(
          <dialog
            ref={dialog}
            className="app-publish-dialog"
            onCancel={(e) => {
              e.preventDefault();
              if (!busy) setReview(null);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <header>
              <span>发布确认</span>
              <h2>发布到正式应用？</h2>
              <p>{review.appName}</p>
            </header>
            <div className="app-publish-versions">
              <div>
                <small>当前正式版</small>
                <strong>{review.baseVersion}</strong>
              </div>
              <span>→</span>
              <div>
                <small>即将发布</small>
                <strong>{review.version}</strong>
              </div>
            </div>
            <h3>文件变更 · {review.changes.length}</h3>
            <ul>
              {review.changes.map((f: any) => (
                <li key={f.path}>
                  <span>{f.kind}</span>
                  {f.path}
                </li>
              ))}
            </ul>
            <p>
              确认后将备份正式数据并切换到新版本。草稿预览会关闭，新版首次打开需要重新授权，定时任务会暂停。
            </p>
            {error && (
              <p role="alert">
                {error}
                <button disabled={busy} onClick={() => void prepare()}>
                  重新读取变更
                </button>
              </p>
            )}
            <footer>
              <button disabled={busy} onClick={() => setReview(null)}>
                暂不发布
              </button>
              <button className="primary" disabled={busy} onClick={() => void publish()}>
                {busy ? '正在发布…' : '确认发布到正式版'}
              </button>
            </footer>
          </dialog>,
          document.body,
        )}
    </>
  );
}
