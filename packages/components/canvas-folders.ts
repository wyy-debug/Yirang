import type { CanvasGroups } from '../contracts/index.js';
import { contains, extent, type Rect } from './canvas-spatial.js';
type Group = CanvasGroups['items'][number];
export const regionMemberIds = (group: Group) =>
  group.linkedObjectIds?.length
    ? [...new Set([...group.objectIds, ...group.linkedObjectIds])]
    : group.objectIds;

export function regionBoundsFor(rects: Rect[]): Rect | null {
  const bounds = extent(rects);
  if (!bounds) return null;
  const x = Math.max(-100000, bounds.x - 32);
  const y = Math.max(-100000, bounds.y - 56);
  return {
    x, y,
    width: Math.min(200000, Math.max(200, bounds.x + bounds.width + 32 - x)),
    height: Math.min(200000, Math.max(120, bounds.y + bounds.height + 32 - y)),
  };
}
export function descendants(groups: Group[], id: string): Set<string> {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups)
      if (group.parentId && ids.has(group.parentId) && !ids.has(group.id)) {
        ids.add(group.id);
        changed = true;
      }
  }
  return ids;
}
export function folderAt(groups: Group[], bounds: Rect, excluded = new Set<string>()) {
  return groups
    .filter(
      (g) =>
        g.bounds &&
        !excluded.has(g.id) &&
        (g.collapsed
          ? bounds.x + bounds.width / 2 >= g.bounds.x &&
            bounds.x + bounds.width / 2 <= g.bounds.x + 260 &&
            bounds.y + bounds.height / 2 >= g.bounds.y - 32 &&
            bounds.y + bounds.height / 2 <= g.bounds.y + 110
          : contains(g.bounds, bounds)),
    )
    .sort((a, b) => a.bounds!.width * a.bounds!.height - b.bounds!.width * b.bounds!.height)[0];
}
export function growFolderParents(groups: Group[]) {
  for (const child of groups.filter((g) => g.bounds)) {
    let item = child,
      parent = child.parentId;
    while (parent) {
      const g = groups.find((g) => g.id === parent);
      if (!g?.bounds) break;
      const a = g.bounds,
        b = item.bounds!;
      const right = Math.max(a.x + a.width, b.x + b.width + 32),
        bottom = Math.max(a.y + a.height, b.y + b.height + 64);
      a.x = Math.min(a.x, b.x - 32);
      a.y = Math.min(a.y, b.y - 64);
      a.width = right - a.x;
      a.height = bottom - a.y;
      item = g;
      parent = g.parentId;
    }
  }
}
// Legacy rectangles become explicit containers once; later resizing never changes ownership.
export function normalizeFolders(
  groups: CanvasGroups,
  objects: { id: string; bounds: Rect }[],
  marks: ({ id: string } & Rect)[],
): CanvasGroups {
  const legacy = new Set(groups.items.filter((g) => g.bounds && !g.folder).map((g) => g.id));
  if (!legacy.size && groups.items.every((g) => g.bounds)) return groups;
  const areas = groups.items.filter((g) => g.bounds).map((g) => ({ ...g, collapsed: false }));
  const assigned = new Set(groups.items.filter((g) => g.folder).flatMap((g) => g.objectIds));
  const normalized = groups.items.map<Group>((g) => {
    if (!legacy.has(g.id)) return g;
    const area = g.bounds!,
      parents = areas.filter(
        (p) => p.id !== g.id && p.bounds!.width * p.bounds!.height > area.width * area.height,
      );
    return {
      ...g,
      folder: true,
      layout: g.layout ?? 'free',
      parentId: folderAt(parents, area)?.id,
      objectIds: objects
        .filter((o) => !assigned.has(o.id) && folderAt(areas, o.bounds)?.id === g.id)
        .map((o) => o.id),
      markIds: marks.filter((m) => folderAt(areas, m)?.id === g.id).map((m) => m.id),
    };
  });
  const claimed = new Set(normalized.filter((g) => g.bounds).flatMap((g) => g.objectIds));
  const boundsById = new Map(objects.map((o) => [o.id, o.bounds]));
  const items = normalized.map<Group>((g, index) => {
    if (g.bounds) return g;
    const members = regionMemberIds(g);
    const bounds = regionBoundsFor(members.flatMap((id) => boundsById.get(id) ?? []))
      ?? { x: 60 + 32 * index, y: 80 + 32 * index, width: 760, height: 520 };
    const objectIds = members.filter((id) => !claimed.has(id));
    // Old groups could share cards. Only their existing owner may move shared cards.
    const linkedObjectIds = members.filter((id) => claimed.has(id));
    for (const id of objectIds) claimed.add(id);
    return {
      ...g, bounds, folder: true, layout: 'free', objectIds,
      ...(linkedObjectIds.length ? { linkedObjectIds } : {}),
    };
  });
  return { ...groups, items };
}
export function validateFolders(groups: Group[]) {
  const objects = new Set<string>(),
    marks = new Set<string>();
  for (const group of groups.filter((g) => g.bounds)) {
    if (group.parentId && !groups.some((g) => g.id === group.parentId && g.bounds))
      throw Error('父区域不存在。');
    const seen = new Set([group.id]);
    let parent = group.parentId;
    while (parent) {
      if (seen.has(parent)) throw Error('区域不能放入自身或自己的子区域。');
      seen.add(parent);
      parent = groups.find((g) => g.id === parent)?.parentId;
    }
    for (const id of group.objectIds) {
      if (objects.has(id)) throw Error('文件只能属于一个区域。');
      objects.add(id);
    }
    for (const id of group.markIds ?? []) {
      if (marks.has(id)) throw Error('图形只能属于一个区域。');
      marks.add(id);
    }
  }
}
