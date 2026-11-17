import {
  fail,
  type DesktopObject,
  type Text,
  type Code,
  type Table,
  type RectAnnotation,
  type Diagram,
  type Deck,
  type Workbook,
} from '../contracts/index.js';
import { textDelta } from './protection.js';
import { undoTable, undoDiagram, undoDeck, undoWorkbook } from './structured-undo.js';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const collision = () =>
  fail(
    'UNDO_CONFLICT',
    '后续修改触及同一内容，无法单独撤销。请查看差异并手动合并；当前内容已保留。',
  );

/** Reverse one revision only when every later revision leaves its touched content intact. */
export function undoRevision(
  kind: DesktopObject['kind'],
  before: DesktopObject['content'],
  after: DesktopObject['content'],
  later: DesktopObject['content'][],
): DesktopObject['content'] {
  const current = later.at(-1) ?? after;
  if (kind === 'text' || kind === 'code') {
    const text = (c: DesktopObject['content']) =>
      kind === 'text' ? (c as Text).blocks[0].text : (c as Code).code;
    const a = text(before),
      b = text(after),
      delta = textDelta(a, b);
    let start = delta.start,
      end = delta.newEnd,
      previous = b;
    const hasTextChange = a !== b;
    const languageChanged =
      kind === 'code' && (before as Code).language !== (after as Code).language;
    for (const revision of later) {
      const value = text(revision),
        d = textDelta(previous, value);
      if (hasTextChange && value !== previous) {
        if (start === end && d.start <= start && d.end >= end) collision();
        if (d.end <= start) {
          start += d.shift;
          end += d.shift;
        } else if (d.start < end) collision();
      }
      if (languageChanged && (revision as Code).language !== (after as Code).language) collision();
      previous = value;
    }
    const value = text(current);
    if (hasTextChange && value.slice(start, end) !== b.slice(delta.start, delta.newEnd))
      collision();
    const result = hasTextChange
      ? value.slice(0, start) + a.slice(delta.start, delta.end) + value.slice(end)
      : value;
    if (kind === 'text') return { blocks: [{ ...(current as Text).blocks[0], text: result }] };
    return {
      ...(current as Code),
      code: result,
      ...(languageChanged ? { language: (before as Code).language } : {}),
    };
  }
  if (kind === 'table') return undoTable(before as Table, after as Table, later as Table[]);
  if (kind === 'diagram')
    return undoDiagram(before as Diagram, after as Diagram, later as Diagram[]);
  if (kind === 'deck') return undoDeck(before as Deck, after as Deck, later as Deck[]);
  if (kind === 'workbook')
    return undoWorkbook(before as Workbook, after as Workbook, later as Workbook[]);
  if (kind === 'image') {
    type Image = {
      assetHash: string;
      mime: string;
      width: number;
      height: number;
      annotations: RectAnnotation[];
    };
    const a = before as Image,
      b = after as Image,
      result = structuredClone(current as Image);
    if (a.assetHash !== b.assetHash) fail('UNDO_UNSUPPORTED', '当前只能单独撤销批注变更。');
    const touched = [...new Set([...a.annotations, ...b.annotations].map((v) => v.id))].filter(
      (id) =>
        !equal(
          a.annotations.find((v) => v.id === id),
          b.annotations.find((v) => v.id === id),
        ),
    );
    for (const id of touched) {
      const old = a.annotations.find((v) => v.id === id),
        expected = b.annotations.find((v) => v.id === id);
      if (
        later.some(
          (c) =>
            !equal(
              (c as Image).annotations.find((v) => v.id === id),
              expected,
            ),
        )
      )
        collision();
      const index = result.annotations.findIndex((v) => v.id === id);
      if (index >= 0) {
        if (old) result.annotations[index] = old;
        else result.annotations.splice(index, 1);
      } else if (old) result.annotations.push(old);
    }
    return result;
  }
  fail('UNDO_UNSUPPORTED', '此对象暂未提供单次修改撤销，请比较历史后手动合并。');
}
