import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { fail } from '../../contracts/index.js';
import {
  WorkflowOutputsSchema,
  WORKFLOW_VALUE_LIMIT,
  type WorkflowNode,
  type WorkflowValue,
} from '../../contracts/workflows.js';
import { cellPosition, columnLabel } from '../../contracts/xlsx.js';
import { isNativeTextFile, NATIVE_FILE_LIMIT } from '../../components/native-files.js';
import { XlsxEditor } from '../documents/spreadsheet/xlsx-editor.js';
import { loadOffice } from '../documents/office-editor.js';
import { xml } from '../documents/spreadsheet/xlsx-xml.js';

export type WorkflowNativeFile = { fileName: string; bytes: Uint8Array };
type Outputs = Record<string, WorkflowValue>;
type Table = { columns: string[]; rows: unknown[][] };
type Parameters = Record<string, unknown>;
const OUTPUT_BYTES = 230 * 1024,
  MAX_ROWS = 10000,
  MAX_COLUMNS = 200,
  MAX_CELLS = 50000;
function bad(message: string): never {
  return fail('WORKFLOW_NATIVE', message);
}
function tooLarge(): never {
  return fail(
    'WORKFLOW_LIMIT',
    '组件输出超过 230 KiB，请缩小工作表范围、段落、页码或图表数据后再运行。',
  );
}
function text(p: Parameters, name: string, fallback = '', limit = 1000) {
  const v = p[name] ?? fallback;
  if (typeof v !== 'string' || v.length > limit) bad(`${name} 必须是最多 ${limit} 字符的文本。`);
  return v as string;
}
function flag(p: Parameters, name: string, fallback: boolean) {
  const v = p[name] ?? fallback;
  if (typeof v !== 'boolean') bad(`${name} 必须是布尔值。`);
  return v as boolean;
}
function integer(p: Parameters, name: string, fallback: number, min: number, max: number) {
  const v = p[name] ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    bad(`${name} 必须是 ${min}–${max} 的整数。`);
  return v as number;
}
function choice<T extends string>(
  p: Parameters,
  name: string,
  fallback: T,
  values: readonly T[],
): T {
  const v = text(p, name, fallback);
  if (!values.includes(v as T)) bad(`${name} 仅支持 ${values.join('、')}。`);
  return v as T;
}
function bounded(outputs: Outputs): Outputs {
  if (
    Buffer.byteLength(JSON.stringify(outputs), 'utf8') >
    Math.min(OUTPUT_BYTES, WORKFLOW_VALUE_LIMIT)
  )
    tooLarge();
  return WorkflowOutputsSchema.parse(outputs);
}
function selection(expression: string, total: number, label: string, max = MAX_ROWS) {
  if (!expression.trim()) {
    if (total > max) bad(`${label}共 ${total} 项，请填写范围，每次最多 ${max} 项。`);
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const result = new Set<number>();
  for (const part of expression.split(/[,，]/)) {
    const match = /^\s*([1-9]\d*)(?:\s*[-–]\s*([1-9]\d*))?\s*$/.exec(part);
    if (!match) bad(`${label}请使用 1,3-5 这样的序号或范围。`);
    const from = Number(match![1]),
      to = Number(match![2] ?? match![1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to > total)
      bad(`${label}范围超出 1–${total}，或起点大于终点。`);
    if (to - from + 1 > max) bad(`每次最多选择 ${max} 个${label}。`);
    for (let i = from; i <= to; i++) {
      result.add(i);
      if (result.size > max) bad(`每次最多选择 ${max} 个${label}。`);
    }
  }
  return [...result].sort((a, b) => a - b);
}
function unitOutputs(
  fileName: string,
  kind: string,
  units: { number: number; text: string }[],
  parameters: Parameters,
  metadata: Record<string, unknown>,
): Outputs {
  const includeEmpty = flag(parameters, 'include_empty', false),
    query = text(parameters, 'text_query', '', 300),
    sensitive = flag(parameters, 'case_sensitive', false);
  const matches = (value: string) =>
    !query ||
    (sensitive
      ? value.includes(query)
      : value.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const chosen = units.filter(
    (unit) => (includeEmpty || unit.text.trim().length > 0) && matches(unit.text),
  );
  const content = chosen.map((unit) => unit.text).join('\n\n');
  return bounded({
    text: { type: 'text', value: content },
    table: {
      type: 'table',
      value: { columns: [kind, 'text'], rows: chosen.map((unit) => [unit.number, unit.text]) },
    },
    metadata: {
      type: 'json',
      value: {
        fileName,
        ...metadata,
        selected: units.map((unit) => unit.number),
        returned: chosen.map((unit) => unit.number),
        textQuery: query || null,
      },
    },
  });
}
function onlyFile(
  inputs: Record<string, WorkflowValue>,
  files: ReadonlyMap<string, WorkflowNativeFile>,
) {
  const input = inputs.files;
  if (!input || input.type !== 'files') bad('原生提取组件需要 files 文件列表输入。');
  if (input.value.length !== 1)
    bad('原生提取组件每次处理一个文件；多个文件请使用文件批处理组件逐项运行。');
  const ref = input.value[0],
    key = 'objectId' in ref ? ref.objectId : ref.artifactId,
    file = files.get(key);
  if (!file) bad('文件不在本次已授权、冻结的输入范围内。');
  if (file.bytes.byteLength > NATIVE_FILE_LIMIT) bad('原生文件超过 50 MiB，暂不支持在组件中提取。');
  // Own the byte view so readers cannot detach or mutate the caller's frozen bytes.
  return { fileName: file.fileName, bytes: Buffer.from(file.bytes) };
}
function excelScalar(value: unknown, address: string): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) bad(`${address} 包含无效日期。`);
    return value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) bad(`${address} 不是有限数字。`);
    return value;
  }
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>;
    if (typeof cell.error === 'string')
      bad(`${address} 包含 Excel 错误 ${cell.error}，请先修正后再提取。`);
    if ('formula' in cell || 'sharedFormula' in cell) {
      if (cell.result === undefined)
        bad(`${address} 的公式没有已保存的计算结果，请先计算并保存工作簿再提取。`);
      return excelScalar(cell.result, address);
    }
    if (Array.isArray(cell.richText))
      return cell.richText
        .map((item) => (typeof item?.text === 'string' ? item.text : ''))
        .join('');
    if (typeof cell.text === 'string') return cell.text;
  }
  bad(`${address} 的单元格值类型暂不支持提取。`);
}
function columnNames(values: unknown[], fromColumn: number) {
  const used = new Set<string>();
  return values.map((value, i) => {
    const base = String(value ?? '').trim() || columnLabel(fromColumn + i);
    if (base.length > 180) bad('表头超过 180 字符，请缩短表头或取消首行为表头。');
    let label = base,
      n = 2;
    while (used.has(label)) label = `${base}_${n++}`;
    used.add(label);
    return label;
  });
}
async function extractXlsx(
  file: ReturnType<typeof onlyFile>,
  parameters: Parameters,
): Promise<Outputs> {
  if (!/\.xlsx$/i.test(file.fileName))
    bad('Excel 提取目前支持 .xlsx；请先把 .xls 或 .xlsm 另存为 .xlsx。');
  const parsed = await new XlsxEditor().parse(
    file.bytes,
    createHash('sha256').update(file.bytes).digest('hex'),
  );
  const selector = text(parameters, 'worksheet', '', 120).trim(),
    sheets = parsed.book.worksheets;
  const sheet = selector
    ? (sheets.find((item) => item.name === selector) ??
      (/^[1-9]\d*$/.test(selector) ? sheets[Number(selector) - 1] : undefined))
    : (sheets.find((item) => item.state === 'visible') ?? sheets[0]);
  if (!sheet)
    bad(`找不到工作表 ${selector}。可选工作表：${sheets.map((item) => item.name).join('、')}。`);
  const expression = text(parameters, 'range', '', 80).trim().replace(/\$/g, '').toUpperCase();
  let from = { row: 1, column: 1 },
    to = { row: sheet.actualRowCount ? sheet.rowCount : 1, column: Math.max(1, sheet.columnCount) };
  if (expression) {
    const parts = expression.split(':'),
      a = cellPosition(parts[0]),
      b = cellPosition(parts[1] ?? parts[0]);
    if (parts.length > 2 || !a || !b || a.row > b.row || a.column > b.column)
      bad('单元格范围请使用 A1:D50，不支持跨工作表或整列范围。');
    from = a!;
    to = b!;
  }
  const columns = to.column - from.column + 1,
    rows = to.row - from.row + 1,
    header = flag(parameters, 'header_row', true),
    includeEmpty = flag(parameters, 'include_empty', false);
  if (
    columns > MAX_COLUMNS ||
    rows > (header ? MAX_ROWS + 1 : MAX_ROWS) ||
    rows * columns > MAX_CELLS
  )
    bad('一次最多提取 10000 行、200 列、50000 格；请填写更小的单元格范围。');
  const data: unknown[][] = [],
    sourceRows: number[] = [];
  let formulas = 0,
    merged = 0,
    estimated = 0;
  for (let r = from.row; r <= to.row; r++) {
    const row: unknown[] = [];
    for (let c = from.column; c <= to.column; c++) {
      const cell = sheet.getCell(r, c);
      if (cell.isMerged && cell.master.address !== cell.address) {
        merged++;
        row.push(null);
        continue;
      }
      if (cell.type === 6) formulas++;
      row.push(excelScalar(cell.value, `${sheet.name}!${cell.address}`));
    }
    if (
      (r === from.row && header) ||
      includeEmpty ||
      row.some((value) => value !== null && value !== '')
    ) {
      estimated += Buffer.byteLength(JSON.stringify(row));
      if (estimated > OUTPUT_BYTES) tooLarge();
      data.push(row);
      sourceRows.push(r);
    }
  }
  const names = header
    ? columnNames(data.shift() ?? Array(columns).fill(null), from.column)
    : Array.from({ length: columns }, (_, i) => columnLabel(from.column + i));
  if (header) sourceRows.shift();
  const table = { columns: names, rows: data },
    tsv = (value: unknown) => {
      const raw = String(value ?? '');
      return /[\t\n\r"]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
    };
  return bounded({
    text: {
      type: 'text',
      value: [names, ...data].map((row) => row.map(tsv).join('\t')).join('\n'),
    },
    table: { type: 'table', value: table },
    metadata: {
      type: 'json',
      value: {
        fileName: file.fileName,
        format: 'xlsx',
        worksheet: sheet.name,
        worksheets: sheets.map((item) => item.name),
        range: `${columnLabel(from.column)}${from.row}:${columnLabel(to.column)}${to.row}`,
        sourceRows,
        headerRow: header,
        formulaCells: formulas,
        mergedFollowers: merged,
        warnings: [
          ...(formulas ? ['公式读取文件中已保存的结果，此步骤不重新计算公式。'] : []),
          ...(merged ? ['合并区域仅主单元格保留值，其余位置为 null。'] : []),
        ],
      },
    },
  });
}
async function extractDocx(
  file: ReturnType<typeof onlyFile>,
  parameters: Parameters,
): Promise<Outputs> {
  if (!/\.docx$/i.test(file.fileName)) bad('Word 提取需要 .docx 文件，不支持旧版 .doc。');
  const zip = await loadOffice(file.bytes),
    source = await xml(zip, 'word/document.xml'),
    paragraphs: { number: number; text: string }[] = [];
  // Streaming XML retains nested hyperlink text and avoids loading embedded images.
  const parser = new SaxesParser({ xmlns: true });
  let current: { number: number; text: string } | undefined,
    textDepth = 0,
    deleted = 0,
    depth = 0,
    nodes = 0;
  const stack: { local: string; word: boolean }[] = [];
  parser.on('doctype', () => bad('Word 正文 XML 不支持 DTD。'));
  parser.on('opentag', (tag) => {
    if (++nodes > 400000 || ++depth > 128) bad('Word 文档结构过于复杂，请拆分文档后提取。');
    const word =
      tag.uri === 'http://schemas.openxmlformats.org/wordprocessingml/2006/main' ||
      tag.uri === 'http://purl.oclc.org/ooxml/wordprocessingml/main';
    stack.push({ local: tag.local, word });
    if (!word) return;
    if (tag.local === 'del' || tag.local === 'moveFrom') deleted++;
    if (tag.local === 'p') {
      if (current) bad('当前 Word 文档包含嵌套文本框段落，请将正文提取到普通文档后重试。');
      if (paragraphs.length >= MAX_ROWS) bad('Word 文档超过 10000 段，请拆分后提取。');
      current = { number: paragraphs.length + 1, text: '' };
      paragraphs.push(current);
    }
    if (tag.local === 't' && !deleted) textDepth++;
    if (current && !deleted && ['tab', 'br', 'cr'].includes(tag.local))
      current.text += tag.local === 'tab' ? '\t' : '\n';
  });
  parser.on('text', (value) => {
    if (current && textDepth && !deleted) current.text += value;
  });
  parser.on('closetag', () => {
    const tag = stack.pop();
    depth--;
    if (!tag?.word) return;
    if (tag.local === 't' && !deleted) textDepth--;
    if (tag.local === 'p') current = undefined;
    if (tag.local === 'del' || tag.local === 'moveFrom') deleted--;
  });
  parser.write(source).close();
  const picked = selection(text(parameters, 'paragraphs'), paragraphs.length, '段落');
  return unitOutputs(
    file.fileName,
    'paragraph',
    picked.map((number) => paragraphs[number - 1]),
    parameters,
    {
      format: 'docx',
      paragraphCount: paragraphs.length,
      warnings: [
        '提取正文与正文表格内文字，保留插入的修订，排除删除的修订；不包含页眉页脚、脚注、图片 OCR 或页面排版。',
      ],
    },
  );
}
async function extractPdf(
  file: ReturnType<typeof onlyFile>,
  parameters: Parameters,
): Promise<Outputs> {
  if (
    !/\.pdf$/i.test(file.fileName) ||
    !file.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))
  )
    bad('PDF 提取需要有效的 .pdf 文件。');
  (globalThis as any).pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(file.bytes),
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const doc = await task.promise;
      if (doc.numPages > 2000) bad('PDF 超过 2000 页，请拆分后提取。');
      const picked = selection(text(parameters, 'pages'), doc.numPages, '页码', 200),
        units: { number: number; text: string }[] = [];
      let bytes = 0;
      for (const number of picked) {
        const page = await doc.getPage(number);
        try {
          const content = await page.getTextContent(),
            parts: string[] = [];
          for (const item of content.items) {
            if (!('str' in item)) continue;
            parts.push(item.str);
            parts.push(item.hasEOL ? '\n' : ' ');
          }
          const value = parts
            .join('')
            .replace(/[ \t]+\n/g, '\n')
            .trim();
          bytes += Buffer.byteLength(value);
          if (bytes > OUTPUT_BYTES) tooLarge();
          units.push({ number, text: value });
        } finally {
          page.cleanup();
        }
      }
      if (units.length && units.every((unit) => !unit.text.trim()))
        bad('所选 PDF 页面没有可提取的文字层，可能是扫描图片；当前组件不提供 OCR。');
      return unitOutputs(file.fileName, 'page', units, parameters, {
        format: 'pdf',
        pageCount: doc.numPages,
        warnings: [
          '按 PDF 文字层的阅读顺序提取；复杂分栏、表格不保证原版式，不执行 PDF 脚本，也不提供图片 OCR。',
          ...(units.some((unit) => !unit.text.trim()) ? ['部分所选页面没有文字层。'] : []),
        ],
      });
    })();
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('PDF 提取超过 45 秒，请减少页数后重试。')), 45000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await task.destroy();
  }
}
function extractText(file: ReturnType<typeof onlyFile>, parameters: Parameters): Outputs {
  if (!isNativeTextFile(file.fileName))
    bad('此文件扩展名不属于支持的原生文本格式。请选择 .txt、.md、.html、.json 等文本文件。');
  if (file.bytes.length > 8 * 1024 * 1024)
    bad('文本提取每次支持最多 8 MiB，请先拆分较大的文本文件。');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    bad('文本文件必须为 UTF-8 编码，请转换编码后重试。');
  }
  const lines = content!
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  if (lines.length > 200000) bad('文本文件超过 200000 行，请先拆分后提取。');
  const picked = selection(text(parameters, 'paragraphs'), lines.length, '行号');
  return unitOutputs(
    file.fileName,
    'line',
    picked.map((number) => ({ number, text: lines[number - 1] })),
    parameters,
    {
      format: 'text',
      lineCount: lines.length,
      warnings: ['HTML、Markdown、SVG 和代码文件按原始文本提取，不执行其中的内容。'],
    },
  );
}

