import React, { useCallback, useEffect, useState } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';

const verdictText: Record<string, string> = { pass: '通过', fail: '不通过', undecided: '无法判定' };
export function useMicroSuggestions(workspaceId: string) {
  const [data, setData] = useState<{ suggestions: any[]; drafts: any[] }>({
    suggestions: [],
    drafts: [],
  });
  const load = useCallback(async () => {
    try {
      setData(
        await browserCommand<any>(
          'light-apps',
          { workspaceId, operation: 'crystal_list', payload: {} },
          30000,
        ),
      );
    } catch {}
  }, [workspaceId]);
  useEffect(() => {
    void load();
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.type === 'micro-crystal-suggestion') void load();
    };
    window.addEventListener('yirang:app-version-changed', changed);
    return () => window.removeEventListener('yirang:app-version-changed', changed);
  }, [load]);
  return {
    ...data,
    pending:
      data.suggestions.filter((s) => s.status === 'suggested').length +
      data.drafts.filter((d) => d.status === 'draft').length,
    load,
  };
}

export function MicroSuggestions({
  workspaceId,
  onPublished,
}: {
  workspaceId: string;
  onPublished: (instanceId: string) => void;
}) {
  const { suggestions, drafts, load } = useMicroSuggestions(workspaceId);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const run = async (key: string, operation: string, payload: any, after?: (v: any) => void) => {
    setBusy(key);
    setError('');
    try {
      const v = await browserCommand<any>(
        'light-apps',
        { workspaceId, operation, payload },
        900000,
      );
      after?.(v);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };
  const open = suggestions.filter((s) => s.status === 'suggested'),
    active = drafts.filter((d) => d.status === 'draft');
  return (
    <section className="micro-suggestions">
      <h3>从重复工作生成微应用</h3>
      {error && (
        <p role="alert" className="light-apps-error">
          {error}
        </p>
      )}
      {!open.length && !active.length && (
        <p className="app-library-hint">
          暂时没有建议。同一桌面有 3 项以上同类且已验收的工作时，这里会出现一次建议。
        </p>
      )}
      {open.map((s) => (
        <article key={s.id}>
          <strong>{s.label}</strong>
          <p>
            {s.workIds.length} 项同类工作 · 相似度 {Math.round(s.similarity * 100)}%
          </p>
          <small>{s.reason}</small>
          <div>
            <button
              className="primary"
              disabled={!!busy}
              onClick={() => void run(s.id, 'crystal_accept', { id: s.id })}
            >
              {busy === s.id ? '正在生成草稿…' : '生成微应用草稿'}
            </button>
            <button
              disabled={!!busy}
              onClick={() => void run(s.id + ':no', 'crystal_decline', { id: s.id })}
            >
              不用（30 天内不再提示同类）
            </button>
          </div>
        </article>
      ))}
      {active.map((d) => (
        <DraftReview key={d.id} draft={d} busy={busy} run={run} onPublished={onPublished} />
      ))}
    </section>
  );
}

function DraftReview({
  draft,
  busy,
  run,
  onPublished,
}: {
  draft: any;
  busy: string;
  run: (k: string, op: string, p: any, after?: (v: any) => void) => Promise<void>;
  onPublished: (id: string) => void;
}) {
  const s = draft.regression?.summary;
  return (
    <article className="micro-draft">
      <strong>草稿：{draft.name || draft.appId}</strong>
      <small>{draft.root}</small>
      {draft.fallback && (
        <p>历史成果没有稳定的共同结构，输出暂用单个“结果”文本字段，可在草稿目录中修改。</p>
      )}
      {!!draft.skipped?.length && (
        <details>
          <summary>{draft.skipped.length} 项工作未作为样例</summary>
          <ul>
            {draft.skipped.map((x: any) => (
              <li key={x.workId}>
                {x.workId}：{x.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {s ? (
        <div className="micro-regression">
          <p>
            首次回归：通过 {s.passed} · 不通过 {s.failed} · 无法判定 {s.undecided} · 不可用{' '}
            {s.unavailable}
          </p>
          {!s.qualityConclusion && <p>可判定的样例不足 3 个，只提供逐条对比，不给质量结论。</p>}
          <table>
            <thead>
              <tr>
                <th>样例</th>
                <th>结论</th>
                <th>字段</th>
                <th>对比</th>
              </tr>
            </thead>
            <tbody>
              {draft.regression.results.map((r: any) => (
                <tr key={r.exampleId}>
                  <td>{r.workId}</td>
                  <td>{r.available === false ? '不可用' : verdictText[r.verdict] || r.verdict}</td>
                  <td>
                    {r.reason ||
                      r.error ||
                      Object.entries(r.fields || {})
                        .map(([k, v]) => `${k}:${verdictText[v as string] || v}`)
                        .join('，')}
                  </td>
                  <td>
                    {r.available !== false && (
                      <details>
                        <summary>查看</summary>
                        <pre>
                          {'期望：' +
                            JSON.stringify(r.expected, null, 2) +
                            '\n\n本次：' +
                            JSON.stringify(r.actual ?? null, null, 2)}
                        </pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>尚未回归。</p>
      )}
      {!!draft.anchors?.length && (
        <details>
          <summary>提示词中来自历史要求的片段（{draft.anchors.length}）</summary>
          <ul>
            {draft.anchors.map((a: any, i: number) => (
              <li key={i}>{a.quote}</li>
            ))}
          </ul>
        </details>
      )}
      <div>
        <button
          disabled={!!busy}
          onClick={() => void run('r:' + draft.id, 'crystal_regress', { id: draft.id })}
        >
          {busy === 'r:' + draft.id ? '正在回归…' : '重新回归'}
        </button>
        <button
          className="primary"
          disabled={!!busy}
          onClick={() =>
            void run('p:' + draft.id, 'crystal_publish', { id: draft.id }, (v) =>
              onPublished(v.instanceId),
            )
          }
        >
          确认并发布
        </button>
      </div>
    </article>
  );
}

export function MicroRunActions({
  run,
  call,
  perform,
  busy,
}: {
  run: any;
  call: (op: string, p: any) => Promise<any>;
  perform: (fn: () => Promise<unknown>) => void;
  busy: boolean;
}) {
  if (run.kind !== 'micro') return null;
  const instanceId = run.instanceId,
    runId = run.id;
  return (
    <div className="micro-run-actions">
      {run.state === 'verifying' && <small>正在确认上次运行是否结束</small>}
      {['verifying', 'unknown'].includes(run.state) && (
        <button
          disabled={busy}
          onClick={() => perform(() => call('micro_abandon', { instanceId, runId }))}
        >
          放弃这次运行
        </button>
      )}
      {run.state === 'finalizing' && (
        <>
          <button
            disabled={busy}
            onClick={() => perform(() => call('micro_outputs_retry', { instanceId, runId }))}
          >
            重试文件生成
          </button>
          <button
            disabled={busy}
            onClick={() => perform(() => call('micro_outputs_drop', { instanceId, runId }))}
          >
            放弃文件，仅保留结构化结果
          </button>
        </>
      )}
      {run.state === 'completed' && (
        <>
          <button
            disabled={busy}
            onClick={() =>
              perform(() => call('micro_outputs_retry', { instanceId, runId, regenerate: true }))
            }
          >
            按原结果重新生成文件
          </button>
          <button
            disabled={busy}
            onClick={() => perform(() => call('examples_propose', { instanceId, runId }))}
          >
            设为样例
          </button>
          <button
            disabled={busy}
            onClick={() => {
              const note = window.prompt('哪里不对？');
              if (note !== null)
                perform(() => call('feedback', { instanceId, runId, verdict: 'wrong', note }));
            }}
          >
            结果不对
          </button>
        </>
      )}
      {!!run.diagnostics?.some((d: any) => d.type === 'conflict') && (
        <small>原文件曾被修改，已另存</small>
      )}
      {!!run.missingOutputs?.length && <small>缺少产出：{run.missingOutputs.length} 个</small>}
    </div>
  );
}

const stateText: Record<string, string> = {
  draft: '待回归',
  proposed: '有改进可用',
  held: '未达到提议条件',
  published: '已发布',
  'rolled-back': '已回退',
  discarded: '已放弃',
  failed: '生成失败',
};
const signalText: Record<string, string> = {
  feedback: '标记不对',
  edit: '修改结果',
  'repeat-note': '重复补充说明',
  failure: '运行失败',
};
export function MicroEvolution({
  workspaceId,
  instance,
  onChanged,
}: {
  workspaceId: string;
  instance: any;
  onChanged: (instanceId?: string) => void;
}) {
  const instanceId = instance.id;
  const [data, setData] = useState<{ improvements: any[]; signals: any[] }>({
      improvements: [],
      signals: [],
    }),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [plan, setPlan] = useState<any>(null),
    [note, setNote] = useState('');
  const [anchors, setAnchors] = useState<Record<number, { action: string; text?: string }>>({}),
    [examples, setExamples] = useState<string[]>([]),
    [materials, setMaterials] = useState<string[]>([]),
    [materialsConfirmed, setMaterialsConfirmed] = useState(false);
  const call = (operation: string, payload: any = {}) =>
    browserCommand<any>('light-apps', { workspaceId, operation, payload }, 900000);
  const load = useCallback(async () => {
    try {
      setData(await call('evolution_list', { instanceId }));
    } catch (e) {
      setError(String(e));
    }
  }, [workspaceId, instanceId]);
  useEffect(() => {
    void load();
    setPlan(null);
    setNote('');
  }, [load]);
  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };
  const version = instance.manifest?.version,
    current = data.signals.filter((s) => s.appVersion === version),
    autoPropose =
      instance.manifest?.evolution?.autoPropose !== false && instance.autoPropose !== false;
  const toggle = (list: string[], key: string, on: boolean) =>
    on ? [...list, key] : list.filter((x) => x !== key);
  return (
    <section className="micro-suggestions micro-evolution">
      {error && (
        <p role="alert" className="light-apps-error">
          {error}
        </p>
      )}
      {note && <p>{note}</p>}
      <h3>自动改进</h3>
      <p>
        当前版本 {version || '未标注'} · 信号 {current.length} 条（
        {Object.entries(
          current.reduce((m: any, s: any) => ({ ...m, [s.type]: (m[s.type] || 0) + 1 }), {}),
        )
          .map(([k, n]) => `${signalText[k] || k} ${n}`)
          .join('，') || '暂无'}
        ）。累积 5 条使用信号或 3 次同类失败后，系统会生成一个改进草稿并回归；发布始终由你确认。
      </p>
      <label>
        <input
          type="checkbox"
          checked={autoPropose}
          disabled={!!busy || instance.manifest?.evolution?.autoPropose === false}
          onChange={(e) =>
            void act('settings', async () => {
              await call('evolution_settings', { instanceId, autoPropose: e.target.checked });
              onChanged();
            })
          }
        />{' '}
        自动提出改进{instance.manifest?.evolution?.autoPropose === false && '（应用声明已关闭）'}
      </label>
      <div>
        <button disabled={!!busy} onClick={() => void act('check', () => call('evolution_check'))}>
          {busy === 'check' ? '正在检查…' : '立即检查'}
        </button>
      </div>
      {data.improvements.map((i) => {
        const c = i.regression?.comparison;
        return (
          <article key={i.id}>
            <strong>
              {i.version || i.baseVersion} · {stateText[i.state] || i.state}
            </strong>
            <small>
              {new Date(i.createdAt).toLocaleString()} · {i.reason}
            </small>
            {i.error && <p>{i.error}</p>}
            {i.rationale && <p>{i.rationale}</p>}
            {c && (
              <p>
                回归：{c.reason}（新版本 通过 {c.new.passed} / 不通过 {c.new.failed} / 无法判定{' '}
                {c.new.undecided}；旧版本 通过 {c.old.passed}）
              </p>
            )}
            {i.diff && (
              <details>
                <summary>查看修改（{i.changes.join('、')}）</summary>
                <pre>
                  {'原提示词：\n' +
                    i.diff.prompt.before +
                    '\n\n新提示词：\n' +
                    i.diff.prompt.after +
                    (i.diff.outputSchema
                      ? '\n\n输出结构：\n' + JSON.stringify(i.diff.outputSchema.after, null, 2)
                      : '') +
                    (i.diff.outputs
                      ? '\n\n产出映射：\n' + JSON.stringify(i.diff.outputs.after, null, 2)
                      : '')}
                </pre>
              </details>
            )}
            {i.regression && (
              <details>
                <summary>样例对比</summary>
                <table>
                  <thead>
                    <tr>
                      <th>样例</th>
                      <th>来源</th>
                      <th>新版本</th>
                      <th>旧版本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {i.regression.results.map((r: any, n: number) => (
                      <tr key={r.exampleId}>
                        <td>{r.workId || r.exampleId.slice(0, 8)}</td>
                        <td>{r.source}</td>
                        <td>
                          {r.available === false
                            ? '不可用'
                            : (verdictText[r.verdict] || r.verdict) +
                              (r.error ? '：' + r.error : '')}
                        </td>
                        <td>
                          {i.regression.baseline[n]?.baselineUnavailable
                            ? '无法补跑'
                            : verdictText[i.regression.baseline[n]?.verdict] || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
            <div>
              {i.state === 'draft' && (
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void act('r:' + i.id, () => call('evolution_regress', { id: i.id }))
                  }
                >
                  {busy === 'r:' + i.id ? '正在回归…' : '回归'}
                </button>
              )}
              {['proposed', 'held'].includes(i.state) && (
                <button
                  className={i.state === 'proposed' ? 'primary' : ''}
                  disabled={!!busy}
                  onClick={() =>
                    void act('p:' + i.id, async () => {
                      await call('evolution_publish', { instanceId, id: i.id });
                      onChanged();
                    })
                  }
                >
                  {i.state === 'proposed' ? '查看并发布' : '人工确认发布'}
                </button>
              )}
              {['draft', 'proposed', 'held'].includes(i.state) && (
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void act('d:' + i.id, () => call('evolution_discard', { id: i.id }))
                  }
                >
                  放弃
                </button>
              )}
              {i.state === 'published' && (
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void act('b:' + i.id, async () => {
                      await call('evolution_rollback', { id: i.id });
                      onChanged();
                    })
                  }
                >
                  回退到上一版本
                </button>
              )}
            </div>
          </article>
        );
      })}
      <h3>分享与升级</h3>
      <div>
        <button
          disabled={!!busy}
          onClick={() =>
            void act('plan', async () => {
              const v = await call('micro_export_plan', { instanceId });
              setPlan(v);
              setAnchors({});
              setExamples([]);
              setMaterials([]);
              setMaterialsConfirmed(false);
            })
          }
        >
          导出微应用…
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            void act('up', async () => {
              const v = await call('micro_upgrade', { instanceId });
              setNote('已生成轻应用草稿：' + v.path);
              onChanged(v.id);
            })
          }
        >
          升级为轻应用
        </button>
      </div>
      {plan && (
        <article>
          <strong>导出清单</strong>
          <p>默认导出：{plan.files.join('、')}</p>
          {!!plan.excluded.length && (
            <p>
              不导出：{plan.excluded.map((x: any) => x.path + '（' + x.reason + '）').join('、')}
            </p>
          )}
          {!!plan.stripped.length && <p>已去除结晶来源信息（工作 ID、历史要求摘录）。</p>}
          {!!plan.anchors.length && (
            <>
              <p>
                将导出的内容里有 {plan.anchors.length}{' '}
                处可能敏感（历史工作原文、真实样例或材料的片段、邮箱、电话、证件号、密钥、本机路径），逐条确认保留或替换后才能导出。系统不能识别所有敏感内容。
              </p>
              {plan.anchors.map((a: any) => (
                <div key={a.index}>
                  <small>{(a.label || '来自历史工作的原文') + '：' + a.files.join('、')}</small>
                  <pre>{a.quote}</pre>
                  <label>
                    <input
                      type="radio"
                      name={'a' + a.index}
                      checked={anchors[a.index]?.action === 'keep'}
                      onChange={() => setAnchors({ ...anchors, [a.index]: { action: 'keep' } })}
                    />
                    保留
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={'a' + a.index}
                      checked={anchors[a.index]?.action === 'replace'}
                      onChange={() =>
                        setAnchors({ ...anchors, [a.index]: { action: 'replace', text: '' } })
                      }
                    />
                    替换为
                  </label>
                  {anchors[a.index]?.action === 'replace' && (
                    <input
                      aria-label="替换文本"
                      value={anchors[a.index].text || ''}
                      onChange={(e) =>
                        setAnchors({
                          ...anchors,
                          [a.index]: { action: 'replace', text: e.target.value },
                        })
                      }
                    />
                  )}
                </div>
              ))}
            </>
          )}
          {!!plan.examples.length && (
            <>
              <p>真实样例默认不导出。勾选前请查看将导出的完整内容：</p>
              {plan.examples.map((e: any) => (
                <div key={e.key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={examples.includes(e.key)}
                      onChange={(x) => {
                        setExamples(toggle(examples, e.key, x.target.checked));
                        if (!x.target.checked) setMaterials(toggle(materials, e.key, false));
                      }}
                    />
                    {e.source} 样例
                  </label>
                  <details>
                    <summary>查看</summary>
                    <pre>
                      {'输入：' +
                        JSON.stringify(e.input, null, 2) +
                        '\n\n输出：' +
                        JSON.stringify(e.output, null, 2) +
                        '\n\n材料：' +
                        (e.materials.map((m: any) => m.title).join('、') || '无')}
                    </pre>
                  </details>
                  {examples.includes(e.key) && !!e.materials.length && (
                    <label>
                      <input
                        type="checkbox"
                        checked={materials.includes(e.key)}
                        onChange={(x) => setMaterials(toggle(materials, e.key, x.target.checked))}
                      />
                      同时附带材料原文
                    </label>
                  )}
                </div>
              ))}
              {!!materials.length && (
                <label>
                  <input
                    type="checkbox"
                    checked={materialsConfirmed}
                    onChange={(e) => setMaterialsConfirmed(e.target.checked)}
                  />
                  我确认导出这些材料的原文
                </label>
              )}
            </>
          )}
          <div>
            <button
              className="primary"
              disabled={
                !!busy ||
                plan.anchors.some((a: any) => !anchors[a.index]) ||
                (!!materials.length && !materialsConfirmed)
              }
              onClick={() =>
                void act('export', async () => {
                  const v = await call('micro_export', {
                    instanceId,
                    decisions: {
                      digest: plan.digest,
                      anchors,
                      examples,
                      materials,
                      materialsConfirmed,
                    },
                  });
                  setPlan(null);
                  setNote(
                    '已导出：' + v.path + '（' + v.manifest.length + ' 个文件，清单已保存在本机）',
                  );
                })
              }
            >
              导出
            </button>
            <button onClick={() => setPlan(null)}>取消</button>
          </div>
        </article>
      )}
    </section>
  );
}

export function MicroTemplates({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: (instanceId: string) => void;
}) {
  const [items, setItems] = useState<any[]>([]),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    void browserCommand<any>('light-apps', {
      workspaceId,
      operation: 'micro_templates',
      payload: {},
    })
      .then(setItems)
      .catch((e) => setError(String(e)));
  }, [workspaceId]);
  return (
    <section className="micro-suggestions">
      <h3>从模板新建微应用</h3>
      {error && (
        <p role="alert" className="light-apps-error">
          {error}
        </p>
      )}
      {items.map((t) => (
        <article key={t.id}>
          <strong>{t.name}</strong>
          <small>{t.description}</small>
          <div>
            <button
              disabled={!!busy}
              onClick={() => {
                setBusy(t.id);
                setError('');
                void browserCommand<any>(
                  'light-apps',
                  {
                    workspaceId,
                    operation: 'micro_template_create',
                    payload: { templateId: t.id },
                  },
                  60000,
                )
                  .then((v) => onCreated(v.id))
                  .catch((e) => setError(String(e)))
                  .finally(() => setBusy(''));
              }}
            >
              {busy === t.id ? '正在创建…' : '用这个模板创建'}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
