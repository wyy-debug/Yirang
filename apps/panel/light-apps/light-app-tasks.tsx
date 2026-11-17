import React, { useEffect, useState } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';

const activeStates = ['queued', 'starting', 'running'];
const states: Record<string, string> = {
  queued: '等待中',
  starting: '正在启动',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
const sources: Record<string, string> = {
  ai: 'AI 调用',
  page: '页面 / 手动',
  schedule: '定时任务',
};
const duration = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
};

export function AppTasks({
  workspaceId,
  instanceId,
  canControl = true,
}: {
  workspaceId: string;
  instanceId: string;
  canControl?: boolean;
}) {
  const [items, setItems] = useState<any[]>([]),
    [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now()),
    [revision, setRevision] = useState(0),
    [logs, setLogs] = useState<string | null>(null),
    [detail, setDetail] = useState<any>(null);
  const call = (operation: string, payload: Record<string, unknown> = {}) =>
    browserCommand<any>('light-apps', {
      workspaceId,
      operation,
      payload: { instanceId, ...payload },
    });
  useEffect(() => {
    let live = true,
      pending = false,
      cursor = '',
      timer: ReturnType<typeof setTimeout> | undefined;
    setItems([]);
    setDetail(null);
    setLogs(null);
    const poll = async () => {
      clearTimeout(timer);
      if (!live || pending || document.hidden) return;
      pending = true;
      let delay = 10000;
      try {
        const v = await call('runs_poll', { cursor });
        if (live) {
          cursor = v.cursor;
          if (!v.unchanged) setItems(v.items || []);
          setError('');
          setNow(Date.now());
          delay = v.running ? 2000 : 10000;
        }
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        pending = false;
        if (live && !document.hidden) timer = setTimeout(poll, delay);
      }
    };
    const visible = () => {
      if (!document.hidden) void poll();
    };
    void poll();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('yirang:app-task-changed', visible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('yirang:app-task-changed', visible);
    };
  }, [workspaceId, instanceId, revision]);
  const active = items.filter((r) => activeStates.includes(r.state)),
    waiting = active.filter((r) => r.state === 'queued').sort((a, b) => a.createdAt - b.createdAt),
    running = active.find((r) => r.state !== 'queued');
  useEffect(() => {
    if (!open || !active.length) return;
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [open, active.length]);
  const perform = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = (r: any) =>
    void perform(async () => {
      await call('cancel', { runId: r.id });
      setRevision((n) => n + 1);
    });
  const ordered = [
    ...active.filter((r) => r.state !== 'queued'),
    ...waiting,
    ...items.filter((r) => !activeStates.includes(r.state)),
  ];
  return (
    <section className="app-task-panel">
      <div className="app-task-summary">
        <button aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={active.length ? 'app-task-dot live' : 'app-task-dot'} />
          <strong>任务与运行</strong>
          <span>
            {running
              ? `${running.actionTitle || running.action} · ${states[running.state]}`
              : '当前无执行任务'}
          </span>
          <span>等待 {waiting.length}</span>
          <span>{open ? '收起' : '展开记录'}</span>
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {open && (
        <div className="app-task-body">
          <div className="app-task-toolbar" title="同一应用按顺序执行 · 最多保留 50 项等待任务">
            <button disabled={busy} onClick={() => setRevision((n) => n + 1)}>
              刷新
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => setLogs((await call('logs_read')).text || '暂无后端日志'))
              }
            >
              后端日志
            </button>
          </div>
          {running && (
            <p className="app-task-note">
              停止执行会终止应用后端并取消等待队列；取消等待项不会影响当前任务。
            </p>
          )}
          {!items.length && <p>还没有运行记录。页面、AI 和定时任务发起的动作都会显示在这里。</p>}
          <div className="app-task-list">
            {ordered.map((r) => (
              <article key={r.id} className={'app-task-row ' + r.state}>
                <div className="app-task-title">
                  <strong>{r.actionTitle || r.action}</strong>
                  <span>
                    {states[r.state] || r.state}
                    {r.state === 'queued'
                      ? ` · 第 ${waiting.findIndex((q) => q.id === r.id) + 1} 位`
                      : ''}
                  </span>
                </div>
                <small>
                  {sources[r.source] || '应用调用'} ·{' '}
                  {new Date(r.createdAt || r.startedAt).toLocaleString()} ·{' '}
                  {r.state === 'queued' ? '等待' : '耗时'}{' '}
                  {duration(
                    (r.endedAt || now) -
                      (r.state === 'queued' ? r.createdAt : r.startedAt || r.createdAt),
                  )}
                  {r.timeoutMs ? ` · 超时上限 ${duration(r.timeoutMs)}` : ''}
                </small>
                {r.progress && <p>{r.progress}</p>}
                {r.error && <p role="alert">{r.error}</p>}
                {r.state === 'running' && !r.progress && (
                  <p className="app-task-note">等待应用返回结果；应用尚未上报进度。</p>
                )}
                <div className="app-task-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const v = await call('runs_get', { runId: r.id });
                        setDetail(v[0] || null);
                      })
                    }
                  >
                    任务详情
                  </button>
                  {canControl && activeStates.includes(r.state) && (
                    <button disabled={busy} onClick={() => cancel(r)}>
                      {r.state === 'queued' ? '取消排队' : '停止执行并清空队列'}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {logs !== null && (
            <div className="app-task-details">
              <button onClick={() => setLogs(null)}>收起日志</button>
              <pre>{logs}</pre>
            </div>
          )}
          {detail && (
            <div className="app-task-details">
              <button onClick={() => setDetail(null)}>关闭详情</button>
              <pre>
                {JSON.stringify(
                  {
                    任务: detail.id,
                    状态: states[detail.state] || detail.state,
                    参数: detail.input,
                    结果: detail.result,
                    错误: detail.error,
                  },
                  null,
                  2,
                ).slice(0, 32000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
