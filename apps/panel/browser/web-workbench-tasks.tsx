import { useEffect, useState } from 'react';
import {
  subscribeUiLanguage as onUiLocale,
  t as uiText,
} from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { Icon } from '../ui/icons.js';
import { PanelActionError } from '../host.js';
import {
  flushDraftStorage,
  writeDraftNow,
} from '../documents/draft-storage.js';
import {
  type WebCapture,
  type WebFormDraft,
  type WebPage,
} from '../../../packages/contracts/web-workspace.js';
import {
  date,
  domain,
  Empty,
  message,
  uid,
  useDraft,
} from './web-workbench-shared.js';
import type {
  Dirty,
  Task,
  TaskMode,
  WebTaskRequest,
  WebWorkbenchProps,
} from './web-workbench-shared.js';

let taskLabels: Record<Task['status'], string> = {
  queued: uiText('等待执行'),
  running: uiText('浏览中'),
  waiting: uiText('等待你的回复'),
  completed: uiText('已完成'),
  failed: uiText('未完成'),
};
export const canContinueTask = (task: Task) =>
  !task.restoredAt && !task.cancelled && !['completed', 'failed'].includes(task.status);
export function TasksPanel({
  workspaceId,
  page,
  capture,
  tasks,
  drafts,
  action,
  run,
  resume,
  refresh,
  disabled,
  canSend,
  dirty,
  showCapture,
}: {
  workspaceId: string;
  page: WebPage;
  capture?: WebCapture;
  tasks: Task[];
  drafts: WebFormDraft[];
  action: WebWorkbenchProps['action'];
  run: (request: WebTaskRequest) => Promise<boolean>;
  resume: (taskId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  disabled: boolean;
  canSend: boolean;
  dirty: Dirty;
  showCapture: (id: string) => void;
}) {
  useUiLocale();
  const [draft, setDraft, storageError] = useDraft<{
      mode: TaskMode;
      instruction: string;
      formDraftId: string;
      replies: Record<string, string>;
      replyPending?: { taskId: string; requestId: string; body: string };
      cancelPending?: { taskId: string; requestId: string };
    }>(
      `ai-desktop:web-task-draft:${workspaceId}:${page.id}`,
      () => ({ mode: 'capture', instruction: '', formDraftId: '', replies: {} }),
      dirty,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const blocked = disabled || busy || !!draft.replyPending || !!draft.cancelPending,
    availableForms = drafts.filter((form) => form.captureId === capture?.id);
  useEffect(() => {
    const task = tasks.find((item) => item.id === draft.replyPending?.taskId);
    if (task && !canContinueTask(task))
      setDraft((previous) => ({ ...previous, replyPending: undefined }));
  }, [tasks, draft.replyPending?.taskId]);
  async function cancel(taskId: string, retry = false) {
    if (busy || disabled || (!retry && blocked)) return;
    setBusy(true);
    setError('');
    const payload = retry ? draft.cancelPending! : { taskId, requestId: uid() },
      key = `ai-desktop:web-task-draft:${workspaceId}:${page.id}`;
    try {
      const pending = { ...draft, cancelPending: payload };
      writeDraftNow(key, JSON.stringify(pending));
      setDraft(pending);
      flushDraftStorage(key);
      await action('web_task', { operation: 'cancel', ...payload });
      const saved = { ...pending, cancelPending: undefined };
      writeDraftNow(key, JSON.stringify(saved));
      setDraft(saved);
      flushDraftStorage(key);
      await refresh();
    } catch (problem) {
      setError(message(problem));
      if (
        problem instanceof PanelActionError &&
        !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(problem.code)
      )
        setDraft((previous) => ({ ...previous, cancelPending: undefined }));
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (blocked) return;
    setBusy(true);
    setError('');
    try {
      const sent = await run({
        pageId: page.id,
        expectedRevision: page.revision,
        ...(capture ? { captureId: capture.id } : {}),
        mode: draft.mode,
        instruction:
          draft.instruction.trim() ||
          (draft.mode === 'capture'
            ? uiText('打开这个网页，捕获当前可见正文、链接和普通表单字段，结果回到 Web 工作区。')
            : ''),
        ...(draft.mode === 'fill' && draft.formDraftId ? { formDraftId: draft.formDraftId } : {}),
      });
      if (sent) setDraft({ ...draft, instruction: '' });
    } catch (problem) {
      setError(message(problem));
    } finally {
      setBusy(false);
    }
  }
  async function reply(taskId: string, retry = false) {
    const body = draft.replies?.[taskId]?.trim();
    if (busy || (!retry && !body)) return;
    setBusy(true);
    setError('');
    const payload = retry ? draft.replyPending! : { taskId, requestId: uid(), body: body! };
    try {
      writeDraftNow(
        `ai-desktop:web-task-draft:${workspaceId}:${page.id}`,
        JSON.stringify({ ...draft, replyPending: payload }),
      );
      setDraft({ ...draft, replyPending: payload });
      flushDraftStorage(`ai-desktop:web-task-draft:${workspaceId}:${page.id}`);
      await action('web_task', { operation: 'reply', ...payload });
      setDraft((previous) => ({
        ...previous,
        replyPending: undefined,
        replies: { ...previous.replies, [taskId]: '' },
      }));
      await resume(taskId);
      await refresh();
    } catch (problem) {
      setError(message(problem));
      if (
        problem instanceof PanelActionError &&
        !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(problem.code)
      )
        setDraft((previous) => ({ ...previous, replyPending: undefined }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ww-inspector-body">
      <header className="ww-panel-intro">
        <h3>{uiText('让浏览器接着做')}</h3>
        <p>{uiText('任务交给当前 Codex 对话执行，进度、追问和快照回到这里。')}</p>
      </header>
      <div className="ww-task-composer">
        <select
          aria-label={uiText('浏览任务类型')}
          value={draft.mode}
          disabled={blocked}
          onChange={(event) => setDraft({ ...draft, mode: event.target.value as TaskMode })}
        >
          <option value="capture">{uiText('捕获当前网页')}</option>
          <option value="browse">{uiText('浏览与查找资料')}</option>
          <option value="compare">{uiText('重新捕获并比较变化')}</option>
          <option value="fill">{uiText('填写已保存表单')}</option>
        </select>
        {draft.mode === 'fill' && (
          <select
            value={draft.formDraftId}
            disabled={blocked}
            onChange={(event) => setDraft({ ...draft, formDraftId: event.target.value })}
          >
            <option value="">{uiText('选择表单草稿')}</option>
            {availableForms.map((form) => (
              <option key={form.id} value={form.id}>
                {form.name}
              </option>
            ))}
          </select>
        )}
        <textarea
          maxLength={8000}
          value={draft.instruction}
          onChange={(event) => setDraft({ ...draft, instruction: event.target.value })}
          placeholder={
            draft.mode === 'capture'
              ? uiText('例如：捕获产品介绍和价格，保留来源链接…')
              : uiText('描述你希望浏览器完成的事…')
          }
        />
        <footer>
          <span>
            {canSend ? uiText('结果返回当前网页') : uiText('当前宿主尚未提供任务发送入口')}
          </span>
          <button
            className="ww-primary"
            disabled={
              blocked ||
              !canSend ||
              (draft.mode !== 'capture' && !draft.instruction.trim()) ||
              (draft.mode === 'fill' && !draft.formDraftId)
            }
            onClick={() => void start()}
          >
            <Icon name="arrow" size={15} />
            {uiText('开始')}
          </button>
        </footer>
      </div>
      {storageError && <p className="ww-inline-error">{storageError}</p>}
      {error && <p className="ww-inline-error">{error}</p>}
      {draft.replyPending && (
        <div className="ww-feedback attention">
          <span>{uiText('补充回复的结果尚未确认。')}</span>
          <button
            disabled={busy || disabled}
            onClick={() => void reply(draft.replyPending!.taskId, true)}
          >
            {uiText('继续原回复')}
          </button>
        </div>
      )}
      {draft.cancelPending && (
        <div className="ww-feedback attention">
          <span>{uiText('撤销回报的结果尚未确认，原请求已保留。')}</span>
          <button
            disabled={busy || disabled}
            onClick={() => void cancel(draft.cancelPending!.taskId, true)}
          >
            {uiText('继续原撤销请求')}
          </button>
        </div>
      )}
      <div className="ww-section-title">
        {uiText('任务记录')}
        <span>{tasks.length}</span>
      </div>
      {tasks.map((task) => (
        <article className={`ww-task-card status-${task.status}`} key={task.id}>
          <header>
            <span>
              <i />
              {task.restoredAt
                ? uiText('恢复的历史记录')
                : task.cancelled
                  ? uiText('已撤销桌面回报')
                  : taskLabels[task.status]}
            </span>
            <time>{date(task.updatedAt)}</time>
          </header>
          <h4>{task.instruction}</h4>
          {task.summary && <p>{task.summary}</p>}
          {['claimed', 'unknown'].includes(task.delivery) && canContinueTask(task) && (
            <div className="ww-task-delivery">
              {uiText('发送尚未确认，任务记录已保留。继续会沿用原任务。')}
            </div>
          )}
          {task.executionRef && (
            <small>
              {task.executionRef.browser} ·{' '}
              {task.executionRef.url
                ? domain(task.executionRef.url)
                : uiText('页签 {0}', { '0': task.executionRef.tabId })}
            </small>
          )}
          {task.reports?.length > 0 && (
            <details>
              <summary>
                {uiText('最近回报 ·')}
                {task.reports.length}
              </summary>
              {task.reports.slice(-8).map((report, index) => (
                <div className="ww-report" key={`${report.at}:${index}`}>
                  <time>{date(report.at)}</time>
                  <p>{report.body}</p>
                </div>
              ))}
            </details>
          )}
          <footer>
            {task.captureIds?.map((id, index) => (
              <button key={id} onClick={() => showCapture(id)}>
                <Icon name="document" size={12} />
                {uiText('快照')}
                {index + 1}
              </button>
            ))}
            {canContinueTask(task) && (
              <button disabled={blocked || !canSend} onClick={() => void resume(task.id)}>
                <Icon name="play" size={12} />
                {task.status === 'waiting' ? uiText('继续任务') : uiText('恢复 / 继续')}
              </button>
            )}
            {canContinueTask(task) && (
              <button disabled={blocked} onClick={() => void cancel(task.id)}>
                <Icon name="close" size={12} />
                {uiText('撤销桌面回报')}
              </button>
            )}
          </footer>
          {canContinueTask(task) && (
            <small>{uiText('撤销仅取消桌面回报授权，不会停止已开始的浏览操作。')}</small>
          )}
          {['completed', 'failed'].includes(task.status) && (
            <small>{uiText('这项任务已结束。需要继续处理时，可在上方发起新任务。')}</small>
          )}
          {canContinueTask(task) && (
            <div className="ww-task-reply">
              <textarea
                rows={2}
                maxLength={8000}
                value={draft.replies?.[task.id] ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    replies: { ...draft.replies, [task.id]: event.target.value },
                  })
                }
                placeholder={uiText('补充要求或回答追问…')}
              />
              <button
                disabled={blocked || !canSend || !draft.replies?.[task.id]?.trim()}
                onClick={() => void reply(task.id)}
              >
                {uiText('回复并继续')}
                <Icon name="arrow" size={12} />
              </button>
            </div>
          )}
        </article>
      ))}
      {!tasks.length && (
        <Empty icon="tasks" title={uiText('任务会留在这里')}>
          {uiText('执行中断后，从原任务继续，已保存的快照仍会保留。')}
        </Empty>
      )}
    </div>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  taskLabels = {
    queued: uiText('等待执行'),
    running: uiText('浏览中'),
    waiting: uiText('等待你的回复'),
    completed: uiText('已完成'),
    failed: uiText('未完成'),
  };
});
