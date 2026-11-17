import { z } from 'zod';
import React from 'react';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import {
  XlsxEdit,
  XlsxSave,
  XlsxOperations,
  columnLabel,
  cellPosition,
  type SheetEdit,
  type XlsxPage,
} from '../../../../packages/contracts/xlsx.js';

export type Edits = Record<string, SheetEdit>;
export type EditorView = { sheetId?: string; row: number; column: number; active: string; end: string };

export const key = (sheet: string, address: string) => `${sheet}:${address}`;

export const Draft = z.object({
  revision: z.number().int().positive(),
  edits: z.array(XlsxEdit).max(2000),
  operations: XlsxOperations.optional(),
  view: z
    .object({
      sheetId: z.string().optional(),
      row: z.number().int().min(1).max(1048576),
      column: z.number().int().min(1).max(16384),
      active: z.string().refine((value) => !!cellPosition(value)),
      end: z.string().refine((value) => !!cellPosition(value)),
    })
    .optional(),
  pending: XlsxSave.nullable().optional(),
});

export const ChangeList = z
  .object({
    format: z.literal('ai-desktop-xlsx-draft').optional(),
    version: z.literal(1).optional(),
    objectId: z.string(),
    baseRevision: z.number().int().positive(),
    edits: z.array(XlsxEdit).max(2000),
    operations: XlsxOperations.optional(),
    view: Draft.shape.view,
    pending: XlsxSave.nullable().optional(),
  })
  .strict()
  .refine((value) => !!value.format === (value.version !== undefined));

export function stable(value: unknown): string {
  return JSON.stringify(
    value && typeof value === 'object'
      ? Array.isArray(value)
        ? value.map((item) => JSON.parse(stable(item)))
        : Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, JSON.parse(stable(v))]),
          )
      : value,
  );
}

export function checkDraftCells(edits: SheetEdit[]) {
  const seen = new Set<string>();
  for (const edit of edits) {
    const id = key(edit.sheetId, edit.address);
    if (!cellPosition(edit.address) || seen.has(id))
      throw Error(uiText('修改清单含重复或越界单元格。'));
    seen.add(id);
  }
}

export function boundedView(view: EditorView): EditorView {
  const first = cellPosition(view.active),
    last = cellPosition(view.end),
    visible = (at: ReturnType<typeof cellPosition>) =>
      at &&
      at.row >= view.row &&
      at.row < view.row + 50 &&
      at.column >= view.column &&
      at.column < view.column + 16;
  return {
    ...view,
    active: visible(first) ? view.active : columnLabel(view.column) + view.row,
    end:
      visible(first) && visible(last)
        ? view.end
        : visible(first)
          ? view.active
          : columnLabel(view.column) + view.row,
  };
}

export function mergeCell(page: XlsxPage, address: string) {
  const bounds = page.cells[address]?.mergeBounds;
  if (!bounds) return { skip: false, rowSpan: 1, colSpan: 1 };
  const a = cellPosition(bounds.from)!,
    b = cellPosition(bounds.to)!,
    point = cellPosition(address)!,
    top = Math.max(page.row, a.row),
    left = Math.max(page.column, a.column);
  return {
    skip: point.row !== top || point.column !== left,
    rowSpan: Math.min(page.row + page.rows - 1, b.row) - top + 1,
    colSpan: Math.min(page.column + page.columns - 1, b.column) - left + 1,
  };
}

export function conditionalColor(page: XlsxPage, row: number, column: number, value: string) {
  if (!value.trim() || !Number.isFinite(Number(value))) return;
  for (const rule of page.conditionalFormats ?? []) {
    const match = rule.ref.split(' ').some((ref) => {
      const [x, y = x] = ref.split(':'),
        a = cellPosition(x),
        b = cellPosition(y);
      return a && b && row >= a.row && row <= b.row && column >= a.column && column <= b.column;
    });
    if (
      match &&
      (rule.operator === 'greaterThan'
        ? Number(value) > rule.value
        : rule.operator === 'lessThan'
          ? Number(value) < rule.value
          : Number(value) === rule.value)
    )
      return rule.color;
  }
}

export function cellLayout(page: XlsxPage, row: number, column: number): React.CSSProperties {
  const hidden = page.hiddenColumns?.includes(column),
    frozenRow = row <= (page.frozen?.rows ?? 0),
    frozenColumn = column <= (page.frozen?.columns ?? 0);
  return {
    display: hidden ? 'none' : undefined,
    position: frozenRow || frozenColumn ? 'sticky' : undefined,
    top: frozenRow
      ? 28 +
        page.heights
          .slice(0, row - page.row)
          .reduce((n, h, i) => n + (page.hiddenRows?.includes(page.row + i) ? 0 : h), 0)
      : undefined,
    left: frozenColumn
      ? 52 +
        page.widths
          .slice(0, column - page.column)
          .reduce((n, w, i) => n + (page.hiddenColumns?.includes(page.column + i) ? 0 : w), 0)
      : undefined,
    zIndex: frozenRow && frozenColumn ? 5 : frozenRow || frozenColumn ? 3 : undefined,
    background: frozenRow || frozenColumn ? '#fff' : undefined,
  };
}

export function parseClipboard(text: string) {
  const rows: string[][] = [[]];
  let field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && (quoted || field.length === 0)) {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === '\t' || char === '\n' || char === '\r')) {
      rows.at(-1)!.push(field);
      field = '';
      if (char !== '\t') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        rows.push([]);
      }
    } else field += char;
  }
  rows.at(-1)!.push(field);
  if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '') rows.pop();
  return rows;
}
