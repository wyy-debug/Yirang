import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useWorkspaceRefresh, retainEqual } from '../workspace/workspace-refresh.js';
import React, { useEffect, useRef, useState } from 'react';
import type { Code, DesktopObject, MaterialRange } from '../../../packages/contracts/index.js';
import type { LocalRunRecord } from '../../../packages/local-runtime/work/local-runs.js';
import { localCodeRuntime } from '../../../packages/components/native-files.js';

export type RunSelection = { objects: DesktopObject[]; ranges: Record<string, MaterialRange> };
type RecordView = LocalRunRecord & {
  paths: { inputDirectory: string; outputDirectory: string; entrypoint: string };
  nextAction?: string;
};
type Grant = {
  snapshotId: string;
  codeTitle: string;
  status: string;
  expires: number;
  runId?: string;
  recoveryOnly?: boolean;
};
const status = (run: RecordView) =>
  run.report
    ? `${{ succeeded: uiText('执行成功'), failed: uiText('执行失败'), cancelled: uiText('已取消') }[run.report.status]} · ${run.returnedAt ? uiText('结果已回桌面') : run.collectionIssues?.length ? uiText('部分结果待处理') : uiText('等待收回结果')}`
    : run.progress?.phase === 'unavailable'
      ? uiText('执行状态未知 · 可收回已有文件')
      : run.progress
        ? uiText('最近回报：{0}', {
            '0': run.progress.phase === 'running' ? uiText('执行中') : uiText('等待中'),
          })
        : uiText('已准备材料 · 等待执行回报');

