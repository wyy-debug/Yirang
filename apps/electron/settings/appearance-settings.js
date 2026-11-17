import { t } from '../../../packages/components/ui-language.js';
const key = 'yirang:appearance';
const choices = ['system', 'light', 'dark'];
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();
export function getAppearance() {
  try {
    const saved = localStorage.getItem(key);
    return choices.includes(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}
export function currentTheme() {
  const choice = getAppearance();
  return choice === 'system' ? (media.matches ? 'dark' : 'light') : choice;
}
function apply() {
  const theme = currentTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  for (const listener of listeners) listener(theme);
}
export function subscribeTheme(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
media.addEventListener('change', () => {
  if (getAppearance() === 'system') apply();
});
apply();
export function createAppearanceSetting() {
  const section = document.createElement('section'),
    label = document.createElement('label'),
    text = document.createElement('span'),
    title = document.createElement('strong'),
    note = document.createElement('small'),
    select = document.createElement('select'),
    error = document.createElement('p');
  section.className = 'settings-language settings-appearance';
  title.textContent = t('外观');
  note.textContent = t('跟随系统时，会随 Windows 的浅色或深色模式自动切换。');
  select.setAttribute('aria-label', t('外观'));
  select.append(
    new Option(t('跟随系统'), 'system'),
    new Option(t('浅色'), 'light'),
    new Option(t('深色'), 'dark'),
  );
  select.value = getAppearance();
  error.setAttribute('role', 'alert');
  select.onchange = () => {
    try {
      localStorage.setItem(key, select.value);
      error.textContent = '';
      apply();
    } catch {
      select.value = getAppearance();
      error.textContent = t('外观设置未能保存，请重试。');
    }
  };
  text.append(title, note);
  label.append(text, select);
  section.append(label, error);
  return section;
}
