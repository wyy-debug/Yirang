import { fail, type Table, type Diagram, type Deck, type Workbook } from '../contracts/index.js';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const conflict = () =>
  fail(
    'UNDO_CONFLICT',
    '后续修改涉及相同字段、结构或关联内容，无法单独撤销。请比较后手动合并；当前内容已保留。',
  );
const latest = <T>(after: T, later: T[]) => later.at(-1) ?? after;

function undoFields<T extends object>(before: T, after: T, later: T[], keys: (keyof T)[]): T {
  const result = structuredClone(latest(after, later));
  for (const key of keys) {
    if (equal(before[key], after[key])) continue;
    if (later.some((value) => !equal(value[key], after[key]))) conflict();
    result[key] = structuredClone(before[key]);
  }
  return result;
}
function undoRecord<T>(
  before: Record<string, T>,
  after: Record<string, T>,
  later: Record<string, T>[],
): Record<string, T> {
  const result = structuredClone(latest(after, later));
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const present = Object.hasOwn(after, key),
      previous = Object.hasOwn(before, key);
    if (present === previous && equal(before[key], after[key])) continue;
    if (
      later.some(
        (value) =>
          Object.hasOwn(value, key) !== present || (present && !equal(value[key], after[key])),
      )
    )
      conflict();
    if (previous)
      Object.defineProperty(result, key, {
        value: structuredClone(before[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else delete result[key];
  }
  return result;
}

/** Restore only touched identities and fields. Later independent identities remain intact. */
function undoList<T extends { id: string }>(
  before: T[],
  after: T[],
  later: T[][],
  undoItem: (a: T, b: T, versions: T[]) => T,
): T[] {
  const beforeMap = new Map(before.map((item) => [item.id, item])),
    afterMap = new Map(after.map((item) => [item.id, item]));
  const versions = later.map((items) => new Map(items.map((item) => [item.id, item])));
  let result = structuredClone(latest(after, later));
  const removed = before.filter((item) => !afterMap.has(item.id));
  const added = after.filter((item) => !beforeMap.has(item.id));
  for (const item of added) {
    if (versions.some((version) => !equal(version.get(item.id), item))) conflict();
    result = result.filter((value) => value.id !== item.id);
  }
  for (const item of removed) if (versions.some((version) => version.has(item.id))) conflict();
  for (const item of before) {
    const next = afterMap.get(item.id);
    if (!next || equal(item, next)) continue;
    if (versions.some((version) => !version.has(item.id))) conflict();
    const restored = undoItem(
      item,
      next,
      versions.map((version) => version.get(item.id)!),
    );
    const index = result.findIndex((value) => value.id === item.id);
    if (index < 0) conflict();
    result[index] = restored;
  }
  const oldOrder = before.filter((item) => afterMap.has(item.id)).map((item) => item.id);
  const newOrder = after.filter((item) => beforeMap.has(item.id)).map((item) => item.id);
  if (!equal(oldOrder, newOrder)) {
    // Undoing order is ambiguous once a later revision has changed that list's structure.
    if (
      later.some(
        (items) =>
          !equal(
            items.map((item) => item.id),
            after.map((item) => item.id),
          ),
      )
    )
      conflict();
    const values = new Map([...result, ...removed].map((item) => [item.id, item]));
    return before.map((item) => structuredClone(values.get(item.id)!));
  }
  for (const item of removed) {
    const oldIndex = before.findIndex((value) => value.id === item.id);
    const left = before
      .slice(0, oldIndex)
      .reverse()
      .find((value) => result.some((current) => current.id === value.id));
    const right = before
      .slice(oldIndex + 1)
      .find((value) => result.some((current) => current.id === value.id));
    const leftIndex = left ? result.findIndex((value) => value.id === left.id) : -1;
    const rightIndex = right ? result.findIndex((value) => value.id === right.id) : result.length;
    if (left && right && leftIndex >= rightIndex) conflict();
    result.splice(
      right ? rightIndex : left ? leftIndex + 1 : result.length,
      0,
      structuredClone(item),
    );
  }
  return result;
}

type GridRow = { id: string; values: Record<string, string> };
const gridRows = (table: Table): GridRow[] =>
  table.rows.map((row) => ({
    id: row.id,
    values: Object.fromEntries(table.columns.map((column, index) => [column.id, row.cells[index]])),
  }));
export function undoTable(before: Table, after: Table, later: Table[]): Table {
  // Removing a column must not erase cells introduced by a later row.
  const addedColumns = after.columns.filter(
    (column) => !before.columns.some((old) => old.id === column.id),
  );
  if (
    addedColumns.length &&
    later.some((table) => table.rows.some((row) => !after.rows.some((old) => old.id === row.id)))
  )
    conflict();
  const columns = undoList(
    before.columns,
    after.columns,
    later.map((table) => table.columns),
    (a, b, versions) => undoFields(a, b, versions, ['label']),
  );
  const rows = undoList(
    gridRows(before),
    gridRows(after),
    later.map(gridRows),
    (a, b, versions) => ({
      ...latest(b, versions),
      values: undoRecord(
        a.values,
        b.values,
        versions.map((row) => row.values),
      ),
    }),
  );
  return {
    columns,
    rows: rows.map((row) => ({
      id: row.id,
      cells: columns.map((column) =>
        Object.hasOwn(row.values, column.id) ? row.values[column.id] : '',
      ),
    })),
  };
}
export function undoDiagram(before: Diagram, after: Diagram, later: Diagram[]): Diagram {
  const result = undoFields(before, after, later, ['width', 'height']);
  result.nodes = undoList(
    before.nodes,
    after.nodes,
    later.map((value) => value.nodes),
    (a, b, versions) =>
      undoFields(a, b, versions, ['text', 'x', 'y', 'width', 'height', 'shape', 'color']),
  );
  result.edges = undoList(
    before.edges,
    after.edges,
    later.map((value) => value.edges),
    (a, b, versions) => undoFields(a, b, versions, ['from', 'to', 'label']),
  );
  // A later edge may rely on a node added in the revision being undone.
  if (
    result.edges.some(
      (edge) =>
        !result.nodes.some((node) => node.id === edge.from) ||
        !result.nodes.some((node) => node.id === edge.to),
    )
  )
    conflict();
  if (
    result.nodes.some(
      (node) => node.x + node.width > result.width || node.y + node.height > result.height,
    )
  )
    conflict();
  return result;
}
export function undoDeck(before: Deck, after: Deck, later: Deck[]): Deck {
  const result = undoFields(before, after, later, ['title', 'accent', 'footer']);
  result.slides = undoList(
    before.slides,
    after.slides,
    later.map((value) => value.slides),
    (a, b, versions) =>
      undoFields(a, b, versions, ['layout', 'title', 'subtitle', 'body', 'secondary', 'notes']),
  );
  if (!result.slides.length || result.slides.length > 50) conflict();
  return result;
}
export function undoWorkbook(before: Workbook, after: Workbook, later: Workbook[]): Workbook {
  const result = undoFields(before, after, later, ['title', 'formulas']);
  result.sheets = undoList(
    before.sheets,
    after.sheets,
    later.map((value) => value.sheets),
    (a, b, versions) => {
      const sheet = undoFields(a, b, versions, ['name']);
      const addedColumns = b.table.columns.filter(
        (column) => !a.table.columns.some((old) => old.id === column.id),
      );
      if (
        versions.some((value) =>
          addedColumns.some(
            (column) =>
              Object.hasOwn(value.formats, column.id) !== Object.hasOwn(b.formats, column.id) ||
              !equal(value.formats[column.id], b.formats[column.id]),
          ),
        )
      )
        conflict();
      sheet.table = undoTable(
        a.table,
        b.table,
        versions.map((value) => value.table),
      );
      sheet.formats = undoRecord(
        a.formats,
        b.formats,
        versions.map((value) => value.formats),
      );
      return sheet;
    },
  );
  if (
    !result.sheets.length ||
    result.sheets.length > 12 ||
    new Set(result.sheets.map((sheet) => sheet.name.toLowerCase())).size !== result.sheets.length
  )
    conflict();
  return result;
}
