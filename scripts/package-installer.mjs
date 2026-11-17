import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve('.');
const run = (exe, args) =>
  new Promise((ok, fail) => {
    const p = spawn(exe, args, { stdio: 'inherit', windowsHide: true });
    p.once('error', fail);
    p.once('exit', (c) => (c === 0 ? ok() : fail(Error(`${exe} exited ${c}`))));
  });
const compilers = [
  process.env.ISCC,
  join(root, 'release/build-tools/inno/ISCC.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/Inno Setup 6/ISCC.exe'),
  'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
  'C:/Program Files/Inno Setup 6/ISCC.exe',
].filter(Boolean);
let compiler;
for (const file of compilers) {
  try {
    await access(file);
    compiler = file;
    break;
  } catch {}
}
if (!compiler) throw Error('Install Inno Setup 6 or set ISCC to ISCC.exe.');
await run(process.execPath, ['scripts/build.mjs']);
const { packagedDesktop: source } = await import('./package-electron.mjs');
const build = JSON.parse(await readFile(join(source, 'desktop-build.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(source, 'desktop-package.json'), 'utf8'));
const { version } = build;
const staging = resolve('release/installer-build', build.buildId);
await mkdir(staging, { recursive: true });
await writeFile(
  join(staging, 'installed.json'),
  JSON.stringify({
    version,
    buildId: build.buildId,
    executableName: 'Yirang.exe',
    manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    installedAt: new Date().toISOString(),
  }),
);
await writeFile(
  join(staging, 'activate.mjs'),
  `import {activatePackage} from './versions/${build.buildId}/resources/app/apps/electron/install-core.mjs';\nawait activatePackage(process.argv[2],${JSON.stringify(build.buildId)});\n`,
);
await mkdir('release/installers', { recursive: true });
await run(compiler, [
  '/Qp',
  `/DSourceDir=${source}`,
  `/DStagingDir=${staging}`,
  `/DRepoDir=${root}`,
  `/DAppVersion=${version}`,
  `/DBuildId=${build.buildId}`,
  resolve('scripts/windows-installer.iss'),
]);
console.log(`Installer: ${resolve('release/installers', `Yirang-${version}-Setup-x64.exe`)}`);
if (process.argv.includes('--update-zip')) {
  const archive = resolve('release/installers', `Yirang-${version}-win32-x64.zip`);
  const temporary = `${archive}.${process.pid}.partial`;
  await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', resolve('scripts/create-update-archive.ps1'),
    '-Source', source, '-Archive', temporary,
  ]);
  await rename(temporary, archive);
  console.log(`Update archive: ${archive}`);
}
