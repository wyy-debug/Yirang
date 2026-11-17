import {
  CodeContent,
  TableContent,
  TextContent,
  DiagramContent,
  DeckContent,
  WorkbookContent,
  type DesktopObject,
  type EditableContent,
  type Table,
} from '../contracts/index.js';

export const kindLabels = {
  text: '文字',
  image: '图片',
  table: '表格',
  code: '代码',
  file: '文件',
  diagram: '图形',
  deck: '演示文稿',
  workbook: '工作簿',
} as const;
export const kindIcons = {
  text: 'T',
  image: '▧',
  table: '▦',
  code: '</>',
  file: '▤',
  diagram: '◇',
  deck: '▱',
  workbook: '▥',
} as const;
export function parseEditable(kind: DesktopObject['kind'], content: unknown): EditableContent {
  if (kind === 'text') return TextContent.parse(content);
  if (kind === 'code') return CodeContent.parse(content);
  if (kind === 'diagram') return DiagramContent.parse(content);
  if (kind === 'deck') return DeckContent.parse(content);
  if (kind === 'workbook') return WorkbookContent.parse(content);
  if (kind === 'table') {
    return TableContent.parse(content);
  }
  throw new Error('图片通过批注操作编辑。');
}
/** RFC 4180 quoting, CRLF and embedded line breaks; all cells remain literal strings. */
export function parseCsv(source: string, uid: () => string): Table {
  if (source.length > 1000000 || source.includes('\0')) throw new Error('CSV 过大或包含无效字符。');
  const text = source.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const field = () => {
    if (cell.length > 4000) throw new Error('CSV 单元格超过 4000 字符。');
    row.push(cell);
    cell = '';
    closed = false;
    if (row.length > 50) throw new Error('CSV 最多支持 50 列。');
  };
  const record = () => {
    field();
    records.push(row);
    row = [];
    if (records.length > 501) throw new Error('CSV 最多支持表头加 500 行。');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === ',') field();
    else if (c === '\r' || c === '\n') {
      record();
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (closed || c === '"') throw new Error('CSV 引号格式无效，请检查分隔符与双引号。');
    else cell += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合。');
  if (cell || row.length || closed) record();
  if (!records.length) throw new Error('CSV 为空。');
  const width = records[0].length;
  if (records.some((r) => r.length !== width)) throw new Error('CSV 每行的列数必须与表头相同。');
  return TableContent.parse({
    columns: records[0].map((label) => ({ id: uid(), label })),
    rows: records.slice(1).map((cells) => ({ id: uid(), cells })),
  });
}
export function tableCsv(table: Table, spreadsheetSafe = true) {
  // CSV does not encode a literal/Formula cell type. Escape executable prefixes by default.
  const quote = (value: string) => {
    const safe = spreadsheetSafe && /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [table.columns.map((c) => c.label), ...table.rows.map((r) => r.cells)]
    .map((row) => row.map(quote).join(','))
    .join('\r\n');
}
export function contentText(content: DesktopObject['content']): string {
  if ('blocks' in content) return content.blocks.map((b) => b.text).join('\n');
  if ('code' in content) return content.code;
  if ('columns' in content) return tableCsv(content, false);
  if ('nodes' in content)
    return (
      content.nodes.map((n) => `${n.text} [${n.id}]`).join('\n') +
      '\n' +
      content.edges.map((e) => `${e.from} → ${e.to} ${e.label}`).join('\n')
    );
  if ('slides' in content)
    return content.slides
      .map((s, i) => `第 ${i + 1} 页 · ${s.title}\n${s.subtitle}\n${s.body}\n${s.secondary}`)
      .join('\n\n');
  if ('sheets' in content)
    return content.sheets.map((s) => `工作表 ${s.name}\n${tableCsv(s.table, false)}`).join('\n\n');
  if ('fileName' in content)
    return `${content.fileName}\n${content.mime} · ${content.size} 字节\nSHA-256 ${content.assetHash}`;
  return content.annotations
    .map((a) => a.note || `${a.type} ${a.x.toFixed(2)}, ${a.y.toFixed(2)}`)
    .join('\n');
}
export function editOperation(object: DesktopObject, content: EditableContent) {
  const type = (
    {
      text: 'replace_text',
      code: 'replace_code',
      table: 'replace_table',
      diagram: 'replace_diagram',
      deck: 'replace_deck',
      workbook: 'replace_workbook',
    } as Record<string, string>
  )[object.kind];
  return { type, objectId: object.id, content };
}
