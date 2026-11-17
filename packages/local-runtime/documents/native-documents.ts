import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import PptxGenJSModule from 'pptxgenjs';
// The package typings are CommonJS-shaped, but the ESM entry default-exports the class itself.
const PptxGenJS = PptxGenJSModule as unknown as typeof PptxGenJSModule.default;
import { escape } from './spreadsheet/xlsx-xml.js';
import { renderArtifact } from './artifacts.js';
import { contentText } from '../../components/content.js';
import type { DesktopObject } from '../../contracts/index.js';
export async function newNativeFile(format: string, title: string) {
  if (format === 'html')
    return Buffer.from(
      `<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>${escape(title)}</title>\n</head>\n<body>\n  <h1>${escape(title)}</h1>\n  <p>从这里开始编辑。</p>\n</body>\n</html>\n`,
    );
  if (format === 'xlsx') {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('工作表 1');
    return Buffer.from(await book.xlsx.writeBuffer());
  }
  if (format === 'pptx') {
    const deck = new PptxGenJS();
    deck.layout = 'LAYOUT_WIDE';
    deck.addSlide().addText(title, { x: 0.8, y: 1, w: 11, h: 1, fontSize: 32 });
    return Buffer.from((await deck.write({ outputType: 'nodebuffer' })) as Buffer);
  }
  if (format === 'docx') {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t xml:space="preserve">${escape(title)}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    );
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
  return Buffer.from(
    format === 'md'
      ? `# ${title}\n\n`
      : format === 'svg'
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>'
        : '',
  );
}
export async function convertNativeFile(object: DesktopObject) {
  if (object.kind === 'table' || object.kind === 'workbook')
    return { extension: 'xlsx', bytes: (await renderArtifact(object, 'xlsx')).bytes };
  if (object.kind === 'deck')
    return { extension: 'pptx', bytes: (await renderArtifact(object, 'pptx')).bytes };
  if (object.kind === 'diagram')
    return { extension: 'svg', bytes: (await renderArtifact(object, 'svg')).bytes };
  if (object.kind === 'text')
    return { extension: 'md', bytes: Buffer.from(contentText(object.content)) };
  if (object.kind === 'code')
    return {
      extension:
        ({ python: 'py', javascript: 'js', typescript: 'ts', text: 'txt' } as any)[
          (object.content as any).language
        ] ?? 'txt',
      bytes: Buffer.from(contentText(object.content)),
    };
  throw Error('此对象已经是文件，或需保留图片批注后单独转换。');
}
