import type { Workspace } from '../contracts/index.js';
import type { CanvasBoard } from '../contracts/canvas-board.js';
import { descendants, folderAt } from './canvas-folders.js';
export function arrangeFolder(
  workspace: Workspace,
  board: CanvasBoard,
  id: string,
  dx: number,
  dy: number,
  layout?: 'free' | 'grid' | 'list',
) {
  const groups = structuredClone(workspace.groups),
    objects = structuredClone(workspace.objects),
    nextBoard = structuredClone(board);
  const root = groups.items.find((g) => g.id === id);
  if (!root?.bounds) throw Error('区域不存在。');
  function translate(groupId: string, x: number, y: number) {
    const ids = descendants(groups.items, groupId),
      members = groups.items.filter((g) => ids.has(g.id));
    const cards = new Set(members.flatMap((g) => g.objectIds)),
      marks = new Set(members.flatMap((g) => g.markIds ?? []));
    for (const g of members)
      if (g.bounds) {
        g.bounds.x += x;
        g.bounds.y += y;
      }
    for (const o of objects)
      if (cards.has(o.id)) {
        o.bounds.x += x;
        o.bounds.y += y;
      }
    for (const m of nextBoard.items)
      if (marks.has(m.id)) {
        m.x += x;
        m.y += y;
      }
  }
  if (layout) {
    root.layout = layout;
    if (layout !== 'free') {
      const entries = [
        ...objects
          .filter((o) => root.objectIds.includes(o.id))
          .map((o) => ({
            rect: o.bounds,
            move: (x: number, y: number) => {
              o.bounds.x += x;
              o.bounds.y += y;
            },
          })),
        ...nextBoard.items
          .filter((m) => root.markIds?.includes(m.id))
          .map((m) => ({
            rect: m,
            move: (x: number, y: number) => {
              m.x += x;
              m.y += y;
            },
          })),
        ...groups.items
          .filter((g) => g.parentId === id && g.bounds)
          .map((g) => ({ rect: g.bounds!, move: (x: number, y: number) => translate(g.id, x, y) })),
      ];
      const columns = layout === 'list' ? 1 : Math.max(1, Math.ceil(Math.sqrt(entries.length)));
      const width = Math.max(200, ...entries.map((e) => e.rect.width)),
        height = Math.max(120, ...entries.map((e) => e.rect.height));
      entries.forEach((e, i) => {
        const x = root.bounds!.x + 32 + (i % columns) * (width + 32),
          y = root.bounds!.y + 64 + Math.floor(i / columns) * (height + 64);
        e.move(x - e.rect.x, y - e.rect.y);
      });
      root.bounds.width = Math.max(320, columns * (width + 32) + 32);
      root.bounds.height = Math.max(200, Math.ceil(entries.length / columns) * (height + 64) + 32);
    }
  } else {
    translate(id, dx, dy);
    root.parentId = folderAt(groups.items, root.bounds, descendants(groups.items, id))?.id;
  }
  // Grow ancestors to contain their children without moving unrelated material.
  let parent = root.parentId,
    child = root;
  while (parent) {
    const g = groups.items.find((g) => g.id === parent);
    if (!g?.bounds) break;
    const a = g.bounds,
      b = child.bounds!;
    const right = Math.max(a.x + a.width, b.x + b.width + 32),
      bottom = Math.max(a.y + a.height, b.y + b.height + 32);
    a.x = Math.min(a.x, b.x - 32);
    a.y = Math.min(a.y, b.y - 64);
    a.width = right - a.x;
    a.height = bottom - a.y;
    child = g;
    parent = g.parentId;
  }
  for (const r of [
    ...groups.items.flatMap((g) => (g.bounds ? [g.bounds] : [])),
    ...objects.map((o) => o.bounds),
    ...nextBoard.items,
  ])
    if (
      r.x < -100000 ||
      r.x > 100000 ||
      r.y < -100000 ||
      r.y > 100000 ||
      r.width > 200000 ||
      r.height > 200000
    )
      throw Error('区域排版超出了画布范围。');
  return { groups, objects, board: nextBoard };
}
