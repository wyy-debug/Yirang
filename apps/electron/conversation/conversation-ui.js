import { bindUiLabel } from '../ui/ui-labels.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
export function createConversationUI({ input, status, surface, changed }) {
  let id = 'unbound',
    timer,
    loading = 0,
    initializing = null,
    orphan = '',
    saving = Promise.resolve(),
    state = { queue: [], paused: false };
  const host = document.createElement('details'),
    title = document.createElement('summary'),
    body = document.createElement('div');
  host.className = 'conversation-queue';
  host.append(title, body);
  document.querySelector('.composer-tools').before(host);
  const savedDrafts = new Map();
  const storageKey = (key) => `desktop:conversation-draft:${key}`;
  function preserve() {
    void window.desktop.draftPresence(id, !!input.value.trim()).catch(() => {});
    try {
      localStorage.setItem(storageKey(id), input.value);
    } catch {
      bindUiLabel(status, 'textContent', '草稿空间不足，请先保存输入内容');
    }
  }
  function save() {
    clearTimeout(timer);
    preserve();
    const target = id,
      text = input.value,
      cached = savedDrafts.get(target);
    if (cached?.text === text) return cached.promise;
    const next = saving
      .catch(() => {})
      .then(() => window.desktop.conversation('draft', { threadId: target, text }));
    saving = next;
    savedDrafts.set(target, { text, promise: next });
    void next.catch(() => {
      if (savedDrafts.get(target)?.promise === next) savedDrafts.delete(target);
    });
    return next;
  }
  function button(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        b.disabled = false;
      }
    };
    return b;
  }
  function render() {
    const queue = state.queue.filter((item) => item.state !== 'sent');
    host.hidden = !queue.length && !orphan;
    bindUiLabel(title, 'textContent', '待发送 {0} 条{1}', {
      0: queue.length,
      1: state.paused ? uiText(' · 已暂停') : '',
    });
    body.replaceChildren();
    if (orphan)
      body.append(
        button(uiText('恢复未关联的草稿'), async () => {
          input.value = [input.value, orphan].filter(Boolean).join('\n');
          await save();
          await window.desktop.conversation('draft', { threadId: 'unbound', text: '' });
          localStorage.removeItem(storageKey('unbound'));
          orphan = '';
          surface.fitInput();
          render();
          changed();
        }),
      );
    body.append(
      button(state.paused ? uiText('继续队列') : uiText('暂停队列'), () =>
        window.desktop.conversation('pause', { threadId: id, paused: !state.paused }),
      ),
    );
    for (const item of queue) {
      const row = document.createElement('div'),
        text = document.createElement('textarea'),
        label = document.createElement('small'),
        actions = document.createElement('div');
      row.className = 'queue-row';
      text.value = item.text;
      text.rows = 2;
      text.disabled = item.state !== 'queued' || !state.paused;
      label.textContent =
        item.error ||
        {
          queued: state.paused
            ? uiText('暂停中 · 修改后点击保存，再继续队列')
            : uiText('按顺序发送 · 暂停后可编辑 · 材料固定为排队时的引用'),
          sending: uiText('正在发送'),
          uncertain: uiText('发送未确认'),
          failed: uiText('发送失败'),
        }[item.state] ||
        item.state;
      row.append(text, label, actions);
      if (item.state === 'queued' && state.paused)
        actions.append(
          button(uiText('保存修改'), () =>
            window.desktop.conversation('edit', { threadId: id, id: item.id, text: text.value }),
          ),
          button(uiText('上移'), () =>
            window.desktop.conversation('move', { threadId: id, id: item.id, delta: -1 }),
          ),
          button(uiText('下移'), () =>
            window.desktop.conversation('move', { threadId: id, id: item.id, delta: 1 }),
          ),
        );
      if (['uncertain', 'failed'].includes(item.state))
        actions.append(
          button(uiText('重新排队'), async () => {
            if (
              confirm(
                uiText('请先查看对话历史，确认这条消息需要再次发送。重新排队可能重复执行原任务。'),
              )
            )
              await window.desktop.conversation('retry', { threadId: id, id: item.id });
          }),
        );
      if (item.state !== 'sending')
        actions.append(
          button(uiText('移除'), () =>
            window.desktop.conversation('remove', { threadId: id, id: item.id }),
          ),
        );
      body.append(row);
    }
  }
  input.addEventListener('input', () => {
    preserve();
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        void save().catch((error) => {
          status.textContent = error.message;
        }),
      450,
    );
  });
  window.addEventListener('pagehide', preserve);
  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'conversation-state' && payload.threadId === id) {
      state = payload;
      render();
    }
  });
  return {
    checkpoint() {
      void save().catch((error) => {
        status.textContent = error.message;
      });
    },
    openFresh(next) {
      // Capture the old draft before changing its owner. Disk writes keep their
      // ordering, but an empty composer never waits for them.
      void save().catch((error) => {
        status.textContent = error.message;
      });
      ++loading;
      id = next;
      input.value = '';
      input.readOnly = false;
      state = { queue: [], paused: false };
      orphan = '';
      savedDrafts.set(next, { text: '', promise: Promise.resolve() });
      preserve();
      surface.fitInput();
      render();
      changed();
    },
    async adopt(next, previous) {
      if (id !== previous) return this.switchTo(next);
      clearTimeout(timer);
      savedDrafts.delete(previous);
      try {
        localStorage.removeItem(storageKey(previous));
      } catch {}
      id = next;
      const serial = ++loading;
      preserve();
      const saved = await window.desktop.conversation('get', { threadId: next });
      if (serial !== loading) return;
      state = saved;
      await save();
      render();
      changed();
    },
    async switchTo(next) {
      const serial = ++loading;
      if (initializing) await initializing;
      if (serial !== loading) return;
      next = next || 'unbound';
      if (next === id) {
        const saved = await window.desktop.conversation('get', { threadId: id });
        if (serial === loading) {
          state = saved;
          render();
        }
        return;
      }
      input.readOnly = true;
      changed();
      try {
        await save();
        const old = id,
          oldText = input.value,
          saved = await window.desktop.conversation('get', { threadId: next });
        if (serial !== loading) return;
        id = next;
        state = saved;
        savedDrafts.set(next, { text: saved.draft || '', promise: Promise.resolve() });
        let local;
        try {
          local = localStorage.getItem(storageKey(next));
        } catch {}
        input.value = local ?? saved.draft ?? '';
        if (old === 'unbound' && oldText) {
          if (!input.value) {
            input.value = oldText;
            await save();
            await window.desktop.conversation('draft', { threadId: 'unbound', text: '' });
            try {
              localStorage.removeItem(storageKey('unbound'));
            } catch {}
          } else orphan = oldText;
        }
        surface.fitInput();
        render();
      } finally {
        if (serial === loading) {
          input.readOnly = false;
          changed();
        }
      }
    },
    init() {
      if (initializing) return initializing;
      const owner = id,
        before = input.value;
      let stored = null;
      try {
        stored = localStorage.getItem(storageKey(id));
        input.value = stored ?? input.value;
      } catch {}
      const local = input.value;
      surface.fitInput();
      initializing = window.desktop.conversation('get', { threadId: owner }).then((saved) => {
        if (id !== owner) return;
        savedDrafts.set(id, { text: saved.draft || '', promise: Promise.resolve() });
        if (input.value === local) input.value = stored !== null ? local : saved.draft || before;
        state = saved;
        surface.fitInput();
        render();
        changed();
      });
      return initializing;
    },
    async enqueue(override) {
      const owner = id,
        before = input.value,
        text = override ?? before;
      await window.desktop.conversation('enqueue', { threadId: owner, text });
      if (id !== owner) return;
      if (input.value === before) {
        input.value = '';
        await save();
      }
      surface.fitInput();
      changed();
      host.open = true;
    },
    flush: save,
    changed() {
      preserve();
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          void save().catch((error) => {
            status.textContent = error.message;
          }),
        450,
      );
    },
  };
}
