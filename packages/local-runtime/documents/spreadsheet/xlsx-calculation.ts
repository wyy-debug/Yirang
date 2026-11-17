import ExcelJS from 'exceljs';
import FormulaParser from 'fast-formula-parser';
import * as SSF from 'ssf';
import {
  cellPosition,
  columnLabel,
  type SheetEdit,
  type CalculatedCell,
} from '../../../contracts/xlsx.js';
import { fail } from '../../../contracts/index.js';
import { criteriaFunctions } from './xlsx-extra-functions.js';

const Errors = FormulaParser.FormulaError;
const dateFunctions = new Set(
  'DATE DAY DAYS YEAR MONTH TIME HOUR MINUTE SECOND EOMONTH WEEKDAY'.split(' '),
);
const supported = new Set(
  'SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK SUMIF COUNTIF AVERAGEIF SUMPRODUCT SUMSQ PRODUCT IF IFERROR IFNA AND OR NOT TRUE FALSE ABS ROUND ROUNDUP ROUNDDOWN INT TRUNC MOD POWER SQRT SIGN CEILING FLOOR LEN LEFT RIGHT MID TRIM UPPER LOWER CONCAT CONCATENATE EXACT SUBSTITUTE REPLACE FIND SEARCH VALUE N T ISBLANK ISNUMBER ISTEXT ISERROR ISNA ROW COLUMN ROWS COLUMNS INDEX MATCH VLOOKUP HLOOKUP'.split(
    ' ',
  ),
);
export type Scalar = string | number | boolean | null | Error;
export type CellValue = { value: Scalar; formula?: string; issue?: string };
export type CalculationSheet = {
  id: string;
  name: string;
  cells: Map<string, unknown>;
  rows: number;
  columns: number;
};
export type CalculationName = { name: string; reference: string; sheetName?: string };

/** Shared input conversion for preview and persisted cell values. */
export function editValue(edit: SheetEdit, existing: ExcelJS.Cell, date1904: boolean): CellValue {
  const value = edit.value!;
  if (edit.mode === 'text') return { value };
  if (value.startsWith('=')) return { value: null, formula: value.slice(1) };
  if (value === '') return { value: null };
  if (existing.value instanceof Date && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value)
      fail('XLSX_DATE', '日期无效。');
    return { value: (+date - Date.UTC(1899, 11, 30)) / 86400000 - (date1904 ? 1462 : 0) };
  }
  if (/^(true|false)$/i.test(value)) return { value: value.toLowerCase() === 'true' };
  if (
    /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) &&
    value.replace(/[^0-9]/g, '').length <= 15
  )
    return { value: Number(value) };
  return { value };
}

