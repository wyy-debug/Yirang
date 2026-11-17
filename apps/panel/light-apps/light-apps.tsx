import React, { useEffect, useState } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import './light-apps.css';
import { SchemaForm } from '../ui/schema-form.js';
import { useAppSdkBridge } from './light-app-sdk-bridge.js';
import { AppControls } from './light-app-controls.js';
import { openLightAppPage } from './light-app-page-session.js';
import {
  MicroSuggestions,
  MicroRunActions,
  useMicroSuggestions,
  MicroEvolution,
  MicroTemplates,
} from './light-app-crystals.js';

export function LightApps({
  workspaceId,
  close,
  initialInstance,
}: {
  workspaceId: string;
  close: () => void;
  initialInstance?: string;
}) {
  const pageRef = React.useRef<HTMLIFrameElement>(null);
  const [catalog, setCatalog] = useState<any>({ apps: [], instances: [] }),
    [id, setId] = useState(initialInstance || ''),
    [runs, setRuns] = useState<any[]>([]),
    [schedules, setSchedules] = useState<any[]>([]),
    [logs, setLogs] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [url, setUrl] = useState(''),
    [path, setPath] = useState(''),
    [name, setName] = useState('我的轻应用'),
    [appId, setAppId] = useState('my.app'),
    [runtime, setRuntime] = useState('node'),
    [input, setInput] = useState('{}'),
    [config, setConfig] = useState('{}'),
    [action, setAction] = useState(''),
    [interval, setIntervalValue] = useState('300'),
    [tab, setTab] = useState('page');
  const [managing, setManaging] = useState(false),
    [search, setSearch] = useState(''),
    [initialConfig, setInitialConfig] = useState('{}');
  const [pageAttempt, setPageAttempt] = useState(0);
  const micro = useMicroSuggestions(workspaceId);
  useAppSdkBridge(pageRef, workspaceId, id);
  useEffect(() => {
    const refresh = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d?.instanceId === id && d?.workspaceId === workspaceId) {
        setPageAttempt((n) => n + 1);
        void reload();
      }
    };
    window.addEventListener('yirang:app-version-changed', refresh);
    return () => window.removeEventListener('yirang:app-version-changed', refresh);
  }, [workspaceId, id]);
  const call = async (operation: string, payload: Record<string, unknown> = {}) => {
    const result = await browserCommand<any>(
      'light-apps',
      { workspaceId, operation, payload },
      120000,
    );
    return operation === 'list'
      ? { ...result, instances: result.instances.filter((v: any) => !v.remote) }
      : result;
  };
  const [secretName, setSecretName] = useState('API_KEY'),
    [secretValue, setSecretValue] = useState(''),
    [secretNames, setSecretNames] = useState<string[]>([]);
  const selected = catalog.instances.find((v: any) => v.id === id),
    registeredApp = catalog.apps.find((a: any) => a.id === selected?.appId),
    app = selected?.manifest ? { ...registeredApp, manifest: selected.manifest } : registeredApp;
  const reload = async () => {
    const v = await call('list');
    setCatalog(v);
    return v;
  };
  const perform = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    void call('list')
      .then((v) => {
        if (active) setCatalog(v);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  useEffect(() => {
    if (!id || tab !== 'runs') return;
    let active = true,
      pending = false,
      cursor = '',
      timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!active || pending || document.hidden) return;
      clearTimeout(timer);
      pending = true;
      let delay = 15000;
      try {
        const v = await call('runs_poll', { instanceId: id, cursor });
        if (active) {
          cursor = v.cursor;
          if (!v.unchanged) setRuns(v.items);
          delay = v.running ? 3000 : 15000;
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        pending = false;
        if (active && !document.hidden) timer = setTimeout(refresh, delay);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [id, workspaceId, tab]);
  useEffect(() => {
    setUrl('');
    setRuns([]);
    setAction('');
    setInput('{}');
    setLogs('');
    setSchedules([]);
    if (id)
      void call('config_get', { instanceId: id })
        .then((v) => {
          setConfig(JSON.stringify(v.config, null, 2));
          setSecretNames(v.secretNames || []);
        })
        .catch((e) => setError(String(e)));
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    setTab('page');
    setBusy(true);
    setError('');
    const page = openLightAppPage(workspaceId, id);
    void page.ready
      .then((url) => {
        if (active) setUrl(url);
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      page.close();
    };
  }, [initialInstance, id, workspaceId, pageAttempt]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [close]);
  return (
    <div
      className="light-apps-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="轻应用"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <section className="light-apps-window">
        <header>
          <div>
            <strong>本地应用管理</strong>
            <small>远程应用从组件看板或顶部应用标签打开</small>
          </div>
          <button onClick={close} aria-label="关闭轻应用">
            ×
          </button>
        </header>
        {error && (
          <p role="alert" className="light-apps-error">
            {error}
            <button onClick={() => setError('')}>×</button>
          </p>
        )}
        <div className="light-apps-body">
          <aside className="app-library-sidebar">
            <div className="app-library-heading">
              <span>我的应用</span>
              <button
                disabled={busy}
                title="刷新列表"
                aria-label="刷新列表"
                onClick={() => void perform(reload)}
              >
                ↻
              </button>
            </div>
            <input
              className="app-library-search"
              aria-label="搜索应用"
              placeholder="搜索应用…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="app-library-list">
              {catalog.instances
                .filter((v: any) => v.name.toLowerCase().includes(search.toLowerCase()))
                .map((v: any) => (
                  <button
                    className={(!managing && id === v.id ? 'selected ' : '') + 'app-library-item'}
                    key={v.id}
                    onClick={() => {
                      setManaging(false);
                      setId(v.id);
                    }}
                  >
                    <span className="app-library-icon">{v.name.slice(0, 1)}</span>
                    <span className="app-library-label">
                      <strong>{v.name}</strong>
                      <small>
                        <i
                          className={
                            v.runtime === 'running' || v.runtime === 'page-open' ? 'is-live' : ''
                          }
                        />
                        {v.previewOf
                          ? '草稿预览'
                          : v.runtime === 'micro'
                            ? '微应用'
                            : v.runtime === 'running'
                              ? '运行中'
                              : v.runtime === 'page-open'
                                ? '已打开'
                                : v.runtime === 'static'
                                  ? '静态应用'
                                  : '未启动'}
                      </small>
                    </span>
                  </button>
                ))}
              {!catalog.instances.length && (
                <p className="app-library-hint">
                  还没有应用
                  <br />
                  添加你的第一个轻应用
                </p>
              )}
              {!!catalog.instances.length &&
                !catalog.instances.some((v: any) =>
                  v.name.toLowerCase().includes(search.toLowerCase()),
                ) && <p className="app-library-hint">没有找到匹配的应用</p>}
            </div>
            <footer>
              {micro.pending > 0 && (
                <button className="micro-suggestion-entry" onClick={() => setManaging(true)}>
                  微应用建议 {micro.pending}
                </button>
              )}
              <button className={managing ? 'selected' : ''} onClick={() => setManaging(true)}>
                ＋ 添加与管理
              </button>
            </footer>
          </aside>

          <main>
            {managing ? (
              <section className="app-library-manager">
                <div className="app-manager-intro">
                  <span className="app-manager-symbol">＋</span>
                  <h2>添加你的应用</h2>
                  <p>导入应用包，或连接本地项目。</p>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await call('package_import_picker');
                      })
                    }
                  >
                    导入应用包
                  </button>
                </div>
                <div className="app-manager-form">
                  <h3>注册项目</h3>
                  <input
                    aria-label="项目路径"
                    placeholder="包含 yirang.app.json 的目录"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                  />
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const p = await call('choose_folder');
                        if (p) setPath(p);
                      })
                    }
                  >
                    选择目录
                  </button>
                  <button
                    disabled={busy || !path}
                    onClick={() => void perform(() => call('register', { path }))}
                  >
                    注册已有应用
                  </button>
                  <details>
                    <summary>新建通用模板</summary>
                    <input
                      aria-label="应用名称"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <input
                      aria-label="应用标识"
                      value={appId}
                      onChange={(e) => setAppId(e.target.value)}
                    />
                    <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
                      <option value="node">Node.js</option>
                      <option value="python">Python</option>
                      <option value="static">静态页面</option>
                    </select>
                    <small>在上方路径内创建以应用标识命名的新目录。</small>
                    <button
                      disabled={busy || !path}
                      onClick={() =>
                        void perform(async () => {
                          const target = path.replace(/[\\/]$/, '') + '/' + appId;
                          await call('scaffold', { path: target, name, appId, runtime });
                          await call('register', { path: target });
                          setPath(target);
                        })
                      }
                    >
                      创建并注册
                    </button>
                  </details>
                  <details>
                    <summary>高级 · 新实例配置</summary>
                    <textarea
                      value={initialConfig}
                      onChange={(e) => setInitialConfig(e.target.value)}
                    />
                  </details>
                  <MicroTemplates
                    workspaceId={workspaceId}
                    onCreated={(instanceId) => {
                      void reload().then(() => {
                        setId(instanceId);
                        setManaging(false);
                      });
                    }}
                  />
                  <MicroSuggestions
                    workspaceId={workspaceId}
                    onPublished={(instanceId) => {
                      void micro.load();
                      void reload().then(() => {
                        setId(instanceId);
                        setManaging(false);
                      });
                    }}
                  />
                  <h3>已注册</h3>
                  {catalog.apps.map((a: any) => (
                    <div key={a.id}>
                      <strong>{a.manifest.name}</strong>
                      <button
                        disabled={busy || catalog.instances.some((v: any) => v.appId === a.id)}
                        onClick={() => void perform(() => call('unregister', { appId: a.id }))}
                      >
                        移除注册
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const v = await call('instance_create', {
                              appId: a.id,
                              config: JSON.parse(initialConfig),
                            });
                            setId(v.id);
                            setManaging(false);
                          })
                        }
                      >
                        创建实例
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : !selected ? (
              <div className="light-apps-empty">
                <span className="app-manager-symbol">◇</span>
                <h2>你的轻应用空间</h2>
                <p>从左侧打开应用，或添加属于自己的工具。</p>
                <button className="primary" onClick={() => setManaging(true)}>
                  ＋ 添加应用
                </button>
              </div>
            ) : (
              <>
                <div className="light-apps-toolbar">
                  <h2>{selected.name}</h2>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setTab('page');
                      setPageAttempt((n) => n + 1);
                    }}
                  >
                    打开页面
                  </button>
                </div>
                <AppControls
                  key={id}
                  workspaceId={workspaceId}
                  instanceId={id}
                  onDeleted={() => {
                    setId('');
                    void reload();
                  }}
                  onStopped={() => setUrl('')}
                />
                <nav>
                  {[
                    ['actions', '动作'],
                    ['page', '页面'],
                    ['runs', '运行与产出'],
                    ...(selected.runtime === 'micro' ? [['evolve', '改进与分享']] : []),
                    ['config', '配置'],
                    ['schedules', '定时任务'],
                    ['logs', '日志'],
                  ].map(([key, title]) => (
                    <button
                      key={key}
                      className={tab === key ? 'selected' : ''}
                      onClick={() => {
                        setTab(key);
                        if (key === 'logs')
                          void perform(async () =>
                            setLogs((await call('logs_read', { instanceId: id })).text),
                          );
                        if (key === 'schedules')
                          void perform(async () =>
                            setSchedules(await call('schedules_list', { instanceId: id })),
                          );
                      }}
                    >
                      {title}
                    </button>
                  ))}
                </nav>
                {tab === 'page' &&
                  (url ? (
                    <iframe
                      ref={pageRef}
                      title={selected.name}
                      src={url}
                      sandbox="allow-scripts allow-forms"
                    />
                  ) : (
                    <p>
                      {busy
                        ? '正在打开应用页面…'
                        : '点击“打开页面”加载应用，关闭面板后后台仍可继续运行。'}
                    </p>
                  ))}
                {tab === 'actions' && (
                  <section>
                    <p>动作由应用声明，页面和 MCP 使用同一个入口。</p>
                    <select
                      aria-label="选择动作"
                      value={action}
                      onChange={(e) => setAction(e.target.value)}
                    >
                      <option value="">选择动作</option>
                      {app?.manifest.actions.map((a: any) => (
                        <option key={a.name} value={a.name}>
                          {a.title || a.name} · {a.effect}
                        </option>
                      ))}
                    </select>
                    <details>
                      <summary>输入契约</summary>
                      <pre>
                        {JSON.stringify(
                          app?.manifest.actions.find((a: any) => a.name === action)?.inputSchema ||
                            {},
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                    <SchemaForm
                      label="动作参数"
                      schema={
                        app?.manifest.actions.find((a: any) => a.name === action)?.inputSchema || {}
                      }
                      value={JSON.parse(input)}
                      onChange={(v) => setInput(JSON.stringify(v))}
                    />
                    <button
                      className="primary"
                      disabled={busy || !action}
                      onClick={() =>
                        void perform(async () => {
                          await call('action_call', {
                            instanceId: id,
                            action,
                            input: JSON.parse(input),
                            requestId: crypto.randomUUID(),
                          });
                          setTab('runs');
                          setRuns((await call('runs_poll', { instanceId: id })).items);
                        })
                      }
                    >
                      运行
                    </button>
                  </section>
                )}
                {tab === 'config' && (
                  <section>
                    <p>普通配置会提供给 AI。密钥请使用下方本机凭据输入，只向后端提供。</p>
                    <SchemaForm
                      schema={app?.manifest.configSchema || {}}
                      value={JSON.parse(config)}
                      onChange={(v) => setConfig(JSON.stringify(v))}
                    />
                    <details>
                      <summary>高级 JSON</summary>
                      <textarea
                        aria-label="配置 JSON"
                        value={config}
                        onChange={(e) => {
                          try {
                            JSON.parse(e.target.value);
                            setConfig(e.target.value);
                          } catch {}
                        }}
                      />
                    </details>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(() =>
                          call('config_update', { instanceId: id, config: JSON.parse(config) }),
                        )
                      }
                    >
                      保存配置
                    </button>
                    <hr />
                    <h3>本机凭据</h3>
                    <p>
                      已配置：{secretNames.join('、') || '无'}。只保存名称供 AI
                      发现，值不回显。留空保存即删除。
                    </p>
                    <input
                      aria-label="凭据名称"
                      value={secretName}
                      onChange={(e) => setSecretName(e.target.value)}
                    />
                    <input
                      type="password"
                      autoComplete="new-password"
                      aria-label="凭据值"
                      value={secretValue}
                      onChange={(e) => setSecretValue(e.target.value)}
                    />
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const v = await call('secret_set', {
                            instanceId: id,
                            name: secretName,
                            value: secretValue,
                          });
                          setSecretNames(v.secretNames);
                          setSecretValue('');
                        })
                      }
                    >
                      保存凭据
                    </button>
                  </section>
                )}
                {tab === 'runs' && (
                  <section>
                    {!runs.length && <p>还没有运行记录</p>}
                    {runs.map((r) => (
                      <article key={r.id}>
                        <strong>
                          {r.action} · {r.state}
                        </strong>
                        <small>{new Date(r.startedAt).toLocaleString()}</small>
                        {r.error && <p>{r.error}</p>}
                        {r.progress && <p>{r.progress}</p>}
                        <RunDetails run={r} workspaceId={workspaceId} instanceId={id} />
                        <MicroRunActions
                          run={r}
                          call={call}
                          perform={(fn) => void perform(fn)}
                          busy={busy}
                        />
                        {['queued', 'starting', 'running'].includes(r.state) && (
                          <button
                            onClick={() =>
                              void perform(() => call('cancel', { instanceId: id, runId: r.id }))
                            }
                          >
                            {r.state === 'queued' ? '取消排队' : '停止执行并清空队列'}
                          </button>
                        )}
                        {(r.outputs || []).map((o: any) => (
                          <div key={o.path}>
                            {o.name}
                            <button
                              disabled={busy}
                              onClick={() =>
                                void perform(() =>
                                  call('outputs_import', {
                                    instanceId: id,
                                    runId: r.id,
                                    path: o.path,
                                  }),
                                )
                              }
                            >
                              放到画布 / 更新原对象
                            </button>
                          </div>
                        ))}
                      </article>
                    ))}
                  </section>
                )}
                {tab === 'schedules' && (
                  <section>
                    <p>
                      按当前“动作”页选中的动作和输入创建。失败暂停，错过的时间点合并成一次；退出后是否运行由首次授权决定。
                    </p>
                    <input
                      aria-label="间隔秒数"
                      type="number"
                      min="60"
                      value={interval}
                      onChange={(e) => setIntervalValue(e.target.value)}
                    />
                    <button
                      disabled={busy || !action}
                      onClick={() =>
                        void perform(async () => {
                          await call('schedules_update', {
                            instanceId: id,
                            action,
                            input: JSON.parse(input),
                            intervalSeconds: Number(interval),
                            enabled: true,
                          });
                          setSchedules(await call('schedules_list', { instanceId: id }));
                        })
                      }
                    >
                      每 {interval} 秒运行 {action || '所选动作'}
                    </button>
                    {schedules.map((s) => (
                      <article key={s.id}>
                        {s.action} · {s.enabled ? '启用' : '暂停'}
                        {s.error && <p>{s.error}</p>}
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              await call('schedules_update', {
                                instanceId: id,
                                scheduleId: s.id,
                                action: s.action,
                                input: s.input,
                                intervalSeconds: s.intervalSeconds,
                                enabled: !s.enabled,
                              });
                              setSchedules(await call('schedules_list', { instanceId: id }));
                            })
                          }
                        >
                          {s.enabled ? '暂停' : '启用'}
                        </button>
                      </article>
                    ))}
                  </section>
                )}
                {tab === 'logs' && <pre>{logs || '暂无日志'}</pre>}
                {tab === 'evolve' && selected.runtime === 'micro' && (
                  <MicroEvolution
                    key={'evolve:' + id}
                    workspaceId={workspaceId}
                    instance={selected}
                    onChanged={(next) => {
                      void reload().then(() => {
                        if (next) {
                          setId(next);
                          setManaging(false);
                        } else setPageAttempt((n) => n + 1);
                      });
                    }}
                  />
                )}
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}

