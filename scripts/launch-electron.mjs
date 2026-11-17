import { spawn } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release', 'electron');
const builds = [];
for (const item of await readdir(release, { withFileTypes: true }).catch(() => [])) {
  if (!item.isDirectory() || !/^\d+\.\d+\.\d+-\d{8}-\d{6}/.test(item.name)) continue;
  for (const name of ['Yirang', 'AI Desktop']) {
    const candidate = join(release, item.name, `${name}-win32-x64`, `${name}.exe`);
    try {
      const build = JSON.parse(
        await readFile(join(dirname(candidate), 'desktop-build.json'), 'utf8'),
      );
      if (
        build.asar !== false ||
        build.buildId !== item.name ||
        !Number.isFinite(Date.parse(build.createdAt))
      )
        continue;
      await access(candidate);
      await access(join(dirname(candidate), 'runtime', 'node.exe'));
      builds.push({ candidate, time: Date.parse(build.createdAt) });
    } catch {}
  }
}
builds.sort((a, b) => b.time - a.time);
const executable = builds[0]?.candidate;
if (!executable)
  throw Error('尚未生成 Electron 程序。请先运行 npm run build 和 npm run package:electron。');
const child = spawn(executable, [], {
  cwd: dirname(executable),
  stdio: 'ignore',
  detached: true,
  windowsHide: false,
});
await new Promise((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
});
child.unref();
console.log(`已打开 ${executable}`);
