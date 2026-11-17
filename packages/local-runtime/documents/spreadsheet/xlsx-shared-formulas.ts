import JSZip from 'jszip';
import type { Parsed } from './xlsx-editor.js';
import type { SheetEdit } from '../../../contracts/xlsx.js';
import { fail } from '../../../contracts/index.js';
import { child, attrs, textXml, replaceSpans } from './xlsx-xml.js';

/** Detach the entire shared group before changing any member, including its master. */
export async function expandEditedSharedFormulas(
  bytes: Buffer,
  parsed: Parsed,
  edits: SheetEdit[],
) {
  let zip: JSZip | undefined;
  for (const part of parsed.parts) {
    const groups = new Set(
      edits
        .filter((edit) => edit.sheetId === part.id)
        .flatMap((edit) => {
          const cell = part.cells.get(edit.address),
            f = cell && child(cell, 'f');
          return f?.attributes.t === 'shared' ? [f.attributes.si] : [];
        }),
    );
    if (!groups.size) continue;
    const replacements = [];
    for (const [address, cell] of part.cells) {
      const f = child(cell, 'f');
      if (f?.attributes.t !== 'shared' || !groups.has(f.attributes.si)) continue;
      const formula = parsed.book.getWorksheet(Number(part.id))?.getCell(address).formula;
      if (!formula) fail('XLSX_FORMULA', '共享公式无法展开，原文件未修改。');
      replacements.push({
        start: f.start,
        end: f.end,
        text: `<${f.name}${attrs(f, { t: undefined, si: undefined, ref: undefined })}>${textXml(formula!)}</${f.name}>`,
      });
    }
    zip ??= await JSZip.loadAsync(bytes);
    zip.file(part.path, replaceSpans(part.source, replacements));
  }
  return zip
    ? zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      })
    : null;
}
