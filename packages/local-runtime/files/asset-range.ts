import { openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from '../../contracts/index.js';
import { NATIVE_FILE_LIMIT } from '../../components/native-files.js';

// Content-addressed assets are immutable. Keep their file identity across range requests,
// without rereading the full asset or pretending each range recomputes its SHA-256.
const identities = new Map<string, string>();
export function readAssetRange(
  directory: string,
  hash: string,
  offset: number,
  length: number,
  expectedSize: number,
): Buffer {
  if (
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > NATIVE_FILE_LIMIT ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > expectedSize ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 1024 * 1024
  )
    fail('FILE_RANGE', '原生文件读取范围无效。');
  const root = realpathSync(join(directory, 'assets')),
    path = join(root, hash),
    before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size !== expectedSize ||
    realpathSync(path) !== path
  )
    fail('ASSET_CORRUPT', '文件资产尺寸或位置已变化，请重新导入原文件。');
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd),
      identity = `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}`;
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== expectedSize ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    )
      fail('ASSET_CHANGED', '读取前文件发生变化，请重新打开。');
    const known = identities.get(path);
    if (known && known !== identity)
      fail('ASSET_CHANGED', '同一资产在分块读取之间发生变化，已停止本次读取。');
    const bytes = Buffer.alloc(Math.min(length, expectedSize - offset));
    let received = 0;
    while (received < bytes.length) {
      const count = readSync(fd, bytes, received, bytes.length - received, offset + received);
      if (!count) fail('ASSET_CHANGED', '文件分块读取不完整。');
      received += count;
    }
    const after = fstatSync(fd),
      named = lstatSync(path);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.nlink !== 1 ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.size !== opened.size ||
      named.mtimeMs !== opened.mtimeMs ||
      named.ctimeMs !== opened.ctimeMs ||
      realpathSync(path) !== path
    )
      fail('ASSET_CHANGED', '文件在读取过程中发生变化，未返回混合版本的数据。');
    identities.delete(path);
    identities.set(path, identity);
    while (identities.size > 256) identities.delete(identities.keys().next().value!);
    return bytes;
  } finally {
    closeSync(fd);
  }
}
