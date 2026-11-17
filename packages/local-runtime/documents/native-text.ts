import { fail } from '../../contracts/index.js';
import { TEXT_FILE_LIMIT, type NativeTextPage } from '../../contracts/native-text.js';

export function decodeNativeText(bytes: Buffer) {
  if (bytes.length > TEXT_FILE_LIMIT)
    fail('TEXT_LIMIT', '桌面文本编辑当前支持不超过 1 MiB 的文件；较大文件可在原对话中处理。');
  let encoding: NativeTextPage['encoding'] = 'utf-8',
    bom = false,
    offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    offset = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    bom = true;
    offset = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    bom = true;
    offset = 2;
  }
  let original: string;
  try {
    original = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(offset),
    );
  } catch {
    fail(
      'TEXT_ENCODING',
      '文件编码暂不支持。当前支持 UTF-8，以及带 BOM 的 UTF-16 LE / BE；请在原对话中按原编码处理。',
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(original!))
    fail('TEXT_BINARY', '文件含二进制控制字符，不能作为文本编辑。');
  const separators = original!.match(/\r\n|\r|\n/g) ?? [],
    kinds = new Set(separators);
  const newline: NativeTextPage['newline'] =
    kinds.size > 1
      ? 'mixed'
      : kinds.has('\r\n')
        ? 'crlf'
        : kinds.has('\r')
          ? 'cr'
          : kinds.has('\n')
            ? 'lf'
            : 'none';
  return { text: original!.replace(/\r\n|\r/g, '\n'), encoding, bom, newline, bytes: bytes.length };
}
export function encodeNativeText(
  original: Buffer,
  text: string,
  newline: 'preserve' | 'lf' | 'crlf' | 'cr',
) {
  const base = decodeNativeText(original),
    normalized = text.replace(/\r\n|\r/g, '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(normalized))
    fail('TEXT_BINARY', '文本包含不支持的控制字符。');
  // No-op saves keep every byte, including mixed line endings.
  if (normalized === base.text && newline === 'preserve') return original;
  if (base.newline === 'mixed' && newline === 'preserve')
    fail('TEXT_NEWLINE', '原文件混用换行符，请选择 LF、CRLF 或 CR 后保存。');
  const style = newline === 'preserve' ? (base.newline === 'none' ? 'lf' : base.newline) : newline;
  const value = normalized.replace(/\n/g, style === 'crlf' ? '\r\n' : style === 'cr' ? '\r' : '\n');
  let data = Buffer.from(value, base.encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (base.encoding === 'utf-16be') data.swap16();
  const bom = base.bom
    ? Buffer.from(
        base.encoding === 'utf-8'
          ? [0xef, 0xbb, 0xbf]
          : base.encoding === 'utf-16le'
            ? [0xff, 0xfe]
            : [0xfe, 0xff],
      )
    : Buffer.alloc(0);
  const result = Buffer.concat([bom, data]);
  if (result.length > TEXT_FILE_LIMIT)
    fail('TEXT_LIMIT', '编辑后的文件超过 1 MiB，请精简后保存或在原对话中处理。');
  if (decodeNativeText(result).text !== normalized)
    fail('TEXT_ENCODING', '文本包含无法按原编码保存的字符，修改已保留。');
  return result;
}
