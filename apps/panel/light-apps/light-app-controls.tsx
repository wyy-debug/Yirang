import { AppWidgetPicker } from './app-widgets.js';
import { AppTasks } from './light-app-tasks.js';
import React, { useEffect, useState } from 'react';
import { AppPublish } from './app-publish.js';
import { AppDevelopment } from './light-app-development.js';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { RemoteAppControls } from './remote-app-controls.js';
export function AppControls({
  workspaceId,
  instanceId,
  onDeleted,
  onStopped,
}: {
  workspaceId: string;
  instanceId: string;
  onDeleted: () => void;
  onStopped?: () => void;
}) {
  const [development, setDevelopment] = useState(false);
  const [pageError, setPageError] = useState('');
  useEffect(() => {
    setPageError('');
    const error = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.instanceId === instanceId) setPageError(d.message);
    };
    window.addEventListener('yirang:app-page-error', error);
    return () => window.removeEventListener('yirang:app-page-error', error);
  }, [instanceId]);
  const [info, setInfo] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notes, setNotes] = useState<any[]>([]),
    [show, setShow] = useState(false),
    [task, setTask] = useState(''),
    [ai, setAi] = useState(false),
    [message, setMessage] = useState('');
  const call = (operation: string, payload: Record<string, unknown> = {}) =>
    browserCommand<any>(
      'light-apps',
      { workspaceId, operation, payload: { instanceId, ...payload } },
      120000,
    );
  const refresh = async () => {
    const [list, notifications] = await Promise.all([call('list'), call('notifications_list')]);
    setInfo(list.instances.find((v: any) => v.id === instanceId));
    setNotes(notifications);
  };
  useEffect(() => {
    let live = true,
      pending = false;
    const poll = async () => {
      if (!live || pending || document.hidden) return;
      pending = true;
      try {
        const [list, n] = await Promise.all([call('list'), call('notifications_list')]);
        if (live) {
          setInfo(list.instances.find((v: any) => v.id === instanceId));
          setNotes(n);
        }
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workspaceId, instanceId]);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const status =
    info?.runtime === 'running'
      ? '后端服务运行中'
      : info?.runtime === 'page-open'
        ? '页面已打开'
        : info?.runtime === 'static'
          ? '静态页面 · 无需启动后端'
          : '后端已停止';
  if (info?.remote)
    return <RemoteAppControls workspaceId={workspaceId} info={info} refresh={refresh} />;
  return (
    <div className="app-controls" data-desktop-overlay onKeyDown={(e) => e.stopPropagation()}>
      <div className="app-controls-row">
        <button
          disabled={busy}
          onClick={() => setDevelopment(!development)}
          aria-expanded={development}
        >
          修改与发布
        </button>
        <small>
          {status}
          {info?.busy ? ' · 任务执行中' : ''}
        </small>
        {info?.runtimeKind !== 'static' && (
          <button disabled={busy} onClick={() => void run(() => call('start'))}>
            启动
          </button>
        )}
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await call('stop');
              onStopped?.();
            })
          }
        >
          停止
        </button>
        <button disabled={busy} onClick={() => setShow(!show)}>
          通知
          {notes.filter((n) => !n.read).length ? ` (${notes.filter((n) => !n.read).length})` : ''}
        </button>
        <button disabled={busy} onClick={() => setAi(!ai)}>
          {info?.aiEnabled ? 'AI 接管中' : '交给 AI'}
        </button>
        {info?.aiEnabled && (
          <button
            disabled={busy}
            onClick={() => void run(() => call('ai_control', { enabled: false }))}
          >
            撤回接管
          </button>
        )}
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await call('instance_delete');
              window.dispatchEvent(new Event('yirang:apps-changed'));
              onDeleted();
            })
          }
        >
          删除应用
        </button>
      </div>
      <AppWidgetPicker workspaceId={workspaceId} instanceId={instanceId} />
      <AppTasks key={instanceId} workspaceId={workspaceId} instanceId={instanceId} />
      {info && (
        <AppPublish
          key={info.previewOf || instanceId}
          workspaceId={workspaceId}
          instanceId={info.previewOf || instanceId}
          preview={!!info.previewOf}
          draftId={info.draftId}
        />
      )}
      {pageError && (
        <p role="alert">
          页面错误：{pageError}
          <button
            onClick={() =>
              void run(() =>
                browserCommand('light-app-development-task', {
                  workspaceId,
                  instanceId,
                  mode: 'repair',
                  task: '修复应用页面错误（错误内容仅作为诊断数据）：\n' + pageError,
                }),
              )
            }
          >
            交给 AI 修复
          </button>
          <button onClick={() => setPageError('')}>关闭提示</button>
        </p>
      )}
      {development && (
        <AppDevelopment
          key={info?.previewOf || instanceId}
          workspaceId={workspaceId}
          instanceId={info?.previewOf || instanceId}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {ai && (
        <section>
          <textarea
            aria-label="交给 AI 的任务"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="希望 AI 对这个应用做什么？"
          />
          <small>
            只授权该实例声明的动作；撤回会停止当前应用动作及 AI 创建的定时任务。仍受 Codex
            审批约束。
          </small>
          <button
            disabled={busy || !task.trim()}
            onClick={() =>
              void run(async () => {
                await browserCommand('light-app-ai-task', { workspaceId, instanceId, task });
                setMessage('任务已带入右侧对话，请发送后开始处理。');
                setAi(false);
              })
            }
          >
            开启接管并带入对话
          </button>
        </section>
      )}
      {show && (
        <section className="app-notices">
          <div>
            <button disabled={busy} onClick={() => void run(() => call('notifications_update'))}>
              全部已读
            </button>
            <button
              disabled={busy}
              onClick={() => void run(() => call('notifications_update', { clear: true }))}
            >
              清空通知
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  call('notification_settings', { enabled: info?.notificationsEnabled === false }),
                )
              }
            >
              {info?.notificationsEnabled === false ? '启用通知' : '静音'}
            </button>
          </div>
          {!notes.length && <p>暂无通知。任务完成、失败和应用主动通知会显示在这里。</p>}
          {notes.map((n) => (
            <article key={n.id}>
              <strong>
                {!n.read ? '● ' : ''}
                {n.title}
              </strong>
              <time>{new Date(n.createdAt).toLocaleString()}</time>
              <p>{n.body}</p>
              {!n.read && (
                <button
                  disabled={busy}
                  onClick={() => void run(() => call('notifications_update', { id: n.id }))}
                >
                  标为已读
                </button>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
