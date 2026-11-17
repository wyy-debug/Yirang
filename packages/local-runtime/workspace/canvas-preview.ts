import type { CanvasPreview } from '../../contracts/canvas-preview.js';
import { nativeFormat, isNativeTextFile } from '../../components/native-files.js';
import { decodeNativeText } from '../documents/native-text.js';
import { OfficeEditor } from '../documents/office-editor.js';
import { XlsxEditor } from '../documents/spreadsheet/xlsx-editor.js';
import { imageThumbnail, pdfThumbnail } from '../documents/raster-preview.js';
import { TEXT_FILE_LIMIT } from '../../contracts/native-text.js';

/** A bounded local preview of saved bytes, without executing code or recalculating formulas. */
export async function canvasPreview(
  bytes: Buffer,
  fileName: string,
  hash: string,
  objectId: string,
  revision: number,
): Promise<CanvasPreview> {
  const format = nativeFormat(fileName),
    fallback = (reason?: string): CanvasPreview => ({ kind: 'file', label: format.label, reason });
  if (/\.(png|jpe?g|webp|gif)$/i.test(fileName)) {
    try {
      return await imageThumbnail(bytes, hash);
    } catch (error) {
      return fallback(error instanceof Error ? error.message : '图片缩略暂不可用，请展开查看');
    }
  }
  if (/\.pdf$/i.test(fileName)) {
    try {
      return await pdfThumbnail(bytes, hash);
    } catch (error) {
      return fallback(error instanceof Error ? error.message : 'PDF 首页预览暂不可用，请展开查看');
    }
  }
  if (bytes.length > 8 * 1024 * 1024) return fallback('较大文件请展开查看');
  if (/\.xlsx$/i.test(fileName)) {
    const sheet = await new XlsxEditor().page(
      bytes,
      hash,
      { objectId, expectedRevision: revision, row: 1, column: 1, rows: 20, columns: 8 },
      fileName,
    );
    for (const cell of Object.values(sheet.cells)) {
      cell.display = cell.display.slice(0, 160);
      cell.input = cell.input.slice(0, 160);
    }
    return { kind: 'sheet', sheet };
  }
  if (/\.(docx|pptx)$/i.test(fileName)) {
    const page = await new OfficeEditor().read(bytes, fileName, objectId, revision, 0);
    page.paragraphs = page.paragraphs.slice(0, 24).map((p) => ({
      ...p,
      runs: p.runs.slice(0, 40).map((r) => ({ ...r, text: r.text.slice(0, 800) })),
    }));
    let imageBudget = 2 * 1024 * 1024;
    page.shapes = page.shapes.slice(0, 40).map((shape) => {
      const next = { ...shape };
      if (next.image) {
        if (next.image.length > imageBudget) delete next.image;
        else imageBudget -= next.image.length;
      }
      return next;
    });
    page.labels = page.labels.slice(0, 1);
    return { kind: 'office', page };
  }
  if (isNativeTextFile(fileName)) {
    const text = decodeNativeText(bytes).text,
      plain = /\.(txt|md|markdown|log)$/i.test(fileName);
    if (/\.html?$/i.test(fileName))
      return text.length > TEXT_FILE_LIMIT
        ? fallback('网页较大，请展开查看')
        : { kind: 'html', text, truncated: false };
    if (/\.svg$/i.test(fileName))
      return text.length > TEXT_FILE_LIMIT
        ? fallback('SVG 较大，请打开原文件查看')
        : { kind: 'svg', text };
    return {
      kind: plain ? 'text' : 'code',
      text: text.slice(0, 8000),
      truncated: text.length > 8000,
      language: format.extension,
    };
  }
  return fallback();
}
