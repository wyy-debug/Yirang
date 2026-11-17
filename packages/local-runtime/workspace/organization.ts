import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { arrangeFolder } from '../../components/folder-layout.js';
import { emptyCanvasBoard, CanvasBoardSchema } from '../../contracts/canvas-board.js';
import { z } from 'zod';
import {
  Id,
  FolderName,
  RelativeFilePath,
  FileTreeSchema,
  LayoutLibrarySchema,
  CanvasGroupsSchema,
  fail,
  type FileTree,
  type DesktopObject,
  type Workspace,
} from '../../contracts/index.js';

type Api = {
  auth: (w: string, c: string, s: string | null) => unknown;
  tx: <T>(fn: () => T) => T;
  once: <T>(w: string, id: string, payload: unknown, fn: () => T) => T;
  object: (w: string, id: string) => DesktopObject;
  snapshot: (w: string) => Workspace;
  event: (w: string, type: string) => void;
};
export class WorkspaceOrganization {
  constructor(
    private db: DatabaseSync,
    private api: Api,
  ) {}
  private get(w: string, key: string, fallback: unknown) {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(w, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : fallback;
  }
  private put(w: string, key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(w, key, JSON.stringify(value));
  }
  tree(w: string): FileTree {
    return FileTreeSchema.parse(
      this.get(w, 'file-tree', { revision: 0, folders: [], locations: {} }),
    );
  }
  private writeTree(w: string, tree: FileTree) {
    tree.revision++;
    this.put(w, 'file-tree', FileTreeSchema.parse(tree));
    this.api.event(w, 'folders.changed');
  }
  private ensure(tree: FileTree, path: string) {
    RelativeFilePath.parse(path);
    let parentId: string | null = null;
    for (const name of path.split('/')) {
      let folder = tree.folders.find(
        (f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase(),
      );
      if (!folder) {
        if (tree.folders.length >= 1000) fail('FOLDER_LIMIT', '当前工作区最多保存 1000 个文件夹。');
        folder = { id: `folder_${randomUUID()}`, name, parentId };
        tree.folders.push(folder);
      }
      parentId = folder.id;
    }
    return parentId!;
  }
  // Called inside the document creation transaction, so bytes and placement commit together.
  placeImported(w: string, objectId: string, relativePath: string) {
    const parts = RelativeFilePath.parse(relativePath).split('/');
    parts.pop();
    if (!parts.length) return;
    const tree = this.tree(w);
    tree.locations[objectId] = this.ensure(tree, parts.join('/'));
    this.writeTree(w, tree);
    this.importRegions(w, tree, [tree.locations[objectId]], objectId);
  }
  // Keep the disk directory visible in the file tree without manufacturing canvas regions.
  recordGeneratedLocation(w: string, objectId: string, relativePath: string) {
    const parts = RelativeFilePath.parse(relativePath).split('/');
    parts.pop();
    if (!parts.length) return;
    const tree = this.tree(w);
    tree.locations[objectId] = this.ensure(tree, parts.join('/'));
    this.writeTree(w, tree);
  }
  // Output storage paths do not dictate explicit canvas placement.
  placeGenerated(w: string, objectId: string, regionId: string, relativePath?: string) {
    const workspace = this.api.snapshot(w),
      groups = workspace.groups,
      region = groups.items.find((g) => g.id === regionId && g.bounds);
    if (!region?.bounds) fail('NOT_FOUND', '指定产出区域已删除，请重新指定；文件仍保留在磁盘。');
    if (relativePath) {
      const parts = RelativeFilePath.parse(relativePath).split('/');
      parts.pop();
      if (parts.length) {
        const tree = this.tree(w);
        tree.locations[objectId] = this.ensure(tree, parts.join('/'));
        this.writeTree(w, tree);
      }
    }
    const object = this.api.object(w, objectId),
      members = workspace.objects.filter(
        (o) => region.objectIds.includes(o.id) && o.id !== objectId,
      );
    const bounds = {
      ...object.bounds,
      x: region.bounds.x + 32,
      y: Math.max(region.bounds.y + 64, ...members.map((o) => o.bounds.y + o.bounds.height + 24)),
    };
    region.bounds.width = Math.max(region.bounds.width, bounds.width + 64);
    region.bounds.height = Math.max(
      region.bounds.height,
      bounds.y + bounds.height + 32 - region.bounds.y,
    );
    for (const group of groups.items)
      group.objectIds = group.objectIds.filter((id) => id !== objectId);
    region.objectIds.push(objectId);
    region.collapsed = false;
    groups.revision++;
    this.put(w, 'canvas-groups', CanvasGroupsSchema.parse(groups));
    this.db
      .prepare(
        'UPDATE objects SET bounds=?,layout_revision=layout_revision+1 WHERE workspace=? AND id=?',
      )
      .run(JSON.stringify(bounds), w, objectId);
    this.db.prepare('UPDATE workspaces SET view_revision=view_revision+1 WHERE id=?').run(w);
    this.api.event(w, 'groups.changed');
    this.api.event(w, 'view.changed');
  }
  private importRegions(w: string, tree: FileTree, folderIds: string[], objectId?: string) {
    let workspace = this.api.snapshot(w);
    const originalBounds = new Map(
      workspace.objects.map((object) => [object.id, JSON.stringify(object.bounds)]),
    );
    const originalBoard = workspace.canvasBoard ?? emptyCanvasBoard();
    const groups = workspace.groups;
    const required = new Set<string>();
    for (let folderId of folderIds) {
      while (folderId && !required.has(folderId)) {
        required.add(folderId);
        folderId = tree.folders.find((folder) => folder.id === folderId)?.parentId ?? '';
      }
    }
    const regionId = (id: string) => `import-region:${id}`;
    const ensureRegion = (folderId: string): string => {
      const id = regionId(folderId);
      if (groups.items.some((group) => group.id === id)) return id;
      const folder = tree.folders.find((folder) => folder.id === folderId)!;
      const parentId = folder.parentId ? ensureRegion(folder.parentId) : undefined;
      if (groups.items.length >= 40)
        fail('REGION_LIMIT', '导入后区域超过 40 个，请减少文件夹层级或分桌面导入。');
      const parent = groups.items.find((group) => group.id === parentId);
      const right = Math.max(
        0,
        ...groups.items
          .filter((group) => !group.parentId)
          .map((group) => (group.bounds ? group.bounds.x + group.bounds.width : 0)),
        ...workspace.objects
          .filter((object) => object.id !== objectId)
          .map((object) => object.bounds.x + object.bounds.width),
      );
      groups.items.push({
        id,
        name: folder.name.slice(0, 80),
        parentId,
        color: 'blue',
        folder: true,
        layout: 'grid',
        collapsed: false,
        objectIds: [],
        markIds: [],
        bounds: {
          x: parent?.bounds?.x ?? right + 80,
          y: parent?.bounds?.y ?? 80,
          width: 760,
          height: 520,
        },
      });
      return id;
    };
    for (const folderId of required) ensureRegion(folderId);
    if (objectId) {
      const target = regionId(tree.locations[objectId]);
      for (const group of groups.items)
        group.objectIds = group.objectIds.filter((id) => id !== objectId);
      groups.items.find((group) => group.id === target)!.objectIds.push(objectId);
    }
    const depth = (id: string) => {
      let count = 0,
        parent = groups.items.find((group) => group.id === id)?.parentId;
      while (parent) {
        count++;
        parent = groups.items.find((group) => group.id === parent)?.parentId;
      }
      return count;
    };
    for (const id of [...required].map(regionId).sort((a, b) => depth(b) - depth(a))) {
      const result = arrangeFolder(
        workspace,
        workspace.canvasBoard ?? emptyCanvasBoard(),
        id,
        0,
        0,
        'grid',
      );
      workspace = {
        ...workspace,
        groups: result.groups,
        objects: result.objects,
        canvasBoard: result.board,
      };
    }
    workspace.groups.revision++;
    this.put(w, 'canvas-groups', CanvasGroupsSchema.parse(workspace.groups));
    for (const object of workspace.objects)
      if (originalBounds.get(object.id) !== JSON.stringify(object.bounds))
        this.db
          .prepare(
            'UPDATE objects SET bounds=?,layout_revision=layout_revision+1 WHERE workspace=? AND id=?',
          )
          .run(JSON.stringify(object.bounds), w, object.id);
    if (
      workspace.canvasBoard &&
      JSON.stringify(originalBoard) !== JSON.stringify(workspace.canvasBoard)
    ) {
      this.put(
        w,
        'canvas-board',
        CanvasBoardSchema.parse({ ...workspace.canvasBoard, revision: originalBoard.revision + 1 }),
      );
      this.api.event(w, 'canvas.changed');
    }
    this.db.prepare('UPDATE workspaces SET view_revision=view_revision+1 WHERE id=?').run(w);
    this.api.event(w, 'groups.changed');
    this.api.event(w, 'view.changed');
  }
  copyLocation(w: string, from: string, to: string) {
    const tree = this.tree(w);
    if (tree.locations[from]) {
      tree.locations[to] = tree.locations[from];
      this.writeTree(w, tree);
    }
  }
  importFolders(w: string, c: string, s: string | null, input: unknown) {
    const p = z
      .object({ requestId: Id, paths: z.array(RelativeFilePath).max(1000) })
      .strict()
      .parse(input);
    return this.api.tx(() => {
      this.api.auth(w, c, s);
      return this.api.once(w, p.requestId, { type: 'folders.import', ...p }, () => {
        const tree = this.tree(w),
          before = tree.folders.length;
        for (const path of p.paths) this.ensure(tree, path);
        if (before !== tree.folders.length) this.writeTree(w, tree);
        if (p.paths.length) {
          const ids = p.paths.map((path) => this.ensure(tree, path));
          this.importRegions(w, tree, ids);
        }
        return tree;
      });
    });
  }
  manage(w: string, c: string, s: string | null, input: unknown) {
    const p = z
      .object({
        requestId: Id,
        revision: z.number().int().nonnegative(),
        operation: z.enum(['create', 'rename', 'remove', 'move_objects']),
        folderId: Id.nullable().optional(),
        parentId: Id.nullable().optional(),
        name: FolderName.optional(),
        objectIds: z.array(Id).max(2000).optional(),
      })
      .strict()
      .parse(input);
    return this.api.tx(() => {
      this.api.auth(w, c, s);
      return this.api.once(w, p.requestId, { type: 'folders.manage', ...p }, () => {
        const tree = this.tree(w);
        if (tree.revision !== p.revision) fail('REVISION_CONFLICT', '文件夹已变化，请刷新后重试。');
        const folder = tree.folders.find((f) => f.id === p.folderId);
        if (p.folderId && !folder) fail('NOT_FOUND', '文件夹不存在。');
        if (p.operation === 'create' || p.operation === 'rename') {
          if (!p.name) fail('VALIDATION_FAILED', '请输入文件夹名称。');
          if (p.operation === 'rename' && !folder) fail('NOT_FOUND', '请选择文件夹。');
          const parentId = p.operation === 'create' ? (p.parentId ?? null) : folder!.parentId;
          if (parentId && !tree.folders.some((f) => f.id === parentId))
            fail('NOT_FOUND', '上级文件夹不存在。');
          if (
            tree.folders.some(
              (f) =>
                f.parentId === parentId &&
                f.name.toLowerCase() === p.name!.toLowerCase() &&
                f.id !== (p.operation === 'rename' ? folder!.id : undefined),
            )
          )
            fail('NAME_CONFLICT', '此位置已有同名文件夹。');
          if (p.operation === 'create')
            tree.folders.push({ id: `folder_${randomUUID()}`, name: p.name, parentId });
          else folder!.name = p.name;
        } else if (p.operation === 'remove') {
          if (!folder) fail('NOT_FOUND', '请选择文件夹。');
          if (
            tree.folders.some((f) => f.parentId === folder.id) ||
            Object.values(tree.locations).includes(folder.id)
          )
            fail('FOLDER_NOT_EMPTY', '请先移出材料与子文件夹；归档材料也会保留所在位置。');
          tree.folders = tree.folders.filter((f) => f.id !== folder.id);
        } else {
          if (p.folderId === undefined || !p.objectIds?.length)
            fail('VALIDATION_FAILED', '请选择材料和目标位置。');
          for (const objectId of new Set(p.objectIds)) {
            const object = this.api.object(w, objectId);
            if (object.archived) fail('ARCHIVED', '请先恢复归档材料。');
            if (p.folderId) tree.locations[objectId] = p.folderId;
            else delete tree.locations[objectId];
          }
        }
        this.writeTree(w, tree);
        return tree;
      });
    });
  }
  layouts(w: string, c: string, s: string | null, input: unknown) {
    const p = z
      .object({
        operation: z.enum(['list', 'save', 'restore', 'delete']),
        requestId: Id.optional(),
        revision: z.number().int().nonnegative().optional(),
        expectedView: z.number().int().positive().optional(),
        expectedGroups: z.number().int().nonnegative().optional(),
        id: Id.optional(),
        name: z.string().trim().min(1).max(80).optional(),
      })
      .strict()
      .parse(input);
    return this.api.tx(() => {
      this.api.auth(w, c, s);
      const library = LayoutLibrarySchema.parse(
        this.get(w, 'layout-library', { revision: 0, items: [] }),
      );
      if (p.operation === 'list') return library;
      if (!p.requestId) fail('VALIDATION_FAILED', '缺少操作标识。');
      return this.api.once(w, p.requestId, { type: 'layouts', ...p }, () => {
        if (p.revision !== library.revision)
          fail('REVISION_CONFLICT', '布局记录已变化，请刷新后重试。');
        if (p.operation === 'save') {
          if (!p.name) fail('VALIDATION_FAILED', '请给布局起个名称。');
          if (library.items.length >= 20) fail('LAYOUT_LIMIT', '最多保存 20 套布局。');
          const workspace = this.api.snapshot(w);
          if (
            workspace.viewRevision !== p.expectedView ||
            workspace.groups.revision !== p.expectedGroups
          )
            fail('REVISION_CONFLICT', '桌面刚刚变化，请刷新后再保存布局。');
          library.items.push({
            id: `layout_${randomUUID()}`,
            name: p.name,
            createdAt: new Date().toISOString(),
            viewport: workspace.viewport,
            objects: workspace.objects.map((o) => ({ objectId: o.id, bounds: o.bounds })),
            groups: workspace.groups.items,
          });
        } else {
          const preset = library.items.find((item) => item.id === p.id);
          if (!preset) fail('NOT_FOUND', '布局记录不存在。');
          if (p.operation === 'delete')
            library.items = library.items.filter((item) => item.id !== p.id);
          else {
            const workspace = this.api.snapshot(w);
            if (
              workspace.viewRevision !== p.expectedView ||
              workspace.groups.revision !== p.expectedGroups
            )
              fail('REVISION_CONFLICT', '桌面已在其他面板更新，请刷新后再恢复。');
            const ids = new Set(workspace.objects.map((o) => o.id));
            let restored = 0;
            for (const item of preset.objects) {
              if (!ids.has(item.objectId)) continue;
              this.db
                .prepare(
                  'UPDATE objects SET bounds=?,layout_revision=layout_revision+1 WHERE workspace=? AND id=?',
                )
                .run(JSON.stringify(item.bounds), w, item.objectId);
              restored++;
            }
            // New materials and groups remain. Membership in captured groups returns to the saved state.
            const captured = new Set(preset.objects.map((o) => o.objectId));
            const groups = workspace.groups.items.filter(
              (g) => !preset.groups.some((saved) => saved.id === g.id),
            );
            for (const group of preset.groups) {
              const added =
                workspace.groups.items
                  .find((g) => g.id === group.id)
                  ?.objectIds.filter((id) => !captured.has(id)) ?? [];
              groups.push({ ...group, objectIds: [...new Set([...group.objectIds, ...added])] });
            }
            this.put(
              w,
              'canvas-groups',
              CanvasGroupsSchema.parse({ revision: workspace.groups.revision + 1, items: groups }),
            );
            this.db
              .prepare('UPDATE workspaces SET viewport=?,view_revision=view_revision+1 WHERE id=?')
              .run(JSON.stringify(preset.viewport), w);
            this.api.event(w, 'layout.restored');
            return {
              library,
              workspace: this.api.snapshot(w),
              restored,
              skipped: preset.objects.length - restored,
            };
          }
        }
        library.revision++;
        this.put(w, 'layout-library', LayoutLibrarySchema.parse(library));
        this.api.event(w, 'layouts.changed');
        return library;
      });
    });
  }
}
