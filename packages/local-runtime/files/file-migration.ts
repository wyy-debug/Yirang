import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { FileContent, fail, type DesktopObject } from '../../contracts/index.js';
import { withinDirectory, type GeneratedFileLinks } from './generated-file-links.js';

type Api = {
  objects: () => DesktopObject[];
  object: (id: string) => DesktopObject;
  guard: (id: string) => void;
  commit: <T>(fn: () => T) => T;
  allow: (path: string) => void;
  changed: (object: DesktopObject) => void;
};
type Match = { objectId: string; revision: number; path: string; hash: string };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function migrateFiles(
  workspace: string,
  operation: string,
  path: string,
  targets: Match[],
  links: GeneratedFileLinks,
  api: Api,
) {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) fail('INVALID_PATH', '请选择迁移后的文件目录。');
  const read = async (file: string) => {
    const actual = await realpath(file);
    if (!withinDirectory(root, actual)) fail('INVALID_PATH', '文件已离开所选目录。');
    const before = await lstat(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > 50 * 1024 * 1024
    )
      fail('INVALID_FILE', '请选择 50 MiB 内的普通文件。');
    const bytes = await readFile(file),
      after = await lstat(file);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      bytes.length !== before.size
    )
      fail('FILE_CHANGED', '文件仍在变化，请重新扫描。');
    return { path: actual, hash: digest(bytes) };
  };
  if (operation === 'migration_apply') {
    if (!targets.length) fail('EMPTY_SELECTION', '请选择需要关联的文件。');
    const checked: Match[] = [];
    const paths = new Set<string>(),
      ids = new Set<string>();
    for (const item of targets) {
      const file = await read(item.path),
        object = api.object(item.objectId),
        content = FileContent.parse(object.content);
      api.guard(object.id);
      if (
        object.archived ||
        object.kind !== 'file' ||
        object.revision !== item.revision ||
        content.assetHash !== item.hash ||
        file.hash !== item.hash
      )
        fail('FILE_CHANGED', '文件或桌面版本已变化，请重新扫描。');
      const key = file.path.toLowerCase(),
        existing = links.find(workspace, file.path);
      if (paths.has(key) || ids.has(object.id) || (existing && existing.objectId !== object.id))
        fail('FILE_CONFLICT', '一个文件只能关联一个桌面对象，请取消重复选择。');
      paths.add(key);
      ids.add(object.id);
      checked.push({ ...item, path: file.path });
    }
    return api.commit(() => {
      for (const item of checked) {
        const object = api.object(item.objectId);
        api.guard(object.id);
        if (
          object.revision !== item.revision ||
          FileContent.parse(object.content).assetHash !== item.hash
        )
          fail('REVISION_CONFLICT', '扫描后桌面版本已改变。');
      }
      api.allow(root);
      for (const item of checked) {
        links.bind(workspace, item.objectId, item.path, item.hash);
        links.accept(workspace, item.objectId, item.hash);
        api.changed(api.object(item.objectId));
      }
      return { linked: checked.length };
    });
  }
  const files: { path: string; name: string; size: number }[] = [],
    issues: string[] = [];
  let visited = 0,
    truncated = false;
  const walk = async (dir: string, depth: number) => {
    if (depth > 16) {
      truncated = true;
      return;
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 10000) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const item = join(dir, entry.name);
      try {
        if (!withinDirectory(root, await realpath(item))) continue;
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', '.codex'].includes(entry.name)) await walk(item, depth + 1);
        } else if (entry.isFile()) {
          const stat = await lstat(item);
          if (stat.nlink === 1 && stat.size <= 50 * 1024 * 1024)
            files.push({ path: item, name: entry.name.toLocaleLowerCase(), size: stat.size });
        }
      } catch {
        issues.push(relative(root, item));
      }
    }
  };
  await walk(root, 0);
  const hashes = new Map<string, Awaited<ReturnType<typeof read>>>(),
    items = [];
  let hashedBytes = 0;
  for (const object of api.objects().filter((value) => value.kind === 'file' && !value.archived)) {
    const content = FileContent.parse(object.content),
      candidates = files.filter(
        (file) =>
          file.name === basename(content.fileName).toLocaleLowerCase() &&
          file.size === content.size,
      ),
      matches = [];
    for (const file of candidates)
      try {
        let result = hashes.get(file.path);
        if (!result) {
          if (hashedBytes + file.size > 512 * 1024 * 1024) {
            truncated = true;
            break;
          }
          hashedBytes += file.size;
          result = await read(file.path);
          hashes.set(file.path, result);
        }
        if (result.hash === content.assetHash) matches.push(result.path);
      } catch {
        issues.push(relative(root, file.path));
      }
    items.push({
      objectId: object.id,
      revision: object.revision,
      title: object.title,
      hash: content.assetHash,
      matches,
      state: matches.length === 1 ? 'matched' : matches.length ? 'ambiguous' : 'missing',
    });
  }
  return { path: root, items, issues: issues.slice(0, 100), truncated, scanned: files.length };
}
