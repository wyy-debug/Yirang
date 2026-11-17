import type {
  DesktopObject,
  Revision,
  Diagram,
  Deck,
  Workbook,
  RectAnnotation,
} from '../contracts/index.js';
type Location = NonNullable<Revision['contribution']>['location'];
type Parts = Extract<Location, { type: 'parts' }>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function structuredLocation(
  kind: DesktopObject['kind'],
  before: DesktopObject['content'],
  after: DesktopObject['content'],
): Location {
  const result: Parts = { type: 'parts', items: [], settings: [], order: [] };
  function fields<T extends object>(a: T, b: T, keys: (keyof T)[]) {
    result.settings.push(...keys.filter((key) => !equal(a[key], b[key])).map(String));
  }
  function parts<T extends { id: string }>(
    type: Parts['items'][number]['kind'],
    a: T[],
    b: T[],
    label: (value: T) => string,
  ) {
    const old = new Map(a.map((value) => [value.id, value])),
      next = new Map(b.map((value) => [value.id, value]));
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const left = old.get(id),
        right = next.get(id);
      if (equal(left, right)) continue;
      result.items.push({
        kind: type,
        id,
        label: label((right ?? left)!).slice(0, 120),
        change: !left ? 'added' : !right ? 'removed' : 'updated',
        fields:
          left && right
            ? Object.keys(right).filter(
                (key) => key !== 'id' && !equal(left[key as keyof T], right[key as keyof T]),
              )
            : [],
      });
    }
    const sharedBefore = a.filter((value) => next.has(value.id)).map((value) => value.id);
    const sharedAfter = b.filter((value) => old.has(value.id)).map((value) => value.id);
    if (!equal(sharedBefore, sharedAfter)) result.order.push(type);
  }
  if (kind === 'diagram') {
    const a = before as Diagram,
      b = after as Diagram;
    fields(a, b, ['width', 'height']);
    parts('node', a.nodes, b.nodes, (node) => node.text || '未命名节点');
    parts('edge', a.edges, b.edges, (edge) => edge.label || '连线');
  } else if (kind === 'deck') {
    const a = before as Deck,
      b = after as Deck;
    fields(a, b, ['title', 'accent', 'footer']);
    parts('slide', a.slides, b.slides, (slide) => slide.title || '未命名页面');
  } else if (kind === 'workbook') {
    const a = before as Workbook,
      b = after as Workbook;
    fields(a, b, ['title', 'formulas']);
    parts('sheet', a.sheets, b.sheets, (sheet) => sheet.name);
  } else if (kind === 'image') {
    const a = before as { annotations: RectAnnotation[] },
      b = after as { annotations: RectAnnotation[] };
    parts(
      'annotation',
      a.annotations,
      b.annotations,
      (annotation) => annotation.note || '图片批注',
    );
  } else return { type: 'object' };
  return result;
}
