import { readFileSync } from 'node:fs';
import { t } from './platform/native-ui-language.mjs';

// Shared source/dist layout: packaged resources remain under packages/components.
const messages = JSON.parse(
  readFileSync(new URL('../../packages/components/main-text.zh-CN.json', import.meta.url), 'utf8'),
);
export function mainText(id, values = {}) {
  if (!Object.hasOwn(messages, id)) throw new Error(`Unknown main text key: ${id}`);
  return t(messages[id], values);
}
