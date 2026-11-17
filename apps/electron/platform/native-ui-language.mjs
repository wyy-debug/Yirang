import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const english = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../packages/components/ui-english.json',
    ),
    'utf8',
  ),
);
let language = 'zh-CN',
  settingsFile,
  saved = false;
export function initializeUiLanguage(directory) {
  settingsFile = join(directory, 'ui-language.json');
  try {
    const value = JSON.parse(readFileSync(settingsFile, 'utf8')).language;
    if (value === 'en' || value === 'zh-CN') {
      language = value;
      saved = true;
    }
  } catch {}
}
export function nativeUiLanguage(value) {
  if (value !== undefined) {
    if (value !== 'en' && value !== 'zh-CN') throw Error('Invalid interface language');
    if (!settingsFile) throw Error('Language settings unavailable');
    writeFileSync(settingsFile, JSON.stringify({ language: value }));
    language = value;
    saved = true;
  }
  return { language, saved };
}
export function t(source, values = {}) {
  const text = language === 'en' ? (english[source] ?? source) : source;
  return text.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}
