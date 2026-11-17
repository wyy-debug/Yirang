import { packager } from '@electron/packager';
import { downloadArtifact } from '@electron/get';
import { resolve, join, sep } from 'node:path';
import { readdir, readFile, mkdir, copyFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { electronPackageIgnore } from './electron-package-files.mjs';

const root = resolve('.');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const buildId = `${version}-${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '')}`;
const output = resolve('release/electron', buildId);
if (!output.startsWith(`${resolve(root, 'release/electron')}${sep}`))
  throw Error('Unexpected Electron output directory');
const electronVersion = JSON.parse(
  await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'),
).version;
const cache = join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
const candidates = [];
for (const location of [
  cache,
  ...(await readdir(cache, { withFileTypes: true }).catch(() => []))
    .filter((item) => item.isDirectory())
    .map((item) => join(cache, item.name)),
]) {
  for (const file of await readdir(location).catch(() => [])) {
    const match = /^electron-v(\d+\.\d+\.\d+)-win32-x64\.zip$/.exec(file);
    if (match && match[1] === electronVersion) candidates.push({ version: match[1], location });
  }
}
candidates.sort((a, b) => {
  const left = a.version.split('.').map(Number),
    right = b.version.split('.').map(Number);
  return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
});
if (!candidates.length) {
  const zip = await downloadArtifact({
    version: electronVersion,
    artifactName: 'electron',
    platform: 'win32',
    arch: 'x64',
    cacheRoot: join(root, '.npm-cache/electron'),
    checksums: JSON.parse(
      await readFile(join(root, 'node_modules/electron/checksums.json'), 'utf8'),
    ),
  });
  candidates.push({ version: electronVersion, location: resolve(zip, '..') });
}
const runtime = candidates[0];
const paths = await packager({
  // External Node and Codex processes need real paths, including their cwd.
  // Packager 20 defaults to ASAR, which only Electron can read as a directory.
  dir: root,
  name: 'Yirang',
  icon: join(root, 'assets', 'brand', 'yirang.ico'),
  win32metadata: { ProductName: '一壤 · Yirang', FileDescription: '一壤 · Yirang' },
  platform: 'win32',
  arch: 'x64',
  out: output,
  overwrite: false,
  prune: true,
  asar: false,
  // Build directly in the unique output folder; Windows can lock a freshly copied
  // staging directory against rename. The launcher ignores it until the marker exists.
  tmpdir: false,
  electronVersion: runtime.version,
  electronZipDir: runtime.location,
  // Let Windows release handles to freshly extracted runtime files before the
  // packager renames their parent directory (EPERM on some Windows hosts).
  afterExtract: [async () => {
    if (process.platform === 'win32') await new Promise((resolve) => setTimeout(resolve, 3000));
  }],
  ignore: await electronPackageIgnore(root),
});
for (const path of paths) {
  // Legacy updaters require this executable name. Keep an alias for in-place upgrades.
  await copyFile(join(path, 'Yirang.exe'), join(path, 'AI Desktop.exe'));
  const runtimeDir = join(path, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await copyFile(process.execPath, join(runtimeDir, 'node.exe'));
  await copyFile(join(root, 'vendor', 'NODE-LICENSE'), join(runtimeDir, 'LICENSE'));
  const appDirectory = join(path, 'resources', 'app');
  if (!(await stat(appDirectory)).isDirectory())
    throw Error('Electron 包缺少真实的应用目录，不能启动本地服务。');
  for (const file of [
    join(appDirectory, 'dist', 'server.mjs'),
    join(appDirectory, 'dist', 'completion-worker.mjs'),
    join(appDirectory, 'dist', 'retrieval-worker.mjs'),
    join(appDirectory, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'),
    join(appDirectory, 'dist', 'generated-sync-worker.mjs'),
    join(appDirectory, 'dist', 'panel-electron.html'),
    join(appDirectory, 'dist', 'shell.js'),
    join(appDirectory, 'dist', 'electron', 'main.mjs'),
    join(appDirectory, 'apps', 'electron', 'browser', 'browser.mjs'),
    join(appDirectory, 'apps', 'electron', 'workspace', 'outputs.mjs'),
    join(appDirectory, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    join(runtimeDir, 'node.exe'),
  ]) {
    if (!(await stat(file)).isFile()) throw Error(`Electron 包缺少文件：${file}`);
  }
  // The launcher only considers complete builds, never a package still being copied.
  for (const script of ['windows-ocr.ps1', 'install-shortcuts.ps1']) {
    const location = join(appDirectory, 'apps', 'electron', script),
      text = await readFile(location, 'utf8');
    await writeFile(location, '\ufeff' + text.replace(/^\ufeff/, ''));
  }
  await writeFile(
    join(path, 'Install Yirang.cmd'),
    '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0resources\\app\\apps\\electron\\installer.mjs"\r\nif errorlevel 1 pause\r\n',
  );
  await writeFile(
    join(path, 'desktop-build.json'),
    JSON.stringify(
      {
        version,
        buildId,
        executableName: 'Yirang.exe',
        productName: '一壤 · Yirang',
        createdAt: new Date().toISOString(),
        asar: false,
        node: process.version,
        dataSchema: 6,
      },
      null,
      2,
    ),
  );
  const files = [],
    pendingFiles = [];
  async function inventory(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = join(directory, entry.name),
        name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw Error(`安装包不能包含链接：${name}`);
      if (entry.isDirectory()) await inventory(location, `${name}/`);
      else pendingFiles.push({ location, name });
    }
  }
  await inventory(path);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < pendingFiles.length) {
        const { location, name } = pendingFiles[cursor++],
          hash = createHash('sha256');
        for await (const bytes of createReadStream(location)) hash.update(bytes);
        files.push({ path: name, bytes: (await stat(location)).size, sha256: hash.digest('hex') });
      }
    }),
  );
  files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(
    join(path, 'desktop-package.json'),
    JSON.stringify({ format: 'ai-desktop-installation', schema: 1, buildId, files }),
  );
  console.log(`Electron desktop: ${path}`);
}
export const packagedDesktop = paths[0];
