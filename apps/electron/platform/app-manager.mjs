import { t as uiText } from './native-ui-language.mjs';
import { app, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, basename, relative, isAbsolute } from 'node:path';
import {
  inspectPackage,
  installPackage,
  readInstalled,
  activatePackage,
} from '../install-core.mjs';

export function createAppManager({ window, root, state, emit, diagnostics, beforeRestart }) {
  const defaultInstallation = join(
      process.env.LOCALAPPDATA || app.getPath('userData'),
      'Programs',
      'AI Desktop',
    ),
    repository = 'wyy-debug/Yirang';
  let selected = null,
    release = null,
    busy = false;
  async function installationRoot() {
    const buildDir = dirname(process.execPath);
    const versions = dirname(buildDir);
    if (basename(versions).toLowerCase() !== 'versions') return defaultInstallation;
    const candidate = dirname(versions);
    try {
      const marker = JSON.parse(await readFile(join(buildDir, 'installed.json'), 'utf8'));
      if (marker.buildId === basename(buildDir) &&
          ['Yirang.exe', 'AI Desktop.exe'].includes(marker.executableName) &&
          marker.executableName.toLowerCase() === basename(process.execPath).toLowerCase())
        return candidate;
    } catch {}
    return defaultInstallation;
  }
  const progress = (value) => emit('app-management', value);
  function command(program, args, timeout = 180000) {
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '',
        error = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(Error(uiText('更新服务超时，可选择本地完整安装包')));
      }, timeout);
      child.stdout.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-3000000);
      });
      child.stderr.on('data', (chunk) => {
        error = (error + chunk.toString()).slice(-4000);
      });
      child.once('error', (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve(output)
          : reject(Error(error || uiText('更新命令退出：{0}', { 0: code })));
      });
    });
  }
  async function latest() {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) return { ...(await response.json()), via: 'public' };
    } catch {}
    try {
      return {
        ...JSON.parse(await command('gh', ['api', `repos/${repository}/releases/latest`], 30000)),
        via: 'gh',
      };
    } catch {
      throw Error(
        uiText(
          '尚未找到可访问的发布版本。私有仓库在线更新需要本机 GitHub CLI 登录；也可直接选择本地完整安装包。',
        ),
      );
    }
  }
  async function unpack(path) {
    const { default: JSZip } = await import('jszip');
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024 * 1024)
      throw Error(uiText('请选择小于 1 GiB 的完整 ZIP 安装包'));
    const zip = await JSZip.loadAsync(await readFile(path)),
      entries = Object.values(zip.files),
      directory = join(app.getPath('userData'), 'updates', `unpacked-${randomUUID()}`);
    if (entries.length > 60000) throw Error(uiText('安装包文件数量过多'));
    await mkdir(directory, { recursive: true });
    let bytes = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i],
        name = entry.unsafeOriginalName || entry.name,
        parts = name.split('/');
      if (entry.dir && parts.at(-1) === '') parts.pop();
      const target = join(directory, ...parts),
        local = relative(directory, target);
      if (
        !parts.length ||
        parts.some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[\\<>:"|?*\x00-\x1f]/.test(part) ||
            /[. ]$/.test(part),
        ) ||
        local === '..' ||
        local.startsWith('..\\') ||
        isAbsolute(local) ||
        (Number(entry.unixPermissions) & 0xf000) === 0xa000
      )
        throw Error(uiText('安装包含有无效路径'));
      if (entry.dir) {
        await mkdir(target, { recursive: true });
        continue;
      }
      // JSZip replaces a zero-length compressed object with an empty content promise.
      const expected = entry._data?.uncompressedSize ?? 0;
      if (
        !Number.isSafeInteger(expected) ||
        expected > 512 * 1024 * 1024 ||
        bytes + expected > 3 * 1024 * 1024 * 1024
      )
        throw Error(uiText('安装包解压大小超出限制'));
      const content = await entry.async('nodebuffer');
      bytes += content.length;
      if (content.length !== expected || bytes > 3 * 1024 * 1024 * 1024)
        throw Error(uiText('安装包解压内容不一致'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx' });
      if (i % 100 === 0) progress({ phase: 'unpacking', done: i + 1, total: entries.length });
    }
    const roots = [
      directory,
      ...(await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name)),
    ];
    for (const candidate of roots)
      try {
        await inspectPackage(candidate);
        return candidate;
      } catch {}
    throw Error(uiText('ZIP 中没有完整的桌面程序与安装清单'));
  }
  const summary = (info) => ({
    version: info.build.version,
    buildId: info.build.buildId,
    bytes: info.bytes,
    files: info.manifest.files.length,
  });
  async function shortcuts(installation) {
    await command(
      join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(root, 'apps', 'electron', 'install-shortcuts.ps1'),
        '-InstallRoot',
        installation,
      ],
      30000,
    );
  }
  async function restart(result) {
    await beforeRestart();
    app.relaunch({ execPath: result.executable, args: [] });
    app.quit();
  }
  return {
    async action(action, payload = {}) {
      const installation = await installationRoot();
      if (action === 'info')
        return {
          version: app.getVersion(),
          installation,
          current: await readInstalled(installation),
          selected: selected ? summary(await inspectPackage(selected)) : null,
          repository,
        };
      if (action === 'diagnostics') {
        const path = await dialog.showSaveDialog(window(), {
          title: uiText('导出桌面诊断'),
          defaultPath: `Yirang-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (path.canceled) return null;
        const info = await diagnostics(),
          redact = (value) =>
            JSON.stringify(value, null, 2)
              .replace(/(?:Bearer\s+)[\w.-]+/gi, 'Bearer [redacted]')
              .replace(
                /((?:api[_-]?key|token|credential|authorization)["'\s]*[:=]["'\s]*)[^\s,}"']+/gi,
                '$1[redacted]',
              );
        await writeFile(
          path.filePath,
          redact({
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron,
            node: process.versions.node,
            createdAt: new Date().toISOString(),
            ...info,
          }),
        );
        return { path: path.filePath };
      }
      if (action === 'releases') {
        await shell.openExternal(`https://github.com/${repository}/releases`);
        return true;
      }
      if (action === 'check') {
        release = await latest();
        return {
          tag: release.tag_name,
          name: release.name || release.tag_name,
          date: release.published_at,
          url: release.html_url,
          downloadable: !!release.assets?.some((asset) =>
            /^(?:Yirang|AI-Desktop)-.*-win32-x64\.zip$/i.test(asset.name),
          ),
          current: release.tag_name.replace(/^v/, '') === app.getVersion(),
        };
      }
      if (busy) throw Error(uiText('安装管理正在处理，请等待完成'));
      if (
        ![
          'select-folder',
          'select-zip',
          'download',
          'install-current',
          'apply',
          'rollback',
        ].includes(action)
      )
        throw Error(uiText('不支持的安装操作'));
      if (['apply', 'rollback', 'install-current'].includes(action) && state().running)
        throw Error(uiText('请先结束运行中的任务与审阅'));
      busy = true;
      let restarting = false;
      try {
        if (action === 'select-folder') {
          const choice = await dialog.showOpenDialog(window(), {
            title: uiText('选择完整一壤程序目录'),
            properties: ['openDirectory'],
          });
          if (choice.canceled) return null;
          const info = await inspectPackage(choice.filePaths[0]);
          selected = info.root;
          return summary(info);
        }
        if (action === 'select-zip') {
          const choice = await dialog.showOpenDialog(window(), {
            title: uiText('选择桌面安装包'),
            properties: ['openFile'],
            filters: [{ name: uiText('一壤 · Yirang'), extensions: ['zip'] }],
          });
          if (choice.canceled) return null;
          selected = await unpack(choice.filePaths[0]);
          return summary(await inspectPackage(selected));
        }
        if (action === 'download') {
          if (!release) throw Error(uiText('请先检查发布版本'));
          const asset = release.assets?.find((item) =>
            /^(?:Yirang|AI-Desktop)-.*-win32-x64\.zip$/i.test(item.name),
          );
          if (!asset || asset.size > 1024 * 1024 * 1024)
            throw Error(uiText('发布中没有可下载的安装包'));
          const directory = join(app.getPath('userData'), 'updates', `download-${randomUUID()}`);
          await mkdir(directory, { recursive: true });
          const path = join(directory, asset.name);
          progress({ phase: 'downloading', done: 0, total: 1 });
          if (release.via === 'gh')
            await command(
              'gh',
              [
                'release',
                'download',
                release.tag_name,
                '--repo',
                repository,
                '--pattern',
                asset.name,
                '--dir',
                directory,
              ],
              600000,
            );
          else {
            const url = new URL(asset.browser_download_url);
            if (
              url.hostname !== 'github.com' ||
              !url.pathname.startsWith(`/${repository}/releases/download/`)
            )
              throw Error(uiText('发布下载地址无效'));
            const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
            if (!response.ok) throw Error(uiText('安装包下载失败：{0}', { 0: response.status }));
            const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'wx'));
            let received = 0;
            try {
              for await (const chunk of response.body) {
                received += chunk.length;
                if (received > 1024 * 1024 * 1024) throw Error(uiText('下载大小超限'));
                await handle.write(chunk);
                progress({ phase: 'downloading', done: received, total: asset.size });
              }
            } finally {
              await handle.close();
            }
          }
          if (asset.digest?.startsWith('sha256:')) {
            const hash = createHash('sha256')
              .update(await readFile(path))
              .digest('hex');
            if (hash !== asset.digest.slice(7))
              throw Error(uiText('下载文件摘要不一致，请重新下载'));
          }
          selected = await unpack(path);
          return summary(await inspectPackage(selected));
        }
        if (!payload.backupId) throw Error(uiText('请先保存当前编辑并创建升级前备份'));
        let result;
        if (action === 'rollback') {
          const saved = await readInstalled(installation);
          if (!saved?.previous) throw Error(uiText('没有可回退的已安装版本'));
          result = await activatePackage(installation, saved.previous);
        } else {
          const source = action === 'install-current' ? dirname(process.execPath) : selected;
          if (!source) throw Error(uiText('请先选择或下载完整安装包'));
          result = await installPackage(source, installation, progress);
        }
        let note = '';
        try {
          await shortcuts(installation);
        } catch (error) {
          note = uiText('已安装，快捷方式创建失败：{0}', { 0: error.message });
        }
        progress({ phase: 'ready', version: result.version, note });
        restarting = true;
        setTimeout(() => {
          void restart(result).catch((error) =>
            progress({ phase: 'error', message: error.message }),
          ).finally(() => { busy = false; });
        }, 400);
        return { version: result.version, note };
      } finally {
        if (!restarting) busy = false;
      }
    },
  };
}
