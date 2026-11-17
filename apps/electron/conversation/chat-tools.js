import { createSettingsLayout } from '../settings/settings-layout.js';
import { bindUiLabel } from '../ui/ui-labels.js';
import { subscribeUiLanguage, getUiLanguage } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { createLanguageSetting } from '../settings/language-settings.js';
import { createAppearanceSetting } from '../settings/appearance-settings.js';
import { createProjectNavigation } from '../workspace/project-navigation.js';
export function createChatTools({
  messages,
  status,
  threadList,
  thread,
  history,
  state,
  surface,
  beforeSwitch,
}) {
  let turns = [],
    cursor = null,
    hasMore = true,
    settingsCategory = 'general',
    settingsLifetime;
  async function refreshHistory() {
    const id = state().threadId;
    if (!id) return;
    const latest = await window.desktop.chat('history', { threadId: id });
    if (state().threadId !== id) return;
    const ids = new Set(latest.data.map((turn) => turn.id));
    turns = [...turns.filter((turn) => !ids.has(turn.id)), ...latest.data.reverse()];
  }
  const button = (label, action) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = uiText(label);
    b.onclick = async () => {
      b.disabled = true;
      try {
        await action(b);
      } catch (error) {
        const panel = modal.open ? modal.querySelector('.settings-category:not([hidden])') : null;
        if (panel) {
          let errorNode = panel.querySelector('.settings-action-error');
          if (!errorNode) {
            errorNode = document.createElement('p');
            errorNode.className = 'settings-action-error';
            errorNode.setAttribute('role', 'alert');
            panel.prepend(errorNode);
          }
          errorNode.textContent = error.message;
        } else status.textContent = error.message;
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };
  const bar = document.createElement('div');
  bar.className = 'chat-utilities';
  const older = button(uiText('更早消息'), async () => {
    if (!state().threadId || state().running) return;
    await refreshHistory();
    const id = state().threadId,
      known = new Set(turns.map((turn) => turn.id)),
      savedHeight = messages.scrollHeight;
    let added = [];
    for (let page = 0; page < 6; page++) {
      const result = await window.desktop.chat('history', { threadId: id, cursor });
      if (state().threadId !== id) return;
      cursor = result.nextCursor || null;
      hasMore = !!cursor;
      added = result.data.filter((turn) => !known.has(turn.id));
      if (added.length || !hasMore) break;
    }
    const nextCursor = cursor,
      more = hasMore;
    history([...added.reverse(), ...turns], true, nextCursor);
    cursor = nextCursor;
    hasMore = more;
    older.hidden = !hasMore;
    messages.scrollTop = messages.scrollHeight - savedHeight;
  });
  const search = document.createElement('input');
  search.type = 'search';
  bindUiLabel(search, 'placeholder', '查找当前对话');
  bindUiLabel(search, 'aria-label', '查找当前对话');
  search.oninput = () => {
    for (const node of messages.querySelectorAll('.message'))
      node.hidden =
        !!search.value && !node.textContent.toLowerCase().includes(search.value.toLowerCase());
  };
  bar.append(older, search);
  bar.hidden = true;
  bar.id = 'chat-search-tools';
  document.querySelector('.chat-body').before(bar);
  const searchToggle = document.createElement('button');
  searchToggle.type = 'button';
  searchToggle.className = 'chat-search-toggle';
  searchToggle.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>';
  bindUiLabel(searchToggle, 'aria-label', '查找消息与材料');
  bindUiLabel(searchToggle, 'title', '查找消息与材料');
  searchToggle.setAttribute('aria-controls', bar.id);
  searchToggle.setAttribute('aria-expanded', 'false');
  document
    .querySelector('.chat-actions')
    .insertBefore(searchToggle, document.getElementById('chat-close'));
  const showSearch = (show) => {
    bar.hidden = !show;
    searchToggle.setAttribute('aria-expanded', String(show));
    if (show) search.focus();
    else {
      search.value = '';
      search.oninput();
      searchToggle.focus();
    }
  };
  searchToggle.onclick = () => showSearch(bar.hidden);
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      showSearch(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'f' &&
      document.getElementById('chat')?.contains(document.activeElement)
    ) {
      event.preventDefault();
      showSearch(true);
    }
  });
  const modal = document.createElement('dialog');
  modal.className = 'desktop-settings';
  document.body.append(modal);
  modal.addEventListener('close', () => {
    settingsLifetime?.abort();
    surface.onOverlay?.(false);
  });
  createProjectNavigation({ thread, threadList, status, state, beforeSwitch });
  async function openSettings(category) {
    settingsLifetime?.abort();
    settingsLifetime = new AbortController();
    modal.replaceChildren();
    modal.classList.add('organized-settings');
    const header = document.createElement('header'),
      title = document.createElement('h2');
    title.id = 'desktop-settings-title';
    title.textContent = uiText('设置');
    modal.setAttribute('aria-labelledby', title.id);
    const close = button(uiText('关闭'), () => modal.close());
    close.className = 'settings-close';
    close.title = close.textContent;
    close.setAttribute('aria-label', close.textContent);
    close.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
    header.append(title, close);
    modal.append(header);
    const { sections, row } = createSettingsLayout(modal, category ?? settingsCategory, (id) => {
      settingsCategory = id;
    });
    sections.general.append(createLanguageSetting(), createAppearanceSetting());
    row('ai', '模型与思考强度', '选择 AI 使用的模型和思考强度。', [
      button(uiText('选择模型'), () => {
        modal.close();
        window.dispatchEvent(new Event('desktop-show-model'));
      }),
    ]);
    row('ai', '操作权限', '选择需要授权的操作由你批准，还是交给 AI 审查。', [
      button('权限与审批', () => {
        modal.close();
        window.dispatchEvent(new Event('desktop-show-permissions'));
      }),
    ]);
    const notice = document.createElement('p');
    notice.setAttribute('role', 'status');
    row('ai', '账号', '管理登录状态，查看使用额度。', [
      button(uiText('账号与额度'), () => {
        modal.close();
        window.dispatchEvent(new Event('desktop-show-quota'));
      }),
      button(uiText('登录 Codex'), async () => {
        const result = await window.desktop.chat('login');
        notice.textContent =
          result.method === 'port-blocked'
            ? uiText(
                result.canImport
                  ? '浏览器登录无法完成（本机登录端口被占用或拦截）。可以改用「导入当前 Codex 登录」。'
                  : '浏览器登录无法完成（本机登录端口被占用或拦截），也没有找到可导入的 Codex 登录。请先在 Codex 中登录。',
              )
            : uiText('请在打开的浏览器完成登录');
      }),
      button(uiText('导入当前 Codex 登录'), async () => {
        try {
          await window.desktop.chat('import-login');
          await window.desktop.reconnect();
          window.dispatchEvent(new Event('desktop-auth-imported'));
          notice.textContent = uiText('已导入当前 Codex 登录。');
        } catch (error) { notice.textContent = error.message; }
      }),
    ]);
    sections.ai.append(notice);
    window.dispatchEvent(
      new CustomEvent('desktop-settings-open', {
        detail: { modal, button, sections, row, signal: settingsLifetime.signal },
      }),
    );
    if (!modal.open) modal.showModal();
  }
  subscribeUiLanguage(() => {
    bindUiLabel(older, 'textContent', '更早消息');
    bindUiLabel(search, 'placeholder', '查找当前对话');
    search.setAttribute('aria-label', search.placeholder);
    if (modal.open) void openSettings();
  });
  return {
    revealSearch: () => showSearch(true),
    setHistory(value, nextCursor = null) {
      turns = value;
      cursor = nextCursor;
      hasMore = !!cursor;
      older.hidden = !hasMore;
      search.value = '';
    },
    async completed() {
      try {
        await refreshHistory();
      } catch {}
    },
    openSettings,
  };
}
