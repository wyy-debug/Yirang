import { z } from 'zod';
import { Id } from './index.js';
export const XlsxFormat = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    fontSize: z.number().min(6).max(72).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    background: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .nullable()
      .optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    wrap: z.boolean().optional(),
    numberFormat: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => !/[\u0000-\u001f]/.test(value))
      .optional(),
  })
  .strict();
export const XlsxEdit = z
  .object({
    sheetId: z.string().regex(/^\d+$/),
    address: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/),
    value: z
      .string()
      .max(32767)
      .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
      .optional(),
    mode: z.enum(['auto', 'text']).default('auto'),
    format: XlsxFormat.optional(),
  })
  .strict()
  .refine(
    (edit) => edit.value !== undefined || (!!edit.format && Object.keys(edit.format).length > 0),
  );
export const XlsxSheetName = z
  .string()
  .min(1)
  .max(31)
  .refine(
    (name) =>
      name.trim().length > 0 &&
      !/[\\/?*\[\]:\u0000-\u001f]/.test(name) &&
      !name.startsWith("'") &&
      !name.endsWith("'") &&
      name.toLowerCase() !== 'history',
    '工作表名称需为 1–31 字符，不能包含特殊字符或使用 History。',
  );
const structureBase = {
  sheetId: z.string().regex(/^[1-9]\d{0,8}$/),
  editsBefore: z.array(XlsxEdit).max(2000).optional(),
};
export const XlsxStructure = z.discriminatedUnion('kind', [
  z
    .object({ ...structureBase, kind: z.literal('merge_cells'), from: z.string(), to: z.string() })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('unmerge_cells'),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('filter_range'),
      from: z.string(),
      to: z.string(),
      column: z.number().int().positive(),
      match: z.enum(['equal', 'contains']),
      value: z.string().max(1000),
      clear: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('conditional_format'),
      from: z.string(),
      to: z.string(),
      operator: z.enum(['greaterThan', 'lessThan', 'equal']),
      value: z.number().finite(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      clear: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('insert_rows'),
      at: z.number().int().min(1).max(1048576),
      count: z.number().int().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('delete_rows'),
      at: z.number().int().min(1).max(1048576),
      count: z.number().int().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('insert_columns'),
      at: z.number().int().min(1).max(16384),
      count: z.number().int().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('delete_columns'),
      at: z.number().int().min(1).max(16384),
      count: z.number().int().min(1).max(1000),
    })
    .strict(),
  z.object({ ...structureBase, kind: z.literal('add_sheet'), name: XlsxSheetName }).strict(),
  z.object({ ...structureBase, kind: z.literal('rename_sheet'), name: XlsxSheetName }).strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('copy_sheet'),
      newSheetId: z.string().regex(/^[1-9]\d{0,8}$/),
      name: XlsxSheetName,
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('move_sheet'),
      position: z.number().int().min(1).max(200),
    })
    .strict(),
  z.object({ ...structureBase, kind: z.literal('delete_sheet') }).strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('row_layout'),
      start: z.number().int().min(1).max(1048576),
      end: z.number().int().min(1).max(1048576),
      size: z.number().min(1).max(409).optional(),
      hidden: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('column_layout'),
      start: z.number().int().min(1).max(16384),
      end: z.number().int().min(1).max(16384),
      size: z.number().min(1).max(255).optional(),
      hidden: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('freeze'),
      rows: z.number().int().min(0).max(1048575),
      columns: z.number().int().min(0).max(16383),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('fill_range'),
      from: z.string(),
      to: z.string(),
      direction: z.enum(['down', 'right']),
    })
    .strict(),
  z
    .object({
      ...structureBase,
      kind: z.literal('sort_range'),
      from: z.string(),
      to: z.string(),
      keyColumn: z.number().int().min(1).max(16384),
      descending: z.boolean(),
      header: z.boolean(),
    })
    .strict(),
]);
export const XlsxOperations = z.array(XlsxStructure).max(30);
export const XlsxRead = z
  .object({
    objectId: Id,
    expectedRevision: z.number().int().positive(),
    sheetId: z.string().optional(),
    row: z.number().int().min(1).max(1048576).default(1),
    column: z.number().int().min(1).max(16384).default(1),
    rows: z.number().int().min(1).max(80).default(50),
    columns: z.number().int().min(1).max(30).default(16),
    operations: XlsxOperations.optional(),
  })
  .strict();
export const XlsxSave = z
  .object({
    requestId: Id,
    objectId: Id,
    expectedRevision: z.number().int().positive(),
    edits: z.array(XlsxEdit).max(2000),
    operations: XlsxOperations.optional(),
  })
  .strict()
  .refine((value) => value.edits.length > 0 || !!value.operations?.length);
export const XlsxCalculate = XlsxRead.extend({ edits: z.array(XlsxEdit).max(2000) }).strict();
export type SheetEdit = z.infer<typeof XlsxEdit>;
export type StructureEdit = z.infer<typeof XlsxStructure>;
export type CellFormat = z.infer<typeof XlsxFormat>;
export interface XlsxSheet {
  id: string;
  name: string;
  rows: number;
  columns: number;
  hidden: boolean;
  readOnly: boolean;
}
export interface XlsxCell {
  input: string;
  display: string;
  formula: boolean;
  textValue?: boolean;
  readOnly?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;
  wrap?: boolean;
  color?: string;
  background?: string;
  align?: string;
  numberFormat?: string;
  merged?: string;
  mergeBounds?: { from: string; to: string };
}
export interface CalculatedCell {
  display: string;
  formula: boolean;
  error?: string;
}
export interface XlsxCalculation {
  cells: Record<string, CalculatedCell>;
  issues: number;
}
export interface XlsxPage {
  conditionalFormats?: {
    ref: string;
    operator: string;
    value: number;
    color?: string;
    priority: number;
  }[];
  objectId: string;
  revision: number;
  fileName: string;
  sheetId: string;
  sheets: XlsxSheet[];
  row: number;
  column: number;
  rows: number;
  columns: number;
  cells: Record<string, XlsxCell>;
  widths: number[];
  heights: number[];
  hiddenRows?: number[];
  hiddenColumns?: number[];
  frozen?: { rows: number; columns: number };
  warnings: string[];
  structureBlocked?: string;
  nextSheetId?: string;
}
export function columnLabel(index: number) {
  let result = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
export function cellPosition(address: string) {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(address.toUpperCase());
  if (!match) return null;
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return row <= 1048576 && column <= 16384 ? { row, column } : null;
}