const escapeXml = (value: unknown) =>
  String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const short = (value: unknown, length = 24) => {
  const text = String(value ?? '');
  return text.length > length ? text.slice(0, length - 1) + '…' : text;
};
function number(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (
    typeof value === 'string' &&
    value.trim() &&
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  ) {
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
  }
  return undefined;
}
const numberLabel = (value: number) =>
  Math.abs(value) >= 1e8 || (Math.abs(value) > 0 && Math.abs(value) < 0.001)
    ? value.toExponential(2)
    : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(value);
/** Generate a standalone SVG without scripts, links, external fonts or images. */
export function generateWorkflowChart(
  inputs: Record<string, WorkflowValue>,
  parameters: Parameters = {},
): Outputs {
  const input = inputs.table;
  if (!input || input.type !== 'table') bad('图表组件需要 table 表格输入。');
  const table = input.value as Table,
    { columns, rows } = table;
  if (
    !columns.length ||
    columns.length > MAX_COLUMNS ||
    new Set(columns).size !== columns.length ||
    columns.some((name) => !name)
  )
    bad('表格列名需要非空、唯一，最多 200 列。');
  if (
    !rows.length ||
    rows.length > MAX_ROWS ||
    rows.some((row) => !Array.isArray(row) || row.length !== columns.length)
  )
    bad('图表需要 1–10000 行，且每行单元格数与列名一致。');
  const kind = choice(parameters, 'chart_type', 'bar', ['bar', 'line', 'metric'] as const),
    x = text(parameters, 'x_column', '', 200) || columns[0],
    xIndex = columns.indexOf(x);
  if (xIndex < 0) bad(`找不到横轴列 ${x}。`);
  let requested = parameters.y_columns ?? [];
  if (typeof requested === 'string')
    requested = requested
      .split(/[,，]/)
      .map((v) => v.trim())
      .filter(Boolean);
  if (
    !Array.isArray(requested) ||
    requested.some((name) => typeof name !== 'string') ||
    requested.length > 6
  )
    bad('y_columns 请选择最多 6 个数值列。');
  const names = requested.length
    ? (requested as string[])
    : columns
        .filter(
          (name, index) =>
            (kind === 'metric' || name !== x) &&
            rows.every((row) => number(row[index]) !== undefined),
        )
        .slice(0, 3);
  if (!names.length || new Set(names).size !== names.length)
    bad('请选择不重复的数值列；自动识别时未找到完整的数值列。');
  const indices = names.map((name) => {
    const index = columns.indexOf(name);
    if (index < 0) bad(`找不到数值列 ${name}。`);
    return index;
  });
  const series = indices.map((index, i) =>
    rows.map((row, r) => {
      const value = number(row[index]);
      if (value === undefined)
        bad(`第 ${r + 1} 行的 ${names[i]} 不是有限数值；空值不能当作 0 绘图。`);
      return value!;
    }),
  );
  if (kind !== 'metric' && rows.length > 200)
    bad('柱状图和折线图最多显示 200 行，请先筛选、聚合或缩小数据范围。');
  const width = integer(parameters, 'width', 900, 400, 2000),
    height = integer(parameters, 'height', 520, 240, 1200),
    title =
      text(parameters, 'title', '', 200) ||
      { bar: '数据对比', line: '数据趋势', metric: '关键指标' }[kind];
  const colors = ['#4179ea', '#38a58a', '#9a6be0', '#e99c43', '#df6c83', '#52a5be'],
    pieces: string[] = [];
  const label = (
    x: number,
    y: number,
    value: unknown,
    size = 12,
    fill = '#667085',
    anchor = 'start',
  ) =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
  pieces.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title"><title id="chart-title">${escapeXml(title)}</title><desc>${escapeXml(`${rows.length} 行数据；数值列 ${names.join('、')}`)}</desc><rect width="${width}" height="${height}" rx="20" fill="#ffffff"/><g font-family="system-ui, -apple-system, Segoe UI, Microsoft YaHei, sans-serif">`,
    label(32, 42, short(title, Math.max(10, Math.floor((width - 64) / 22))), 22, '#172033'),
  );
  let metricValues: number[] | undefined;
  const aggregate = choice(parameters, 'aggregate', 'sum', [
    'first',
    'sum',
    'mean',
    'min',
    'max',
  ] as const);
  if (kind === 'metric') {
    metricValues = series.map((values) => {
      let value = values[0];
      if (aggregate === 'sum' || aggregate === 'mean')
        value = values.reduce((a, b) => a + b, 0) / (aggregate === 'mean' ? values.length : 1);
      else if (aggregate === 'min') value = values.reduce((a, b) => Math.min(a, b));
      else if (aggregate === 'max') value = values.reduce((a, b) => Math.max(a, b));
      if (!Number.isFinite(value)) bad('指标聚合结果溢出，请缩小数据范围或数值尺度。');
      return value;
    });
    const count = Math.min(3, names.length, Math.max(1, Math.floor((width - 48) / 196))),
      rowCount = Math.ceil(names.length / count),
      gap = 16,
      w = (width - 64 - gap * (count - 1)) / count,
      h = (height - 112 - gap * (rowCount - 1)) / rowCount;
    if (h < 100)
      bad(
        `当前指标数量和宽度需要至少 ${112 + 100 * rowCount + gap * (rowCount - 1)} 像素高度，请增加高度或减少指标列。`,
      );
    metricValues.forEach((value, i) => {
      const x = 32 + (i % count) * (w + gap),
        y = 72 + Math.floor(i / count) * (h + gap),
        display = numberLabel(value);
      pieces.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#f5f7fb"/>`,
        label(x + 18, y + 32, short(names[i], Math.max(6, Math.floor(w / 13))), 13),
        label(
          x + 18,
          y + Math.max(64, h * 0.58),
          display,
          Math.min(42, Math.max(15, ((w - 36) / Math.max(1, display.length)) * 1.6)),
          colors[i],
        ),
        label(
          x + 18,
          y + h - 18,
          { first: '首条', sum: '合计', mean: '平均值', min: '最小值', max: '最大值' }[aggregate] +
            ` · ${rows.length} 条`,
          11,
        ),
      );
    });
  } else {
    const left = 78,
      top = 106,
      right = width - 32,
      bottom = height - 76,
      w = right - left,
      h = bottom - top,
      values = series.flat();
    let minimum = Math.min(0, ...values),
      maximum = Math.max(0, ...values);
    if (minimum === maximum) maximum = minimum + 1;
    const span = maximum - minimum;
    if (!Number.isFinite(span) || span <= 0) bad('图表数值跨度过大，请换算为较小单位后再绘制。');
    const y = (value: number) => bottom - ((value - minimum) / span) * h,
      zero = y(0);
    for (let i = 0; i <= 4; i++) {
      const value = minimum + (span * i) / 4,
        at = y(value);
      pieces.push(
        `<line x1="${left}" y1="${at}" x2="${right}" y2="${at}" stroke="#e9edf4"/>`,
        label(left - 12, at + 4, numberLabel(value), 11, '#667085', 'end'),
      );
    }
    pieces.push(`<line x1="${left}" y1="${zero}" x2="${right}" y2="${zero}" stroke="#aab5c7"/>`);
    const band = w / rows.length,
      pointX = (i: number) => left + band * (i + 0.5),
      stride = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(w / 95))));
    rows.forEach((row, i) => {
      if (i % stride === 0 || i === rows.length - 1)
        pieces.push(label(pointX(i), bottom + 23, short(row[xIndex], 12), 11, '#667085', 'middle'));
    });
    names.forEach((name, i) => {
      const lx = 32 + (i % 3) * ((width - 64) / 3),
        ly = 68 + Math.floor(i / 3) * 18;
      pieces.push(
        `<rect x="${lx}" y="${ly - 9}" width="9" height="9" rx="3" fill="${colors[i]}"/>`,
        label(lx + 16, ly, short(name, Math.max(8, Math.floor((width - 100) / 3 / 12))), 11),
      );
    });
    series.forEach((values, seriesIndex) => {
      const color = colors[seriesIndex];
      if (kind === 'bar') {
        const group = band * 0.76,
          bar = group / series.length;
        values.forEach((value, index) => {
          const x = pointX(index) - group / 2 + seriesIndex * bar,
            at = y(value);
          pieces.push(
            `<rect x="${x}" y="${Math.min(at, zero)}" width="${Math.max(0.3, bar * 0.88)}" height="${Math.abs(at - zero)}" rx="${Math.min(4, bar / 4)}" fill="${color}"><title>${escapeXml(`${rows[index][xIndex]} · ${names[seriesIndex]}: ${value}`)}</title></rect>`,
          );
        });
      } else {
        pieces.push(
          `<polyline points="${values.map((value, index) => `${pointX(index)},${y(value)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`,
        );
        if (values.length <= 80)
          values.forEach((value, index) =>
            pieces.push(
              `<circle cx="${pointX(index)}" cy="${y(value)}" r="3" fill="${color}"><title>${escapeXml(`${rows[index][xIndex]} · ${names[seriesIndex]}: ${value}`)}</title></circle>`,
            ),
          );
      }
    });
    pieces.push(label((left + right) / 2, height - 24, short(x, 50), 12, '#344054', 'middle'));
  }
  pieces.push('</g></svg>');
  return bounded({
    svg: { type: 'text', value: pieces.join('') },
    summary: {
      type: 'json',
      value: {
        chartType: kind,
        title,
        rows: rows.length,
        xColumn: x,
        yColumns: names,
        width,
        height,
        ...(metricValues
          ? {
              aggregate,
              values: Object.fromEntries(names.map((name, i) => [name, metricValues![i]])),
            }
          : { warnings: ['横轴按输入行顺序绘制，相同标签的行不会自动合并。'] }),
      },
    },
  });
}

/** Pure data worker: only frozen supplied bytes, no filesystem writes or network fetches.
 * The caller must authorize inputs and commit outputs under its run-state transaction. */
export async function executeNativeWorkflowNode(
  node: WorkflowNode,
  inputs: Record<string, WorkflowValue>,
  files: ReadonlyMap<string, WorkflowNativeFile>,
): Promise<Outputs> {
  const parameters = node.config.parameters ?? {};
  if (node.type === 'chart') return generateWorkflowChart(inputs, parameters);
  if (node.type !== 'extract') bad('此组件不是原生提取或图表组件。');
  const file = onlyFile(inputs, files),
    requested = choice(parameters, 'format', 'auto', [
      'auto',
      'xlsx',
      'docx',
      'pdf',
      'text',
    ] as const);
  const format =
    requested !== 'auto'
      ? requested
      : /\.xlsx$/i.test(file.fileName)
        ? 'xlsx'
        : /\.docx$/i.test(file.fileName)
          ? 'docx'
          : /\.pdf$/i.test(file.fileName)
            ? 'pdf'
            : 'text';
  if (format === 'xlsx') return extractXlsx(file, parameters);
  if (format === 'docx') return extractDocx(file, parameters);
  if (format === 'pdf') return extractPdf(file, parameters);
  return extractText(file, parameters);
}
