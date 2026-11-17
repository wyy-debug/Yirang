import {
  DesktopError,
  type DesktopObject,
  type MaterialRange,
  type Text,
  type Code,
  type Table,
} from '../contracts/index.js';
export function selectedObject(
  object: DesktopObject,
  range?: MaterialRange,
  nativeText?: string,
): DesktopObject {
  if (!range) return object;
  const fail: () => never = () => {
    throw new DesktopError('STALE_SELECTION', '局部选区已过期，请重新选择。');
  };
  if (range.baseRevision !== object.revision) fail();
  if (range.type === 'file_text') {
    if (object.kind !== 'file' || nativeText === undefined || range.end > nativeText.length) fail();
    return { ...object, selection: range, selectedText: nativeText!.slice(range.start, range.end) };
  }
  if (range.type === 'cells') {
    if (object.kind !== 'table') fail();
    const table = object.content as Table;
    if (
      range.rowIds.some((id) => !table.rows.some((r) => r.id === id)) ||
      range.columnIds.some((id) => !table.columns.some((c) => c.id === id))
    )
      fail();
    const indexes = table.columns
      .map((c, i) => (range.columnIds.includes(c.id) ? i : -1))
      .filter((i) => i >= 0);
    return {
      ...object,
      selection: range,
      content: {
        columns: indexes.map((i) => table.columns[i]),
        rows: table.rows
          .filter((r) => range.rowIds.includes(r.id))
          .map((r) => ({ ...r, cells: indexes.map((i) => r.cells[i]) })),
      },
    };
  }
  if (range.type !== object.kind) fail();
  const text =
    object.kind === 'text'
      ? (object.content as Text).blocks[0].text
      : (object.content as Code).code;
  if (range.end > text.length) fail();
  return {
    ...object,
    selection: range,
    content:
      object.kind === 'text'
        ? {
            blocks: [
              { ...(object.content as Text).blocks[0], text: text.slice(range.start, range.end) },
            ],
          }
        : { ...(object.content as Code), code: text.slice(range.start, range.end) },
  };
}
