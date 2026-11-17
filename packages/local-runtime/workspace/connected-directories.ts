import {
  realpathSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, basename, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { fail, FileContent } from '../../contracts/index.js';
import { isNativeTextFile, NATIVE_FILE_LIMIT } from '../../components/native-files.js';
import { decodeNativeText } from '../documents/native-text.js';
import type { WorkbenchAPI } from '../work/workbench.js';
type Connection = {
  id: string;
  path: string;
  access: 'read' | 'write';
  device: number;
  inode: number;
  createdAt: string;
};
type Link = {
  connectionId: string;
  relativePath: string;
  objectId: string;
  sourceHash: string;
  desktopHash: string;
  mtime: number;
  size: number;
  device?: number;
  inode?: number;
  sourceDirty?: boolean;
};
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const notFound = (e: unknown) =>
  ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');
export class ConnectedDirectories {
  constructor(
    private api: WorkbenchAPI,
    private dataRoot: string,
  ) {}
  private connections(): Connection[] {
    return this.api.get('directory-connections') ?? [];
  }
  private links(): Link[] {
    return this.api.get('directory-links') ?? [];
  }
  private root(id: string) {
    const c = this.connections().find((c) => c.id === id);
    if (!c) fail('DIRECTORY_REVOKED', '目录连接不存在或已撤销。');
    const s = lstatSync(c.path);
    if (
      s.isSymbolicLink() ||
      !s.isDirectory() ||
      s.dev !== c.device ||
      s.ino !== c.inode ||
      realpathSync(c.path) !== c.path
    )
      fail('DIRECTORY_CHANGED', '连接目录已被替换，请重新连接。');
    return c;
  }
  private path(c: Connection, input: string) {
    if (isAbsolute(input) || input.includes(':'))
      fail('DIRECTORY_PATH', '请使用连接目录内的相对路径。');
    const parts = input.replace(/\\/g, '/').split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) fail('DIRECTORY_PATH', '目录路径无效。');
    let path = c.path;
    for (const part of parts) {
      path = join(path, part);
      const s = lstatSync(path);
      if (s.isSymbolicLink() || realpathSync(path) !== path)
        fail('DIRECTORY_PATH', '不能通过链接访问连接范围之外的路径。');
    }
    if (relative(c.path, path).startsWith('..') || isAbsolute(relative(c.path, path)))
      fail('DIRECTORY_PATH', '路径超出连接目录。');
    return path;
  }
  private bytes(path: string) {
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > NATIVE_FILE_LIMIT
    )
      fail('DIRECTORY_FILE', '文件无效、具有硬链接或超过 50 MiB。');
    const bytes = readFileSync(path),
      after = lstatSync(path);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size
    )
      fail('DIRECTORY_CHANGED', '源文件正在更新，请稍后重试。');
    return { bytes, stat: after, hash: hash(bytes) };
  }
  private comparison(source: Buffer, desktop: Buffer, fileName: string) {
    if (!isNativeTextFile(fileName))
      return { kind: 'binary', message: '此格式提供大小和哈希比较；请分别打开文件查看内容。' };
    try {
      const a = decodeNativeText(source),
        b = decodeNativeText(desktop),
        left = a.text.split('\n'),
        right = b.text.split('\n');
      let start = 0,
        end = 0;
      while (start < left.length && start < right.length && left[start] === right[start]) start++;
      while (
        end < left.length - start &&
        end < right.length - start &&
        left[left.length - 1 - end] === right[right.length - 1 - end]
      )
        end++;
      const from = Math.max(0, start - 3),
        stopA = Math.min(left.length, left.length - end + 3),
        stopB = Math.min(right.length, right.length - end + 3),
        limit = 24000;
      const sourceText = left.slice(from, stopA).join('\n'),
        desktopText = right.slice(from, stopB).join('\n');
      return {
        kind: 'text',
        identical: a.text === b.text,
        startLine: from + 1,
        changedSourceLines: left.length - start - end,
        changedDesktopLines: right.length - start - end,
        source: sourceText.slice(0, limit),
        desktop: desktopText.slice(0, limit),
        truncated: sourceText.length > limit || desktopText.length > limit,
        sourceEncoding: a.encoding,
        desktopEncoding: b.encoding,
        sourceNewline: a.newline,
        desktopNewline: b.newline,
      };
    } catch (e) {
      return { kind: 'binary', message: String(e) };
    }
  }
  async action(input: any) {
    const p = z
      .object({
        operation: z.enum([
          'list',
          'connect',
          'revoke',
          'scan',
          'pull',
          'push',
          'status',
          'relink',
          'detach',
        ]),
      })
      .passthrough()
      .parse(input);
    if (p.operation === 'list') return this.connections();
    if (p.operation === 'connect') {
      const input = z.string().min(1).max(2000).parse(p.path);
      if (!isAbsolute(input)) fail('DIRECTORY_PATH', '请填写绝对路径。');
      const stat = lstatSync(input),
        path = realpathSync(input);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        fail('DIRECTORY_PATH', '请选择真实文件夹。');
      const relation = relative(path, resolve(this.dataRoot)),
        reverse = relative(resolve(this.dataRoot), path);
      if (
        !relation ||
        (!relation.startsWith('..') && !isAbsolute(relation)) ||
        !reverse ||
        (!reverse.startsWith('..') && !isAbsolute(reverse))
      )
        fail('DIRECTORY_PATH', '不能连接桌面私有数据目录或其父目录。');
      const access = z.enum(['read', 'write']).parse(p.access),
        all = this.connections(),
        same = all.find((c) => c.path === path),
        c: Connection = {
          id: same?.id ?? randomUUID(),
          path,
          access,
          device: stat.dev,
          inode: stat.ino,
          createdAt: new Date().toISOString(),
        };
      if (all.length >= 30 && !same) fail('DIRECTORY_LIMIT', '最多连接 30 个目录。');
      this.api.put('directory-connections', [...all.filter((x) => x.id !== c.id), c]);
      return c;
    }
    const id = z.string().parse(p.connectionId);
    if (p.operation === 'revoke') {
      this.api.put(
        'directory-connections',
        this.connections().filter((c) => c.id !== id),
      );
      return { revoked: true };
    }
    const c = this.root(id),
      links = this.links().filter((l) => l.connectionId === id);
    if (p.operation === 'scan') {
      const offset = z.number().int().min(0).max(10000).default(0).parse(p.offset),
        limit = z.number().int().min(1).max(500).default(200).parse(p.limit),
        files: any[] = [],
        issues: string[] = [],
        byPath = new Map(links.map((l) => [l.relativePath, l]));
      let truncated = false,
        visited = 0;
      const walk = (folder: string, depth: number) => {
        if (depth > 16) {
          truncated = true;
          return;
        }
        let entries;
        try {
          entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        } catch (e) {
          issues.push(`${relative(c.path, folder) || '.'}: ${String(e)}`);
          return;
        }
        for (const entry of entries) {
          if (files.length >= 10000 || visited++ >= 50000) {
            truncated = true;
            return;
          }
          if (
            entry.isSymbolicLink() ||
            ['.git', 'node_modules', '.ai-desktop-history'].includes(entry.name)
          )
            continue;
          const path = join(folder, entry.name);
          try {
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
              if (realpathSync(path) !== path) {
                issues.push(`${entry.name}: 目录路径已变化`);
                continue;
              }
              walk(path, depth + 1);
            } else if (stat.isFile()) {
              const relativePath = relative(c.path, path).split(sep).join('/'),
                link = byPath.get(relativePath);
              let desktopChanged = false;
              if (link) {
                try {
                  desktopChanged =
                    FileContent.parse(this.api.object(link.objectId).content).assetHash !==
                    link.desktopHash;
                } catch {
                  desktopChanged = true;
                }
              }
              files.push({
                relativePath,
                size: stat.size,
                mtime: stat.mtimeMs,
                device: stat.dev,
                inode: stat.ino,
                objectId: link?.objectId,
                sourceChanged:
                  !!link &&
                  (link.sourceDirty || link.size !== stat.size || link.mtime !== stat.mtimeMs),
                desktopChanged,
                tooLarge: stat.size > NATIVE_FILE_LIMIT,
              });
            }
          } catch (e) {
            issues.push(`${entry.name}: ${String(e)}`);
          }
        }
      };
      walk(c.path, 0);
      const missing: Link[] = [],
        unknown: string[] = [];
      for (const link of links) {
        try {
          this.path(c, link.relativePath);
        } catch (e) {
          if (notFound(e)) missing.push(link);
          else unknown.push(link.relativePath);
        }
      }
      let hashBudget = 16 * 1024 * 1024,
        hashed = 0;
      const candidates = files.filter((f) => !f.objectId && !f.tooLarge),
        candidateHashes = new Map<string, string>();
      const renameSuggestions = missing.map((link) => ({
        from: link.relativePath,
        objectId: link.objectId,
        candidates: candidates
          .filter((f) => {
            if (link.inode && f.inode === link.inode && f.device === link.device) return true;
            if (f.size !== link.size || f.size > 1024 * 1024) return false;
            let value = candidateHashes.get(f.relativePath);
            if (!value && hashed < 40 && hashBudget >= f.size) {
              try {
                value = this.bytes(this.path(c, f.relativePath)).hash;
                candidateHashes.set(f.relativePath, value);
                hashed++;
                hashBudget -= f.size;
              } catch {}
            }
            return value === link.sourceHash;
          })
          .map((f) => ({
            relativePath: f.relativePath,
            match:
              link.inode && f.inode === link.inode && f.device === link.device
                ? 'identity'
                : 'content',
          }))
          .slice(0, 10),
      }));
      return {
        connection: c,
        files: files.slice(offset, offset + limit),
        issues,
        truncated,
        totalScanned: files.length,
        offset,
        limit,
        nextOffset: offset + limit < files.length ? offset + limit : null,
        missing: missing.map((l) => l.relativePath),
        unknown,
        renameSuggestions,
        scanComplete: !truncated && !issues.length,
      };
    }
    const relativePath = z.string().min(1).max(1024).parse(p.relativePath),
      link = links.find((l) => l.relativePath === relativePath);
    if (p.operation === 'detach') {
      if (!link) fail('NOT_FOUND', '文件关联不存在。');
      this.api.put(
        'directory-links',
        this.links().filter((l) => l.connectionId !== id || l.relativePath !== relativePath),
      );
      return { detached: true, objectId: link.objectId };
    }
    if (p.operation === 'relink') {
      if (!link) fail('NOT_FOUND', '文件关联不存在。');
      try {
        this.path(c, relativePath);
        fail('DIRECTORY_EXISTS', '旧路径仍存在，不能按重命名重新关联。');
      } catch (e) {
        if (!notFound(e)) throw e;
      }
      const target = z.string().min(1).max(1024).parse(p.targetPath);
      if (links.some((l) => l.relativePath === target))
        fail('DIRECTORY_LINKED', '目标路径已关联到其他桌面文件。');
      const source = this.bytes(this.path(c, target));
      if (p.expectedSourceHash && p.expectedSourceHash !== source.hash)
        fail('DIRECTORY_CHANGED', '目标文件已经改变，请重新查看。');
      // Keep both baselines: moving a file must not silently accept edits made on either side.
      this.api.put(
        'directory-links',
        this.links().map((l) =>
          l.connectionId === id && l.relativePath === relativePath
            ? {
                ...l,
                relativePath: target,
                sourceDirty: source.hash !== l.sourceHash,
                device: source.stat.dev,
                inode: source.stat.ino,
                mtime: source.hash === l.sourceHash ? source.stat.mtimeMs : l.mtime,
                size: source.hash === l.sourceHash ? source.stat.size : l.size,
              }
            : l,
        ),
      );
      return {
        relinked: true,
        objectId: link.objectId,
        relativePath: target,
        sourceChanged: source.hash !== link.sourceHash,
      };
    }
    const path = this.path(c, relativePath),
      source = this.bytes(path);
    if (p.operation === 'status') {
      const object = link ? this.api.object(link.objectId) : null,
        content = object ? FileContent.parse(object.content) : null;
      return {
        sourceHash: source.hash,
        sourceSize: source.bytes.length,
        desktopHash: content?.assetHash ?? null,
        desktopSize: content?.size ?? null,
        revision: object?.revision,
        baseline: link,
        comparison: content
          ? this.comparison(source.bytes, this.api.load(content.assetHash), content.fileName)
          : null,
      };
    }
    if (p.operation === 'pull') {
      if (p.expectedSourceHash && p.expectedSourceHash !== source.hash)
        fail('DIRECTORY_CHANGED', '比较后源文件发生变化，请重新比较。');
      let object;
      if (link) {
        const previous = this.api.object(link.objectId),
          content = FileContent.parse(previous.content);
        if (content.assetHash !== link.desktopHash && p.expectedDesktopHash !== content.assetHash)
          fail('DIRECTORY_CONFLICT', '桌面和源文件可能都已修改，请比较后明确选择保留内容。');
        object =
          source.hash === content.assetHash
            ? previous
            : this.api.save(
                z.string().parse(p.requestId),
                previous.id,
                previous.revision,
                source.bytes,
                '从连接目录更新文件',
                { type: 'object', source: relativePath },
              );
      } else
        object = this.api.create(
          z.string().parse(p.requestId),
          basename(path),
          source.bytes,
          { x: 80, y: 80, width: 350, height: 300 },
          relativePath,
        );
      this.api.put('directory-links', [
        ...this.links().filter((l) => l.connectionId !== id || l.relativePath !== relativePath),
        {
          connectionId: id,
          relativePath,
          objectId: object.id,
          sourceHash: source.hash,
          desktopHash: FileContent.parse(object.content).assetHash,
          mtime: source.stat.mtimeMs,
          size: source.stat.size,
          device: source.stat.dev,
          inode: source.stat.ino,
        },
      ]);
      return object;
    }
    if (!link || c.access !== 'write')
      fail('DIRECTORY_READ_ONLY', '此目录未允许源文件写回，或文件尚未导入。');
    const object = this.api.object(link.objectId),
      content = FileContent.parse(object.content);
    if (p.expectedRevision !== object.revision) fail('REVISION_CONFLICT', '桌面文件已经改变。');
    if (source.hash !== link.sourceHash && p.expectedSourceHash !== source.hash)
      fail('DIRECTORY_CONFLICT', '源文件已有外部修改，请比较后决定是否覆盖。');
    const bytes = this.api.load(content.assetHash),
      temp = join(dirname(path), `.ai-desktop-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', source.stat.mode & 0o777);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.root(id);
      this.path(c, relativePath);
      if (this.bytes(path).hash !== source.hash)
        fail('DIRECTORY_CHANGED', '写回期间源文件发生变化，未覆盖。');
      renameSync(temp, path);
    } catch (e) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {}
      throw e;
    }
    const stat = lstatSync(path);
    this.api.put(
      'directory-links',
      this.links().map((l) =>
        l.connectionId === id && l.relativePath === relativePath
          ? {
              ...l,
              sourceDirty: false,
              sourceHash: content.assetHash,
              desktopHash: content.assetHash,
              mtime: stat.mtimeMs,
              size: stat.size,
              device: stat.dev,
              inode: stat.ino,
            }
          : l,
      ),
    );
    return { saved: true, objectId: object.id, revision: object.revision };
  }
}
