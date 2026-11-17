import { t, subscribeUiLanguage } from '../../../packages/components/ui-language.js';
import { compactSelect } from '../ui/compact-select.js';
export function createParallelChats({ beforeSwitch, status }) {
  const root = document.createElement('nav');
  root.className = 'parallel-chat-tabs';
  root.setAttribute('aria-label', '对话切换');
  const history = document.createElement('div'),
    heading = document.createElement('strong'),
    trigger = document.createElement('button');
  history.className = 'parallel-chat-history';
  history.id = 'parallel-chat-history';
  history.popover = 'auto';
  trigger.className = 'parallel-history-toggle';
  trigger.type = 'button';
  trigger.setAttribute('popovertarget', history.id);
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>';
  const label = () => {
    heading.textContent = t('历史与执行记录');
    trigger.title = heading.textContent;
    trigger.setAttribute('aria-label', heading.textContent);
  };
  subscribeUiLanguage(label);
  label();
  history.append(heading, root);
  document.body.append(history);
  document
    .querySelector('.chat-actions')
    .insertBefore(
      trigger,
      document.querySelector('.chat-search-toggle') || document.getElementById('chat-close'),
    );
  const position = () => {
    const rect = trigger.getBoundingClientRect();
    history.style.width = Math.min(350, innerWidth - 24) + 'px';
    history.style.left =
      Math.max(
        12,
        Math.min(rect.right - history.offsetWidth, innerWidth - history.offsetWidth - 12),
      ) + 'px';
    history.style.top = Math.min(rect.bottom + 8, innerHeight - history.offsetHeight - 12) + 'px';
  };
  history.addEventListener('toggle', () => {
    const opened = history.matches(':popover-open');
    trigger.setAttribute('aria-expanded', String(opened));
    if (opened) position();
  });
  window.addEventListener('resize', () => {
    if (history.matches(':popover-open')) position();
  });
  const select = document.createElement('select');
  select.className = 'conversation-picker';
  select.setAttribute('aria-label', '切换对话');
  const count = document.createElement('span');
  count.className = 'conversation-count';
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '＋ 新对话';
  const more = document.createElement('button');
  more.type = 'button';
  {
    const chevron = document.createElement('span');
    chevron.className = 'ui-chevron';
    chevron.style.margin = '0';
    more.append(chevron);
  }
  more.title = '选择其他 AI 新建对话';
  more.setAttribute('aria-label', more.title);
  more.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'conversation-new-menu';
  menu.hidden = true;
  root.append(select, count, add, more, menu);
  const picker = compactSelect(select, {
    label: '切换对话',
    description: (option) => option.dataset.detail || '',
  });
  history.append(
    document.getElementById(
      root.querySelector('.compact-select-trigger').getAttribute('aria-controls'),
    ),
  );
  const style = document.createElement('style');
  style.textContent = `.parallel-chat-history>summary{cursor:pointer;padding:6px 14px;color:#526078;font-size:12px}.chat.file-chat .parallel-chat-history{display:none}.parallel-chat-tabs{position:relative;display:flex;align-items:center;gap:5px;padding:7px 12px;border-bottom:1px solid #edf0f4;flex-shrink:0;min-width:0;z-index:15}.parallel-chat-tabs button,.parallel-chat-tabs select{border:0;border-radius:8px;padding:7px 9px;background:#f5f6f8;color:#596579;font:inherit;font-size:12px;cursor:pointer}.parallel-chat-tabs .conversation-picker{flex:1;min-width:0;max-width:100%;text-overflow:ellipsis;background:transparent;color:#283448}.parallel-chat-tabs>button{flex-shrink:0;white-space:nowrap}.conversation-count{font-size:10px;color:#718096;white-space:nowrap}.conversation-count:empty{display:none}.conversation-new-menu{position:absolute;right:12px;top:100%;padding:6px;border:1px solid #e5e9ef;border-radius:10px;background:white;box-shadow:0 8px 24px #23354a15;min-width:180px}.conversation-new-menu button{display:block;width:100%;text-align:left;background:transparent}.conversation-new-menu button:hover{background:#edf4ff}.conversation-new-menu[hidden],.chat.file-chat .parallel-chat-tabs{display:none!important}`;
  document.head.append(style);
  let snapshot = { items: [], current: null },
    switching = false,
    ready = false,
    pendingId = null;
  const unread = new Set();
  function close() {
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
  }
  async function open(id, provider) {
    if (switching || !ready || id === snapshot.current) return;
    close();
    switching = true;
    pendingId = id;
    render();
    try {
      await beforeSwitch();
      if (provider && provider !== 'codex') await window.desktop.aiTools('new', { provider });
      else await window.desktop.switchThread(id);
      unread.delete(id);
    } catch (e) {
      status.textContent = e.message;
    } finally {
      switching = false;
      pendingId = null;
      render();
    }
  }
  function render() {
    select.replaceChildren();
    for (const item of snapshot.items) {
      const option = document.createElement('option');
      option.value = item.id;
      const flag = item.waiting
        ? '待审批'
        : item.running
          ? '执行中'
          : unread.has(item.id)
            ? '已完成'
            : '';
      option.textContent = item.name || '新对话';
      option.dataset.detail = [item.provider === 'codex' ? 'Codex' : item.provider, flag]
        .filter(Boolean)
        .join(' · ');
      select.append(option);
    }
    select.value = snapshot.current || '';
    select.disabled = switching || !ready;
    select.title = select.selectedOptions[0]?.textContent || '切换对话';
    const running = snapshot.items.filter((x) => x.running).length;
    count.textContent = running ? `${running} 个运行中` : '';
    add.textContent = pendingId === 'new' ? '正在创建…' : '＋ 新对话';
    add.disabled = more.disabled = switching || !ready;
    root.setAttribute('aria-busy', String(switching));
  }
  select.onchange = () => void open(select.value);
  select.onfocus = close;
  add.onclick = () => void open('new', document.documentElement.dataset.cliProvider || 'codex');
  more.onclick = async () => {
    picker.close();
    if (!menu.hidden) {
      close();
      return;
    }
    menu.replaceChildren();
    menu.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    const entry = (label, id) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.onclick = () => void open('new', id);
      menu.append(button);
    };
    entry('Codex CLI', 'codex');
    try {
      for (const tool of await window.desktop.aiTools('list'))
        if (tool.installed && tool.supported && tool.id !== 'codex') entry(tool.name, tool.id);
    } catch (e) {
      status.textContent = e.message;
    }
  };
  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target)) close();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      more.focus();
      event.stopPropagation();
    }
  });
  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'ready' || type === 'thread-switched') ready = true;
    if (type === 'connecting' || type === 'connection-error') ready = false;
    if (type === 'sessions') {
      snapshot = payload;
      unread.delete(payload.current);
      render();
    }
    if (type === 'background-completed') {
      unread.add(payload.threadId);
      status.textContent = `${payload.name || '后台对话'}：${payload.status === 'completed' ? '已完成' : '已结束，请查看状态'}`;
      render();
    }
    if (type === 'thread-navigation') {
      switching = payload;
      render();
    }
    if (type === 'ready' || type === 'connection-error') render();
  });
  render();
}
