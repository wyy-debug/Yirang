import { bindUiLabel } from '../ui/ui-labels.js';
import { subscribeUiLanguage, getUiLanguage } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import {
  defaultScreenshotShortcut,
  defaultFileAiShortcut,
  fileAiShortcutLabel,
  fileAiShortcutError,
  fileAiMouseShortcut,
  listenFileAiMouseShortcut,
  matchesFileAiShortcut,
  validFileAiShortcut,
} from '../../../packages/components/file-ai-shortcut.js';

// Keep reference ownership on the selected conversation; busy turns continue in the background.
export function createFileAiInteraction({
  frame,
  surface,
  status,
  canStart,
  prepareConversation,
  preparing,
  clearReference,
}) {
  const key = 'ai-desktop:file-ai-shortcut:v1';
  let screenshotShortcut = defaultScreenshotShortcut;
  try {
    const saved = JSON.parse(localStorage.getItem('ai-desktop:screenshot-shortcut:v1') || 'null');
    if (validFileAiShortcut(saved)) screenshotShortcut = saved;
  } catch {}
  let shortcut = defaultFileAiShortcut,
    armed = false,
    pending = null,
    closing = false,
    switchingConversation = false;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (validFileAiShortcut(saved)) shortcut = saved;
  } catch {}
  const post = (value) => frame.contentWindow?.postMessage(value, '*');
  const publish = () => {
    post({ type: 'ai-desktop:file-ai-config', shortcut });
    post({ type: 'ai-desktop:screenshot-config', shortcut: screenshotShortcut });
    const hint = document.getElementById('file-ai-shortcut-hint');
    if (hint)
      bindUiLabel(hint, 'textContent', '{0} · 点击文件提问', { 0: fileAiShortcutLabel(shortcut) });
  };
  const saveShortcut = (value) => {
    const error = fileAiShortcutError(value);
    if (error) return error;
    if (fileAiShortcutLabel(value) === fileAiShortcutLabel(screenshotShortcut))
      return '此组合已用于截图问 AI，请选择其他快捷键';
    try {
      localStorage.setItem(key, JSON.stringify(value));
      shortcut = value;
      mode(false);
      publish();
      return null;
    } catch {
      return uiText('快捷键未能保存，请重试。');
    }
  };
  function saveScreenshot(value) {
    const error = fileAiShortcutError(value);
    if (error) return error;
    if (fileAiShortcutLabel(value) === fileAiShortcutLabel(shortcut))
      return '此组合已用于文件 AI，请选择其他快捷键';
    try {
      localStorage.setItem('ai-desktop:screenshot-shortcut:v1', JSON.stringify(value));
      screenshotShortcut = value;
      publish();
      return null;
    } catch {
      return '快捷键未能保存，请重试';
    }
  }
  function startScreenshot() {
    frame.contentWindow?.focus();
    post({ type: 'ai-desktop:screenshot-start' });
  }
  function mode(value) {
    armed = value;
    post({ type: 'ai-desktop:file-ai-mode', active: value });
  }
  function toggle() {
    if (pending || closing || surface.isPanelModal()) return;
    if (!canStart()) {
      bindUiLabel(status, 'textContent', '请先完成当前操作或等待 AI 连接，再唤起文件提问。');
      surface.setOpen(true);
      return;
    }
    mode(!armed);
    if (armed) frame.contentWindow?.focus();
  }
  function finish(ok) {
    if (closing && pending) {
      clearTimeout(pending.timer);
      pending = null;
      void endReference();
      return;
    }
    if (!pending) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    preparing(!ok);
    if (ok) status.textContent = '';
    else {
      bindUiLabel(status, 'textContent', '材料引用未完成，请用快捷键重新点击文件。');
      surface.setFileTitle(uiText('引用未完成'));
    }
    surface.setFilePending(false, !ok);
    if (ok && surface.isOpen() && !surface.isPanelModal())
      document.getElementById('input').focus({ preventScroll: true });
  }
  async function endReference() {
    try {
      await clearReference();
      surface.clearFileSession();
      status.textContent = '';
      preparing(false);
      surface.setFilePending(false);
    } catch (error) {
      status.textContent = error.message;
      preparing(true);
      surface.setFilePending(false, true);
    } finally {
      closing = false;
    }
  }
  window.addEventListener('file-chat-close', () => {
    mode(false);
    closing = true;
    preparing(true);
    if (pending) post({ type: 'ai-desktop:file-ai-dismiss', id: pending.id });
    else void endReference();
  });
  window.addEventListener('keydown', (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      surface.isPanelModal() ||
      document.querySelector('dialog[open]')
    )
      return;
    if (matchesFileAiShortcut(event, screenshotShortcut)) {
      event.preventDefault();
      if (!event.repeat) startScreenshot();
      return;
    }
    if (matchesFileAiShortcut(event, shortcut)) {
      event.preventDefault();
      if (!event.repeat) toggle();
    }
  });
  listenFileAiMouseShortcut(
    () => screenshotShortcut,
    () => surface.isPanelModal() || !!document.querySelector('dialog[open]'),
    startScreenshot,
  );
  listenFileAiMouseShortcut(
    () => shortcut,
    () => !!document.querySelector('dialog[open]'),
    toggle,
  );
  window.addEventListener('message', async (event) => {
    if (event.source !== frame.contentWindow) return;
    const value = event.data;
    if (value?.type === 'ai-desktop:file-ai-config-request') {
      publish();
      surface.publishLayout();
      return;
    }
    if (value?.type === 'ai-desktop:file-ai-config-save') {
      if (typeof value.id !== 'string' || value.id.length > 100) return;
      const error = saveShortcut(value.shortcut);
      post({ type: 'ai-desktop:file-ai-config-saved', id: value.id, error, shortcut });
      return;
    }
    if (value?.type === 'ai-desktop:file-ai-toggle') {
      toggle();
      return;
    }
    if (value?.type === 'ai-desktop:file-ai-cancel') {
      mode(false);
      return;
    }
    if (value?.type === 'ai-desktop:file-ai-close') {
      surface.dismissFile();
      return;
    }
    if (value?.type === 'ai-desktop:file-ai-result' && pending?.id === value.id) {
      finish(value.ok === true);
      return;
    }
    if (value?.type !== 'ai-desktop:file-ai-target') return;
    mode(false);
    const a = value.anchor;
    if (
      pending ||
      closing ||
      !canStart() ||
      typeof value.id !== 'string' ||
      value.id.length > 100 ||
      typeof value.title !== 'string' ||
      !a ||
      ![a.x, a.y, a.left, a.right, a.top, a.bottom].every(Number.isFinite)
    ) {
      post({ type: 'ai-desktop:file-ai-rejected', id: value.id });
      return;
    }
    const bounds = frame.getBoundingClientRect();
    const anchor = {
      x: bounds.left + a.x,
      y: bounds.top + a.y,
      left: bounds.left + a.left,
      right: bounds.left + a.right,
      top: bounds.top + a.top,
      bottom: bounds.top + a.bottom,
    };
    pending = {
      id: value.id,
      timer: setTimeout(() => {
        if (closing) return;
        post({ type: 'ai-desktop:file-ai-rejected', id: value.id });
        finish(false);
      }, 60000),
    };
    preparing(true);
    try {
      switchingConversation = true;
      await prepareConversation?.();
      if (pending?.id !== value.id || closing) return;
      surface.openAt(anchor, value.title.slice(0, 180));
      surface.setFilePending(true);
      bindUiLabel(status, 'textContent', '正在引用材料…');
      post({ type: 'ai-desktop:file-ai-prepare', id: value.id });
    } catch (error) {
      post({ type: 'ai-desktop:file-ai-rejected', id: value.id });
      if (pending?.id === value.id) {
        clearTimeout(pending.timer);
        pending = null;
        preparing(false);
        surface.setFilePending(false, true);
      }
      status.textContent = error.message;
    } finally {
      switchingConversation = false;
    }
  });
  frame.addEventListener('load', () => {
    mode(false);
    if (pending) finish(false);
    publish();
  });
  window.addEventListener('blur', () => {
    if (!document.hasFocus()) mode(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) mode(false);
  });
  window.addEventListener('file-chat-exit', () => {
    if (!pending && !closing) {
      preparing(false);
      surface.setFilePending(false);
    }
  });
  window.addEventListener('desktop-settings-open', (event) => {
    for (const screenshot of [false, true]) {
      const chosen = () => (screenshot ? screenshotShortcut : shortcut);
      const { modal, button } = event.detail,
        section = document.createElement('section'),
        heading = document.createElement('h3'),
        label = document.createElement('label'),
        input = document.createElement('input'),
        note = document.createElement('p');
      section.className = 'settings-file-ai';
      bindUiLabel(heading, 'textContent', screenshot ? '截图问 AI 快捷键' : '文件 AI 快捷键');
      input.readOnly = true;
      input.value = fileAiShortcutLabel(chosen());
      bindUiLabel(input, 'aria-label', screenshot ? '录入截图快捷键' : '录入文件 AI 快捷键');
      bindUiLabel(input, 'title', '点击后按键盘组合键或鼠标侧键');
      bindUiLabel(
        note,
        'textContent',
        screenshot
          ? '按下快捷键后框选画布上的区域，截图会连同相关文件一起发给 AI。默认 Ctrl+Shift+S。'
          : '按下快捷键后点击文件，就能针对这个文件向 AI 提问。按 Esc 取消。',
      );
      const save = (value) => {
        const error = screenshot ? saveScreenshot(value) : saveShortcut(value);
        input.value = fileAiShortcutLabel(chosen());
        note.textContent =
          error ??
          (screenshot
            ? uiText('已保存，新的截图快捷键立即生效。')
            : uiText('已保存。按快捷键，再点击文件即可提问。'));
      };
      input.addEventListener('keydown', (event) => {
        if (['Tab', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat || event.isComposing) return;
        const value = {
          code: event.code,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        };
        save(value);
      });
      let capturedMouse = null;
      modal.addEventListener(
        'pointerdown',
        (event) => {
          const value = fileAiMouseShortcut(event);
          if (!value || document.activeElement !== input) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          capturedMouse = event.button;
          save(value);
        },
        { capture: true, signal: event.detail.signal },
      );
      for (const type of ['mouseup', 'auxclick'])
        modal.addEventListener(
          type,
          (event) => {
            if (capturedMouse !== event.button) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (type === 'auxclick') capturedMouse = null;
          },
          { capture: true, signal: event.detail.signal },
        );
      const actions = document.createElement('div');
      actions.className = 'settings-actions';
      label.append(input);
      actions.append(
        label,
        button(uiText('恢复默认快捷键'), () =>
          save(screenshot ? defaultScreenshotShortcut : defaultFileAiShortcut),
        ),
      );
      const copy = document.createElement('div');
      copy.append(heading, note);
      section.append(copy, actions);
      event.detail.sections.general.append(section);
    }
  });
  subscribeUiLanguage(publish);
  publish();
  return {
    isPreparing: () => !!pending || closing,
    isSwitchingConversation: () => switchingConversation,
    cancel() {
      mode(false);
    },
  };
}
