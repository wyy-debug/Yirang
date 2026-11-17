import React, { useState } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { AppTasks } from './light-app-tasks.js';
import { AppWidgetPicker } from './app-widgets.js';
import { RemoteConnections } from './app-dashboard.js';

export function RemoteAppControls({
  workspaceId,
  info,
  refresh,
}: {
  workspaceId: string;
  info: any;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [services, setServices] = useState(false),
    [task, setTask] = useState(''),
    [message, setMessage] = useState(''),
    [notes, setNotes] = useState<any[] | null>(null),
    [outputs, setOutputs] = useState<any[] | null>(null),
    [action, setAction] = useState(''),
    [input, setInput] = useState('{}');
  const c = info.connection,
    control = c.online && c.allowActions && c.access === 'control';
  const call = (operation: string, payload: any = {}) =>
    browserCommand<any>(
      'light-apps',
      { workspaceId, operation, payload: { instanceId: info.id, ...payload } },
      120000,
    );
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="remote-app-controls">
      <div>
        <strong>
          {c.online ? '● 已连接' : '○ 离线 · 显示最近数据'} · {info.connectionName}
        </strong>
        <p>
          {info.runtime === 'running' ? '后端在服务主机运行' : '服务状态：' + info.runtime}
          。关闭页面或退出一壤不会停止任务。
        </p>
      </div>
      <div className="remote-actions">
        <button onClick={() => setServices(true)}>连接设置</button>
        <button disabled={busy || !control} onClick={() => void run(() => call('start'))}>
          启动后端
        </button>
        <button disabled={busy || !control} onClick={() => void run(() => call('stop'))}>
          停止远程任务
        </button>
        <button
          disabled={busy}
          onClick={() => void run(async () => setNotes(await call('notifications_list')))}
        >
          通知{info.unread ? ' · ' + info.unread : ''}
        </button>
        <button
          disabled={busy || !c.online}
          onClick={() => void run(async () => setOutputs(await call('outputs_list')))}
        >
          结果文件
        </button>
      </div>
      <AppWidgetPicker workspaceId={workspaceId} instanceId={info.id} remote />
      <AppTasks workspaceId={workspaceId} instanceId={info.id} canControl={control} />
      <details>
        <summary>执行应用动作</summary>
        <p>按服务声明运行。仅调用时联网，断线不会自动重发。</p>
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">选择动作</option>
          {(info.manifest.actions || [])
            .filter((a: any) => a.name !== 'get_state')
            .map((a: any) => (
              <option key={a.name} value={a.name}>
                {a.title || a.name}
              </option>
            ))}
        </select>
        <details>
          <summary>输入格式</summary>
          <pre>
            {JSON.stringify(
              info.manifest.actions.find((a: any) => a.name === action)?.inputSchema || {},
              null,
              2,
            )}
          </pre>
        </details>
        <textarea
          aria-label="动作输入 JSON"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          disabled={busy || !control || !action}
          onClick={() =>
            void run(async () => {
              await call('action_call', {
                action,
                input: JSON.parse(input),
                requestId: crypto.randomUUID(),
              });
              setMessage('请求已发送，可在任务与运行中查看。');
              window.dispatchEvent(new Event('yirang:app-task-changed'));
            })
          }
        >
          运行
        </button>
      </details>
      <details>
        <summary>让 AI 操作此应用{info.aiEnabled ? ' · 已允许' : ''}</summary>
        <p>AI 可读取公开状态。执行动作还需要连接开启控制权限；撤回 AI 授权不会停止远程服务。</p>
        <textarea
          aria-label="应用 AI 任务"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="希望 AI 查看或处理什么？"
        />
        <button
          disabled={busy || !task.trim()}
          onClick={() =>
            void run(async () => {
              await browserCommand('light-app-ai-task', { workspaceId, instanceId: info.id, task });
              setMessage('已带入对话，发送后开始处理。');
            })
          }
        >
          带入 AI 对话
        </button>
        {info.aiEnabled && (
          <button
            disabled={busy}
            onClick={() => void run(() => call('ai_control', { enabled: false }))}
          >
            撤回 AI 授权
          </button>
        )}
      </details>
      {notes && (
        <section>
          <strong>应用通知</strong>
          {!notes.length && <p>暂无通知</p>}
          {notes.map((n) => (
            <article key={n.id}>
              <strong>{n.title}</strong>
              <p>{n.body}</p>
              <small>{new Date(n.createdAt).toLocaleString()}</small>
            </article>
          ))}
        </section>
      )}
      {outputs && (
        <section>
          <strong>远程结果文件</strong>
          {!outputs.length && <p>暂无登记文件</p>}
          {outputs.map((o) => (
            <article key={o.runId + o.path}>
              <span>{o.name || o.path}</span>
              <button
                disabled={busy || !c.online}
                onClick={() =>
                  void run(() => call('outputs_import', { runId: o.runId, path: o.path }))
                }
              >
                保存到桌面
              </button>
              <button
                disabled={busy || !c.online}
                onClick={() =>
                  void run(() => call('output_open', { runId: o.runId, path: o.path }))
                }
              >
                打开文件
              </button>
            </article>
          ))}
        </section>
      )}
      <p>
        代码、业务配置、凭据和定时任务保存在服务主机。这里只连接服务，不会把本机文件路径发送给 Mac。
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {services && <RemoteConnections workspaceId={workspaceId} close={() => setServices(false)} />}
    </div>
  );
}
