import english from './ui-english.json' with { type: 'json' };
export type UiLanguage = 'zh-CN' | 'en';
const key = 'ai-desktop:ui-language:v1',
  listeners = new Set<() => void>();
let language: UiLanguage = 'zh-CN';
try {
  if (localStorage.getItem(key) === 'en') language = 'en';
} catch {}
export const getUiLanguage = () => language;
export const subscribeUiLanguage = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function setUiLanguage(value: UiLanguage, persist = true) {
  if (value !== 'zh-CN' && value !== 'en') return;
  if (persist) localStorage.setItem(key, value);
  if (language === value) return;
  language = value;
  document.documentElement.lang = value;
  for (const listener of listeners) listener();
}
export function t(source: string, values: Record<string, unknown> = {}) {
  const text = language === 'en' ? ((english as Record<string, string>)[source] ?? source) : source;
  return text.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}
