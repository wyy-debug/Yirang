import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useSyncExternalStore, useState, useEffect } from 'react';
import {
  getUiLanguage,
  subscribeUiLanguage,
  setUiLanguage,
  t,
  type UiLanguage,
} from '../../../packages/components/ui-language.js';
export { t };
export function useUiLanguage() {
  return useSyncExternalStore(subscribeUiLanguage, getUiLanguage, getUiLanguage);
}
export function connectUiLanguage() {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'ai-desktop:language') return;
    setUiLanguage(event.data.language, false);
  });
  document.documentElement.lang = getUiLanguage();
  window.parent.postMessage({ type: 'ai-desktop:language-request' }, '*');
}
export function LanguageSetting() {
  const language = useUiLanguage(),
    [error, setError] = useState('');
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === 'ai-desktop:language-error')
        setError(t('语言设置未能保存，请重试。'));
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return (
    <section className="settings-language">
      <label>
        <span>
          <strong>{t('界面语言')}</strong>
          <small>{t('仅切换界面文字，不修改文件或聊天内容。')}</small>
        </span>
        <select
          aria-label={t('界面语言')}
          value={language}
          onChange={(event) => {
            setError('');
            const value = event.target.value as UiLanguage;
            if (window.parent !== window)
              window.parent.postMessage({ type: 'ai-desktop:language-save', language: value }, '*');
            else
              try {
                setUiLanguage(value);
              } catch {
                setError(t('语言设置未能保存，请重试。'));
              }
          }}
        >
          <option value="zh-CN">{uiText('简体中文')}</option>
          <option value="en">English</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
