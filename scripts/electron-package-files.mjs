import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const runtimeFiles = [
  'package.json',
  'assets/brand/yirang.ico',
  'apps/panel/assets/yirang.png',
  'apps/electron/browser-preload.cjs',
  'apps/electron/preload.cjs',
  'apps/electron/install-shortcuts.ps1',
  'apps/electron/windows-ocr.ps1',
  'apps/electron/shell.html',
  'apps/electron/shell.css',
  'apps/electron/design-tokens.css',
  'apps/electron/composer/composer-layout.css',
  'apps/electron/composer/file-chat.css',
  'apps/electron/composer/permission-controls.css',
  'apps/electron/conversation/question-card.css',
  'apps/electron/timing/execution-timing.css',
  'apps/electron/workspace/project-navigation.css',
  'packages/components/main-text.zh-CN.json',
  'packages/components/ui-english.json',
  'dist/completion-worker.mjs',
  'dist/generated-sync-worker.mjs',
  'dist/panel-electron.html',
  'dist/panel.html',
  'dist/retrieval-worker.mjs',
  'dist/server.mjs',
  'dist/shell.css',
  'dist/shell.js',
  'dist/yirang-service.mjs',
];

const localProfilePath =
  /(?:^|\/)(?:\.(?:aws|codex|env(?:\.[^/]*)?|local-data|npmrc|netrc|ssh)|codex-cli-home|(?:auth|credentials|secrets)\.json|settings\.local\.json)(?:\/|$)/i;
const localDataFile = /\.(?:har|kdbx|log|pfx|p12|sqlite(?:-wal|-shm)?)$/i;

async function modulePaths(root, directory) {
  const entries = await readdir(join(root, directory), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
}

export async function electronPackageIgnore(root) {
  const [electronModules, sharedModules] = await Promise.all([
    modulePaths(root, 'apps/electron'),
    modulePaths(root, 'packages/components'),
  ]);
  const compiledModules = electronModules.map((path) => path.replace(/^apps\//, 'dist/'));
  const allowed = new Set([...runtimeFiles, ...electronModules, ...sharedModules, ...compiledModules]);
  for (const path of allowed) {
    const directory = dirname(path).replaceAll('\\', '/');
    if (directory !== '.') allowed.add(directory);
  }
  const paths = Array.from(allowed, (path) => RegExp.escape(path)).join('|');

  // Packager appends its default ignore rules to this array and prunes dev dependencies.
  return [new RegExp(`^/(?!(?:node_modules(?:/|$)|(?:${paths})$))`), localProfilePath, localDataFile];
}
