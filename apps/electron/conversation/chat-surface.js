import { bindUiLabel } from '../ui/ui-labels.js';
import { subscribeUiLanguage, getUiLanguage } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { fileChatPosition } from '../composer/file-chat-position.js';
/* Presentation only: sending, permissions and material writeback stay in shell.js. */
export function createChatSurface({ frame, onLayoutStart, onLayoutEnd }) {
  const root = document.querySelector('.app-shell'),
    desk = document.querySelector('.desk'),
    chat = document.getElementById('chat');
  const toggle = document.getElementById('chat-toggle'),
    close = document.getElementById('chat-close'),
    resize = document.getElementById('chat-resize');
  const messages = document.getElementById('messages'),
    input = document.getElementById('input'),
    latest = document.getElementById('latest-message');
  const body = messages.closest('.chat-body');
  const scrollSurface = () => messages;
  const selection = document.getElementById('selection'),
    selectionLabel = document.getElementById('selection-label'),
    threadList = document.getElementById('thread-list');
  const progress = document.getElementById('chat-progress'),
    progressLabel = document.getElementById('progress-label'),
    progressTime = document.getElementById('progress-time');
  const preferenceKey = 'ai-desktop:conversation-sidebar:v1';
  let preferences = {};
  try {
    preferences = JSON.parse(localStorage.getItem(preferenceKey) || '{}') || {};
  } catch {}
  const defaultWidth = () => (innerWidth >= 1900 ? 420 : innerWidth <= 1100 ? 340 : 390);
  const maximumWidth = () => Math.max(320, Math.min(560, innerWidth - 640));
  const clampWidth = (value) => Math.round(Math.max(320, Math.min(maximumWidth(), value)));
  let preferredWidth = Number.isFinite(preferences.width) ? preferences.width : defaultWidth();
  let open = preferences.open === true,
    following = true,
    unread = false,
    drag = null,
    layoutTimer = null;
  let state = 'connecting',
    hadContent = false;
  let fileAnchor = null,
    fileSession = false,
    panelModal = false;
  const fileTitle = document.getElementById('file-chat-title'),
    fileHistory = document.getElementById('file-chat-history'),
    fileDock = document.getElementById('file-chat-dock');
  const contact = document.createElement('div');
  contact.className = 'file-ai-contact';
  contact.hidden = true;
  contact.setAttribute('aria-hidden', 'true');
  root.append(contact);
  function positionFileChat() {
    if (!fileAnchor) return;
    const expanded = chat.classList.contains('file-chat-expanded');
    const rect = fileChatPosition(
      fileAnchor,
      410,
      expanded ? Math.min(560, innerHeight - 24) : chat.scrollHeight,
      { width: innerWidth, height: innerHeight },
    );
    chat.style.left = `${rect.left}px`;
    chat.style.top = `${rect.top}px`;
    chat.style.width = `${rect.width}px`;
    chat.style.setProperty('--file-chat-height', `${rect.height}px`);
  }
  function expandFileChat(value) {
    chat.classList.toggle('file-chat-expanded', value);
    fileHistory.setAttribute('aria-expanded', String(value));
    bindUiLabel(fileHistory, 'textContent', value ? '收起记录' : '查看记录');
    positionFileChat();
    if (value) requestAnimationFrame(scrollLatest);
  }
  function resetFileAnchor() {
    fileAnchor = null;
    root.classList.remove('file-chat-open');
    chat.classList.remove('file-chat', 'file-chat-expanded');
    for (const property of ['left', 'top', 'width', '--file-chat-height'])
      chat.style.removeProperty(property);
    fileTitle.textContent = '';
    fileTitle.title = '';
    bindUiLabel(close, 'title', '收起对话');
    bindUiLabel(close, 'aria-label', '收起对话');
    bindUiLabel(input, 'placeholder', '提问，或交办一件事…');
  }
  function dock() {
    resetFileAnchor();
    window.dispatchEvent(new Event('file-chat-exit'));
    beginLayout();
    setOpen(true);
  }
  function openAt(anchor, title) {
    fileSession = true;
    fileAnchor = anchor;
    bindUiLabel(fileTitle, 'textContent', '询问 AI');
    fileTitle.title = title;
    bindUiLabel(close, 'title', '关闭提问 · Esc');
    bindUiLabel(close, 'aria-label', '关闭提问');
    root.classList.add('file-chat-open');
    chat.classList.add('file-chat');
    expandFileChat(false);
    bindUiLabel(fileHistory, 'textContent', '在侧边查看对话');
    contact.hidden = false;
    contact.style.left = `${anchor.x}px`;
    contact.style.top = `${anchor.y}px`;
    contact.getAnimations().forEach((animation) => animation.cancel());
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      contact.animate(
        [
          { opacity: 0.85, transform: 'translate(-50%,-50%) scale(.15)' },
          { opacity: 0, transform: 'translate(-50%,-50%) scale(1.6)' },
        ],
        { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' },
      ).onfinish = () => {
        contact.hidden = true;
      };
      chat.animate(
        [
          { opacity: 0.3, transform: 'translateY(6px) scale(.97)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    } else contact.hidden = true;
    bindUiLabel(input, 'placeholder', '想对这份文件做什么？');
    beginLayout();
    setOpen(true, { persist: false });
    positionFileChat();
  }
  function setFilePending(pending, failed = false) {
    chat.setAttribute('aria-busy', String(pending));
    chat.classList.toggle('file-chat-failed', failed);
  }
  fileHistory.onclick = dock;
  fileDock.onclick = dock;
  new ResizeObserver(positionFileChat).observe(chat.querySelector('.compose'));
  function savePreferences() {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({ open, width: preferredWidth }));
    } catch {}
  }
  function publishLayout() {
    frame.contentWindow?.postMessage(
      { type: 'ai-desktop:chat-layout', open: open && !fileAnchor, fileOpen: open && !!fileAnchor },
      '*',
    );
  }
  function dismiss() {
    const wasFloating = !!fileAnchor;
    setOpen(false);
    if (wasFloating) frame.contentWindow?.focus();
  }
  function endLayout() {
    if (drag) return;
    clearTimeout(layoutTimer);
    layoutTimer = null;
    onLayoutEnd();
  }
  function beginLayout() {
    clearTimeout(layoutTimer);
    onLayoutStart();
    layoutTimer = setTimeout(endLayout, 360);
  }
  function applyWidth(value) {
    const width = clampWidth(value);
    root.style.setProperty('--chat-width', `${width}px`);
    resize.setAttribute('aria-valuemax', String(maximumWidth()));
    resize.setAttribute('aria-valuenow', String(width));
    return width;
  }
  function updateToggle() {
    const text = {
      connecting: uiText('正在连接'),
      running: uiText('正在处理'),
      waiting: uiText('等待你的确认'),
      error: uiText('连接需要处理'),
      ready: uiText('打开侧边对话'),
    }[state];
    toggle.title = unread ? uiText('Codex 有新回复，点击查看') : `Codex · ${text}`;
    toggle.setAttribute('aria-label', toggle.title);
    root.dataset.chatUnread = String(unread);
  }
  function fitInput() {
    input.style.height = '44px';
    input.style.height = `${Math.max(44, Math.min(input.scrollHeight, 168))}px`;
  }
  function scrollLatest() {
    following = true;
    latest.hidden = true;
    const surface = scrollSurface();
    surface.scrollTop = surface.scrollHeight;
  }
  function setOpen(value, { focus = true, persist = true, animate = true } = {}) {
    if (!value && drag) endDrag({ pointerId: drag.id }, true);
    const changed = open !== value;
    // Hide before removing floating geometry: otherwise the sidebar exit transition flashes.
    if (changed && !value && fileAnchor) {
      chat.getAnimations().forEach((animation) => animation.cancel());
      chat.style.transition = 'none';
      chat.style.visibility = 'hidden';
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          chat.style.removeProperty('transition');
          chat.style.removeProperty('visibility');
        }),
      );
    }
    if (changed && !value && fileSession) {
      resetFileAnchor();
      window.dispatchEvent(new Event('file-chat-close'));
    }
    if (changed && animate) beginLayout();
    open = value;
    root.classList.toggle('chat-open', open);
    chat.classList.toggle('collapsed', !open);
    toggle.hidden = open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open && chat.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    chat.inert = !open || panelModal;
    chat.setAttribute('aria-hidden', String(!open));
    if (open) {
      unread = false;
      fitInput();
      if (following) requestAnimationFrame(scrollLatest);
      if (focus && !panelModal) input.focus({ preventScroll: true });
    } else {
      threadList.hidden = true;
      window.dispatchEvent(new Event('file-chat-exit'));
    }
    updateToggle();
    publishLayout();
    if (persist) savePreferences();
  }
  function update({ ready, running, failed, waiting }) {
    state = failed
      ? 'error'
      : !ready
        ? 'connecting'
        : waiting
          ? 'waiting'
          : running
            ? 'running'
            : 'ready';
    root.dataset.chatState = state;
    updateToggle();
    progress.hidden = true;
    progressLabel.textContent = waiting ? uiText('等待你的确认') : uiText('正在处理');
    progressTime.textContent = '';
  }
  function contentChanged({ force = false } = {}) {
    const hasContent = !!messages.querySelector('.user,.assistant,.activity,.approval,.output-batch');
    chat.classList.toggle('is-empty', !hasContent);
    hadContent = hasContent;
    // Streaming output never expands the compact question over the document.
    if (force || following) scrollLatest();
    else latest.hidden = false;
  }
  function reset() {
    following = true;
    unread = false;
    hadContent = false;
    contentChanged({ force: true });
    updateToggle();
  }
  function completed() {
    if (!open) {
      unread = true;
      updateToggle();
    }
  }
  function setSelection(blocks, { reveal = true } = {}) {
    const values = Array.isArray(blocks) ? blocks : [];
    const objects = values.find((block) =>
      Array.isArray(block?._meta?.['ai-desktop/selection']?.objects),
    )?._meta['ai-desktop/selection'].objects;
    const titles = objects
      ?.map((object) => object?.title)
      .filter((title) => typeof title === 'string' && title);
    const quote = values.find((block) => block?._meta?.['ai-desktop/quote'])?._meta[
      'ai-desktop/quote'
    ];
    selection.hidden = !values.length;
    selectionLabel.textContent = quote
      ? uiText('{0} · 选中文本', { 0: quote.title })
      : titles?.length === 1
        ? titles[0]
        : titles?.length
          ? uiText('已引用 {0} 份材料', { 0: titles.length })
          : uiText('已引用桌面内容');
    selection.title = quote
      ? quote.text
      : titles?.join('、') || uiText('本条消息会使用这些桌面内容');
    if (values.length && reveal) setOpen(true);
  }
  toggle.onclick = () => {
    if (fileAnchor) dock();
    else setOpen(true);
  };
  close.onclick = dismiss;
  desk.addEventListener('transitionend', (event) => {
    if (event.propertyName === 'right') endLayout();
  });
  frame.addEventListener('load', publishLayout);
  latest.onclick = scrollLatest;
  body.addEventListener(
    'scroll',
    () => {
      const surface = scrollSurface();
      following = surface.scrollHeight - surface.scrollTop - surface.clientHeight < 48;
      latest.hidden = following || !hadContent;
    },
    { passive: true, capture: true },
  );
  messages.addEventListener('toggle', () => contentChanged(), true);
  new ResizeObserver(() => {
    if (following) scrollLatest();
  }).observe(messages);
  document.querySelectorAll('[data-chat-prompt]').forEach((button) => {
    button.onclick = () => {
      input.value = [input.value.trim(), button.dataset.chatPrompt].filter(Boolean).join('\n');
      input.dispatchEvent(new Event('input'));
      setOpen(true);
    };
  });
  document.addEventListener('pointerdown', (event) => {
    if (!threadList.hidden && !event.target.closest('.chat-header')) threadList.hidden = true;
  });
  window.addEventListener('keydown', (event) => {
    if (
      event.defaultPrevented ||
      event.key !== 'Escape' ||
      !open ||
      event.isComposing ||
      panelModal ||
      document.querySelector('dialog[open]')
    )
      return;
    if (!threadList.hidden) {
      threadList.hidden = true;
      document.getElementById('thread').focus();
    } else dismiss();
    event.preventDefault();
  });
  resize.onpointerdown = (event) => {
    if (event.button !== 0 || !open) return;
    event.preventDefault();
    beginLayout();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      width: chat.getBoundingClientRect().width,
      preferredWidth,
    };
    root.classList.add('resizing-chat');
    resize.setPointerCapture(event.pointerId);
  };
  resize.onpointermove = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    applyWidth(drag.width + drag.x - event.clientX);
  };
  function endDrag(event, cancel = false) {
    if (!drag || event.pointerId !== drag.id) return;
    preferredWidth = cancel ? drag.preferredWidth : clampWidth(drag.width + drag.x - event.clientX);
    applyWidth(preferredWidth);
    const id = drag.id;
    drag = null;
    if (resize.hasPointerCapture(id)) resize.releasePointerCapture(id);
    root.classList.remove('resizing-chat');
    savePreferences();
    endLayout();
  }
  resize.onpointerup = (event) => endDrag(event);
  resize.onpointercancel = (event) => endDrag(event, true);
  resize.onlostpointercapture = (event) => endDrag(event, true);
  resize.ondblclick = () => {
    beginLayout();
    preferredWidth = defaultWidth();
    applyWidth(preferredWidth);
    savePreferences();
  };
  resize.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    beginLayout();
    const current = chat.getBoundingClientRect().width;
    preferredWidth =
      event.key === 'Home'
        ? 320
        : event.key === 'End'
          ? maximumWidth()
          : clampWidth(current + (event.key === 'ArrowLeft' ? 24 : -24));
    applyWidth(preferredWidth);
    savePreferences();
  };
  window.addEventListener('resize', () => {
    beginLayout();
    applyWidth(preferredWidth);
    positionFileChat();
  });
  applyWidth(preferredWidth);
  setOpen(open, { focus: false, persist: false, animate: false });
  subscribeUiLanguage(() => {
    updateToggle();
    progressLabel.textContent = state === 'waiting' ? uiText('等待你的确认') : uiText('正在处理');
    input.placeholder = fileAnchor
      ? uiText('想对这份文件做什么？')
      : uiText('输入问题，或描述你想完成的事…');
  });
  return {
    isFileQuestion: () => !!fileAnchor,
    minimizeTask: () => {
      fileSession = false;
      setOpen(false, { persist: false });
      resetFileAnchor();
      publishLayout();
    },
    setPanelModal: (active) => {
      panelModal = active;
      chat.inert = !open || active;
      toggle.inert = active;
      root.classList.toggle('panel-modal-open', active);
    },
    isPanelModal: () => panelModal,
    setOpen,
    isOpen: () => open,
    dismissFile: () => {
      if (open && fileAnchor && !document.querySelector('dialog[open]')) dismiss();
    },
    publishLayout,
    update,
    contentChanged,
    reset,
    completed,
    setSelection,
    fitInput,
    scrollLatest,
    openAt,
    dock,
    clearFileSession: () => {
      fileSession = false;
    },
    setFilePending,
    setFileTitle: (title) => {
      fileTitle.textContent = title;
    },
  };
}
