import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { electronPackageIgnore } from '../scripts/electron-package-files.mjs';

test('Electron packaging includes runtime files and excludes local data and old build output', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const ignored = await electronPackageIgnore(root);
  const isIgnored = (path) => ignored.some((rule) => rule.test(path));

  for (const path of [
    '/package.json',
    '/apps',
    '/apps/electron',
    '/apps/electron/main.mjs',
    '/apps/electron/shell.html',
    '/apps/panel/assets/yirang.png',
    '/packages/components/main-text.zh-CN.json',
    '/dist/electron/main.mjs',
    '/dist/server.mjs',
    '/node_modules/sqlite-vec-windows-x64/vec0.dll',
  ]) {
    assert.equal(isIgnored(path), false, path);
  }
  for (const path of [
    '/auth.json',
    '/apps/electron/.ENV.local',
    '/apps/electron/settings.local.json',
    '/apps/bot-desk/data/state.json',
    '/dist/ds-bot-runtime/ds-bot/auth.json',
    '/dist/electron/removed-module.mjs',
    '/dist/.env.production',
    '/node_modules/some-dependency/.codex',
    '/node_modules/some-dependency/.env',
    '/node_modules/some-dependency/Auth.json',
    '/scripts/install-local.ps1',
    '/docs/evidence/host-load-diagnostic.json',
    '/test-results/host-load-diagnostic.json',
  ]) {
    assert.equal(isIgnored(path), true, path);
  }
});
