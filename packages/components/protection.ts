import {
  fail,
  type DesktopObject,
  type Text,
  type Code,
  type Table,
  type ObjectPolicy,
  type ProtectionTarget,
  type Diagram,
  type Deck,
  type Workbook,
} from '../contracts/index.js';
import type { z } from 'zod';
import { selectedObject } from './selection.js';

export type Policy = z.infer<typeof ObjectPolicy>;
export function textDelta(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length,
    newEnd = after.length;
  while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) {
    end--;
    newEnd--;
  }
  return { start, end, newEnd, shift: after.length - before.length };
}
const body = (kind: string, content: DesktopObject['content']) =>
  kind === 'text' ? (content as Text).blocks[0].text : (content as Code).code;
const intersects = (start: number, end: number, left: number, right: number) =>
  start === end ? start > left && start < right : start < right && end > left;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function protectionLabel(range: ProtectionTarget) {
  switch (range.type) {
    case 'cells':
      return `${range.rowIds.length} 行 × ${range.columnIds.length} 列`;
    case 'diagram':
      return `${range.nodeIds.length} 个节点、${range.edgeIds.length} 条连线`;
    case 'slides':
      return `${range.slideIds.length} 张幻灯片`;
    case 'sheets':
      return `${range.sheetIds.length} 个完整工作表`;
    default: {
      const offsets = range as { start?: number; end?: number };
      return `字符 ${Number(offsets.start) + 1}–${offsets.end}`;
    }
  }
}
/** Protection targets are distinct from the materials attached to a conversation. */
export function protectedContent(object: DesktopObject, range: ProtectionTarget): unknown {
  if (range.baseRevision !== object.revision)
    fail('STALE_SELECTION', '保留范围基于旧版本，请重新选择。');
  const missing = () =>
    fail('STALE_SELECTION', '保留范围中的内容已不存在或类型不匹配，请重新选择。');
  if (range.type === 'diagram') {
    if (object.kind !== 'diagram') return missing();
    const diagram = object.content as Diagram;
    const nodes = range.nodeIds.map(
      (id) => diagram.nodes.find((node) => node.id === id) ?? missing(),
    );
    const edges = range.edgeIds.map(
      (id) => diagram.edges.find((edge) => edge.id === id) ?? missing(),
    );
    const endpoints = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].map((id) => {
      const node = diagram.nodes.find((node) => node.id === id) ?? missing();
      return {
        id: node.id,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        shape: node.shape,
      };
    });
    return { width: diagram.width, height: diagram.height, nodes, edges, endpoints };
  }
  if (range.type === 'slides') {
    if (object.kind !== 'deck') return missing();
    const deck = object.content as Deck;
    return {
      accent: deck.accent,
      footer: deck.footer,
      slides: range.slideIds.map((id) => deck.slides.find((slide) => slide.id === id) ?? missing()),
    };
  }
  if (range.type === 'sheets') {
    if (object.kind !== 'workbook') return missing();
    const workbook = object.content as Workbook;
    return {
      formulas: workbook.formulas,
      sheets: range.sheetIds.map(
        (id) => workbook.sheets.find((sheet) => sheet.id === id) ?? missing(),
      ),
    };
  }
  return selectedObject(object, range).content;
}

/** Preserve stable ranges outside edits. Ambiguous human edits fail closed for subsequent AI writes. */
export function updateProtection(
  object: DesktopObject,
  content: DesktopObject['content'],
  execution: boolean,
): Policy | undefined {
  const policy = object.policy;
  if (!policy?.protectedRanges?.length) return;
  const entries = structuredClone(policy.protectedRanges);
  for (const item of entries) {
    const range = item.range;
    if (item.stale || range.baseRevision !== object.revision) {
      if (execution) fail('PROTECTION_STALE', '保留范围需要重新选择；确认前此对象禁止 AI 修改。');
      item.stale = true;
      continue;
    }
    if (range.type === 'diagram' || range.type === 'slides' || range.type === 'sheets') {
      let after: unknown,
        present = true;
      try {
        after = protectedContent({ ...object, content }, range);
      } catch {
        present = false;
      }
      if (!present) {
        if (execution) fail('LOCKED_RANGE', '修改删除了已保留的节点、连线、幻灯片或工作表。');
        item.stale = true;
      } else if (execution && !equal(protectedContent(object, range), after)) {
        fail(
          'LOCKED_RANGE',
          '修改触及已保留内容或影响其显示的设置，请保留它们或请用户调整保护范围。',
        );
      }
    } else if (range.type === 'cells') {
      const before = object.content as Table,
        after = content as Table;
      const changed = range.rowIds.some((row) => {
        const oldRow = before.rows.find((r) => r.id === row),
          newRow = after.rows.find((r) => r.id === row);
        return (
          !oldRow ||
          !newRow ||
          range.columnIds.some((col) => {
            const oldIndex = before.columns.findIndex((c) => c.id === col),
              newIndex = after.columns.findIndex((c) => c.id === col);
            return (
              oldIndex < 0 ||
              newIndex < 0 ||
              oldRow.cells[oldIndex] !== newRow.cells[newIndex] ||
              before.columns[oldIndex].label !== after.columns[newIndex].label
            );
          })
        );
      });
      if (changed && execution)
        fail('LOCKED_RANGE', '修改触及已保留的单元格，请保留它们或请用户调整保护范围。');
      if (
        range.rowIds.some((id) => !after.rows.some((r) => r.id === id)) ||
        range.columnIds.some((id) => !after.columns.some((c) => c.id === id))
      )
        item.stale = true;
    } else {
      const delta = textDelta(body(object.kind, object.content), body(object.kind, content));
      // Native ranges carry no character offsets, so no text delta can touch or shift them.
      if (range.type !== 'native') {
        if (intersects(delta.start, delta.end, range.start, range.end)) {
          if (execution)
            fail('LOCKED_RANGE', '修改触及已保留的文字片段，请保留它或请用户调整保护范围。');
          item.stale = true;
        } else if (delta.end <= range.start) {
          range.start += delta.shift;
          range.end += delta.shift;
        }
      }
    }
    range.baseRevision = object.revision + 1;
  }
  return { ...policy, protectedRanges: entries, revision: policy.revision + 1 };
}
