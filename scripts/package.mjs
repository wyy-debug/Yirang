import { mkdir, cp, readFile, writeFile, copyFile, rm, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve('release/marketplace'),
  target = join(root, 'plugins/ai-desktop');
await mkdir(target, { recursive: true });
await cp('plugin/ai-desktop', target, { recursive: true });
await cp('dist', join(target, 'dist'), { recursive: true });
await mkdir(join(target, 'tools'), { recursive: true });
await copyFile('scripts/restore-data.mjs', join(target, 'tools/restore-data.mjs'));
await mkdir(join(target, 'node_modules'), { recursive: true });
await cp('node_modules/@napi-rs', join(target, 'node_modules/@napi-rs'), { recursive: true });
for (const name of ['sqlite-vec', 'sqlite-vec-windows-x64'])
  await cp(join('node_modules', name), join(target, 'node_modules', name), { recursive: true });
// Remove only the obsolete generated Guest payload, never user data or old installs.
const legacyGuest = join(target, 'guest');
if (
  target !== resolve('release/marketplace/plugins/ai-desktop') ||
  (await realpath(target)) !== target
)
  throw Error('Unexpected package directory');
try {
  const stat = await lstat(legacyGuest);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(legacyGuest)) !== legacyGuest)
    throw Error('Unexpected legacy payload path');
  await rm(legacyGuest, { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(join(target, 'runtime'), { recursive: true });
if (process.version !== 'v24.12.0' || process.arch !== 'x64' || process.platform !== 'win32')
  throw Error('Package requires verified Node 24.12.0 win32 x64');
await copyFile(process.execPath, join(target, 'runtime/node.exe'));
const nodeLicense = resolve('vendor/NODE-LICENSE');
await copyFile(nodeLicense, join(target, 'runtime/LICENSE'));
const manifest = JSON.parse(await readFile('plugin/ai-desktop/plugin.json', 'utf8'));
await mkdir(join(target, '.codex-plugin'), { recursive: true });
await writeFile(
  join(target, '.codex-plugin/plugin.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      requires_local_executor: true,
      interface: manifest.extensions['com.openai'].interface,
      mcpServers: './.mcp.json',
    },
    null,
    2,
  ),
);
const mcp = JSON.parse(await readFile('plugin/ai-desktop/mcp.json', 'utf8'));
await writeFile(join(target, '.mcp.json'), JSON.stringify({ mcpServers: mcp.mcpServers }, null, 2));
await mkdir(join(root, '.agents/plugins'), { recursive: true });
await writeFile(
  join(root, '.agents/plugins/marketplace.json'),
  JSON.stringify(
    {
      name: 'ai-desktop-local',
      interface: { displayName: '一壤 · Yirang Local' },
      plugins: [
        {
          name: 'ai-desktop',
          source: { source: 'local', path: './plugins/ai-desktop' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    },
    null,
    2,
  ),
);
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const inventory = Object.entries(lock.packages)
  .filter(([path]) => path)
  .map(([path, p]) => ({
    package: path.replace(/^node_modules\//, ''),
    version: p.version,
    license: p.license ?? 'see upstream',
  }));
await writeFile(join(target, 'dependency-inventory.json'), JSON.stringify(inventory, null, 2));
const licenses = [];
for (const [path, p] of Object.entries(lock.packages).filter(([path, p]) => path && !p.dev)) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try {
      licenses.push(
        `\n==== ${path} ${p.version} ====\n${await readFile(join(path, name), 'utf8')}`,
      );
      break;
    } catch {}
  }
}
await writeFile(join(target, 'THIRD_PARTY_NOTICES.txt'), licenses.join('\n'));
await copyFile('package-lock.json', join(target, 'package-lock.json'));
const runtimeHash = createHash('sha256')
  .update(await readFile(process.execPath))
  .digest('hex');
await writeFile(
  join(target, 'build-info.json'),
  JSON.stringify(
    {
      version: manifest.version,
      node: process.version,
      abi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      nodeSha256: runtimeHash,
    },
    null,
    2,
  ),
);
console.log(`Installable development plugin: ${target}`);
