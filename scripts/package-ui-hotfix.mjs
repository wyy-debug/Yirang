// Package the UI identity fix from the delivered 0.17.0 build.
// Keep the unfinished Guest execution changes in source out of this hotfix.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const target = resolve('release/marketplace/plugins/ai-desktop');
const baseline = resolve('output/ui-hotfix-0.17.0-baseline');
const manifest = JSON.parse(await readFile(join(target, 'plugin.json'), 'utf8'));
if (manifest.version !== '0.17.0')
  throw Error('This hotfix requires the delivered 0.17.0 package.');
await mkdir(baseline, { recursive: false });
await cp(target, baseline, { recursive: true });
const html = await readFile(join(target, 'dist/panel.html'), 'utf8');
const resourceUri = `ui://ai-desktop/workspace/${createHash('sha256').update(html).digest('hex').slice(0, 20)}`;
let server = await readFile(join(target, 'dist/server.mjs'), 'utf8');
const previous = 'var RESOURCE = "ui://ai-desktop/workspace";';
if (server.split(previous).length !== 2)
  throw Error('Unexpected delivered server resource declaration.');
server = server.replace(previous, `var RESOURCE = ${JSON.stringify(resourceUri)};`);
server = server.replaceAll('"0.17.0"', '"0.17.1"');
await writeFile(join(target, 'dist/server.mjs'), server);
for (const name of [
  'plugin.json',
  '.codex-plugin/plugin.json',
  'build-info.json',
  'package-lock.json',
]) {
  const path = join(target, name);
  const value = JSON.parse(await readFile(path, 'utf8'));
  value.version = '0.17.1';
  if (value.packages?.['']) value.packages[''].version = '0.17.1';
  if (name === 'build-info.json') {
    value.uiResource = resourceUri;
    value.baseVersion = '0.17.0';
    value.hotfix = 'Give the delivered material desktop a distinct UI resource identity.';
  }
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
console.log(`Prepared UI hotfix 0.17.1: ${target}`);
