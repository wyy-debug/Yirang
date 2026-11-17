import type { FileTree } from '../contracts/index.js';
export const emptyFileTree: FileTree = { revision: 0, folders: [], locations: {} };
export function folderPath(tree: FileTree, id: string | null): string {
  const names: string[] = [],
    seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = tree.folders.find((f) => f.id === id);
    if (!folder) break;
    names.unshift(folder.name);
    id = folder.parentId;
  }
  return names.join('/');
}
export function nestedFolders(tree: FileTree, id: string | null) {
  const ids = new Set<string>();
  if (id) ids.add(id);
  let parents: (string | null)[] = [id];
  while (parents.length) {
    const children = tree.folders.filter((f) => parents.includes(f.parentId) && !ids.has(f.id));
    for (const f of children) ids.add(f.id);
    parents = children.map((f) => f.id);
  }
  return ids;
}