export function LocalRunsView({
  selection,
  action,
  close,
  updated,
  locate,
  authorize,
  recover,
  canAttach,
  workspaceId,
}: {
  selection: RunSelection;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  close: () => void;
  updated: () => Promise<void>;
  locate: (id: string) => void;
  authorize: (codeObjectId: string) => Promise<boolean>;
  recover: (runId: string) => Promise<boolean>;
  canAttach: boolean;
  workspaceId: string;
}) {
  useUiLocale();
  const cursor = useWorkspaceRefresh(workspaceId, 'runs');
  const codes = selection.objects.filter(
    (object) => localCodeRuntime(object) && !selection.ranges[object.id],
  );
  const [codeId, setCodeId] = useState(codes[0]?.id ?? ''),
    [items, setItems] = useState<RecordView[]>([]),
    [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [chosen, setChosen] = useState<string | null>(null),
    working = useRef(false),
    seenCursor = useRef(cursor);
  const [pendingOnly, setPendingOnly] = useState(false);
  function receive(records: RecordView[], permissions: Grant[]) {
    setItems((previous) => retainEqual(previous, records));
    setGrants((previous) => retainEqual(previous, permissions));
    setChosen((id) => (records.some((item) => item.id === id) ? id : (records[0]?.id ?? null)));
  }
  useEffect(() => {
    let disposed = false;
    Promise.all([action('local_runs'), action('local_run_grants')])
      .then(([records, permissions]) => {
        if (!disposed) receive(records, permissions);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (cursor === seenCursor.current || busy || loading || working.current) return;
    let disposed = false;
    Promise.all([action('local_runs'), action('local_run_grants')])
      .then(([records, permissions]) => {
        if (!disposed) {
          receive(records, permissions);
          seenCursor.current = cursor;
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [cursor, busy, loading]);
  async function perform(fn: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    const [records, permissions] = await Promise.all([
      action('local_runs'),
      action('local_run_grants'),
    ]);
    receive(records, permissions);
  }
  const current = items.find((item) => item.id === chosen),
    logs = current?.report ?? current?.progress;
  const visibleItems = pendingOnly ? items.filter((item) => !item.returnedAt) : items,
    pendingCount = items.filter((item) => !item.returnedAt).length;
  return (
    <section className="local-runs-view" role="dialog" aria-label={uiText('本地运行与结果')}>
      <header className="section-header">
        <button disabled={busy} onClick={close}>
          {uiText('返回桌面')}
        </button>
        <div>
          <strong>{uiText('本地运行与结果')}</strong>
          <small>{uiText('由 Codex 原对话执行')}</small>
        </div>
        <button disabled={busy || loading} onClick={() => void perform(refresh)}>
          {uiText('刷新记录')}
        </button>
      </header>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <div className="local-run-content">
        {selection.objects.length > 0 && (
          <section className="local-run-selection">
            <h2>{uiText('交给 Codex 本地运行')}</h2>
            <p>
              {uiText(
                '选中的代码与材料会保存为本地文件。你在原消息框提出要求，Codex 使用现有执行工具运行，再把日志和生成文件放回桌面。',
              )}
            </p>
            <ul>
              {selection.objects.map((object) => (
                <li key={object.id}>
                  {object.title}
                  {selection.ranges[object.id] ? uiText(' · 局部范围') : ''}
                  {object.policy?.private ? uiText(' · 个人可见，不能交给 Codex') : ''}
                </li>
              ))}
            </ul>
            <div className="runtime-actions">
              <label>
                {uiText('入口代码')}
                <select value={codeId} disabled={busy} onChange={(e) => setCodeId(e.target.value)}>
                  {!codes.length && (
                    <option value="">{uiText('请选择完整的 Python 或 JavaScript 代码')}</option>
                  )}
                  {codes.map((object) => (
                    <option key={object.id} value={object.id}>
                      {object.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={
                  busy ||
                  loading ||
                  !canAttach ||
                  !codeId ||
                  selection.objects.some((object) => object.policy?.private)
                }
                onClick={() =>
                  void perform(async () => {
                    if (!(await authorize(codeId)))
                      throw new Error(uiText('材料尚未附加，请查看桌面提示和原消息框。'));
                  })
                }
              >
                {uiText('交给 Codex 本地运行')}
              </button>
            </div>
            <small>
              {uiText(
                '代码在本机执行，沿用 Codex 权限与审批。此按钮只引用材料，不自动发送消息或运行代码。',
              )}
            </small>
            {!canAttach && <p>{uiText('请在 Codex 原生工作桌面中使用原对话引用。')}</p>}
          </section>
        )}
        {!selection.objects.length && (
          <p className="runtime-note">
            {uiText('选中代码和输入材料，点击“运行代码”，然后在 Codex 原消息框提出要求。')}
          </p>
        )}
        {grants.some((grant) => grant.status === 'active') && (
          <section className="local-run-selection">
            <h2>{uiText('已交给原对话的材料')}</h2>
            {grants
              .filter((grant) => grant.status === 'active')
              .map((grant) => (
                <div className="local-output" key={grant.snapshotId}>
                  <span>
                    {grant.codeTitle} ·{' '}
                    {grant.recoveryOnly
                      ? uiText('恢复回收授权')
                      : grant.runId
                        ? uiText('本地文件已准备')
                        : uiText('等待原对话准备文件')}{' '}
                    · {new Date(grant.expires).toLocaleTimeString(interfaceLocale())}{' '}
                    {uiText('到期')}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await action('cancel', { snapshotId: grant.snapshotId });
                        await refresh();
                      })
                    }
                  >
                    {uiText('撤销后续访问')}
                  </button>
                </div>
              ))}
            <small>
              {uiText(
                '撤销停止插件后续读写；已导出的本地文件保留。停止正在执行的代码请回到原对话。',
              )}
            </small>
          </section>
        )}
        <div className="local-run-filter">
          <button disabled={busy} aria-pressed={!pendingOnly} onClick={() => setPendingOnly(false)}>
            {uiText('全部')}
            {items.length}
          </button>
          <button
            disabled={busy}
            aria-pressed={pendingOnly}
            onClick={() => {
              setPendingOnly(true);
              setChosen((id) =>
                items.some((item) => item.id === id && !item.returnedAt)
                  ? id
                  : (items.find((item) => !item.returnedAt)?.id ?? null),
              );
            }}
          >
            {uiText('待回收')}
            {pendingCount}
          </button>
        </div>
        <div className="local-run-columns">
          <nav aria-label={uiText('运行列表')}>
            {loading ? (
              <p>{uiText('正在读取…')}</p>
            ) : !visibleItems.length ? (
              <p>{pendingOnly ? uiText('当前没有待回收记录。') : uiText('尚无本地运行记录。')}</p>
            ) : (
              visibleItems.map((item) => (
                <button
                  key={item.id}
                  disabled={busy}
                  className={item.id === chosen ? 'active' : ''}
                  onClick={() => setChosen(item.id)}
                >
                  <strong>
                    {item.inputs.find((input) => input.objectId === item.codeObjectId)?.title ??
                      uiText('代码任务')}
                  </strong>
                  <span>{status(item)}</span>
                  <small>{new Date(item.createdAt).toLocaleString(interfaceLocale())}</small>
                </button>
              ))
            )}
          </nav>
          <article className="local-run-detail">
            {current ? (
              <>
                <header>
                  <strong>{status(current)}</strong>
                  <small>{current.id}</small>
                </header>
                <ol className="local-run-steps" aria-label={uiText('执行与回流阶段')}>
                  <li className="done">
                    <strong>{uiText('1 · 材料已准备')}</strong>
                    <small>
                      {new Date(current.createdAt).toLocaleTimeString(interfaceLocale())}
                    </small>
                  </li>
                  <li
                    className={
                      current.report
                        ? 'done'
                        : current.progress?.phase === 'unavailable'
                          ? 'attention'
                          : current.progress
                            ? 'ongoing'
                            : ''
                    }
                  >
                    <strong>
                      2 ·{' '}
                      {current.report
                        ? uiText('执行已回报')
                        : current.progress?.phase === 'unavailable'
                          ? uiText('执行状态未知')
                          : current.progress
                            ? uiText('进度已回报')
                            : uiText('等待执行回报')}
                    </strong>
                    <small>{uiText('来源：Codex 原对话')}</small>
                  </li>
                  <li
                    className={
                      current.returnedAt
                        ? 'done'
                        : current.collectionIssues?.length
                          ? 'attention'
                          : ''
                    }
                  >
                    <strong>
                      3 ·{' '}
                      {current.returnedAt
                        ? uiText('结果已收回')
                        : current.collectionIssues?.length
                          ? uiText('回收待处理')
                          : uiText('等待收回')}
                    </strong>
                    <small>
                      {current.outputs?.filter((output) => output.importedObjectId).length ?? 0}{' '}
                      {uiText('个文件已到桌面')}
                    </small>
                  </li>
                </ol>
                <p>
                  {uiText('输入：')}
                  {current.inputs
                    .map((input) => `${input.title} v${input.revision} → ${input.name}`)
                    .join('；')}
                </p>
                <div className="runtime-actions">
                  {!current.returnedAt && (
                    <button
                      className="primary"
                      disabled={busy || !canAttach}
                      onClick={() =>
                        void perform(async () => {
                          if (!(await recover(current.id)))
                            throw new Error(
                              uiText('恢复材料尚未确认附加，请查看桌面提示和原消息框。'),
                            );
                        })
                      }
                    >
                      {uiText('交给原对话继续回收')}
                    </button>
                  )}
                  {!current.returnedAt && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const record = await action('local_run_collect', { id: current.id });
                          setItems((items) =>
                            items.map((item) => (item.id === record.id ? record : item)),
                          );
                          await updated();
                        })
                      }
                    >
                      {current.collectionIssues?.length
                        ? uiText('重试收回结果')
                        : current.report
                          ? uiText('将结果收回桌面')
                          : uiText('收回已有文件')}
                    </button>
                  )}
                  {current.reportObjectId && (
                    <button disabled={busy} onClick={() => locate(current.reportObjectId!)}>
                      {uiText('查看结果卡片')}
                    </button>
                  )}
                </div>
                {current.nextAction && <p className="runtime-note">{current.nextAction}</p>}
                {!current.returnedAt && (
                  <details className="local-run-recovery">
                    <summary>{uiText('原对话中断后如何继续')}</summary>
                    <p>
                      {uiText(
                        '点击“交给原对话继续回收”，然后在原消息框输入“继续收回这次结果”。即使旧授权已过期，也会为这条记录建立新的回收授权。',
                      )}
                    </p>
                    <p>
                      {current.report
                        ? uiText('最终执行回报已保存，接下来只需处理产物回收。')
                        : current.progress?.executionRef
                          ? uiText(
                              '已保存原执行引用：{0}。Codex 会先尝试从这个会话继续等待和读取结果。',
                              { '0': current.progress.executionRef },
                            )
                          : uiText(
                              '尚未保存执行引用。Codex 需要先查看原对话中的执行记录，确认实际状态。',
                            )}
                    </p>
                    <p>
                      {uiText(
                        '如果执行会话或日志已经丢失，可以直接收回已有文件；文件存在不能证明执行成功。恢复按钮不重新运行代码，也不会自动发送消息。',
                      )}
                    </p>
                  </details>
                )}
                {!!current.collectionIssues?.length && (
                  <section className="local-run-issues" aria-label={uiText('回收待处理事项')}>
                    <h3>{uiText('这些结果还需处理')}</h3>
                    <p>
                      {uiText(
                        '已回到桌面的文件和日志卡片保留。处理以下事项后重试收取，无需重新执行代码。',
                      )}
                    </p>
                    <ul>
                      {current.collectionIssues.map((issue, index) => (
                        <li key={`${issue.stage}:${issue.fileName ?? ''}:${index}`}>
                          <strong>
                            {issue.fileName ??
                              (issue.stage === 'report' ? uiText('结果卡片') : uiText('输出目录'))}
                          </strong>
                          <span>{issue.message}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {!current.report && (
                  <p>
                    {current.progress
                      ? uiText(
                          '上次进度回报：{0}。这不是实时进程监控，请在原对话继续等待或停止。',
                          { '0': new Date(current.progressAt!).toLocaleString(interfaceLocale()) },
                        )
                      : uiText(
                          '尚未收到 Codex 的执行回报。请先在原对话确认执行状态，避免重复运行。',
                        )}
                  </p>
                )}
                {logs && (
                  <>
                    <p>{logs.summary}</p>
                    <small>
                      {current.report
                        ? uiText('退出码：{0} · ', {
                            '0': current.report.exitCode ?? uiText('未提供'),
                          })
                        : uiText('阶段日志 · ')}
                      {uiText('来源：Codex 回报')}
                      {(logs.executionRef ?? current.progress?.executionRef)
                        ? ` · ${logs.executionRef ?? current.progress?.executionRef}`
                        : ''}
                    </small>
                    <h3>{uiText('标准输出')}</h3>
                    <pre>{logs.stdout || uiText('暂无输出')}</pre>
                    <h3>{uiText('错误输出')}</h3>
                    <pre>{logs.stderr || uiText('暂无错误输出')}</pre>
                    {logs.logsTruncated && <small>{uiText('Codex 回报的日志已截断。')}</small>}
                  </>
                )}
                <h3>
                  {uiText('产物 ·')}
                  {current.outputs?.filter((output) => output.importedObjectId).length ?? 0}{' '}
                  {uiText('个已回到桌面')}
                </h3>
                {current.outputs?.map((output) => (
                  <div className="local-output" key={output.name}>
                    <span>
                      {output.name} · {output.bytes} {uiText('字节')}
                    </span>
                    {output.importedObjectId ? (
                      <button disabled={busy} onClick={() => locate(output.importedObjectId!)}>
                        {uiText('在桌面查看')}
                      </button>
                    ) : (
                      <small>{uiText('等待导入，点击收回结果继续')}</small>
                    )}
                  </div>
                ))}
                {!current.outputs?.length && (
                  <p>
                    {current.collectedAt
                      ? uiText('收取时没有输出文件。')
                      : uiText('尚未收取输出文件。')}
                  </p>
                )}
                <details>
                  <summary>{uiText('本地文件位置')}</summary>
                  <p>
                    {uiText('输入：')}
                    <code>{current.paths.inputDirectory}</code>
                  </p>
                  <p>
                    {uiText('输出：')}
                    <code>{current.paths.outputDirectory}</code>
                  </p>
                </details>
              </>
            ) : (
              <p>{uiText('选择一条记录，查看输入、执行回报和产物。')}</p>
            )}
          </article>
        </div>
        <p className="runtime-note">
          {uiText(
            '插件不管理本地进程。原对话中断后可在这里收回已有文件；导入桌面的结果随文档备份保存。',
          )}
        </p>
      </div>
    </section>
  );
}
