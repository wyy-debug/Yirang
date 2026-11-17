import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { BackupPolicy } from './automatic-backups.js';
import React, { useEffect, useRef, useState } from 'react';
import type { Workspace, WorkspaceSummary } from '../../../packages/contracts/index.js';
import type { BackupSummary } from '../../../packages/local-runtime/storage/backups.js';
type Pending = { action: 'backup_create' | 'backup_restore'; payload: Record<string, unknown> };
type Preview = {
  backup: BackupSummary;
  digest: string;
  objects: { id: string; title: string; kind: string; revision: number }[];
};
const size = (bytes: number) =>
  bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;

export function Backups({
  workspace,
  action,
  prepare,
  close,
  openRestored,
}: {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  prepare: () => Promise<void>;
  close: () => void;
  openRestored: (id: string) => Promise<void>;
}) {
  useUiLocale();
  const [items, setItems] = useState<BackupSummary[]>([]),
    [jobs, setJobs] = useState<any[]>([]);
  const [unreadable, setUnreadable] = useState<any[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null),
    [restored, setRestored] = useState<WorkspaceSummary | null>(null);
  const [label, setLabel] = useState(''),
    [name, setName] = useState(uiText('{0} · 恢复副本', { '0': workspace.name.slice(0, 60) }));
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending | null>(null),
    alive = useRef(true);
  const slot = `ai-desktop:backup-request:${workspace.id}`;
  function remember(value: Pending | null) {
    setPending(value);
    try {
      if (value) localStorage.setItem(slot, JSON.stringify(value));
      else localStorage.removeItem(slot);
    } catch {
      setNotice(uiText('本次请求暂时只保留在面板中，请勿在结果未确认时关闭。'));
    }
  }
  async function list() {
    const result = await action('backup_list');
    if (alive.current) {
      setItems(result.items);
      setJobs(result.jobs);
      setUnreadable(result.unreadable ?? []);
    }
  }
  useEffect(() => {
    alive.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(slot) || 'null');
      if (
        saved &&
        ['backup_create', 'backup_restore'].includes(saved.action) &&
        saved.payload &&
        typeof saved.payload.requestId === 'string'
      )
        setPending(saved);
    } catch {
      /* A malformed UI hint cannot authorize any server operation. */
    }
    void list()
      .catch((e) => {
        if (alive.current) setError(String(e));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, [workspace.id]);
  async function run(request: Pending) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    remember(request);
    try {
      if (request.action === 'backup_create') await prepare();
      const result = await action(request.action, request.payload);
      if (!alive.current) return;
      remember(null);
      if (request.action === 'backup_restore') {
        setRestored(result);
        setNotice(uiText('恢复副本已创建，原工作区仍保留。'));
      } else setNotice(uiText('备份已保存到本地，包含数据库、关联资产和已登记产物。'));
      // Keep confirmed operations separate from a subsequent list refresh.
      try {
        await list();
      } catch (e) {
        if (alive.current) setError(uiText('操作已完成，列表暂未刷新：{0}', { '0': String(e) }));
      }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function inspect(item: BackupSummary) {
    if (busy || pending) return;
    setBusy(true);
    setError('');
    setPreview(null);
    setRestored(null);
    try {
      const result = await action('backup_inspect', { id: item.id });
      if (alive.current) {
        setPreview(result);
        setName(uiText('{0} · 恢复副本', { '0': item.workspace.name.slice(0, 60) }));
      }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="backup-desk" role="dialog" aria-label={uiText('备份与恢复')}>
      <header>
        <button disabled={busy} onClick={close}>
          {uiText('返回桌面')}
        </button>
        <div>
          <strong>{uiText('备份与恢复')}</strong>
        </div>
        <button disabled={busy} onClick={() => void list().catch((e) => setError(String(e)))}>
          {uiText('刷新')}
        </button>
      </header>
      <div className="backup-body">
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="banner notice" role="status">
            {notice}
          </div>
        )}
        {pending && (
          <div className="backup-pending">
            <strong>{busy ? uiText('正在处理…') : uiText('上次操作尚待确认')}</strong>
            <p>
              {uiText('请求标识已保留。重试会沿用同一次请求；可以先刷新列表查看已完成的备份。')}
            </p>
            <div>
              <button disabled={busy} onClick={() => void run(pending)}>
                {uiText('重试此次')}
                {pending.action === 'backup_create' ? uiText('备份') : uiText('恢复')}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  remember(null);
                  setNotice(uiText('已停止在此界面重试；服务已完成的结果仍保留。'));
                }}
              >
                {uiText('停止重试')}
              </button>
            </div>
          </div>
        )}
        <BackupPolicy action={action} refresh={list} selectedId={preview?.backup.id} />
        <section className="backup-create">
          <h2>{uiText('保存当前工作区')}</h2>
          <p>
            {uiText(
              '包含材料、修订、布局、已暂存草稿、任务记录、原文件和已登记产物。先暂存当前编辑，再建立一致的数据库副本。',
            )}
          </p>
          <div>
            <input
              aria-label={uiText('备份备注')}
              placeholder={uiText('备份备注（可选）')}
              value={label}
              maxLength={80}
              disabled={busy || !!pending}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button
              className="primary"
              disabled={busy || !!pending}
              onClick={() =>
                void run({
                  action: 'backup_create',
                  payload: { requestId: crypto.randomUUID(), label },
                })
              }
            >
              {uiText('创建本地备份')}
            </button>
          </div>
          <small>
            {uiText(
              '仅保存当前工作区，不包含其他对话的工作区、执行凭据、本地运行目录或尚未落盘的输入。',
            )}
          </small>
        </section>
        {restored && (
          <section className="backup-restored">
            <strong>
              {uiText('已恢复：')}
              {restored.name}
            </strong>
            <p>
              {restored.objectCount}{' '}
              {uiText('份材料已放入独立工作区。任务历史保留，执行与资源连接已停止。')}
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void openRestored(restored.id)
                  .catch((e) => {
                    if (alive.current) setError(String(e));
                  })
                  .finally(() => {
                    if (alive.current) setBusy(false);
                  });
              }}
            >
              {uiText('保存当前编辑并打开副本')}
            </button>
          </section>
        )}
        <div className="backup-columns">
          <section className="backup-list">
            <h2>{uiText('已完成的备份')}</h2>
            <p>{uiText('当前工作区及未关联会话的历史备份。')}</p>
            {loading ? (
              <p>{uiText('正在读取…')}</p>
            ) : !items.length ? (
              <p>{uiText('还没有可恢复的本地备份。')}</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  disabled={busy || !!pending}
                  className={preview?.backup.id === item.id ? 'selected' : ''}
                  onClick={() => void inspect(item)}
                >
                  <strong>{item.label || item.workspace.name}</strong>
                  <span>
                    {item.workspace.objects} {uiText('份材料 ·')}
                    {size(item.bytes)}
                  </span>
                  <small>
                    {new Date(item.createdAt).toLocaleString(interfaceLocale())}{' '}
                    {uiText('· 点击预览恢复内容')}
                  </small>
                </button>
              ))
            )}
            {jobs.map((job) => (
              <div className="backup-job" key={job.id}>
                <strong>{job.label || uiText('未完成备份')}</strong>
                <span>
                  {job.state === 'failed'
                    ? uiText('创建失败，完整备份尚未发布')
                    : uiText('创建中或结果待确认')}
                </span>
                <small>{new Date(job.createdAt).toLocaleString(interfaceLocale())}</small>
              </div>
            ))}
            {unreadable.map((item) => (
              <div className="backup-job" key={item.id}>
                <strong>{item.label || uiText('备份记录')}</strong>
                <span>{uiText('目录或清单不可读，请保留原文件。')}</span>
              </div>
            ))}
          </section>
          <section className="backup-preview">
            {preview ? (
              <>
                <h2>{uiText('恢复前预览')}</h2>
                <div className="backup-counts">
                  <span>
                    {preview.backup.workspace.objects} {uiText('份材料（含归档）')}
                  </span>
                  <span>
                    {preview.backup.workspace.drafts} {uiText('份草稿')}
                  </span>
                  <span>
                    {preview.backup.workspace.tasks} {uiText('条任务记录')}
                  </span>
                  <span>
                    {preview.backup.workspace.artifacts} {uiText('个产物')}
                  </span>
                </div>
                <details>
                  <summary>{uiText('查看材料与版本')}</summary>
                  <ul>
                    {preview.objects.map((object) => (
                      <li key={object.id}>
                        {object.title}
                        <small>
                          v{object.revision} · {object.kind}
                        </small>
                      </li>
                    ))}
                  </ul>
                </details>
                <label>
                  {uiText('备份所在文件夹')}
                  <input readOnly value={preview.backup.path} onFocus={(e) => e.target.select()} />
                </label>
                <label>
                  {uiText('恢复后的工作区名称')}
                  <input
                    value={name}
                    maxLength={80}
                    disabled={busy || !!pending}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <p>
                  {uiText(
                    '恢复会创建独立副本，保留历史修订及草稿。原工作区不被覆盖；任务、对话引用和资源授权不会自动恢复执行。',
                  )}
                </p>
                <button
                  className="primary"
                  disabled={busy || !!pending || !name.trim()}
                  onClick={() =>
                    void run({
                      action: 'backup_restore',
                      payload: {
                        id: preview.backup.id,
                        digest: preview.digest,
                        name: name.trim(),
                        requestId: crypto.randomUUID(),
                      },
                    })
                  }
                >
                  {uiText('恢复为独立副本')}
                </button>
              </>
            ) : (
              <div className="backup-empty">
                <span>▦</span>
                <p>
                  {uiText('选择一份备份，查看内容并恢复。')}
                  <br />
                  {uiText('文件缺失或改变时会停止恢复。')}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
