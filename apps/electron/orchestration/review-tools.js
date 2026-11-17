import { bindUiLabel } from '../ui/ui-labels.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
export function registerReviewTools({ messages, status, surface }) {
  const mode = document.createElement('select');
  mode.className = 'review-mode';
  bindUiLabel(mode, 'aria-label', '结果审阅');
  mode.append(
    new Option(uiText('不审阅'), 'direct'),
    new Option(uiText('完成后自动审阅'), 'review'),
  );
  mode.onchange = async () => {
    try {
      await window.desktop.review('mode', { enabled: mode.value === 'review' });
    } catch (error) {
      mode.value = mode.value === 'review' ? 'direct' : 'review';
      status.textContent = error.message;
    }
  };
  const nodes = new Map();
  const button = (label, action) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await action();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };
  function render(job) {
    let box = nodes.get(job.id);
    if (!box || !box.isConnected) {
      box = document.createElement('details');
      box.className = 'message review-job';
      messages.append(box);
      nodes.set(job.id, box);
    }
    const summary = document.createElement('summary'),
      body = document.createElement('p'),
      actions = document.createElement('div');
    bindUiLabel(summary, 'textContent', '独立审阅 · {0}', {
      0:
        {
          queued: uiText('准备中'),
          starting: uiText('正在连接'),
          running: uiText('审阅中'),
          waiting: uiText('等待授权'),
          completed: uiText('已结束'),
          interrupted: uiText('已中断'),
          failed: uiText('未能启动'),
        }[job.state] || job.state,
    });
    body.textContent = job.summary || uiText('另一个 AI 会查看任务结果并提出意见，不会修改文件。');
    if (['interrupted', 'failed'].includes(job.state))
      actions.append(
        button(uiText('继续审阅'), () => window.desktop.review('resume', { id: job.id })),
      );
    if (['running', 'waiting'].includes(job.state))
      actions.append(
        button(uiText('停止审阅'), () => window.desktop.review('stop', { id: job.id })),
      );
    if (job.state === 'completed') {
      const note = document.createElement('small');
      bindUiLabel(note, 'textContent', '是否通过，请查看任务中的审阅意见。');
      actions.append(note);
    }
    box.replaceChildren(summary, body, actions);
  }
  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'review-job') render(payload);
    if (['started', 'connecting'].includes(type)) mode.disabled = true;
    if (['completed', 'ready', 'connection-error'].includes(type)) mode.disabled = false;
    if (type === 'review-approval') {
      const box = document.createElement('div'),
        body = document.createElement('p');
      box.className = 'approval';
      box.dataset.reviewApproval = `${payload.jobId}:${payload.id}`;
      bindUiLabel(body, 'textContent', '独立审阅请求授权\n{0}', {
        0: payload.params.command || payload.params.reason || payload.method,
      });
      box.append(body);
      for (const [label, accepted] of [
        [uiText('允许本次'), true],
        [uiText('拒绝'), false],
      ])
        box.append(
          button(label, async () => {
            await window.desktop.review('respond', { ...payload, accepted });
            box.remove();
          }),
        );
      messages.append(box);
      surface.setOpen(true);
      surface.contentChanged({ force: true });
    }
    if (type === 'review-approval-expired')
      messages.querySelector(`[data-review-approval="${payload.jobId}:${payload.id}"]`)?.remove();
  });
  window.addEventListener('desktop-settings-open', (event) =>
    event.detail.row(
      'ai',
      '结果审阅',
      '开启后，AI 完成任务时会请另一个 AI 检查结果并提出意见。审阅的 AI 只查看，不修改文件。',
      [mode],
    ),
  );
  window.addEventListener('desktop-settings-open', (event) =>
    event.detail.row('ai', '审阅记录', '查看每次审阅的过程和意见。', [
      button(uiText('查看审阅记录'), async () => {
        const jobs = await window.desktop.review('list');
        event.detail.modal.close();
        surface.setOpen(true);
        for (const job of jobs) render(job);
        if (!jobs.length)
          bindUiLabel(
            status,
            'textContent',
            '还没有审阅记录。把「结果审阅」设为「完成后自动审阅」后，下次任务完成时会自动审阅。',
          );
      }),
    ]),
  );
}
