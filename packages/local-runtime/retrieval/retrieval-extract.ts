import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { decodeNativeText } from '../documents/native-text.js';
import { isNativeTextFile } from '../../components/native-files.js';
import { contentText } from '../../components/content.js';
import type { SearchTarget } from '../../contracts/retrieval.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type Segment = { text: string; location: string; target: SearchTarget };
export function contentHash(row: any) {
  return digest(row.kind === 'file' ? String(JSON.parse(row.content).assetHash) : row.content);
}
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
/** Keep exact identifiers, Chinese words and CJK bigrams, including two-character queries. */
export function terms(text: string) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase(),
    words = new Set<string>();
  for (const part of segmenter.segment(normalized)) {
    if (part.isWordLike) words.add(part.segment);
  }
  for (const match of normalized.matchAll(/[a-z0-9_.$#-]+/g)) {
    words.add(match[0]);
    for (const word of match[0].split(/[_.\-$#]+/)) if (word) words.add(word);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = Array.from(match[0]);
    if (chars.length === 1) words.add(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) words.add(chars[i] + chars[i + 1]);
  }
  return [...words].filter((word) => word.length <= 100);
}
function plainMarkup(text: string) {
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:nbsp|amp|lt|gt|quot);/g,
      (s) => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' })[s]!,
    );
}
export async function extract(
  row: any,
  directory: string,
): Promise<{ segments: Segment[]; note: string }> {
  const segments: Segment[] = [],
    limit = 1000000;
  let chars = 0,
    note = '';
  const push = (text: string, location: string, target: SearchTarget = {}) => {
    if (chars >= limit) {
      note = '正文超过 100 万字符，仅索引前部分';
      return;
    }
    const value = text.slice(0, limit - chars);
    if (value.trim()) segments.push({ text: value, location, target });
    chars += value.length;
    if (value.length < text.length) note = '正文超过 100 万字符，仅索引前部分';
  };
  const content = JSON.parse(row.content);
  if (row.kind !== 'file') {
    push(contentText(content), '正文', { offset: 0 });
    return { segments, note };
  }
  const name = String(content.fileName || '');
  if (/(^|[\\/])(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(name))
    return { segments, note: '凭据文件仅检索名称' };
  if (content.size > 25 * 1024 * 1024) return { segments, note: '文件超过 25 MB，仅索引名称' };
  if (!/\.(xlsx|docx|pptx|pdf)$/i.test(name) && !isNativeTextFile(name))
    return { segments, note: '此格式当前仅检索名称' };
  if (!/^[a-f0-9]{64}$/.test(content.assetHash)) throw Error('文件内容标识无效');
  const path = join(directory, 'assets', content.assetHash);
  if ((await stat(path)).size > 25 * 1024 * 1024)
    return { segments, note: '文件超过 25 MB，仅索引名称' };
  const bytes = await readFile(path);
  if (/\.xlsx$/i.test(name)) {
    const { loadOffice } = await import('../documents/office-editor.js');
    await loadOffice(bytes);
    const { default: ExcelJS } = await import('exceljs'),
      book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as any);
    let cells = 0;
    for (const sheet of book.worksheets) {
      for (let r = 1; r <= sheet.rowCount && cells < 50000 && chars < limit; r++) {
        const row = sheet.getRow(r),
          values: string[] = [],
          addresses: string[] = [];
        row.eachCell((cell) => {
          if (cells++ < 50000) {
            values.push(`${cell.address}: ${cell.text}`);
            addresses.push(cell.address);
          }
        });
        if (values.length)
          push(values.join(' | '), `${sheet.name}!${addresses[0]}:${addresses.at(-1)}`, {
            sheetId: String(sheet.id),
            address: addresses[0],
          });
        if (r % 100 === 0) await yieldTurn();
      }
    }
    if (cells >= 50000) note = '表格超过 5 万单元格，仅索引前部分';
  } else if (/\.(docx|pptx)$/i.test(name)) {
    const { loadOffice, parseOffice } = await import('../documents/office-editor.js'),
      parsed = await parseOffice(await loadOffice(bytes), name, { textOnly: true });
    const pages = Math.min(parsed.paragraphs.length, 200);
    if (parsed.paragraphs.length > pages) note = '文档超过 200 页或正文分段，仅索引前部分';
    for (let i = 0; i < pages && chars < limit; i++) {
      for (const paragraph of parsed.paragraphs[i])
        push(paragraph.runs.map((r) => r.text).join(''), parsed.labels[i] || `第 ${i + 1} 页`, {
          page: i,
          pageBase: 0,
          paragraphId: paragraph.id,
        });
      await yieldTurn();
    }
  } else if (/\.pdf$/i.test(name)) {
    (globalThis as any).pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true })
      .promise;
    try {
      const pages = Math.min(document.numPages, 200);
      if (document.numPages > pages) note = 'PDF 超过 200 页，仅索引前部分';
      for (let p = 1; p <= pages && chars < limit; p++) {
        const page = await document.getPage(p),
          text = await page.getTextContent();
        push(text.items.map((item: any) => item.str || '').join(' '), `第 ${p} 页`, { page: p });
        page.cleanup();
        await yieldTurn();
      }
      if (!segments.length) note = 'PDF 无可提取文字，当前仅检索名称';
    } finally {
      await document.loadingTask.destroy();
    }
  } else if (isNativeTextFile(name)) {
    const raw = decodeNativeText(bytes).text;
    push(
      /\.(?:html?|svg)$/i.test(name) ? plainMarkup(raw) : raw,
      '正文',
      /\.(?:html?|svg)$/i.test(name) ? {} : { offset: 0 },
    );
  } else note = '此格式当前仅检索名称';
  return { segments, note };
}
export function chunks(row: any, segments: Segment[]) {
  const output: {
      id: string;
      text: string;
      location: string;
      target: SearchTarget;
      tokens: string;
    }[] = [],
    seen = new Set<string>();
  const titled: Segment[] = [{ text: row.title, location: '文件名称', target: {} }, ...segments];
  for (const segment of titled) {
    for (let start = 0; start < segment.text.length; ) {
      let end = Math.min(segment.text.length, start + 1000);
      if (end < segment.text.length) {
        const newline = segment.text.lastIndexOf('\n', end);
        if (newline > start + 500) end = newline;
      }
      const text = segment.text.slice(start, end),
        target = {
          ...segment.target,
          ...(segment.target.offset !== undefined ? { offset: segment.target.offset + start } : {}),
        };
      const id = digest(JSON.stringify([row.workspace, row.id, segment.location, target, text]));
      if (text.trim() && !seen.has(id)) {
        seen.add(id);
        output.push({
          id,
          text,
          location: segment.location,
          target,
          tokens: terms(text).join(' '),
        });
      }
      if (end >= segment.text.length) break;
      start = end - 120;
      if (output.length >= 1500) return output;
    }
  }
  return output;
}
