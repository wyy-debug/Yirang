import ExcelJS from 'exceljs';
import PptxGenJSModule from 'pptxgenjs';
// The package typings are CommonJS-shaped, but the ESM entry default-exports the class itself.
const PptxGenJS = PptxGenJSModule as unknown as typeof PptxGenJSModule.default;
import type { DesktopObject, Deck, Workbook, Diagram, Table } from '../../contracts/index.js';
import { diagramSvg, annotationSvg } from '../../components/structured.js';
export function supportedFormula(source: string): boolean {
  if (source.length > 500 || !source.startsWith('=')) return false;
  const input = source.slice(1).toUpperCase().replace(/\s/g, '');
  const tokens =
    input.match(/SUM|AVERAGE|MIN|MAX|COUNT|[A-Z]{1,3}[1-9]\d{0,6}|\d+(?:\.\d+)?|[()+*/,:-]/g) ?? [];
  if (tokens.join('') !== input || !tokens.length) return false;
  let i = 0;
  function primary(): boolean {
    const token = tokens[i++];
    if (token === '+' || token === '-') return primary();
    if (token === '(') {
      if (!expression() || tokens[i++] !== ')') return false;
      return true;
    }
    if (['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT'].includes(token)) {
      if (tokens[i++] !== '(' || !expression()) return false;
      while (tokens[i] === ',') {
        i++;
        if (!expression()) return false;
      }
      return tokens[i++] === ')';
    }
    if (/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(token ?? '')) {
      if (tokens[i] === ':') {
        i++;
        return /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(tokens[i++] ?? '');
      }
      return true;
    }
    return /^\d+(?:\.\d+)?$/.test(token ?? '');
  }
  function term() {
    if (!primary()) return false;
    while (tokens[i] === '*' || tokens[i] === '/') {
      i++;
      if (!primary()) return false;
    }
    return true;
  }
  function expression() {
    if (!term()) return false;
    while (tokens[i] === '+' || tokens[i] === '-') {
      i++;
      if (!term()) return false;
    }
    return true;
  }
  return expression() && i === tokens.length;
}
export async function renderArtifact(
  object: DesktopObject,
  format: 'pptx' | 'xlsx' | 'svg',
  imageData?: string,
) {
  if (format === 'svg') {
    if (object.kind !== 'diagram' && object.kind !== 'image')
      throw new Error('此对象不能导出为 SVG。');
    return {
      bytes: Buffer.from(
        object.kind === 'diagram'
          ? diagramSvg(object.content as Diagram)
          : annotationSvg(object, imageData!),
        'utf8',
      ),
      mime: 'image/svg+xml',
      generator: 'ai-desktop-svg/0.5',
      calculation: 'not_applicable' as const,
    };
  }
  if (format === 'xlsx') {
    if (object.kind !== 'workbook' && object.kind !== 'table')
      throw new Error('请选择工作簿或表格。');
    const spec: Workbook =
      object.kind === 'workbook'
        ? (object.content as Workbook)
        : {
            title: object.title,
            formulas: false,
            sheets: [
              { id: object.id, name: '工作表 1', table: object.content as Table, formats: {} },
            ],
          };
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Yirang';
    workbook.title = spec.title;
    workbook.subject = `源对象 ${object.id} v${object.revision}`;
    workbook.created = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    for (const sheet of spec.sheets) {
      const ws = workbook.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = sheet.table.columns.map((c) => ({ header: c.label, key: c.id, width: 24 }));
      ws.getRow(1).height = 28;
      ws.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FF365E4B' }, name: 'Microsoft YaHei', size: 11 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9F0E2' } };
      });
      for (const row of sheet.table.rows) {
        ws.addRow(
          row.cells.map((text, i) => {
            if (spec.formulas && supportedFormula(text)) return { formula: text.slice(1) };
            const format = sheet.formats[sheet.table.columns[i].id] ?? 'text';
            if (
              format !== 'text' &&
              /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text.trim()) &&
              Number.isFinite(Number(text))
            )
              return Number(text);
            return text;
          }),
        );
      }
      sheet.table.columns.forEach((column, i) => {
        ws.getColumn(i + 1).numFmt = (
          { text: '@', number: '0.00', currency: '"¥"#,##0.00', percent: '0.00%' } as const
        )[sheet.formats[column.id] ?? 'text'];
        ws.getColumn(i + 1).alignment = { vertical: 'top', wrapText: true };
      });
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, sheet.table.rows.length + 1), column: sheet.table.columns.length },
      };
    }
    return {
      bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      generator: 'exceljs/4.4.0',
      calculation: spec.formulas ? ('not_calculated' as const) : ('not_applicable' as const),
    };
  }
  if (object.kind !== 'deck') throw new Error('请选择演示文稿。');
  const spec = object.content as Deck,
    pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.author = 'Yirang';
  pres.subject = `源对象 ${object.id} v${object.revision}`;
  pres.title = spec.title;
  pres.company = 'Local workspace';
  pres.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei' };
  const accent = spec.accent.slice(1);
  spec.slides.forEach((s, i) => {
    const slide = pres.addSlide();
    slide.background = { color: 'F8FAF4' };
    slide.addShape(pres.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 0.16,
      h: 7.5,
      line: { color: accent },
      fill: { color: accent },
    });
    slide.addText(
      s.layout === 'title'
        ? 'PRESENTATION'
        : s.layout === 'section'
          ? 'SECTION'
          : String(i + 1).padStart(2, '0'),
      { x: 0.7, y: 0.55, w: 10, h: 0.3, fontSize: 11, color: accent, charSpacing: 3 },
    );
    const cover = s.layout === 'title' || s.layout === 'section';
    slide.addText(s.title, {
      x: 0.7,
      y: cover ? 1.8 : 1.05,
      w: 11.9,
      h: cover ? 1.4 : 1,
      fontSize: cover ? 36 : 28,
      color: '293D2E',
      bold: false,
      breakLine: false,
      fit: 'shrink',
      margin: 0,
    });
    if (s.subtitle)
      slide.addText(s.subtitle, {
        x: 0.72,
        y: cover ? 3.3 : 2.15,
        w: 11.7,
        h: 0.65,
        fontSize: 17,
        color: '7B8A72',
        fit: 'shrink',
        margin: 0,
      });
    const y = cover ? 4.15 : 3;
    const bodyOptions = {
      x: 0.75,
      y,
      w: s.layout === 'split' ? 5.7 : 11.7,
      h: 6.55 - y,
      fontSize: 19,
      color: '45563E',
      breakLine: false,
      fit: 'shrink' as const,
      margin: 0,
      paraSpaceAfter: 12,
    };
    slide.addText(
      s.layout === 'bullets'
        ? s.body
            .split('\n')
            .map((t) => (t ? `• ${t}` : ''))
            .join('\n')
        : s.body,
      bodyOptions,
    );
    if (s.layout === 'split') slide.addText(s.secondary, { ...bodyOptions, x: 7.05, w: 5.5 });
    slide.addText(spec.footer, {
      x: 0.75,
      y: 7,
      w: 10,
      h: 0.2,
      fontSize: 9,
      color: '94A08B',
      margin: 0,
    });
    slide.addText(String(i + 1), {
      x: 11.8,
      y: 7,
      w: 0.6,
      h: 0.2,
      fontSize: 9,
      color: '94A08B',
      align: 'right',
      margin: 0,
    });
    if (s.notes) slide.addNotes(s.notes);
  });
  const bytes = await pres.write({ outputType: 'nodebuffer' });
  return {
    bytes: Buffer.from(bytes as Buffer),
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    generator: 'pptxgenjs/4.0.1',
    calculation: 'not_applicable' as const,
  };
}
