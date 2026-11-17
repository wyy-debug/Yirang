import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { subscribeUiLanguage as onUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useTransientNotice } from '../ui/use-transient-notice.js';
import { useWorkspaceRefresh, retainEqual } from '../workspace/workspace-refresh.js';
import React, { useEffect, useRef, useState } from 'react';
import type { WorkTask, Workspace } from '../../../packages/contracts/index.js';
import { kindIcons } from '../../../packages/components/content.js';

let labels: Record<WorkTask['status'], string> = {
  queued: uiText('待开始'),
  working: uiText('处理中'),
  review: uiText('审阅中'),
  ready: uiText('待确认'),
  paused: uiText('已暂停'),
  completed: uiText('已完成'),
  waiting_input: uiText('等你补充'),
  waiting_permission: uiText('等待授权'),
  conflict: uiText('材料冲突'),
  failed: uiText('未能继续'),
  cancelled: uiText('已取消'),
};
const ended = (task: WorkTask) => ['completed', 'cancelled'].includes(task.status);
type Props = {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  close: () => void;
  openObject: (id: string) => void;
  saveProposal: (task: WorkTask) => Promise<void>;
};

/** A record viewer. Instructions and model responses remain in the native chat. */
export function TaskDesk({ workspace, action, close, openObject, saveProposal }: Props) {
  useUiLocale();
  const dataRevision = useWorkspaceRefresh(workspace.id, 'tasks');
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useTransientNotice();
  const [filter, setFilter] = useState<'all' | 'active' | 'completed' | 'attention'>('all');
  const alive = useRef(true);
  const fetchSequence = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      fetchSequence.current++;
    };
  }, []);
  async function reload() {
    const sequence = ++fetchSequence.current;
    try {
      const result: WorkTask[] = await action('task_list');
      if (!alive.current || sequence !== fetchSequence.current) return;
      setTasks((previous) => retainEqual(previous, result));
      setActive((current) =>
        result.some((task) => task.id === current) ? current : (result[0]?.id ?? null),
      );
    } catch (e) {
      if (alive.current && sequence === fetchSequence.current) setError(String(e));
    } finally {
      if (alive.current && sequence === fetchSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, [workspace.id, dataRevision]);
  const current = tasks.find((task) => task.id === active);
  const working = tasks.filter((task) => !!task.execution && !ended(task));
  const visible = tasks.filter(
    (task) =>
      filter === 'all' ||
      (filter === 'active'
        ? !!task.execution && !ended(task)
        : filter === 'attention'
          ? ['ready', 'waiting_input', 'waiting_permission', 'conflict', 'failed'].includes(
              task.status,
            )
          : ended(task)),
  );
  async function run(fn: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setPending(false);
    }
  }
  async function update(operation: string, extra: Record<string, unknown> = {}) {
    if (!current) return;
    await run(async () => {
      const updated: WorkTask = await action('task_update', {
        taskId: current.id,
        requestId: crypto.randomUUID(),
        expectedRevision: current.revision,
        operation,
        ...extra,
      });
      if (!alive.current) return;
      // A list request that began before this mutation cannot restore stale state.
      fetchSequence.current++;
      setTasks((items) =>
        updated.archived
          ? items.filter((task) => task.id !== updated.id)
          : items.map((task) => (task.id === updated.id ? updated : task)),
      );
      if (updated.archived) setActive(null);
    });
  }
  return (
    <section className="task-desk" role="dialog" aria-label={uiText('任务记录')}>
      <header className="task-header">
        <button onClick={close}>{uiText('返回桌面')}</button>
        <div>
          <strong>{uiText('任务记录')}</strong>
          <small>{uiText('要求与回复都在 Codex 原消息框')}</small>
        </div>
        <button disabled={pending} onClick={() => void reload()}>
          {uiText('刷新记录')}
        </button>
      </header>
      <div className="task-disclaimer">
        <span>◌</span>
        {uiText('这里查看任务状态和材料变化。开始工作、补充要求或反馈，请回到原对话。')}
      </div>
      {error && (
        <div className="banner error" role="alert">
          <span>{error}</span>
          <button disabled={pending} onClick={() => void reload()}>
            {uiText('重新载入')}
          </button>
          <button onClick={() => setError('')}>{uiText('关闭')}</button>
        </div>
      )}
      {notice && (
        <div className="banner notice" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice('')}>{uiText('关闭')}</button>
        </div>
      )}
      <div className="task-body">
        <aside className="task-list">
          <div className="task-list-summary">
            <strong>{working.length}</strong>
            <span>{uiText('进行中的任务')}</span>
          </div>
          <div className="task-filters">
            {(['all', 'active', 'attention', 'completed'] as const).map((value) => (
              <button
                key={value}
                className={filter === value ? 'active' : ''}
                onClick={() => setFilter(value)}
              >
                {value === 'all'
                  ? uiText('全部')
                  : value === 'active'
                    ? uiText('进行中')
                    : value === 'attention'
                      ? uiText('待处理')
                      : uiText('已结束')}
              </button>
            ))}
          </div>
          {loading ? (
            <p className="task-empty-small">{uiText('正在读取本地记录…')}</p>
          ) : visible.length === 0 ? (
            <p className="task-empty-small">{uiText('没有对应的任务记录。')}</p>
          ) : (
            visible.map((task) => (
              <button
                key={task.id}
                className={`task-list-item ${active === task.id ? 'chosen' : ''}`}
                onClick={() => {
                  setActive(task.id);
                  setNotice('');
                }}
              >
                <span className={`task-status status-${task.status}`}>{labels[task.status]}</span>
                <strong>{task.title}</strong>
                <small>
                  {task.execution ? uiText('对话任务') : uiText('历史演示')} · {task.sources.length}{' '}
                  {uiText('份材料 ·')}
                  {task.events.length} {uiText('条记录')}
                </small>
              </button>
            ))
          )}
        </aside>
        <div className="task-main">
          {current?.execution ? (
            <NativeTaskDetail
              task={current}
              workspace={workspace}
              pending={pending}
              update={update}
              openObject={openObject}
            />
          ) : current ? (
            <article className="task-detail">
              <span className="eyebrow">{uiText('历史演示记录')}</span>
              <h2>{current.title}</h2>
              <p className="task-goal">{current.goal}</p>
              <div className="native-task-route">
                <p>
                  {uiText(
                    '这是旧版的本地演示，未调用模型。记录与草稿仍保留；继续工作请在原消息框提出要求。',
                  )}
                </p>
              </div>
              {current.constraints && (
                <div className="task-rule">
                  <strong>{uiText('原约束')}</strong>
                  <p>{current.constraints}</p>
                </div>
              )}
              <TaskSources task={current} openObject={openObject} />
              {current.proposal && (
                <details className="task-proposal">
                  <summary>{uiText('查看原演示草稿')}</summary>
                  <pre>{current.proposal}</pre>
                  <button
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        await saveProposal(current);
                        if (alive.current) setNotice(uiText('草稿已作为文字材料放到桌面。'));
                      })
                    }
                  >
                    {uiText('将草稿放到桌面')}
                  </button>
                </details>
              )}
              <TaskTimeline task={current} />
              <footer className="task-controls">
                <button disabled={pending} onClick={() => void update('archive')}>
                  {uiText('归档旧记录')}
                </button>
              </footer>
            </article>
          ) : (
            <div className="task-welcome">
              <span>◎</span>
              <h2>{uiText('暂无任务记录')}</h2>
              <p>{uiText('任务建立后，这里会显示状态和材料修改记录。')}</p>
              <button onClick={close}>{uiText('返回桌面')}</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function TaskSources({ task, openObject }: { task: WorkTask; openObject: (id: string) => void }) {
  useUiLocale();
  return (
    <div className="task-sources">
      {task.sources.map((source) => (
        <button key={source.objectId} onClick={() => openObject(source.objectId)}>
          {kindIcons[source.kind]} {source.title}
          <small>
            v{source.revision} ·{' '}
            {task.writeObjectIds.includes(source.objectId) ? uiText('可写') : uiText('只读')}
            {source.selection ? uiText(' · 局部范围') : ''}
          </small>
        </button>
      ))}
    </div>
  );
}
function TaskTimeline({ task }: { task: WorkTask }) {
  useUiLocale();
  return (
    <div className="task-timeline">
      {task.events.map((event) => (
        <div key={event.id} className={`task-event actor-${event.actor}`}>
          <span className="task-avatar">
            {event.actor === 'human'
              ? uiText('你')
              : event.actor === 'codex-writer' || event.actor === 'demo-planner'
                ? uiText('写')
                : uiText('审')}
          </span>
          <div>
            <header>
              <strong>{event.title}</strong>
              <time>{new Date(event.at).toLocaleString(interfaceLocale())}</time>
            </header>
            <p>{event.body}</p>
            {!task.execution && event.actor !== 'human' && (
              <small>{uiText('演示内容 · 未调用模型')}</small>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
function TaskSettings({
  task,
  workspace,
  pending,
  save,
}: {
  task: WorkTask;
  workspace: Workspace;
  pending: boolean;
  save: (budget: WorkTask['budget'], ids: string[]) => void;
}) {
  useUiLocale();
  const [budget, setBudget] = useState(task.budget),
    [ids, setIds] = useState(task.writeObjectIds);
  return (
    <details className="task-settings">
      <summary>{uiText('调整材料操作范围')}</summary>
      <div className="task-budget-fields">
        {(
          [
            { key: 'maxSteps', label: uiText('提交 / 反馈步数'), min: 1, max: 30 },
            { key: 'maxMinutes', label: uiText('读写窗口 / 分钟'), min: 1, max: 240 },
            { key: 'maxTokens', label: uiText('Token 预算偏好'), min: 1000, max: 200000 },
          ] as const
        ).map((field) => (
          <label key={field.key}>
            {field.label}
            <input
              type="number"
              min={field.min}
              max={field.max}
              step={1}
              value={budget[field.key]}
              onChange={(e) => setBudget({ ...budget, [field.key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <p className="muted">
        {uiText(
          '读写窗口从任务建立时开始计算，包含等待和暂停；调整后不会重置已用步数。Token 暂无宿主可信计量，预算偏好不能限制宿主费用。',
        )}
      </p>
      <div className="task-write-scope">
        <strong>{uiText('允许修改的材料')}</strong>
        <p>{uiText('未勾选材料仅供读取，局部选区和保留范围持续生效。')}</p>
        {workspace.objects
          .filter((object) => task.sources.some((source) => source.objectId === object.id))
          .map((object) => (
            <label key={object.id}>
              <input
                type="checkbox"
                checked={ids.includes(object.id)}
                disabled={
                  !ids.includes(object.id) && (object.policy?.locked || object.policy?.private)
                }
                onChange={(e) =>
                  setIds(
                    e.target.checked ? [...ids, object.id] : ids.filter((id) => id !== object.id),
                  )
                }
              />
              {object.title}
              <small>
                {object.policy?.locked
                  ? uiText('AI 只读')
                  : object.policy?.protectedRanges.length
                    ? uiText('包含保留范围')
                    : ''}
              </small>
            </label>
          ))}
      </div>
      <button disabled={pending} onClick={() => save(budget, ids)}>
        {uiText('保存范围')}
      </button>
    </details>
  );
}
function NativeTaskDetail({
  task,
  workspace,
  pending,
  update,
  openObject,
}: {
  task: WorkTask;
  workspace: Workspace;
  pending: boolean;
  update: (operation: string, extra?: Record<string, unknown>) => Promise<void>;
  openObject: (id: string) => void;
}) {
  useUiLocale();
  const execution = task.execution!;
  const [clock, setClock] = useState(Date.now()),
    [recoveryNotice, setRecoveryNotice] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const changedSources = task.sources.filter(
    (source) =>
      workspace.objects.find((object) => object.id === source.objectId)?.revision !==
      source.revision,
  );
  const stale = changedSources.length > 0,
    expired = clock > execution.deadlineAt;
  async function copyRecovery() {
    const text = uiText(
      '继续工作桌面任务 {0}。先查看当前阶段和原文件回执，不要重复已完成修改。{1}任务材料：{2}。',
      {
        '0': task.id,
        '1': stale
          ? uiText(
              '我会重新引用这些任务材料的当前版本，请调用 desktop_task_resume，acceptCurrentSources=true，接纳当前版本后保留任务历史，旧工作副本仅用于比较合并。',
            )
          : uiText(
              '使用我重新引用的材料调用 desktop_task_resume，保留阶段、反馈与预算；先查看未完成工作副本再继续。',
            ),
        '2': task.sources.map((source) => source.title).join('、'),
      },
    );
    try {
      await navigator.clipboard.writeText(text);
      setRecoveryNotice(uiText('恢复说明已复制，重新引用任务材料后粘贴到 Codex 原对话。'));
    } catch {
      setRecoveryNotice(
        uiText('任务 {0}：重新引用全部任务材料，在原对话要求恢复此任务{1}。', {
          '0': task.id,
          '1': stale ? uiText('并接纳当前版本') : '',
        }),
      );
    }
  }
  return (
    <article className="task-detail native-task-detail">
      <div className="task-title-row">
        <span className={`task-status status-${task.status}`}>{labels[task.status]}</span>
        <span className="task-revision">
          {uiText('记录 v')}
          {task.revision}
        </span>
      </div>
      <h2>{task.title}</h2>
      <p className="task-goal">{task.goal}</p>
      {task.constraints && (
        <div className="task-rule">
          <strong>{uiText('保留与约束')}</strong>
          <p>{task.constraints}</p>
        </div>
      )}
      <div className="native-task-route">
        <strong>{uiText('指令与反馈继续写在原消息框')}</strong>
        <p>
          {uiText('当前阶段：')}
          {
            {
              writing: uiText('处理材料'),
              reviewing: uiText('等待独立审阅'),
              revising: uiText('按反馈修订'),
              ready: uiText('结果待你确认'),
              approved: uiText('审阅已通过，待你确认'),
            }[execution.phase]
          }
          {uiText('。这里显示材料操作的记录。')}
        </p>
      </div>
      <TaskSources task={task} openObject={openObject} />
      {(stale || expired) && !ended(task) && (
        <div className="task-stale">
          <span>
            {stale
              ? uiText(
                  '材料已有任务外修改：{0}。重新引用全部任务材料，并在原对话明确接纳当前版本，即可恢复同一任务。旧副本停止回写，已有结果和记录保留。',
                  {
                    '0': changedSources
                      .map(
                        (source) =>
                          `${source.title} v${source.revision} → ${workspace.objects.find((object) => object.id === source.objectId)?.revision ?? uiText('不可用')}`,
                      )
                      .join('；'),
                  },
                )
              : uiText(
                  '读写窗口已到期。在下方调整窗口后可继续同一任务；重新引用不会自动重置预算。',
                )}
          </span>
        </div>
      )}
      {!ended(task) && (
        <div className="native-task-route">
          <button onClick={() => void copyRecovery()}>{uiText('复制原对话恢复说明')}</button>
          {recoveryNotice && <p role="status">{recoveryNotice}</p>}
        </div>
      )}
      <div className="task-budget-summary">
        <span>
          {uiText('提交 / 反馈')}
          <b>
            {execution.steps} / {task.budget.maxSteps}
          </b>{' '}
          {uiText('步')}
        </span>
        <span>
          {uiText('读写截止')}
          {new Date(execution.deadlineAt).toLocaleString(interfaceLocale())}
        </span>
        <span>
          {uiText('任务已建立')}
          {Math.max(0, Math.floor((clock - Date.parse(execution.startedAt)) / 60000))}{' '}
          {uiText('分钟（含等待）')}
        </span>
        <span>
          {uiText('材料访问：')}
          {task.usage.readOperations ?? 0} {uiText('次')}
        </span>
        <span>
          {uiText('独立参与者：')}
          {execution.participants.length}
        </span>
        <span>
          {uiText('审阅：')}
          {execution.reviewRound} {uiText('轮')}
        </span>
        <span>
          {uiText('宿主 Token：不可用')}
          {task.usage.reportedTokens !== undefined
            ? uiText(' · 执行者累计自报 {0}（未经宿主认证）', { '0': task.usage.reportedTokens })
            : ''}
        </span>
      </div>
      {!ended(task) && (
        <TaskSettings
          key={`${task.id}:${JSON.stringify([task.budget, task.writeObjectIds])}`}
          task={task}
          workspace={workspace}
          pending={pending}
          save={(budget, writeObjectIds) => void update('configure', { budget, writeObjectIds })}
        />
      )}
      {execution.feedbacks.length > 0 && (
        <section className="native-feedbacks">
          <strong>{uiText('审阅记录')}</strong>
          {execution.feedbacks.map((feedback) => (
            <article key={feedback.id}>
              <header>
                {feedback.decision === 'approve' ? uiText('通过意见') : uiText('修订意见')} ·{' '}
                {new Date(feedback.at).toLocaleTimeString(interfaceLocale())}
                {Object.entries(feedback.basedOn).some(
                  ([id, revision]) =>
                    task.sources.find((source) => source.objectId === id)?.revision !== revision,
                )
                  ? uiText(' · 历史版本意见')
                  : ''}
              </header>
              <p>{feedback.body}</p>
              <small>
                {Object.entries(feedback.basedOn)
                  .map(
                    ([id, revision]) =>
                      `${task.sources.find((source) => source.objectId === id)?.title ?? id} · v${revision}`,
                  )
                  .join('；')}
              </small>
            </article>
          ))}
        </section>
      )}
      <TaskTimeline task={task} />
      <details className="native-participants">
        <summary>
          {uiText('查看执行来源 ·')}
          {execution.participants.length} {uiText('个上下文')}
        </summary>
        {execution.participants.map((participant) => (
          <div key={participant.id}>
            <b>{participant.role === 'writer' ? uiText('写入者') : uiText('只读审阅者')}</b>
            <small>
              {uiText('已读取')}
              {Object.keys(participant.lastReads).length} {uiText('份材料 ·')}
              {new Date(participant.joinedAt).toLocaleString(interfaceLocale())}
            </small>
          </div>
        ))}
        <p>
          {uiText(
            '标识来自宿主会话元数据。不同的角色名称不算不同执行身份；模型类型与运行用量暂无宿主信号。',
          )}
        </p>
      </details>
      <footer className="task-controls">
        <button disabled={pending} onClick={() => void update('archive')}>
          {ended(task) ? uiText('归档记录') : uiText('停止并归档')}
        </button>
        <div>
          {!ended(task) && (
            <button disabled={pending} onClick={() => void update('cancel')}>
              {uiText('停止后续操作')}
            </button>
          )}
          {!ended(task) && (
            <button
              disabled={pending}
              onClick={() => void update(task.status === 'paused' ? 'resume' : 'pause')}
            >
              {task.status === 'paused' ? uiText('继续任务') : uiText('暂停材料操作')}
            </button>
          )}
          {task.status === 'ready' && (
            <button
              className="primary"
              disabled={pending || stale}
              onClick={() => void update('complete')}
            >
              {uiText('确认完成')}
            </button>
          )}
        </div>
      </footer>
      <p className="native-stop-note">
        {uiText('暂停和停止会阻止后续材料操作。结束 Codex 当前推理，请使用原对话的停止按钮。')}
      </p>
    </article>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  labels = {
    queued: uiText('待开始'),
    working: uiText('处理中'),
    review: uiText('审阅中'),
    ready: uiText('待确认'),
    paused: uiText('已暂停'),
    completed: uiText('已完成'),
    waiting_input: uiText('等你补充'),
    waiting_permission: uiText('等待授权'),
    conflict: uiText('材料冲突'),
    failed: uiText('未能继续'),
    cancelled: uiText('已取消'),
  };
});
