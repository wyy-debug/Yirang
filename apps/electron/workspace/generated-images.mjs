import { t as uiText } from '../platform/native-ui-language.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat, realpath, link, unlink } from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute, extname } from 'node:path';
import { homedir } from 'node:os';

const LIMIT = 50 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => {
  const part = relative(root, path);
  return (
    part !== '..' &&
    !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(part)
  );
};
export const isGeneratedImage = (item) =>
  item?.type === 'imageGeneration' ||
  (item?.type === 'Extension' && item.kind === 'image_gen.generation');
function extension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return '.webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return '.gif';
  throw Error(uiText('生成结果不是可识别的 PNG、JPEG、WebP 或 GIF 图片'));
}
async function imageBytes(item, threadId) {
  if (typeof item.result === 'string' && item.result) {
    const encoded = item.result.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/i, '');
    if (encoded.length > Math.ceil(LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw Error(uiText('图片数据过大或编码无效'));
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > LIMIT) throw Error(uiText('图片为空或超过 50 MiB'));
    return bytes;
  }
  if (typeof item.savedPath !== 'string' || !isAbsolute(item.savedPath))
    throw Error(uiText('CLI 没有返回可保存的图片数据'));
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(threadId)) throw Error(uiText('图片所属对话无效'));
  const root = await realpath(
      join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images', threadId),
    ),
    path = await realpath(item.savedPath),
    info = await lstat(item.savedPath);
  if (!inside(root, path) || info.isSymbolicLink() || !info.isFile() || info.size > LIMIT)
    throw Error(uiText('图片不在该对话的生成目录中，或超过大小限制'));
  return readFile(path);
}

// Copy only explicit completed image results into the task directory. Never
// scan arbitrary CLI caches or overwrite a file already edited by the user.
export async function stageGeneratedImages(batch, items) {
  const paths = [],
    issues = [],
    images = [...new Map(items.filter(isGeneratedImage).map((item) => [item.id, item])).values()];
  for (const item of images.slice(0, 64)) {
    if (item.status !== 'completed') {
      if (!['inProgress', 'in_progress', 'running'].includes(item.status))
        issues.push({
          path: uiText('生成图片'),
          message: uiText('图片生成未成功，没有可回收的最终结果'),
        });
      continue;
    }
    try {
      if (typeof item.id !== 'string' || !item.id || item.id.length > 200)
        throw Error(uiText('图片结果标识无效'));
      const root = await realpath(batch.directory),
        info = await lstat(batch.directory),
        workspace = await realpath(batch.workspaceDirectory || batch.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !inside(workspace, root))
        throw Error(uiText('任务产出目录已被移动或替换'));
      const bytes = await imageBytes(item, batch.threadId),
        suffix = extension(bytes);
      const original = typeof item.savedPath === 'string' ? basename(item.savedPath) : '';
      const name =
        original &&
        original.length <= 120 &&
        !/[<>:"/\\|?*\u0000-\u001f]/.test(original) &&
        [suffix, ...(suffix === '.jpg' ? ['.jpeg'] : [])].includes(extname(original).toLowerCase())
          ? original
          : uiText('生成图片-{0}{1}', {
              0: hash(`${batch.threadId}:${batch.turnId}:${item.id}`).slice(0, 20),
              1: suffix,
            });
      const target = join(root, name),
        existing = await lstat(target).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
          throw Error(uiText('同名产出不是普通文件'));
        // A previously imported original belongs to the user; keep their edits.
        if (
          !batch.files.some((file) => file.path === name && file.objectId) &&
          (existing.size !== bytes.length || hash(await readFile(target)) !== hash(bytes))
        )
          throw Error(uiText('任务目录已有不同的同名图片，未覆盖，请处理后重试回收'));
      } else {
        const temporary = join(root, `.image-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, bytes, { flag: 'wx' });
          await link(temporary, target);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      }
      paths.push(name);
    } catch (error) {
      issues.push({ path: uiText('生成图片'), message: error.message });
    }
  }
  if (images.length > 64)
    issues.push({
      path: uiText('生成图片'),
      message: uiText('单次最多回收 64 张图片，其余结果仍保留在 CLI 中'),
    });
  return { paths, issues };
}
