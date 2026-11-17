import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Bounds, RelativeFilePath, fail } from '../../contracts/index.js';
import { NATIVE_FILE_LIMIT } from '../../components/native-files.js';
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex'),
  CHUNK = 512 * 1024;
export class FileUpload {
  constructor(
    private directory: string,
    private workspace: string,
    private stage: (entry: any) => unknown,
  ) {}
  action(input: any) {
    const p = z
        .object({ operation: z.enum(['begin', 'chunk', 'finish']), id: z.string().uuid() })
        .passthrough()
        .parse(input),
      base = join(resolve(this.directory), 'uploads', digest(this.workspace)),
      folder = join(base, p.id);
    for (const path of [join(resolve(this.directory), 'uploads'), base, folder]) {
      if (existsSync(path)) {
        if (
          lstatSync(path).isSymbolicLink() ||
          !lstatSync(path).isDirectory() ||
          realpathSync(path) !== path
        )
          fail('UPLOAD_PATH', '暂存目录无效。');
      } else mkdirSync(path);
    }
    const manifestPath = join(folder, 'manifest.json');
    if (p.operation === 'begin') {
      const entry = z
        .object({
          fileName: z.string().min(1).max(120),
          relativePath: RelativeFilePath,
          lastModified: z.number().int().nonnegative(),
          bounds: Bounds,
          size: z.number().int().min(0).max(NATIVE_FILE_LIMIT),
        })
        .strict()
        .parse(p.entry);
      if (existsSync(manifestPath)) {
        const old = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (JSON.stringify(old) !== JSON.stringify(entry))
          fail('REQUEST_ID_REUSED', '上传标识已用于另一个文件。');
      } else writeFileSync(manifestPath, JSON.stringify(entry), { flag: 'wx' });
      return { chunkSize: CHUNK };
    }
    if (!existsSync(manifestPath)) fail('UPLOAD_MISSING', '请先建立上传记录。');
    const entry = JSON.parse(readFileSync(manifestPath, 'utf8')),
      count = Math.ceil(entry.size / CHUNK);
    if (p.operation === 'chunk') {
      const index = z
          .number()
          .int()
          .min(0)
          .max(Math.max(0, count - 1))
          .parse(p.index),
        data = z.string().max(710000).parse(p.data),
        bytes = Buffer.from(data, 'base64'),
        expected = Math.min(CHUNK, entry.size - index * CHUNK);
      if (bytes.length !== expected || bytes.toString('base64') !== data)
        fail('UPLOAD_CHUNK', '分块数据不完整。');
      const path = join(folder, String(index));
      if (existsSync(path)) {
        if (lstatSync(path).isSymbolicLink() || digest(readFileSync(path)) !== digest(bytes))
          fail('REQUEST_ID_REUSED', '分块重试内容不一致。');
      } else writeFileSync(path, bytes, { flag: 'wx' });
      return { index, saved: true };
    }
    const chunks: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const path = join(folder, String(i));
      if (!existsSync(path) || lstatSync(path).isSymbolicLink())
        fail('UPLOAD_INCOMPLETE', '部分分块尚未上传，请重试。');
      chunks.push(readFileSync(path));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== entry.size) fail('UPLOAD_INCOMPLETE', '文件大小不一致。');
    const { size, ...metadata } = entry;
    return this.stage({ ...metadata, requestId: p.id, data: bytes.toString('base64') });
  }
}
