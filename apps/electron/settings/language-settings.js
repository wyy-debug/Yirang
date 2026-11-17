import { t as uiText } from '../../../packages/components/ui-language.js';
import {
  getUiLanguage,
  setUiLanguage,
  subscribeUiLanguage,
  t,
} from '../../../packages/components/ui-language.js';
export function createLanguageSetting() {
  const section = document.createElement('section'),
    label = document.createElement('label'),
    text = document.createElement('span'),
    title = document.createElement('strong'),
    note = document.createElement('small'),
    select = document.createElement('select'),
    error = document.createElement('p');
  section.className = 'settings-language';
  title.textContent = t('界面语言');
  note.textContent = t('仅切换界面文字，不修改文件或聊天内容。');
  select.setAttribute('aria-label', t('界面语言'));
  select.append(new Option(uiText('简体中文'), 'zh-CN'), new Option('English', 'en'));
  select.value = getUiLanguage();
  error.setAttribute('role', 'alert');
  select.onchange = () => {
    try {
      setUiLanguage(select.value);
      error.textContent = '';
    } catch {
      select.value = getUiLanguage();
      error.textContent = t('语言设置未能保存，请重试。');
    }
  };
  text.append(title, note);
  label.append(text, select);
  section.append(label, error);
  return section;
}
export function connectUiLanguage(frame) {
  let nativeReady = false;
  const nativeLanguage = window.desktop.language;
  if (nativeLanguage)
    void nativeLanguage()
      .then((value) => {
        if (value.saved) setUiLanguage(value.language);
        nativeReady = true;
        if (!value.saved) return nativeLanguage(getUiLanguage());
      })
      .catch(() => {
        nativeReady = true;
      });
  const publish = () =>
    frame.contentWindow?.postMessage(
      { type: 'ai-desktop:language', language: getUiLanguage() },
      '*',
    );
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    if (event.data?.type === 'ai-desktop:language-request') publish();
    if (
      event.data?.type === 'ai-desktop:language-save' &&
      ['zh-CN', 'en'].includes(event.data.language)
    ) {
      try {
        setUiLanguage(event.data.language);
        publish();
      } catch {
        frame.contentWindow?.postMessage({ type: 'ai-desktop:language-error' }, '*');
      }
    }
  });
  const translate = () => {
    if (nativeReady && nativeLanguage) void nativeLanguage(getUiLanguage()).catch(() => {});
    document.documentElement.lang = getUiLanguage();
    // Only explicitly marked application labels. Never traverse chat or file contents.
    for (const node of document.querySelectorAll('[data-ui-text]'))
      node.textContent = t(node.dataset.uiText);
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      for (const node of document.querySelectorAll(`[data-ui-${attribute}]`))
        node.setAttribute(attribute, t(node.getAttribute(`data-ui-${attribute}`)));
    }
    publish();
  };
  subscribeUiLanguage(translate);
  frame.addEventListener('load', publish);
  translate();
}
