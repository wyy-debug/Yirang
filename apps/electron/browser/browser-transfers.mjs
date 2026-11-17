import { t as uiText } from '../platform/native-ui-language.mjs';
import { app, dialog, shell } from 'electron';
import { readFile, writeFile, mkdir, rename, lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function createBrowserTransfers({ call, emit, window }) {
  const path = join(app.getPath('userData'), 'browser-downloads.json');
  const uploads = join(app.getPath('userData'), 'browser-uploads');
  try {
    const root = await lstat(uploads);
    if (root.isDirectory() && !root.isSymbolicLink()) {
      const canonical = await realpath(uploads);
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.name))
          continue;
        const directory = join(canonical, entry.name);
        try {
          if (await realpath(directory) !== directory) continue;
          for (const file of await readdir(directory, { withFileTypes: true }))
            if (file.isFile()) await unlink(join(directory, file.name));
          await rmdir(directory);
        } catch {
          // A locked upload can be cleaned up on the next startup.
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Browser upload cleanup:', error.code);
  }
  let jobs = [],
    chain = Promise.resolve();
  try {
    jobs = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const save = () => {
    const value = JSON.stringify(jobs);
    const job = chain
      .catch(() => {})
      .then(async () => {
        const temporary = path + '.tmp';
        await writeFile(temporary, value, { mode: 0o600 });
        await rename(temporary, path);
      });
    chain = job;
    return job;
  };
  async function collect(job) {
    try {
      if (!job.workspaceId) throw Error(uiText('下载时工作区未就绪，请在目标桌面中点击重试加入'));
      job.result = await call({
        operation: 'browser_import',
        path: job.path,
        url: job.url,
        requestId: job.id,
        viewWorkspaceId: job.workspaceId,
      });
      job.error = '';
      emit('browser-file-ready', job);
    } catch (error) {
      job.error = error.message;
    }
    await save();
    emit('browser-downloads', jobs);
    return job;
  }
  return {
    async context() {
      const value = await call({ operation: 'tasks' });
      return { workspaceId: value.workspaceId };
    },
    async downloaded({ path: filePath, url, workspaceId }) {
      const job = {
        id: randomUUID(),
        path: filePath,
        url,
        workspaceId,
        fileName: basename(filePath),
        at: new Date().toISOString(),
      };
      jobs.unshift(job);
      await save();
      return collect(job);
    },
    busy: false,
    async command(action, payload = {}) {
      if (action === 'transfers') return jobs;
      if (action === 'retry-download') {
        const job = jobs.find((job) => job.id === payload.id);
        if (!job) throw Error(uiText('下载记录不存在'));
        if (!job.workspaceId) job.workspaceId = (await call({ operation: 'tasks' })).workspaceId;
        return collect(job);
      }
      if (action === 'reveal-download') {
        const job = jobs.find((job) => job.id === payload.id);
        if (!job) throw Error(uiText('下载记录不存在'));
        shell.showItemInFolder(job.path);
        return true;
      }
      if (action === 'upload-list') return call({ operation: 'browser_files' });
      throw Error(uiText('不支持的文件传输操作'));
    },
    async uploadFile(payload, url) {
      const list = await call({ operation: 'browser_files' }),
        file = list.files.find(
          (file) => file.id === payload.objectId && file.revision === payload.revision,
        );
      if (!file) throw Error(uiText('文件已变化，请重新选择'));
      const answer = await dialog.showMessageBox(window(), {
        type: 'question',
        message: uiText('将「{0}」上传到网页？', { 0: file.title }),
        detail: url,
        buttons: [uiText('取消'), uiText('上传此文件')],
        cancelId: 0,
        defaultId: 0,
      });
      if (answer.response !== 1) throw Error(uiText('已取消上传'));
      const result = await call({
        operation: 'browser_export',
        objectId: file.id,
        expectedRevision: file.revision,
        viewWorkspaceId: list.workspaceId,
      });
      const directory = join(uploads, randomUUID());
      await mkdir(directory, { recursive: true });
      const target = join(
        directory,
        basename(result.fileName)
          .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
          .replace(/[. ]+$/g, ''),
      );
      await writeFile(target, Buffer.from(result.data, 'base64'), { flag: 'wx', mode: 0o600 });
      return target;
    },
    flush: () => chain,
  };
}
