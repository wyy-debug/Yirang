import { visibleUserText } from '../conversation/user-message-view.mjs';
import { t } from '../../../packages/components/ui-language.js';
import { renderMessage } from '../conversation/chat-markdown.js';
import labels from '../../../packages/components/work-history-labels.json' with { type: 'json' };

// This view reads an execution; it never changes the composer's thread owner.
export function createWorkExecution({ threadId, workspaceId, interval = 3000, live = true, expanded = false }) {
  const element = document.createElement(expanded ? 'section' : 'details');
  element.className = 'work-execution-inline';
  const summary = document.createElement('summary');
  summary.textContent = t('执行过程');
  const content = document.createElement('div');
  const error = document.createElement('p');
  error.setAttribute('role', 'status');
  const more = document.createElement('button');
  more.type = 'button';
  more.textContent = t('加载更多');
  more.hidden = true;
  if (!expanded) element.append(summary);
  element.append(content, error, more);
  const turns = new Map();
  let cursor = null, initialized = false, busy = false, disposed = false, timer;
  const visible = () => !disposed && element.isConnected && (expanded || element.open) &&
    !element.closest('[hidden]') && !document.hidden;
  function schedule() {
    clearTimeout(timer);
    if (live && visible()) timer = setTimeout(() => void load(false), interval);
  }
  async function load(older) {
    if (!visible() || busy) return;
    busy = true;
    more.disabled = true;
    try {
      const page = await window.desktop.workManagement({ workspaceId,
        command: { operation: 'execution_history', payload: { threadId, cursor: older ? cursor : null } } });
      if (!visible()) return;
      error.textContent = '';
      const fresh = document.createDocumentFragment();
      for (const turn of page.data || []) {
        const key = turn.id;
        if (!key) continue;
        const signature = JSON.stringify(turn);
        const prior = turns.get(key);
        if (prior?.signature === signature) continue;
        const block = document.createElement(expanded ? 'section' : 'details');
        block.dataset.turn = key;
        const title = document.createElement('summary');
        title.textContent = t(labels.states[turn.status] || labels.fallback);
        if (!expanded) {
          block.append(title);
          block.open = prior ? prior.element.open : true;
        }
        for (const item of turn.items || []) {
          if (item.type === 'agentMessage' || item.type === 'userMessage' && !item.lazy) {
            const text = document.createElement('div');
            text.className = item.type === 'userMessage' ? 'work-history-request' : 'work-history-response';
            const value = item.type === 'userMessage'
              ? visibleUserText(item)
              : item.text;
            renderMessage(text, value || '');
            if (value) block.append(text);
          } else {
            const detail = document.createElement('details');
            const label = document.createElement('summary');
            label.textContent = t(labels.items[item.type] || labels.fallback);
            detail.append(label);
            detail.addEventListener('toggle', async () => {
              if (!detail.open || detail.childElementCount > 1) return;
              const raw = document.createElement('pre');
              detail.append(raw);
              try {
                const value = item.lazy ? await window.desktop.workManagement({workspaceId,
                  command:{operation:'execution_item',payload:{threadId,...item.lazy}}}) : item;
                if (!disposed && detail.isConnected) {
                  if (item.type === 'userMessage') renderMessage(raw, visibleUserText(value));
                  else raw.textContent = JSON.stringify(value, null, 2);
                }
              } catch (e) {
                if (!disposed && detail.isConnected) {
                  raw.remove();
                  error.textContent = e.message;
                }
              }
            });
            block.append(detail);
          }
        }
        if (prior) prior.element.replaceWith(block);
        else if (initialized && !older) fresh.append(block);
        else content.append(block);
        turns.set(key, { element: block, signature });
      }
      if (fresh.childNodes.length) content.prepend(fresh);
      // Refreshing the newest page must not reset the older-history cursor.
      if (!initialized || older) cursor = page.nextCursor;
      initialized = true;
      more.hidden = !cursor;
    } catch (e) { if (visible()) error.textContent = e.message; }
    finally { busy = false; more.disabled = false; schedule(); }
  }
  more.onclick = () => void load(true);
  element.addEventListener('toggle', () => {
    clearTimeout(timer);
    if (element.open) void load(false);
  });
  const visibility = () => { if (visible()) void load(false); else clearTimeout(timer); };
  document.addEventListener('visibilitychange', visibility);
  return { element, setLive(value) {
    const ended = live && !value;
    live = value;
    clearTimeout(timer);
    if (ended && visible()) void load(false);
    else schedule();
  }, resume: () => queueMicrotask(() => { if (!initialized && visible()) void load(false); else schedule(); }), dispose() {
    disposed = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', visibility);
  } };
}
