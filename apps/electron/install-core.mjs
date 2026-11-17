import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, lstat, copyFile, rename } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const within = (root, path) => {
  const part = relative(resolve(root), resolve(path));
  return part !== '..' && !part.startsWith('..\\') && !part.startsWith('../') && !isAbsolute(part);
};
async function checksum(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}
async function ordinaryPath(root, path) {
  if (!within(root, path)) throw Error('安装文件路径超出目标目录');
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw Error('安装包不能包含符号链接或目录联接');
    if (resolve(current) === resolve(root)) break;
  }
  return lstat(path);
}
export async function inspectPackage(source) {
  const root = resolve(source),
    manifest = JSON.parse(await readFile(join(root, 'desktop-package.json'), 'utf8')),
    build = JSON.parse(await readFile(join(root, 'desktop-build.json'), 'utf8'));
  if (
    manifest.format !== 'ai-desktop-installation' ||
    manifest.schema !== 1 ||
    build.dataSchema !== 6 ||
    !/^\d+\.\d+\.\d+-\d{8}-\d{9}$/.test(build.buildId) ||
    !/^\d+\.\d+\.\d+$/.test(build.version) ||
    manifest.buildId !== build.buildId ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 60000
  )
    throw Error('请使用包含安装清单的完整新版桌面安装包');
  const names = new Set();
  let bytes = 0;
  for (const item of manifest.files) {
    if (
      typeof item.path !== 'string' ||
      !item.path ||
      item.path.includes('\\') ||
      item.path
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[<>:"|?*\x00-\x1f]/.test(part) ||
            /[. ]$/.test(part),
        ) ||
      !within(root, join(root, item.path)) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      names.has(item.path.toLowerCase())
    )
      throw Error('安装清单含有无效路径或重复文件');
    names.add(item.path.toLowerCase());
    bytes += item.bytes;
  }
  if (
    bytes > 3 * 1024 * 1024 * 1024 ||
    (!names.has('yirang.exe') && !names.has('ai desktop.exe')) ||
    ![
      'runtime/node.exe',
      'resources/app/apps/electron/main.mjs',
      'resources/app/dist/server.mjs',
    ].every((name) => names.has(name))
  )
    throw Error('安装包文件不完整或超过大小限制');
  return { root, manifest, build, bytes };
}
export async function readInstalled(directory) {
  try {
    return JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'));
  } catch {
    return null;
  }
}
export async function activatePackage(directory, buildId) {
  if (!/^\d+\.\d+\.\d+-\d{8}-\d{9}$/.test(buildId)) throw Error('版本标识无效');
  const path = join(directory, 'versions', buildId),
    ready = JSON.parse(await readFile(join(path, 'installed.json'), 'utf8'));
  if (ready.buildId !== buildId) throw Error('此版本没有完整安装');
  const executableName = ready.executableName || 'AI Desktop.exe';
  if (!['Yirang.exe', 'AI Desktop.exe'].includes(executableName)) throw Error('安装程序名称无效');
  const previous = await readInstalled(directory),
    state = {
      buildId,
      version: ready.version,
      executableName,
      previous: previous?.buildId === buildId ? previous.previous : previous?.buildId || null,
      updatedAt: new Date().toISOString(),
    };
  const temp = join(directory, `current-${randomUUID()}.pending`);
  await writeFile(temp, JSON.stringify(state, null, 2));
  await rename(temp, join(directory, 'current.json'));
  return { ...state, path, executable: join(path, executableName) };
}
export async function installPackage(source, directory, progress = () => {}) {
  const packageInfo = await inspectPackage(source),
    { manifest, build } = packageInfo,
    versions = join(resolve(directory), 'versions'),
    target = join(versions, build.buildId);
  await mkdir(versions, { recursive: true });
  await ordinaryPath(resolve(directory), versions);
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink()) throw Error('版本目录不是普通目录');
    const installed = JSON.parse(await readFile(join(target, 'installed.json'), 'utf8'));
    if (
      installed.manifestHash !== createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    )
      throw Error('同版本安装包内容不同，请保留为新的构建版本');
    return activatePackage(directory, build.buildId);
  }
  const staging = join(versions, `${build.buildId}.partial-${randomUUID()}`);
  if (!within(versions, staging) || !within(versions, target)) throw Error('安装目录无效');
  await mkdir(staging);
  for (let i = 0; i < manifest.files.length; i++) {
    const file = manifest.files[i],
      input = join(packageInfo.root, file.path),
      output = join(staging, file.path),
      info = await ordinaryPath(packageInfo.root, input);
    if (!info.isFile() || info.size !== file.bytes) throw Error(`安装文件大小不符：${file.path}`);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(input, output);
    if ((await checksum(output)) !== file.sha256) throw Error(`安装文件校验不符：${file.path}`);
    if (i % 30 === 0) progress({ phase: 'installing', done: i + 1, total: manifest.files.length });
  }
  const executableName = manifest.files.some((file) => file.path === 'Yirang.exe')
    ? 'Yirang.exe'
    : 'AI Desktop.exe';
  await writeFile(join(staging, 'desktop-package.json'), JSON.stringify(manifest));
  await writeFile(
    join(staging, 'installed.json'),
    JSON.stringify({
      version: build.version,
      buildId: build.buildId,
      executableName,
      manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      installedAt: new Date().toISOString(),
    }),
  );
  // Both absolute paths were bounded to the managed versions directory above.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(staging, target);
      break;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) ||
        attempt >= 7
      )
        throw error;
      await delay(500 + attempt * 250);
    }
  }
  return activatePackage(directory, build.buildId);
}
