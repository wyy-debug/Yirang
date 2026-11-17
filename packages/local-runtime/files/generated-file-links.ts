import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join, basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { GeneratedSource } from '../../contracts/index.js';
import { Worker } from 'node:worker_threads';

const workers = new WeakMap<
  object,
  { worker: Worker; running: boolean; again: boolean; retry: boolean; timer?: NodeJS.Timeout }
>();

export const fileDigest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export const withinDirectory = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('..\\') && !part.startsWith('../') && !isAbsolute(part);
};
const pathIdentity = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
type Link = { objectId: string; path: string; diskHash: string };
type Pending = { hash: string; revision: number; error?: string };

/** A persistent path-to-object identity; the asset store still keeps every revision. */
export class GeneratedFileLinks {
  static async closeWorker(db: object) {
    const current = workers.get(db);
    if (!current) return;
    workers.delete(db);
    if (current.timer) clearTimeout(current.timer);
    await current.worker.terminate();
  }
  constructor(
    private db: DatabaseSync,
    private dataDirectory: string,
    private outputRoot: string,
  ) {}
  private read<T>(workspace: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(workspace, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  private write(workspace: string, key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(workspace, key, JSON.stringify(value));
  }
  link(workspace: string, objectId: string) {
    return this.read<Link>(workspace, `generated-object:${objectId}`);
  }
  conflict(workspace: string, objectId: string) {
    return (
      this.read<Pending>(workspace, `generated-write:${objectId}`)?.error ??
      this.read<{ message: string }>(workspace, `generated-disk-change:${objectId}`)?.message
    );
  }
  find(workspace: string, path: string) {
    const ref = this.read<{ objectId: string }>(
      workspace,
      `generated-path:${fileDigest(pathIdentity(path))}`,
    );
    return ref ? this.link(workspace, ref.objectId) : undefined;
  }
  importSource(workspace: string, requestId: string) {
    return this.read<{ path: string; diskHash: string; parent: string; linked?: boolean }>(
      workspace,
      `import-source:${requestId}`,
    );
  }
  registerImport(workspace: string, requestId: string, path: string, linked = false) {
    if (!isAbsolute(path)) throw Error('原文件路径无效。');
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 50 * 1024 * 1024)
      throw Error('请选择不超过 50 MiB 的普通文件');
    const parent = realpathSync(dirname(path)),
      canonical = join(parent, basename(path));
    const previous = this.importSource(workspace, requestId);
    if (previous) {
      if (pathIdentity(previous.path) !== pathIdentity(canonical))
        throw Error('导入请求已用于不同文件。');
      return;
    }
    const bytes = readFileSync(canonical),
      after = lstatSync(canonical);
    if (
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw Error('原文件正在编辑，请保存后重新拖入。');
    this.write(workspace, `import-source:${requestId}`, {
      path: canonical,
      parent,
      diskHash: fileDigest(bytes),
      linked,
    });
  }
  attachImport(workspace: string, requestId: string, objectId: string, assetHash: string) {
    const source = this.importSource(workspace, requestId);
    if (!source) return;
    if (source.diskHash !== assetHash) throw Error('导入期间原文件已修改，请重新拖入。');
    if (pathIdentity(realpathSync(dirname(source.path))) !== pathIdentity(source.parent))
      throw Error('原文件目录已移动，请重新拖入。');
    // Grant only this file, never its siblings or the whole containing directory.
    this.write(workspace, `generated-file-allow:${fileDigest(pathIdentity(source.path))}`, {
      parent: source.parent,
    });
    this.bind(workspace, objectId, source.path, assetHash);
  }
  source(workspace: string, objectId: string): GeneratedSource | undefined {
    const source = this.read<GeneratedSource>(workspace, `generated-source:${objectId}`);
    if (!source) return;
    const pending = this.read<Pending>(workspace, `generated-write:${objectId}`);
    const changedSources = source.sources.flatMap((source) => {
      const object = this.db
          .prepare('SELECT revision FROM objects WHERE workspace=? AND id=?')
          .get(workspace, source.id) as { revision: number } | undefined,
        unavailable =
          this.read<boolean>(workspace, `archived:${source.id}`) ||
          this.read<{ private?: boolean }>(workspace, `policy:${source.id}`)?.private;
      return !object || unavailable || object.revision !== source.revision
        ? [{ ...source, currentRevision: object && !unavailable ? object.revision : null }]
        : [];
    });
    const issue = this.conflict(workspace, objectId);
    const request =
      source.request ?? this.read<{ title?: string }>(workspace, `generated:${source.batchId}`)?.title;
    return {
      ...source,
      request,
      ...(issue ? { syncError: issue } : pending ? { syncPending: true } : {}),
      ...(changedSources.length ? { changedSources } : {}),
    };
  }
  allowed(workspace: string, path: string) {
    const grant = this.read<{ parent: string }>(
      workspace,
      `generated-file-allow:${fileDigest(pathIdentity(path))}`,
    );
    if (grant) {
      try {
        if (pathIdentity(realpathSync(dirname(path))) === pathIdentity(grant.parent)) return true;
      } catch {}
    }
    return [this.outputRoot, ...(this.read<string[]>(workspace, 'generated-roots') ?? [])].some(
      (root) => {
        try {
          return withinDirectory(realpathSync(root), realpathSync(dirname(path)));
        } catch {
          return false;
        }
      },
    );
  }
  inspect(workspace: string, objectId: string, path?: string) {
    const link = this.link(workspace, objectId);
    if (!link) throw Error('此对象没有关联文件');
    const object = this.db
      .prepare('SELECT content,revision FROM objects WHERE workspace=? AND id=?')
      .get(workspace, objectId) as { content: string; revision: number };
    const content = JSON.parse(object.content),
      target = path ?? link.path;
    if (!this.allowed(workspace, target)) throw Error('请选择当前工作区保存目录内的文件');
    if (!existsSync(target))
      return {
        path: target,
        missing: true,
        revision: object.revision,
        desktopHash: content.assetHash,
      };
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 50 * 1024 * 1024)
      throw Error('请选择不超过 50 MiB 的普通文件');
    const bytes = readFileSync(target),
      diskHash = fileDigest(bytes);
    let desktopText: string | undefined, diskText: string | undefined;
    if (
      /\.(md|txt|json|csv|tsv|py|js|ts|tsx|jsx|html|htm|css|svg|xml|yaml|yml|toml|log)$/i.test(
        content.fileName,
      ) &&
      bytes.length <= 512000 &&
      content.size <= 512000
    )
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        diskText = decoder.decode(bytes);
        desktopText = decoder.decode(
          readFileSync(join(this.dataDirectory, 'assets', content.assetHash)),
        );
      } catch {}
    return {
      path: target,
      revision: object.revision,
      desktopHash: content.assetHash,
      diskHash,
      desktopText,
      diskText,
      size: bytes.length,
      conflict: diskHash !== link.diskHash && content.assetHash !== diskHash,
    };
  }
  provenance(workspace: string, objectId: string, source: GeneratedSource) {
    this.write(workspace, `generated-source:${objectId}`, source);
  }
  materialize(
    workspace: string,
    objectId: string,
    directory: string,
    fileName: string,
    hash: string,
  ) {
    const existing = this.link(workspace, objectId);
    if (existing) return existing.path;
    if (/[\\/:\u0000-\u001f]/.test(fileName) || ['.', '..'].includes(fileName))
      throw Error('原文件名无效。');
    if (!this.allowed(workspace, join(directory, fileName))) throw Error('任务目录不在工作区内。');
    const bytes = readFileSync(join(this.dataDirectory, 'assets', hash));
    if (fileDigest(bytes) !== hash) throw Error('原文件内容不完整。');
    // An imported file may have no disk path. Publish its edited bytes without creating another object.
    for (let index = 0; index < 1000; index++) {
      const folder = index ? join(directory, `文件 ${index + 1}`) : directory;
      if (index) {
        try {
          mkdirSync(folder);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        if (
          lstatSync(folder).isSymbolicLink() ||
          !withinDirectory(realpathSync(directory), realpathSync(folder))
        )
          continue;
      }
      const path = join(folder, fileName),
        linked = this.find(workspace, path);
      if (linked && linked.objectId !== objectId) continue;
      let fd: number;
      try {
        fd = openSync(path, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = lstatSync(path);
        if (
          info.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 1 &&
          info.size === bytes.length &&
          fileDigest(readFileSync(path)) === hash
        ) {
          this.bind(workspace, objectId, path, hash);
          return path;
        }
        continue;
      }
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.bind(workspace, objectId, path, hash);
      return path;
    }
    throw Error('同名文件过多，请整理任务目录。');
  }
  bind(workspace: string, objectId: string, path: string, diskHash: string) {
    if (!this.allowed(workspace, path)) throw Error('产出文件不在工作区目录内。');
    const existing = this.find(workspace, path);
    if (existing && existing.objectId !== objectId) throw Error('此文件已经关联另一桌面对象。');
    const previous = this.link(workspace, objectId);
    if (previous && pathIdentity(previous.path) !== pathIdentity(path))
      this.db
        .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
        .run(workspace, `generated-path:${fileDigest(pathIdentity(previous.path))}`);
    this.write(workspace, `generated-object:${objectId}`, {
      objectId,
      path: resolve(path),
      diskHash,
    });
    this.write(workspace, `generated-path:${fileDigest(pathIdentity(path))}`, { objectId });
  }
  accept(workspace: string, objectId: string, diskHash: string) {
    this.db
      .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
      .run(workspace, `generated-disk-change:${objectId}`);
    const link = this.link(workspace, objectId);
    if (!link) return;
    this.write(workspace, `generated-object:${objectId}`, { ...link, diskHash });
    this.db
      .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
      .run(workspace, `generated-write:${objectId}`);
  }
  enqueue(workspace: string, objectId: string) {
    const link = this.link(workspace, objectId);
    if (!link) return;
    const object = this.db
      .prepare('SELECT content,revision,kind FROM objects WHERE workspace=? AND id=?')
      .get(workspace, objectId) as { content: string; revision: number; kind: string } | undefined;
    if (!object || object.kind !== 'file') return;
    const content = JSON.parse(object.content);
    if (content.assetHash !== link.diskHash)
      this.write(workspace, `generated-write:${objectId}`, {
        hash: content.assetHash,
        revision: object.revision,
      });
    else
      this.db
        .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
        .run(workspace, `generated-write:${objectId}`);
  }
  /** Run only after the object transaction committed, never on each input event. */
  flush(workspace?: string, retry = false) {
    let item = workers.get(this.db);
    if (!item) {
      const workerUrl = import.meta.url.endsWith('.ts')
        ? new URL('../../../dist/generated-sync-worker.mjs', import.meta.url)
        : new URL('./generated-sync-worker.mjs', import.meta.url);
      const worker = new Worker(workerUrl, {
        workerData: { directory: this.dataDirectory, outputRoot: this.outputRoot },
      });
      item = { worker, running: false, again: false, retry: false };
      workers.set(this.db, item);
      const current = item;
      worker.on('error', (error) => {
        console.error('文件后台同步暂不可用', error.message);
        workers.delete(this.db);
      });
      worker.on('message', (message) => {
        if (message.error) console.error('文件后台同步', message.error);
        if (message.done) {
          current.running = false;
          if (current.again) {
            current.again = false;
            this.flush(undefined, current.retry);
          }
        }
      });
      worker.unref();
    }
    item.retry ||= retry;
    if (item.running) {
      item.again = true;
      return;
    }
    if (item.timer) return;
    const current = item;
    current.timer = setTimeout(() => {
      current.timer = undefined;
      current.running = true;
      current.worker.postMessage({ retry: current.retry });
      current.retry = false;
    }, 60);
    current.timer.unref();
  }
  /** Kept for offline recovery tools that own the database exclusively. */
  flushSynchronously(workspace?: string, retry = false) {
    const rows = this.db
      .prepare(
        `SELECT workspace,key,value FROM settings WHERE key LIKE 'generated-write:%'${workspace ? ' AND workspace=?' : ''} LIMIT 64`,
      )
      .all(...(workspace ? [workspace] : [])) as {
      workspace: string;
      key: string;
      value: string;
    }[];
    for (const row of rows) {
      if (JSON.parse(row.value).error && !retry) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const objectId = row.key.slice('generated-write:'.length),
          pending = this.read<Pending>(row.workspace, row.key),
          link = this.link(row.workspace, objectId);
        if (pending && link) {
          try {
            const object = this.db
              .prepare('SELECT content FROM objects WHERE workspace=? AND id=?')
              .get(row.workspace, objectId) as { content: string } | undefined;
            if (!object) throw Error('原桌面对象不存在。');
            const content = JSON.parse(object.content);
            if (content.assetHash !== pending.hash) throw Error('等待保存最新版本。');
            if (!this.allowed(row.workspace, link.path))
              throw Error('保存目录已移动或成为外部链接。');
            if (!existsSync(link.path))
              throw Error('原文件已移走；桌面版本已保留，请恢复原文件后重新收回。');
            const info = lstatSync(link.path);
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.nlink !== 1 ||
              info.size > 50 * 1024 * 1024
            )
              throw Error('原文件不是可同步的普通文件。');
            const currentHash = fileDigest(readFileSync(link.path));
            if (currentHash !== pending.hash) {
              if (currentHash !== link.diskHash)
                throw Error('文件夹中的文件也有修改；桌面版本已保留，请合并后重新收回。');
              const bytes = readFileSync(join(this.dataDirectory, 'assets', pending.hash));
              if (fileDigest(bytes) !== pending.hash) throw Error('保存内容不完整。');
              const temporary = join(dirname(link.path), `.desktop-${randomUUID()}.tmp`);
              try {
                const fd = openSync(temporary, 'wx');
                try {
                  writeFileSync(fd, bytes);
                  fsyncSync(fd);
                } finally {
                  closeSync(fd);
                }
                const latest = lstatSync(link.path);
                if (
                  latest.isSymbolicLink() ||
                  latest.nlink !== 1 ||
                  latest.ino !== info.ino ||
                  latest.size !== info.size ||
                  latest.mtimeMs !== info.mtimeMs ||
                  fileDigest(readFileSync(link.path)) !== currentHash
                )
                  throw Error('原文件正在编辑，稍后重新收回即可。');
                renameSync(temporary, link.path);
              } finally {
                if (existsSync(temporary)) unlinkSync(temporary);
              }
            }
            this.accept(row.workspace, objectId, pending.hash);
          } catch (error) {
            this.write(row.workspace, row.key, {
              ...pending,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          this.db
            .prepare(
              'INSERT INTO events(workspace,type,object_id,revision,actor,created_at) VALUES(?,?,?,?,?,?)',
            )
            .run(
              row.workspace,
              'object.changed',
              objectId,
              pending.revision,
              'host-ack',
              new Date().toISOString(),
            );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }
}
