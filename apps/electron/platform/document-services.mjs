import { t as uiText } from './native-ui-language.mjs';
import { app, dialog, nativeImage } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export function createDocumentServices({ preferences, window, root }) {
  const cache = join(app.getPath('userData'), 'document-cache'),
    jobs = new Set();
  let chain = Promise.resolve();
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  async function office() {
    const candidates = [
      preferences.get().libreOfficePath,
      ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
        .filter(Boolean)
        .flatMap((base) => [
          join(base, 'LibreOffice', 'program', 'soffice.com'),
          join(base, 'LibreOffice', 'program', 'soffice.exe'),
        ]),
    ];
    for (const path of candidates)
      if (path && (await stat(path).catch(() => null))?.isFile()) return path;
    return null;
  }
  function execute(program, args, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      jobs.add(child);
      let output = '',
        error = '',
        done = false;
      const finish = (cause) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        jobs.delete(child);
        cause ? reject(cause) : resolve(output);
      };
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid)
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        else child.kill();
        finish(Error(uiText('文档处理超时，可缩小页面或重试')));
      }, timeout);
      child.stdout.on('data', (data) => {
        output = (output + data.toString('utf8')).slice(-4000000);
      });
      child.stderr.on('data', (data) => {
        error = (error + data.toString('utf8')).slice(-4000);
      });
      child.on('error', finish);
      child.on('exit', (code) =>
        finish(code === 0 ? null : Error(error || uiText('文档处理退出：{0}', { 0: code }))),
      );
    });
  }
  const powershell = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const ocrArgs = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'apps', 'electron', 'windows-ocr.ps1'),
  ];
  async function command(action, payload = {}) {
    if (action === 'document-capabilities') {
      let languages = [],
        ocrError = '';
      if (process.platform === 'win32')
        try {
          languages = JSON.parse(
            await execute(powershell, [...ocrArgs, '-ListLanguages'], 30000),
          ).languages;
        } catch (error) {
          ocrError = error.message;
        }
      return { office: await office(), ocr: process.platform === 'win32', languages, ocrError };
    }
    if (action === 'document-choose-office') {
      const selected = await dialog.showOpenDialog(window(), {
        title: uiText('选择 LibreOffice 程序（soffice.exe / soffice.com）'),
        properties: ['openFile'],
        filters: [{ name: 'LibreOffice', extensions: ['exe', 'com'] }],
      });
      if (selected.canceled) return null;
      await preferences.set({ libreOfficePath: selected.filePaths[0] });
      return { path: selected.filePaths[0] };
    }
    if (action === 'document-office-preview') {
      const extension = extname(String(payload.fileName || '')).toLowerCase();
      if (!['.docx', '.pptx', '.xlsx'].includes(extension))
        throw Error(uiText('仅支持 DOCX、PPTX、XLSX 原生文件预览'));
      const program = await office();
      if (!program)
        throw Error(
          uiText(
            '排版预览需要 LibreOffice。安装后可在设置中选择 soffice.exe；现有文件编辑仍可继续使用。',
          ),
        );
      if (typeof payload.data !== 'string' || payload.data.length > 70000000)
        throw Error(uiText('文件超过 50 MiB'));
      const bytes = Buffer.from(payload.data, 'base64');
      if (bytes.length > 50 * 1024 * 1024 || bytes.toString('base64') !== payload.data)
        throw Error(uiText('文件数据无效'));
      const engine = await stat(program),
        folder = join(
          cache,
          `office-${digest(Buffer.concat([bytes, Buffer.from(program + engine.mtimeMs)]))}`,
        ),
        pdf = join(folder, 'document.pdf');
      await mkdir(folder, { recursive: true });
      if (!(await stat(pdf).catch(() => null))?.isFile()) {
        const input = join(folder, `document${extension}`),
          profile = join(folder, `profile-${randomUUID()}`);
        await mkdir(join(profile, 'user'), { recursive: true });
        await writeFile(
          join(profile, 'user', 'registrymodifications.xcu'),
          '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>',
        );
        await writeFile(input, bytes);
        try {
          await execute(program, [
            `-env:UserInstallation=${pathToFileURL(profile).href}`,
            '--headless',
            '--nologo',
            '--nodefault',
            '--norestore',
            '--convert-to',
            'pdf',
            '--outdir',
            folder,
            input,
          ]);
        } finally {
          await unlink(input).catch(() => {});
        }
      }
      const info = await stat(pdf).catch(() => null);
      if (!info?.isFile() || info.size > 50 * 1024 * 1024)
        throw Error(uiText('未生成可用的分页预览，原文件保持不变'));
      return {
        data: (await readFile(pdf)).toString('base64'),
        engine: 'LibreOffice',
        sha256: digest(bytes),
      };
    }
    if (action === 'document-ocr') {
      if (process.platform !== 'win32') throw Error(uiText('当前 OCR 使用 Windows 本地文字识别'));
      if (
        typeof payload.image !== 'string' ||
        !payload.image.startsWith('data:image/png;base64,') ||
        payload.image.length > 32000000
      )
        throw Error(uiText('请选择不超过 24 MiB 的 PNG 页面'));
      if (payload.language && !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(payload.language))
        throw Error(uiText('OCR 语言代码无效'));
      let image = nativeImage.createFromDataURL(payload.image);
      if (image.isEmpty()) throw Error(uiText('页面图片无效'));
      const size = image.getSize();
      if (Math.max(size.width, size.height) > 2400)
        image = image.resize(size.width > size.height ? { width: 2400 } : { height: 2400 });
      await mkdir(cache, { recursive: true });
      const imageFile = join(cache, `ocr-${randomUUID()}.png`);
      await writeFile(imageFile, image.toPNG());
      try {
        return JSON.parse(
          await execute(
            powershell,
            [
              ...ocrArgs,
              '-ImagePath',
              imageFile,
              ...(payload.language ? ['-Language', payload.language] : []),
            ],
            60000,
          ),
        );
      } finally {
        await unlink(imageFile).catch(() => {});
      }
    }
    throw Error(uiText('不支持的文档操作'));
  }
  return {
    command(action, payload) {
      const next = chain.catch(() => {}).then(() => command(action, payload));
      chain = next;
      return next;
    },
    close() {
      for (const child of jobs) {
        if (process.platform === 'win32' && child.pid)
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        else child.kill();
      }
    },
  };
}
