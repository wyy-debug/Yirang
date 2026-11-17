import React, { useState, useEffect } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';
export function AppDevelopment({
  workspaceId,
  instanceId,
}: {
  workspaceId: string;
  instanceId: string;
}) {
  const [context, setContext] = useState<any>(null),
    [changes, setChanges] = useState<any>(null),
    [deps, setDeps] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [task, setTask] = useState('');
  const call = async (operation: string, payload: any = {}) => {
    const result = await browserCommand<any>(
      'light-apps',
      { workspaceId, operation, payload: { instanceId, ...payload } },
      120000,
    );
    return result;
  };
  const refresh = async () => setContext(await call('development_context'));
  useEffect(() => {
    let live = true;
    void call('development_context')
      .then((v) => {
        if (live) setContext(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, instanceId]);
  const run = async (fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      await refresh();
      window.dispatchEvent(new Event('yirang:apps-changed'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const draft = context?.draft?.state === 'editing' ? context.draft : null;
  return (
    <section className="app-development">
      <h3>版本与发布</h3>
      <p>先查看草稿变更，再预览并确认发布。正式应用在发布前保持不变。</p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="例如：增加版本筛选、调整页面布局、接入新的查询接口"
      />
      <div className="app-dev-actions">
        <button
          disabled={busy || !task.trim()}
          onClick={() =>
            void run(() =>
              browserCommand('light-app-development-task', {
                workspaceId,
                instanceId,
                task,
                mode: 'modify',
              }),
            )
          }
        >
          让 AI 修改应用
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(() =>
              browserCommand('light-app-development-task', {
                workspaceId,
                instanceId,
                task: task || '定位并修复这个应用的错误',
                mode: 'repair',
              }),
            )
          }
        >
          修复此应用
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await call('development_control', { enabled: true });
              await call('draft_create');
            })
          }
        >
          创建 / 继续草稿
        </button>
        {context?.developmentEnabled && (
          <button
            disabled={busy}
            onClick={() => void run(() => call('development_control', { enabled: false }))}
          >
            撤回草稿开发授权
          </button>
        )}
      </div>
      {!draft && <p>当前没有待发布草稿。可点击“创建 / 继续草稿”开始修改。</p>}
      {draft && (
        <article>
          <strong>待发布草稿 · 基于 {draft.baseVersion}</strong>
          <p>点击“查看变更”读取最新改动后，发布按钮会启用。</p>
          <small>{draft.root}</small>
          <div className="app-dev-actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => setChanges(await call('draft_changes', { draftId: draft.id })))
              }
            >
              1 · 查看变更
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const v = await call('draft_preview', { draftId: draft.id });
                  window.dispatchEvent(
                    new CustomEvent('yirang:open-apps', {
                      detail: { workspaceId, instanceId: v.instanceId },
                    }),
                  );
                })
              }
            >
              预览草稿
            </button>
            <button
              disabled={busy}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('yirang:publish-review', { detail: { instanceId } }),
                )
              }
            >
              查看并发布更新
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call('draft_discard', { draftId: draft.id });
                  setChanges(null);
                })
              }
            >
              放弃草稿
            </button>
          </div>
          {changes && (
            <ul>
              {changes.changes.map((f: any) => (
                <li key={f.path}>
                  {f.kind} · {f.path}
                </li>
              ))}
            </ul>
          )}
        </article>
      )}
      <details>
        <summary>依赖环境</summary>
        <p>Python 使用应用自己的 .venv。Node 使用锁文件安装，默认不执行 npm 安装脚本。</p>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => setDeps(await call('dependencies_status', { draftId: draft?.id })))
          }
        >
          查看{draft ? '草稿' : '正式'}环境
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const j = await call('dependencies_install', { draftId: draft?.id });
              setMessage('安装任务已开始：' + j.id);
            })
          }
        >
          安装{draft ? '草稿' : '正式'}依赖
        </button>
        {deps && <pre>{JSON.stringify(deps, null, 2)}</pre>}
        {context?.jobs.map((j: any) => (
          <article key={j.id}>
            {j.kind} · {j.state}
            <button disabled={busy} onClick={() => void run(refresh)}>
              刷新
            </button>
            {j.state === 'running' && (
              <button onClick={() => void run(() => call('dependencies_cancel', { jobId: j.id }))}>
                取消
              </button>
            )}
            <pre>{j.error || j.log}</pre>
          </article>
        ))}
      </details>
      <details>
        <summary>版本历史与回退</summary>
        <p>回退代码保留当前数据；需要恢复数据时，从下方备份单独恢复。</p>
        {context?.releases
          .slice()
          .reverse()
          .map((r: any) => (
            <article key={r.id}>
              {r.version} · {new Date(r.createdAt).toLocaleString()}
              <button
                disabled={busy}
                onClick={() =>
                  void run(() => call('release_rollback', { releaseId: r.id, previous: false }))
                }
              >
                使用此版本
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(() => call('release_rollback', { releaseId: r.id, previous: true }))
                }
              >
                回到更新前
              </button>
            </article>
          ))}
      </details>
      <details>
        <summary>数据备份与恢复</summary>
        <button disabled={busy} onClick={() => void run(() => call('data_backup'))}>
          立即备份
        </button>
        {context?.backups
          .slice()
          .reverse()
          .map((b: any) => (
            <article key={b.id}>
              {new Date(b.createdAt).toLocaleString()} · {b.version}
              <button
                disabled={busy}
                onClick={() => void run(() => call('data_restore', { backupId: b.id }))}
              >
                恢复这份数据
              </button>
            </article>
          ))}
        <small>恢复前再创建安全备份；凭据不导出。运行中不能备份或切换版本。</small>
      </details>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const v = await call('package_export');
            setMessage('应用包已保存：' + v.path);
          })
        }
      >
        导出应用包
      </button>
    </section>
  );
}
