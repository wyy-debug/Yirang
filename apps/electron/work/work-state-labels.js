import { projectWorkReport } from './work-report-journal.mjs';
// One work state, one name. Four surfaces used to label `review` as
// 待检查 / 查看成果 / 结果可查看 / 待验收, so the same job looked like four
// different things depending on where you read it.
const STATES = {
  queued: '等待安排',
  scheduled: '已安排',
  waiting: '正在处理',
  running: '正在处理',
  revising: '正在更新',
  review: '待你确认',
  attention: '需要你',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  pausing: '正在暂停',
  cancelling: '正在取消',
};

export function workStateLabel(state, fallback = '') {
  return STATES[state] || fallback || state;
}

export { STATES as workStateLabels };

const LIVE = ['running', 'revising', 'waiting', 'pausing', 'cancelling'];
const minutes = (at, now) => Math.floor((now - Date.parse(at)) / 60000);

// What one row says about a work: a tone the dot shows, a short label, and one
// sentence. While running, the sentence is the agent's own report; otherwise
// it names what happened and what the user can do next.
//   done    green   finished, waiting for you to look
//   ask     orange  the agent asked you something
//   blocked red     it cannot continue on its own
//   running blue    working now (breathing)
//   idle    grey    queued, scheduled or paused
export function workStatus(task, now = Date.now()) {
  const report = projectWorkReport(task);
  const m = { ...task.management, state: report.state };
  if (m.question) return { tone: 'ask', label: '需要你回答', line: m.question };
  if (m.continuation && m.continuation.revision === m.currentRequirementsRevision &&
      m.continuation.next === 'repair' && ['queued', 'running', 'waiting'].includes(m.state))
    return { tone: 'running', label: '正在补齐成果',
      line: m.reason || '保留已完成的文件，继续处理未完成的部分' };
  const run = (m.runs || []).find(r => r.id === report.runId);
  if (m.state === 'attention' && run?.state === 'waiting')
    return { tone: 'ask', label: '等待确认', line: '请在对话中的请求卡片回答或授权' };
  if (m.state === 'attention')
    return {
      tone: 'blocked',
      label: '卡住了',
      line: report.reason || m.lastReport || m.reason || '执行停下了，原要求和已有文件都保留',
      action: '重新开始',
    };
  if (m.state === 'review') {
    return {
      tone: 'done',
      label: '待你确认',
      line: report.reason,
    };
  }
  if (m.state === 'completed') return { tone: 'done', label: '已完成', line: report.reason };
  if (LIVE.includes(m.state)) {
    const p = m.progress;
    if (!p)
      return {
        tone: 'running',
        label: STATES[m.state],
        line: m.state === 'waiting' ? '等前面的步骤完成' : '已开始，AI 马上汇报进度',
      };
    const count = p.total ? ` · ${Math.min(p.step ?? 0, p.total)}/${p.total}` : '';
    const age = minutes(p.at, now);
    return {
      tone: 'running',
      label: STATES[m.state],
      line: p.text + count + (age >= 2 ? ` · ${age} 分钟前` : ''),
    };
  }
  if (m.state === 'paused') return { tone: 'idle', label: '已暂停', line: '点开可以继续' };
  if (m.state === 'scheduled')
    return { tone: 'idle', label: '已安排', line: m.reason || '到时间后开始' };
  if (m.state === 'cancelled') return { tone: 'idle', label: '已取消', line: '文件和记录保留' };
  return { tone: 'idle', label: STATES[m.state] || '等待安排', line: '排队中，空出位置后开始' };
}

const RANK = { ask: 0, blocked: 0, running: 1, done: 2, idle: 3 };
/** Orange and red first: those are the rows that are waiting on the user. */
export const workStatusRank = (task) => RANK[workStatus(task).tone];
