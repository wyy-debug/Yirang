import { t, subscribeUiLanguage } from '../../../packages/components/ui-language.js';

export function createVoiceSelectionUI(anchor) {
  const row = document.createElement('div');
  row.className = 'voice-selection';
  row.hidden = true;
  const text = document.createElement('span'),
    detail = document.createElement('small'),
    clear = document.createElement('button');
  const copy = document.createElement('div');
  copy.append(text, detail);
  text.setAttribute('aria-live', 'polite');
  clear.type = 'button';
  clear.textContent = '×';
  clear.onclick = () =>
    void window.desktop.attach([]).catch((error) => {
      text.textContent = error.message;
    });
  row.append(copy, clear);
  anchor.after(row);
  const style = document.createElement('style');
  style.textContent =
    '.voice-selection{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:7px 9px;border:1px solid #e3e9f2;border-radius:8px;font-size:12px;color:#526782}.voice-selection[hidden]{display:none}.voice-selection>div{min-width:0;flex:1}.voice-selection span,.voice-selection small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.voice-selection small{margin-top:3px;color:#738095}.voice-selection button{flex:none;border:0;border-radius:5px;background:transparent;color:inherit;width:26px;height:26px;cursor:pointer}.voice-selection button:hover{background:#edf2fa}';
  document.head.append(style);
  const frame = document.getElementById('panel');
  let owner = null,
    value = null;
  const post = (message) => frame?.contentWindow?.postMessage(message, '*');
  const mode = () => post({ type: 'ai-desktop:voice-selection-mode', threadId: owner });
  function paint() {
    row.hidden = !owner;
    clear.title = t('清除语音引用');
    clear.setAttribute('aria-label', clear.title);
    if (!value) {
      text.textContent = t('正在同步选区…');
      detail.hidden = true;
      return;
    }
    text.textContent =
      value.state === 'pending'
        ? t('正在同步选区…')
        : value.state === 'error'
          ? t(value.error || '选区同步失败，请重新选择')
          : value.label
            ? t(
                value.readOnly
                  ? '正在看：{0} · 只读选区'
                  : value.partial
                    ? '正在看：{0} · 选中文字'
                    : '正在看：{0}',
                { 0: value.label },
              )
            : t('未引用材料 · 在桌面选择文件或文字');
    text.title = text.textContent;
    detail.hidden = value.state !== 'ready' || !value.snippet;
    detail.textContent = value.snippet || '';
    clear.hidden = value.state === 'ready' && !value.label;
  }
  window.addEventListener('message', (event) => {
    if (
      event.source === frame?.contentWindow &&
      event.data?.type === 'ai-desktop:voice-selection-ready'
    )
      mode();
  });
  window.desktop.onEvent(({ type, payload }) => {
    if (type !== 'voice' || payload.threadId !== owner) return;
    if (payload.method === 'selection-override') post({ type: 'ai-desktop:voice-selection-reset' });
  });
  subscribeUiLanguage(paint);
  return {
    start(threadId) {
      owner = threadId;
      paint();
      mode();
    },
    stop() {
      owner = null;
      value = null;
      paint();
      mode();
    },
    status(payload) {
      value = payload;
      paint();
    },
  };
}