export function LightAppCard({ text }: { text: string }) {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    return <p>应用入口无效</p>;
  }
  return (
    <div className="light-app-card">
      <span>◇</span>
      <strong>{value.name || '轻应用'}</strong>
      <small>按需打开 · 后台独立运行</small>
      <button
        className="nodrag nopan"
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent('yirang:open-apps', {
              detail: { instanceId: value.instanceId, workspaceId: value.workspaceId },
            }),
          );
        }}
      >
        打开应用
      </button>
    </div>
  );
}

const RunDetails = React.memo(function RunDetails({
  run,
  workspaceId,
  instanceId,
}: {
  run: any;
  workspaceId: string;
  instanceId: string;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    setText('正在读取…');
    void browserCommand<any>('light-apps', {
      workspaceId,
      operation: 'runs_get',
      payload: { instanceId, runId: run.id },
    })
      .then((items) => {
        if (active) {
          const value = items[0];
          const formatted = JSON.stringify(value?.result ?? value?.input ?? {}, null, 2);
          setText(
            formatted.length > 32000
              ? formatted.slice(0, 32000) + '\n…仅展示前 32000 字符'
              : formatted,
          );
        }
      })
      .catch((e) => {
        if (active) setText(String(e));
      });
    return () => {
      active = false;
    };
  }, [open, run.id, run.state, workspaceId, instanceId]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>结果</summary>
      {open && <pre>{text}</pre>}
    </details>
  );
});
