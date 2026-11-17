import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { bindUiLabel } from '../ui/ui-labels.js';
import { subscribeUiLanguage, getUiLanguage } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
const reviewerName = (value) =>
  ({
    user: uiText('请求批准'),
    auto_review: uiText('帮我批准'),
    guardian_subagent: uiText('自动审批（旧版）'),
  })[value] || uiText('尚未确认');
const reviewName = (value) =>
  ({
    inProgress: uiText('正在审批'),
    approved: uiText('已批准'),
    denied: uiText('已拒绝'),
    timedOut: uiText('审批超时'),
    aborted: uiText('审批中止'),
    strict: uiText('需要进一步审查'),
    warning: uiText('审批提醒'),
  })[value] || value;
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

export function createPermissionControls({ state }) {
  let provider = 'codex';
  let data = null,
    error = '',
    loading = false,
    saving = false,
    epoch = 0,
    choice = 'inherit';
  const reviews = new Map(),
    button = node('button', uiText('权限'), 'composer-permission');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6Z"/><path d="m8 12 3 3 5-6"/></svg>';
  document
    .querySelector('.composer-tools')
    .insertBefore(
      button,
      document.querySelector('.voice-button') || document.getElementById('stop'),
    );
  const popup = node('dialog', undefined, 'composer-popover permission-popover'),
    header = node('header'),
    title = node('strong', uiText('如何批准 AI 操作？')),
    body = node('div', undefined, 'composer-popover-body');
  bindUiLabel(popup, 'aria-label', '操作权限');
  header.append(title);
  popup.append(header, body);
  document.body.append(popup);
  popup.addEventListener('close', () => button.setAttribute('aria-expanded', 'false'));
  popup.addEventListener('click', (event) => {
    if (event.target !== popup) return;
    const r = popup.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      popup.close();
  });
  // Right-aligned to the composer so the card never spills past the chat column toward the desk.
  function position() {
    if (!popup.open) return;
    const r = button.getBoundingClientRect(),
      edge = (button.closest('.composer') || button).getBoundingClientRect(),
      column = button.closest('.chat')?.getBoundingClientRect();
    popup.style.width = `${Math.min(232, window.innerWidth - 24)}px`;
    const min = Math.max(12, (column?.left ?? 0) + 8);
    popup.style.left = `${Math.max(min, Math.min(edge.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 12))}px`;
    popup.style.top = `${Math.max(12, r.top - popup.offsetHeight - 8)}px`;
  }
  new ResizeObserver(position).observe(popup);
  window.addEventListener('resize', position);
  function effective() {
    return data?.threadId === state().threadId ? data.effective : {};
  }
  function label() {
    const recent = [...reviews.values()].at(-1),
      waiting = recent?.status === 'inProgress',
      needsAttention =
        recent && ['denied', 'timedOut', 'aborted', 'strict', 'warning'].includes(recent.status);
    const reviewer =
      data?.mode === 'inherit'
        ? effective()?.approvalsReviewer || data?.defaults?.approvalsReviewer
        : data?.mode;
    const caption = !state().ready
      ? uiText('权限 · 离线')
      : loading
        ? uiText('读取中…')
        : data?.readError
          ? uiText('权限读取失败')
          : waiting
            ? uiText('权限 · 审批中')
            : needsAttention
              ? uiText('权限 · {0}', { 0: reviewName(recent.status) })
              : reviewer
                ? reviewerName(reviewer)
                : uiText('权限');
    button.setAttribute('aria-label', caption);
    button.title = caption;

    button.dataset.attention = String(!!(needsAttention || data?.readError || error));
    button.hidden = provider !== 'codex';
    button.disabled = provider !== 'codex' || !state().ready;
  }
  function render() {
    label();
    if (!popup.open) return;
    const opened = new Set([...body.querySelectorAll('details[open]')].map((el) => el.dataset.key));
    body.replaceChildren();
    const actual = effective() || {},
      sandbox = actual.sandbox || {},
      scope =
        {
          workspaceWrite: uiText('工作区可写'),
          readOnly: uiText('只读'),
          dangerFullAccess: uiText('完全访问'),
          externalSandbox: uiText('外部沙箱'),
        }[sandbox.type] || uiText('CLI 未提供');
    const selected =
      data?.mode === 'inherit'
        ? actual.approvalsReviewer || data?.defaults?.approvalsReviewer || 'inherit'
        : data?.mode;
    const options = node('div', undefined, 'permission-options');
    options.setAttribute('role', 'group');
    bindUiLabel(options, 'aria-label', '审批方式');
    for (const [value, label, description] of [
      ['user', '请求批准', '需要授权的操作先询问你'],
      ['auto_review', '帮我批准', '由 AI 审查需要授权的操作'],
    ]) {
      const reviewer = value === 'inherit' ? data?.defaults?.approvalsReviewer : value,
        policy = value === 'inherit' ? data?.defaults?.approvalPolicy : 'on-request';
      const restricted =
        !(data?.draft && value === 'inherit') &&
        ((data?.allowedReviewers && !data.allowedReviewers.includes(reviewer)) ||
          (data?.allowedPolicies &&
            !data.allowedPolicies.some(
              (item) => JSON.stringify(item) === JSON.stringify(policy),
            )) ||
          (value === 'inherit' && !data?.defaults?.approvalPolicy));
      const row = node('button', undefined, 'permission-option'),
        copy = node('span', undefined, 'permission-option-copy');
      row.type = 'button';
      const checked = value === 'inherit' ? data?.mode === 'inherit' : selected === value;
      row.setAttribute('aria-pressed', String(checked));
      row.disabled =
        loading ||
        saving ||
        !state().ready ||
        state().navigating ||
        !data?.supported ||
        !!restricted;
      const check = node('span', '', 'permission-option-check');
      check.setAttribute('aria-hidden', 'true');
      copy.append(node('strong', uiText(label)), node('small', uiText(description)));
      row.append(copy, check);
      if (restricted) row.title = uiText('当前配置不支持此选项');
      row.onclick = () => {
        choice = value;
        void save();
      };
      options.append(row);
    }
    body.append(options);
    if (loading || saving)
      body.append(node('p', uiText(saving ? '正在应用…' : '读取中…'), 'permission-status'));

    if (error || data?.readError) {
      const notice = node('p', error || data.readError, 'composer-notice');
      notice.setAttribute('role', 'alert');
      body.append(notice);
    }
    position();
  }
  function accept(result) {
    data = result;
    choice = result.mode;
    for (const item of result.reviews || [])
      if (!reviews.has(item.id) || reviews.get(item.id).at <= item.at) reviews.set(item.id, item);
    while (reviews.size > 50) reviews.delete(reviews.keys().next().value);
  }
  async function load(refresh = false) {
    if (provider !== 'codex' || loading || !state().ready) return;
    const generation = epoch,
      id = state().threadId;
    loading = true;
    error = '';
    render();
    try {
      const result = await window.desktop.permissions('read', { refresh });
      if (generation === epoch && id === state().threadId) accept(result);
    } catch (cause) {
      if (generation === epoch) error = cause.message;
    } finally {
      if (generation === epoch) {
        loading = false;
        render();
      }
    }
  }
  async function save() {
    if (provider !== 'codex' || saving || loading || state().navigating || !data?.supported) return;
    const generation = epoch,
      id = state().threadId,
      mode = choice;
    saving = true;
    error = '';
    render();
    try {
      const result = await window.desktop.permissions('set', { threadId: id, mode });
      if (generation === epoch && id === state().threadId) {
        accept(result);
        popup.close();
      }
    } catch (cause) {
      if (generation === epoch) {
        choice = data?.mode || 'inherit';
        error = cause.message;
      }
    } finally {
      if (generation === epoch) {
        saving = false;
        render();
      }
    }
  }
  button.onclick = () => {
    if (provider !== 'codex') return;
    popup.showModal();
    button.setAttribute('aria-expanded', 'true');
    render();
    void load();
  };
  window.addEventListener('desktop-show-permissions', () => button.click());
  window.desktop.onEvent(({ type, payload }) =>
    queueMicrotask(() => {
      if (type === 'provider') {
        provider = payload.id;
        epoch++;
        data = null;
        reviews.clear();
        loading = false;
        saving = false;
        error = '';
        choice = 'inherit';
        if (provider !== 'codex') popup.close();
        render();
        if (provider === 'codex') void load();
      } else if (
        ['connecting', 'connection-error', 'ready', 'thread-switched', 'thread-created'].includes(
          type,
        )
      ) {
        epoch++;
        data = null;
        reviews.clear();
        loading = false;
        saving = false;
        error = '';
        choice = 'inherit';
        render();
        if (['ready', 'thread-switched', 'thread-created'].includes(type) && provider === 'codex')
          void load();
      } else if (type === 'permissions' && payload.threadId === state().threadId) {
        if (data) {
          data.effective = payload.effective;
          data.readError = null;
        }
        render();
      } else if (type === 'auto-review' && payload.threadId === state().threadId) {
        reviews.set(payload.id, payload);
        while (reviews.size > 50) reviews.delete(reviews.keys().next().value);
        render();
      } else if (['thread-navigation', 'started', 'completed'].includes(type)) render();
    }),
  );
  subscribeUiLanguage(() => {
    bindUiLabel(title, 'textContent', '如何批准 AI 操作？');
    bindUiLabel(popup, 'aria-label', '操作权限');
    render();
  });
  label();
}