/** Per-request graph with memoization; parser instances are isolated by recursion depth. */
export class XlsxCalculator {
  private edits: Map<string, SheetEdit>;
  private memo = new Map<string, CellValue>();
  private visiting = new Set<string>();
  private frames: { issue?: string }[] = [];
  private parsers: any[] = [];
  private reads = 0;
  private deadline = Date.now() + 1500;
  constructor(
    private book: ExcelJS.Workbook,
    private sheets: CalculationSheet[],
    edits: SheetEdit[],
    private date1904: boolean,
    private unsupported?: (sheet: string, address: string) => string | undefined,
    private names: CalculationName[] = [],
  ) {
    this.edits = new Map(edits.map((edit) => [`${edit.sheetId}:${edit.address}`, edit]));
  }
  private limited() {
    return ++this.reads > 200000 || Date.now() > this.deadline;
  }
  private reference(sheetName: string, row: number, col: number): Scalar {
    const sheet = this.sheets.find((s) => s.name.toLowerCase() === sheetName?.toLowerCase());
    if (
      !sheet ||
      !Number.isInteger(row) ||
      !Number.isInteger(col) ||
      !cellPosition(columnLabel(col) + row)
    )
      return Errors.REF;
    const result = this.cell(sheet.id, columnLabel(col) + row);
    if (result.issue) this.frames.at(-1)!.issue = result.issue;
    return result.value;
  }
  private parser(depth: number) {
    if (this.parsers[depth]) return this.parsers[depth];
    const parser = new FormulaParser({
      functions: criteriaFunctions(Errors, () => this.limited()),
      onVariable: (name: string, sheetName: string) => {
        const candidates = this.names.filter((n) => n.name.toLowerCase() === name.toLowerCase()),
          chosen =
            candidates.find((n) => n.sheetName === sheetName) ??
            candidates.find((n) => !n.sheetName);
        const ref =
          chosen &&
          /^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)(?::\$?([A-Z]{1,3})\$?([1-9]\d*))?$/i.exec(
            chosen.reference.replace(/^=/, ''),
          );
        if (!ref) {
          this.frames.at(-1)!.issue = '命名区域仅支持单个固定单元格或矩形区域';
          return null;
        }
        const sheet = ref[1]?.replace(/''/g, "'") ?? ref[2],
          from = cellPosition(ref[3].toUpperCase() + ref[4]),
          to = cellPosition((ref[5] ?? ref[3]).toUpperCase() + (ref[6] ?? ref[4]));
        if (!from || !to || from.row > to.row || from.column > to.column) {
          this.frames.at(-1)!.issue = '命名区域地址无效';
          return null;
        }
        return ref[5]
          ? {
              sheet,
              from: { row: from.row, col: from.column },
              to: { row: to.row, col: to.column },
            }
          : { sheet, row: from.row, col: from.column };
      },
      onCell: ({ sheet, row, col }: any) => this.reference(sheet, row, col),
      onRange: ({ sheet, from, to }: any) => {
        const count = (to.row - from.row + 1) * (to.col - from.col + 1);
        if (
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count > 25000 ||
          from.row < 1 ||
          from.col < 1 ||
          to.row > 1048576 ||
          to.col > 16384
        ) {
          this.frames.at(-1)!.issue = '引用区域超过实时计算范围（最多 25000 格）';
          return [[Errors.REF]];
        }
        const result: Scalar[][] = [];
        for (let r = from.row; r <= to.row; r++) {
          const row: Scalar[] = [];
          for (let c = from.col; c <= to.col; c++) row.push(this.reference(sheet, r, c));
          result.push(row);
        }
        return result;
      },
    });
    const call = parser.callFunction.bind(parser);
    parser.callFunction = (name: string, args: unknown[]) => {
      const normalized = name.replace(/^_xlfn\./i, '').toUpperCase();
      if (
        !supported.has(normalized) &&
        !dateFunctions.has(normalized) &&
        !['TEXT', 'SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'XLOOKUP', 'XMATCH', 'TEXTJOIN'].includes(
          normalized,
        )
      ) {
        this.frames.at(-1)!.issue = `暂不支持函数 ${normalized}`;
        return Errors.NAME;
      }
      if (this.date1904 && dateFunctions.has(normalized)) {
        this.frames.at(-1)!.issue = '1904 日期系统的日期函数暂不计算';
        return Errors.VALUE;
      }
      return call(normalized, args);
    };
    this.parsers[depth] = parser;
    return parser;
  }
  cell(sheetId: string, address: string): CellValue {
    const key = `${sheetId}:${address}`;
    if (this.limited())
      return { value: Errors.VALUE, issue: '本次计算超过资源限制，请缩小公式引用范围' };
    const cached = this.memo.get(key);
    if (cached) return cached;
    if (this.visiting.has(key)) return { value: Errors.REF, issue: '检测到循环引用' };
    if (this.frames.length >= 32) return { value: Errors.REF, issue: '公式依赖超过 32 层' };
    const sheet = this.sheets.find((s) => s.id === sheetId),
      ws = this.book.getWorksheet(Number(sheetId));
    if (!sheet || !ws) return { value: Errors.REF };
    const edit = this.edits.get(key),
      exists = sheet.cells.has(address),
      cell = exists || edit ? ws.getCell(address) : undefined;
    const unsupported = this.unsupported?.(sheetId, address);
    if (unsupported) {
      const result = { value: Errors.VALUE, issue: unsupported };
      this.memo.set(key, result);
      return result;
    }
    let source: CellValue;
    try {
      if (edit?.value !== undefined) source = editValue(edit, cell!, this.date1904);
      else if (!cell) source = { value: null };
      else if (cell.type === ExcelJS.ValueType.Merge) source = { value: null };
      else if (cell.type === ExcelJS.ValueType.Formula)
        source = { value: null, formula: cell.formula };
      else if (cell.value instanceof Date)
        source = {
          value: (+cell.value - Date.UTC(1899, 11, 30)) / 86400000 - (this.date1904 ? 1462 : 0),
        };
      else if (cell.type === ExcelJS.ValueType.Error)
        source = { value: new Errors((cell.value as ExcelJS.CellErrorValue).error) };
      else if (
        typeof cell.value === 'number' ||
        typeof cell.value === 'boolean' ||
        typeof cell.value === 'string' ||
        cell.value === null
      )
        source = { value: cell.value };
      else source = { value: cell.text ?? '' };
    } catch {
      source = { value: Errors.VALUE, issue: '输入值或公式无法解析' };
    }
    if (source.formula !== undefined) {
      const frame: { issue?: string } = {},
        depth = this.frames.length;
      this.visiting.add(key);
      this.frames.push(frame);
      try {
        if (!source.formula || source.formula.length > 8192)
          frame.issue = '公式为空或超过 8192 字符';
        // External/structured references and array expressions are outside this scalar editor.
        const syntax = source.formula.replace(/"(?:[^"]|"")*"/g, '""');
        if (/[\[\]{}]/.test(syntax)) frame.issue = '外部引用、结构化引用及数组公式暂不支持';
        source.value = frame.issue
          ? Errors.NAME
          : this.parser(depth).parse(source.formula, {
              sheet: sheet.name,
              row: cellPosition(address)!.row,
              col: cellPosition(address)!.column,
            });
        if (typeof source.value === 'number' && !Number.isFinite(source.value))
          source.value = Errors.NUM;
        if (typeof source.value === 'string' && source.value.length > 32767)
          frame.issue = '计算结果文本超过 32767 字符';
        if (source.value instanceof Errors && ['#NAME?', '#ERROR!'].includes(String(source.value)))
          frame.issue ??= '公式语法或函数暂不支持';
        if (
          source.value !== null &&
          !['number', 'boolean', 'string'].includes(typeof source.value) &&
          !(source.value instanceof Error)
        )
          frame.issue = '此公式不是单个单元格结果';
        if (frame.issue) {
          source.issue = frame.issue;
          source.value = Errors.VALUE;
        }
      } catch {
        source = { ...source, value: Errors.VALUE, issue: frame.issue ?? '公式语法或函数暂不支持' };
      } finally {
        this.frames.pop();
        this.visiting.delete(key);
      }
    }
    this.memo.set(key, source);
    return source;
  }
  display(sheetId: string, address: string): CalculatedCell {
    const result = this.cell(sheetId, address),
      cell = this.book.getWorksheet(Number(sheetId))!.getCell(address),
      format =
        this.edits.get(`${sheetId}:${address}`)?.format?.numberFormat ?? cell.numFmt ?? 'General';
    if (result.issue)
      return {
        display: result.issue.includes('循环') ? '#CYCLE!' : '#UNSUPPORTED!',
        formula: result.formula !== undefined,
        error: result.issue,
      };
    if (result.value instanceof Error)
      return {
        display: String(result.value),
        formula: result.formula !== undefined,
        error: String(result.value),
      };
    try {
      return {
        display:
          result.value === null
            ? ''
            : SSF.format(format, result.value, { date1904: this.date1904 }),
        formula: result.formula !== undefined,
      };
    } catch {
      return {
        display: String(result.value ?? ''),
        formula: result.formula !== undefined,
        error: '此数字格式暂无法显示，原格式仍保留',
      };
    }
  }
}
