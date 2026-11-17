// Workspace and canvas surface of DesktopStore, extracted by responsibility
// boundary: session-bound current-desktop resolution, region reads/writes,
// multi-workspace lifecycle (create/rename/switch with linked folders) and
// canvas layout (groups, board, region moves).
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  Id,
  Bounds,
  CanvasGroupsSchema,
  fail,
  type DesktopObject,
  type Workspace,
  type WorkspaceSummary,
} from '../../contracts/index.js';
import { RegionRead, RegionWrite } from '../../contracts/region-tools.js';
import { WorkspaceCreate } from '../../contracts/workspace-tools.js';
import { CanvasBoardAction, CanvasBoardSchema, emptyCanvasBoard, type CanvasBoard } from '../../contracts/canvas-board.js';
import { normalizeFolders, validateFolders, growFolderParents, folderAt, regionMemberIds } from '../../components/canvas-folders.js';
import { arrangeFolder } from '../../components/folder-layout.js';
import { contains } from '../../components/canvas-spatial.js';
import { decode, encode, hash, id, canonical } from '../storage/serde.js';
import type { GeneratedFileLinks } from '../files/generated-file-links.js';
import type { WorkManagementStore } from '../work/work-management.js';
import { active } from '../work/work-conventions.js';
import { requireWorkspaceSlot } from './workspace-capacity.js';

type Auth = {
  kind: 'panel' | 'execution';
  workspaceId: string;
  owner: string;
  session: string | null;
  scope: string[];
  observed: Record<string, number>;
  status: string;
};

/** The store surface this subsystem relies on; privates are opened on the class. */
export type WorkspaceSurfaceHost = {
  db: DatabaseSync;
  workManagement: WorkManagementStore;
  tx<T>(fn: () => T): T;
  once<T>(workspace: string, request: string, payload: unknown, fn: () => T): T;
  auth(workspace: string, credential: string, session: string | null, kind?: Auth['kind']): Auth;
  object(workspace: string, objectId: string): DesktopObject;
  setting(workspace: string, key: string): string;
  event(
    workspace: string,
    type: string,
    objectId: string | null,
    revision: number | null,
    actor: string,
  ): void;
  snapshot(workspace: string): Workspace;
  panelState(workspace: string, session: string | null, messageRouteAvailable: boolean): any;
  importAttachment(workspace: string, credential: string, session: string | null, input: unknown): DesktopObject;
  generatedLinks(): GeneratedFileLinks;
};

export interface WorkspaceSurfaceMethods {
  currentWorkspaceOverview(session: string | null): {
    workspaceId: string;
    name: string;
    objects: { id: string; title: string; kind: string; revision: number }[];
    total: number;
    truncated: boolean;
  };
  currentWorkspaces(session: string | null): { workspaceId: string; items: WorkspaceSummary[] };
  createCurrentWorkspace(session: string | null, input: unknown): {
    workspaceId: string;
    name: string;
    sourceWorkspaceId: string;
    created: boolean;
    objectCount: number;
  };
  readCurrentRegions(session: string | null, input?: unknown): unknown;
  writeCurrentRegion(session: string | null, input: unknown): unknown;
  workspaceList(workspace: string, token: string, session: string | null): WorkspaceSummary[];
  workspaceTrash(workspace: string, token: string, session: string | null, input: unknown): unknown;
  renameWorkspace(workspace: string, token: string, session: string | null, input: unknown): unknown;
  switchWorkspace(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
    messageRouteAvailable?: boolean,
  ): unknown;
  saveGroups(workspace: string, token: string, session: string | null, input: unknown): unknown;
  readCanvasBoard(workspace: string): CanvasBoard;
  moveRegion(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): Workspace;
  canvasBoard(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): CanvasBoard;
  createWorkspace(session: string | null, name?: string, requestId?: string): string;
  listUnbound(): unknown[];
  placeNewObjectInRegion(workspace: string, objectId: string): void;
}

type WorkspaceSurfaceInternals = {
  workspaceSummaries(workspace: string): WorkspaceSummary[];
  trashWorkspace(workspace: string): void;
};

export const canvasWorkspaces: WorkspaceSurfaceMethods &
  WorkspaceSurfaceInternals &
  ThisType<WorkspaceSurfaceHost & WorkspaceSurfaceMethods & WorkspaceSurfaceInternals> = {
  currentWorkspaceOverview(session: string | null) {
    if (!session) fail('SESSION_REQUIRED', 'Codex 尚未提供会话标识，请重新连接当前对话。');
    this.createWorkspace(session);
    const row = this.db.prepare('SELECT id,name FROM workspaces WHERE session=?').get(session) as
      | { id: string; name: string }
      | undefined;
    if (!row) fail('NOT_FOUND', '当前对话没有工作桌面。');
    const ids = this.db
      .prepare('SELECT id FROM objects WHERE workspace=? ORDER BY rowid DESC')
      .all(row.id) as { id: string }[];
    const objects = ids
      .map(({ id }) => this.object(row.id, id))
      .filter((object) => !object.archived && !object.policy?.private);
    return {
      workspaceId: row.id,
      name: row.name,
      objects: objects.slice(0, 100).map((object) => ({
        id: object.id,
        title: object.title,
        kind: object.kind,
        revision: object.revision,
      })),
      total: objects.length,
      truncated: objects.length > 100,
    };
  },
  currentWorkspaces(session: string | null) {
    if (!session) fail('SESSION_REQUIRED', '请先连接当前对话。');
    const current = this.db.prepare('SELECT id FROM workspaces WHERE session=?').get(session) as
      | { id: string }
      | undefined;
    if (!current) fail('NOT_FOUND', '请先打开工作桌面，再管理桌面。');
    return { workspaceId: current.id, items: this.workspaceSummaries(current.id) };
  },
  createCurrentWorkspace(session: string | null, input: unknown) {
    const p = WorkspaceCreate.parse(input);
    if (!session) fail('SESSION_REQUIRED', '请先连接当前对话。');
    // A session-scoped receipt survives a later switch to the new desktop.
    return this.tx(() =>
      this.once(
        'index',
        `ai-workspace:${hash(session)}:${p.requestId}`,
        { type: 'workspace.create', ...p },
        () => {
          const current = this.currentWorkspaces(session);
          if (current.workspaceId !== p.workspaceId)
            fail('WORKSPACE_CHANGED', '当前桌面已切换，请重新读取桌面列表。');
          requireWorkspaceSlot(this.db);
          const workspaceId = id('workspace');
          this.db
            .prepare('INSERT INTO workspaces(id,name,session,viewport) VALUES(?,?,NULL,?)')
            .run(workspaceId, p.name, encode({ x: 0, y: 0, zoom: 1 }));
          this.event(p.workspaceId, 'workspace.created', null, null, 'ai');
          this.event(workspaceId, 'workspace.created', null, null, 'ai');
          return {
            workspaceId,
            name: p.name,
            sourceWorkspaceId: p.workspaceId,
            created: true,
            objectCount: 0,
          };
        },
      ),
    );
  },
  readCurrentRegions(session: string | null, input: unknown = {}) {
    const p = RegionRead.parse(input),
      current = this.currentWorkspaceOverview(session),
      w = current.workspaceId;
    if (p.workspaceId && p.workspaceId !== w)
      fail('WORKSPACE_CHANGED', '工作区已切换，请重新读取区域。');
    const snapshot = this.snapshot(w),
      groups = snapshot.groups;
    const objects = snapshot.objects.filter((o) => !o.archived && !o.policy?.private);
    return {
      workspaceId: w,
      groupsRevision: groups.revision,
      viewRevision: snapshot.viewRevision,
      regions: groups.items
        .filter((g) => g.bounds)
        .map(({ linkedObjectIds, ...g }) => ({
          ...g,
          objectIds: objects
            .filter((o) => regionMemberIds({ ...g, linkedObjectIds }).includes(o.id) || contains(g.bounds!, o.bounds))
            .map((o) => o.id),
        })),
      objects: objects.map((o) => ({
        id: o.id,
        title: o.title,
        kind: o.kind,
        revision: o.revision,
        bounds: o.bounds,
        locked: !!o.policy?.locked,
      })),
    };
  },
  writeCurrentRegion(session: string | null, input: unknown) {
    const p = RegionWrite.parse(input);
    // Resolving the current workspace can create a binding in its own transaction.
    // Do that before the atomic region write, then recheck ownership inside it.
    const current = this.currentWorkspaceOverview(session),
      w = current.workspaceId;
    if (w !== p.workspaceId) fail('WORKSPACE_CHANGED', '工作区已切换，请重新读取区域。');
    return this.tx(() => {
      const binding = this.db.prepare('SELECT id FROM workspaces WHERE session=?').get(session) as
        | { id: string }
        | undefined;
      if (binding?.id !== w) fail('WORKSPACE_CHANGED', '工作区已切换，请重新读取区域。');
      return this.once(w, p.requestId, { type: 'model.region', ...p }, () => {
        const snapshot = this.snapshot(w),
          groups = structuredClone(snapshot.groups);
        if (groups.revision !== p.groupsRevision || snapshot.viewRevision !== p.viewRevision)
          fail('REVISION_CONFLICT', '区域或卡片位置已改变，请重新读取后操作。');
        const ids = [...new Set(p.objectIds ?? [])],
          objects = ids.map((id) => this.object(w, id));
        for (const object of objects)
          if (object.archived || object.policy?.private || object.policy?.locked)
            fail('OBJECT_UNAVAILABLE', '所选材料已归档、私有或锁定，不能移动。');
        let region = groups.items.find((g) => g.id === p.regionId && g.bounds);
        if (p.operation === 'create') {
          if (!p.name) fail('VALIDATION_FAILED', '创建区域需要名称。');
          if (groups.items.length >= 40) fail('GROUP_LIMIT', '最多保留40 个分组或区域。');
          let bounds = p.bounds;
          if (!bounds) {
            let x = 80,
              y = 80;
            const occupied = [
              ...snapshot.objects.map((o) => o.bounds),
              ...groups.items.flatMap((g) => (g.bounds ? [g.bounds] : [])),
            ];
            for (const b of occupied) y = Math.max(y, b.y + b.height + 80);
            bounds = { x, y, width: 1000, height: 520 };
          }
          region = {
            id: id('region'),
            name: p.name,
            color: p.color ?? 'blue',
            objectIds: [],
            bounds,
            collapsed: false,
          };
          groups.items.push(region);
        } else if (!region) fail('NOT_FOUND', '目标区域不存在，请先读取区域 ID。');
        if (p.operation === 'rename') {
          if (!p.name) fail('VALIDATION_FAILED', '改名需要新名称。');
          if (ids.length || p.bounds || p.color)
            fail('VALIDATION_FAILED', '改名只接受区域 ID 和名称。');
          region!.name = p.name;
        }
        if (p.operation === 'move_objects' && !ids.length)
          fail('VALIDATION_FAILED', '请指定要移动的材料 ID。');
        const moved: { id: string; bounds: DesktopObject['bounds'] }[] = [];
        if (ids.length) {
          const target = region!.bounds!,
            padding = 32,
            gap = 24;
          const obstacles = [
            ...snapshot.objects.filter((o) => !ids.includes(o.id)).map((o) => o.bounds),
            ...this.readCanvasBoard(w).items,
          ];
          const maxWidth = Math.max(...objects.map((o) => o.bounds.width));
          target.width = Math.max(target.width, maxWidth + padding * 2);
          let x = target.x + padding,
            y = target.y + 64,
            rowHeight = 0;
          for (const object of objects) {
            const b = { ...object.bounds };
            if (x + b.width > target.x + target.width - padding) {
              x = target.x + padding;
              y += rowHeight + gap;
              rowHeight = 0;
            }
            let candidate = { ...b, x, y };
            for (let attempt = 0; attempt <= obstacles.length; attempt++) {
              const collisions = obstacles.filter(
                (o) =>
                  candidate.x < o.x + o.width + gap &&
                  candidate.x + candidate.width + gap > o.x &&
                  candidate.y < o.y + o.height + gap &&
                  candidate.y + candidate.height + gap > o.y,
              );
              if (!collisions.length) break;
              y = Math.max(...collisions.map((o) => o.y + o.height + gap));
              candidate = { ...candidate, y };
            }
            Bounds.parse(candidate);
            moved.push({ id: object.id, bounds: candidate });
            obstacles.push(candidate);
            x = candidate.x + candidate.width + gap;
            rowHeight = Math.max(rowHeight, candidate.height);
            target.height = Math.max(
              target.height,
              candidate.y + candidate.height + padding - target.y,
            );
          }
          region!.collapsed = false;
          region!.objectIds = [...new Set([...region!.objectIds, ...ids])];
          for (const group of groups.items)
            if (group.id !== region!.id)
              group.objectIds = group.objectIds.filter((id) => !ids.includes(id));
        }
        if (p.operation === 'set_output_target' && !p.outputBatchId)
          fail('VALIDATION_FAILED', '请提供本轮产出批次 ID。');
        if (p.outputBatchId) {
          const raw = this.setting(w, `generated:${p.outputBatchId}`),
            batch = raw ? decode<any>(raw) : null;
          if (!batch || batch.workspaceId !== w || batch.owner !== session)
            fail('SESSION_MISMATCH', '产出批次不属于当前工作桌面。');
          if (p.operation === 'rename')
            fail('VALIDATION_FAILED', '请用 set_output_target 设置产出区域。');
          this.db
            .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
            .run(w, `generated-target:${p.outputBatchId}`, encode(region!.id));
          this.db
            .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
            .run(w, `generated-target-thread:${batch.threadId}`, encode(region!.id));
        }
        const next = CanvasGroupsSchema.parse({ ...groups, revision: groups.revision + 1 });
        for (const item of moved)
          this.db
            .prepare(
              'UPDATE objects SET bounds=?,layout_revision=layout_revision+1 WHERE workspace=? AND id=?',
            )
            .run(encode(item.bounds), w, item.id);
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(w, 'canvas-groups', encode(next));
        if (moved.length) {
          this.db.prepare('UPDATE workspaces SET view_revision=view_revision+1 WHERE id=?').run(w);
          this.event(w, 'view.changed', null, null, 'ai');
        }
        this.event(w, 'groups.changed', null, null, 'ai');
        const visible = new Set(
          snapshot.objects.filter((o) => !o.archived && !o.policy?.private).map((o) => o.id),
        );
        return {
          workspaceId: w,
          region: { ...region!, objectIds: region!.objectIds.filter((id) => visible.has(id)) },
          groupsRevision: next.revision,
          viewRevision: snapshot.viewRevision + (moved.length ? 1 : 0),
          moved,
          summary:
            p.operation === 'rename'
              ? '区域已改名'
              : moved.length
                ? '原材料已移入区域，文件内容保持不变'
                : '区域已创建',
        };
      });
    });
  },
  workspaceList(workspace: string, token: string, session: string | null): WorkspaceSummary[] {
    this.auth(workspace, token, session, 'panel');
    return this.workspaceSummaries(workspace);
  },
  workspaceSummaries(workspace: string): WorkspaceSummary[] {
    const rows = this.db
      .prepare(`SELECT id,name FROM workspaces WHERE (id=? OR session IS NULL)
        AND id NOT IN (SELECT workspace FROM settings WHERE key='workspace-trashed')
        ORDER BY rowid DESC`)
      .all(workspace) as { id: string; name: string }[];
    return rows.map((row) => {
      const data = this.db
        .prepare(
          "SELECT COUNT(*) AS count,MAX(updated_at) AS at FROM objects WHERE workspace=? AND id NOT IN (SELECT substr(key,10) FROM settings WHERE workspace=? AND key LIKE 'archived:%' AND value='true')",
        )
        .get(row.id, row.id) as { count: number; at: string | null };
      return { ...row, objectCount: data.count, updatedAt: data.at, current: row.id === workspace };
    });
  },
  trashWorkspace(workspace: string) {
    if (this.db.prepare('SELECT 1 FROM drafts WHERE workspace=? AND expires>?')
      .get(workspace, Date.now()))
      fail('DRAFT_ACTIVE', '请先保存该桌面的草稿。');
    const generated = this.db.prepare(
      "SELECT 1 FROM settings WHERE workspace=? AND key LIKE 'generated:%' AND json_valid(value) AND json_extract(value,'$.state')='running' LIMIT 1",
    ).get(workspace);
    if (generated || this.workManagement.all(workspace).some(({ management }) =>
      management && !management.restoredHistory &&
      (management.runs.some(active) ||
        ['queued', 'scheduled', 'waiting', 'running', 'revising', 'review', 'pausing', 'cancelling'].includes(management.state)),
    ))
      fail('WORKSPACE_BUSY', '该桌面还有待处理或未确认结果的任务，请先在执行记录中处理。');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?,?)')
      .run(workspace, 'workspace-trashed', encode(true));
    this.db.prepare("UPDATE credentials SET status='revoked' WHERE workspace=? AND status IN ('active','delegated')")
      .run(workspace);
    this.event(workspace, 'workspace.trashed', null, null, 'human');
  },
  workspaceTrash(workspace: string, token: string, session: string | null, input: unknown) {
    const p = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('list') }).strict(),
      z.object({ operation: z.enum(['delete', 'restore']), targetId: Id, requestId: Id }).strict(),
    ]).parse(input);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      if (p.operation === 'list') {
        const rows = this.db.prepare(`SELECT w.id,w.name FROM workspaces w
          JOIN settings s ON s.workspace=w.id AND s.key='workspace-trashed'
          WHERE w.session IS NULL ORDER BY w.rowid DESC`).all() as { id: string; name: string }[];
        return rows.map(({ id, name }) => ({ id, name }));
      }
      return this.once(workspace, p.requestId, { type: 'workspace.trash', ...p }, () => {
        const target = this.db.prepare('SELECT id FROM workspaces WHERE id=? AND session IS NULL')
          .get(p.targetId);
        if (!target || workspace === p.targetId)
          fail('WORKSPACE_NOT_FOUND', '请选择另一个可用的桌面。');
        const deleted = !!this.setting(p.targetId, 'workspace-trashed');
        if (p.operation === 'delete' && !deleted) this.trashWorkspace(p.targetId);
        if (p.operation === 'restore' && deleted) {
          requireWorkspaceSlot(this.db);
          this.db.prepare("DELETE FROM settings WHERE workspace=? AND key='workspace-trashed'")
            .run(p.targetId);
          this.event(p.targetId, 'workspace.restored', null, null, 'human');
        }
        return { id: p.targetId };
      });
    });
  },
  renameWorkspace(workspace: string, token: string, session: string | null, input: unknown) {
    const p = z
      .object({ requestId: Id, name: z.string().trim().min(1).max(80), expectedName: z.string() })
      .strict()
      .parse(input);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, p.requestId, { type: 'workspace.rename', ...p }, () => {
        const row = this.db.prepare('SELECT name FROM workspaces WHERE id=?').get(workspace) as {
          name: string;
        };
        if (row.name !== p.expectedName)
          fail('REVISION_CONFLICT', '工作区名称已更新，请重新打开工作区列表。');
        this.db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(p.name, workspace);
        this.event(workspace, 'workspace.renamed', null, null, 'human');
        return { name: p.name };
      });
    });
  },
  switchWorkspace(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
    messageRouteAvailable = false,
  ) {
    const p = z
      .object({
        requestId: Id,
        operation: z.enum(['create', 'switch', 'delete']),
        targetId: Id.optional(),
        name: z.string().trim().min(1).max(80).optional(),
        rootPath: z.string().max(4096).optional(),
      })
      .strict()
      .parse(input);
    let linkedFiles: { path: string; relativePath: string }[] = [];
    if (p.rootPath) {
      if (
        p.operation !== 'create' ||
        !isAbsolute(p.rootPath) ||
        !lstatSync(p.rootPath).isDirectory() ||
        lstatSync(p.rootPath).isSymbolicLink()
      )
        fail('INVALID_PATH', '请选择真实文件夹创建关联工作区。');
      const root = realpathSync(p.rootPath);
      let folders = 0,
        total = 0;
      const scan = (path: string, prefix = '', depth = 0) => {
        if (depth > 16) fail('IMPORT_LIMIT', '目录层级超过 16 层。');
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const target = join(path, entry.name),
            relativePath = prefix + entry.name;
          if (entry.isDirectory()) {
            if (++folders > 40) fail('IMPORT_LIMIT', '目录超过 40 个，请选择更具体的文件夹。');
            scan(target, relativePath + '/', depth + 1);
          } else if (entry.isFile()) {
            const size = lstatSync(target).size;
            total += size;
            if (size > 50 * 1024 * 1024 || total > 256 * 1024 * 1024 || linkedFiles.length >= 2000)
              fail('IMPORT_LIMIT', '关联目录超过导入上限，请选择更具体的文件夹。');
            linkedFiles.push({ path: target, relativePath });
          }
        }
      };
      scan(root);
      p.rootPath = root;
    }
    const switched = this.tx(() => {
      const receiptKey = `switch:${hash(token).slice(0, 24)}:${p.requestId}`,
        payload = { type: 'workspace.switch', ...p };
      const credential = this.db
        .prepare("SELECT * FROM credentials WHERE token_hash=? AND workspace=? AND kind='panel'")
        .get(hash(token), workspace) as any;
      if (!credential || credential.session !== session || credential.expires < Date.now())
        fail('PERMISSION_DENIED', '工作区凭据失效，请重新打开面板。');
      if (credential.status === 'switched') {
        const previous = this.db
          .prepare('SELECT payload_hash,result FROM receipts WHERE workspace=? AND request=?')
          .get(workspace, receiptKey) as any;
        if (previous?.payload_hash === hash(canonical(payload))) {
          const result = decode(previous.result);
          this.auth(result.binding.workspaceId, result.binding.credential, session, 'panel');
          return result;
        }
        fail('WORKSPACE_SWITCHED', '此面板已切换工作区，请重新打开面板。');
      }
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, receiptKey, payload, () => {
        if (p.operation === 'switch' && p.targetId === workspace)
          return this.panelState(workspace, session, messageRouteAvailable);
        if (
          this.db
            .prepare('SELECT 1 FROM drafts WHERE workspace=? AND owner=? AND expires>?')
            .get(workspace, credential.owner, Date.now())
        )
          fail('DRAFT_ACTIVE', '请先保存当前草稿，再切换工作区。');
        let target: string;
        if (p.operation === 'create') {
          requireWorkspaceSlot(this.db);
          target = id('workspace');
          this.db
            .prepare('INSERT INTO workspaces(id,name,session,viewport) VALUES(?,?,NULL,?)')
            .run(target, p.name ?? '新的工作桌面', encode({ x: 0, y: 0, zoom: 1 }));
          if (p.rootPath) {
            this.db
              .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
              .run(target, 'generated-workspace-root', encode(p.rootPath));
            this.db
              .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
              .run(target, 'generated-roots', encode([p.rootPath]));
            this.db
              .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
              .run(target, 'workspace-linked', encode(true));
          }
        } else {
          if (!p.targetId) fail('VALIDATION_FAILED', '请选择目标工作区。');
          const row = this.db
            .prepare('SELECT id,session FROM workspaces WHERE id=?')
            .get(p.targetId) as { id: string; session: string | null } | undefined;
          if (this.setting(p.targetId, 'workspace-trashed'))
            fail('WORKSPACE_NOT_FOUND', '请先恢复已删除的桌面。');
          if (!row || row.session !== null)
            fail('SESSION_MISMATCH', '此工作区已关联其他会话，不能在当前面板切换。');
          if (p.operation === 'delete' && (row.id === workspace || session === null && this.db
            .prepare('SELECT 1 FROM workspaces WHERE id=? AND session IS NOT NULL').get(workspace)))
            fail('VALIDATION_FAILED', '请保留至少一个可用桌面。');
          target = row.id;
        }
        if (session) {
          const row = this.db
            .prepare('SELECT session FROM workspaces WHERE id=?')
            .get(workspace) as { session: string | null };
          if (row.session !== session)
            fail('SESSION_MISMATCH', '当前会话绑定已变化，请重新打开面板。');
          this.db.prepare('UPDATE workspaces SET session=NULL WHERE id=?').run(workspace);
          this.db.prepare('UPDATE workspaces SET session=? WHERE id=?').run(session, target);
        }
        this.db
          .prepare(
            "UPDATE credentials SET status='switched' WHERE workspace=? AND kind='panel' AND session IS ?",
          )
          .run(workspace, session);
        if (p.operation !== 'delete')
          this.db
            .prepare(
              "UPDATE credentials SET status='cancelled' WHERE workspace=? AND kind IN ('execution','run-recovery')",
            )
            .run(workspace);
        // Unbound target panels cannot keep operating after it becomes session-bound.
        if (session)
          this.db
            .prepare(
              "UPDATE credentials SET status='revoked' WHERE workspace=? AND session IS NULL",
            )
            .run(target);
        this.event(workspace, 'workspace.left', null, null, 'human');
        if (p.operation === 'delete') this.trashWorkspace(workspace);
        this.event(target, 'workspace.opened', null, null, 'human');
        return this.panelState(target, session, messageRouteAvailable);
      });
    });
    if (p.rootPath) {
      const target = switched.binding.workspaceId,
        credential = switched.binding.credential;
      for (const [index, file] of linkedFiles.entries()) {
        const requestId = 'linked-import:' + hash(p.requestId + file.relativePath).slice(0, 40);
        this.generatedLinks().registerImport(target, requestId, file.path, true);
        this.importAttachment(target, credential, session, {
          requestId,
          fileName: basename(file.path),
          relativePath: file.relativePath,
          data: readFileSync(file.path).toString('base64'),
          bounds: {
            x: 80 + (index % 4) * 360,
            y: 80 + Math.floor(index / 4) * 300,
            width: 320,
            height: 240,
          },
        });
      }
      return this.panelState(target, session, messageRouteAvailable);
    }
    return switched;
  },
  saveGroups(workspace: string, token: string, session: string | null, input: unknown) {
    const p = CanvasGroupsSchema.extend({ requestId: Id }).parse(input);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, p.requestId, { type: 'groups', ...p }, () => {
        const current = decode(
          this.setting(workspace, 'canvas-groups') || '{"revision":0,"items":[]}',
        );
        if (current.revision !== p.revision)
          fail('REVISION_CONFLICT', '区域已在其他面板更新，请刷新后重试。');
        if (new Set(p.items.map((g) => g.id)).size !== p.items.length)
          fail('VALIDATION_FAILED', '分组 ID 不可重复。');
        for (const group of p.items) {
          if (new Set(group.objectIds).size !== group.objectIds.length)
            fail('VALIDATION_FAILED', '分组内的对象不可重复。');
          for (const objectId of regionMemberIds(group)) this.object(workspace, objectId);
        }
        const groups = normalizeFolders(
          { revision: p.revision + 1, items: p.items },
          this.snapshot(workspace).objects,
          this.readCanvasBoard(workspace).items,
        );
        validateFolders(groups.items);
        growFolderParents(groups.items);
        CanvasGroupsSchema.parse(groups);
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(workspace, 'canvas-groups', encode(groups));
        this.event(workspace, 'groups.changed', null, null, 'human');
        return groups;
      });
    });
  },
  readCanvasBoard(workspace: string): CanvasBoard {
    const saved = this.setting(workspace, 'canvas-board');
    return saved ? CanvasBoardSchema.parse(decode(saved)) : emptyCanvasBoard();
  },
  placeNewObjectInRegion(workspace: string, objectId: string) {
    const current = this.snapshot(workspace),
      object = current.objects.find((o) => o.id === objectId);
    if (!object) return;
    const group = folderAt(current.groups.items, object.bounds);
    if (!group || group.objectIds.includes(objectId)) return;
    group.objectIds.push(objectId);
    current.groups.revision++;
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(workspace, 'canvas-groups', encode(current.groups));
    this.event(workspace, 'groups.changed', null, null, 'human');
  },
  moveRegion(workspace: string, token: string, session: string | null, input: unknown) {
    const p = z
      .object({
        requestId: Id,
        id: Id,
        groupsRevision: z.number().int(),
        viewRevision: z.number().int(),
        boardRevision: z.number().int(),
        dx: z.number().finite().min(-200000).max(200000),
        dy: z.number().finite().min(-200000).max(200000),
        layout: z.enum(['free', 'grid', 'list']).optional(),
      })
      .strict()
      .parse(input);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, p.requestId, { type: 'region.move', ...p }, () => {
        const current = this.snapshot(workspace),
          groups = current.groups,
          board = this.readCanvasBoard(workspace);
        if (
          groups.revision !== p.groupsRevision ||
          board.revision !== p.boardRevision ||
          current.viewRevision !== p.viewRevision
        )
          fail('REVISION_CONFLICT', '区域内的布局已改变，已保留原位置。请重新移动。');
        const group = groups.items.find((group) => group.id === p.id);
        if (!group?.bounds) fail('NOT_FOUND', '画布区域已不存在。');
        const plan = arrangeFolder(current, board, p.id, p.dx, p.dy, p.layout);
        for (const object of plan.objects) {
          const before = current.objects.find((o) => o.id === object.id)!;
          if (encode(before.bounds) === encode(object.bounds)) continue;
          this.db
            .prepare(
              'UPDATE objects SET bounds=?,layout_revision=layout_revision+1 WHERE workspace=? AND id=?',
            )
            .run(encode(object.bounds), workspace, object.id);
        }
        const nextBoard = CanvasBoardSchema.parse({ ...plan.board, revision: board.revision + 1 });
        const nextGroups = CanvasGroupsSchema.parse({
          ...plan.groups,
          revision: groups.revision + 1,
        });
        validateFolders(nextGroups.items);
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(workspace, 'canvas-board', encode(nextBoard));
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(workspace, 'canvas-groups', encode(nextGroups));
        this.db
          .prepare('UPDATE workspaces SET view_revision=view_revision+1 WHERE id=?')
          .run(workspace);
        this.event(workspace, 'canvas.changed', null, nextBoard.revision, 'human');
        this.event(workspace, 'groups.changed', null, null, 'human');
        this.event(workspace, 'view.changed', null, null, 'human');
        return this.snapshot(workspace);
      });
    });
  },
  canvasBoard(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): CanvasBoard {
    const p = CanvasBoardAction.parse(input);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      if (p.operation === 'read') return this.readCanvasBoard(workspace);
      return this.once(workspace, p.requestId, { type: 'canvas.save', ...p }, () => {
        const current = this.readCanvasBoard(workspace);
        if (current.revision !== p.expectedRevision)
          fail('REVISION_CONFLICT', '画布已在其他面板更新，请保留当前修改并重新同步。');
        // Archived objects keep their links so restoring a card also restores its connections.
        // Only their visibility changes in the panel. Foreign-workspace IDs never enter the board.
        const endpoints = new Set(p.links.flatMap((link) => [link.sourceId, link.targetId]));
        for (const objectId of endpoints) {
          if (
            !this.db
              .prepare('SELECT 1 FROM objects WHERE workspace=? AND id=?')
              .get(workspace, objectId)
          )
            fail('NOT_FOUND', '连线的材料不属于当前工作区或已不存在。');
        }
        const board = CanvasBoardSchema.parse({
          revision: current.revision + 1,
          items: p.items,
          links: p.links,
        });
        const groups = this.snapshot(workspace).groups;
        let membershipChanged = false;
        for (const g of groups.items.filter((g) => g.bounds)) {
          const kept = (g.markIds ?? []).filter((id) => p.items.some((m) => m.id === id));
          if (kept.length !== (g.markIds?.length ?? 0)) {
            g.markIds = kept;
            membershipChanged = true;
          }
        }
        for (const mark of p.items) {
          const before = current.items.find((m) => m.id === mark.id);
          if (before && before.x === mark.x && before.y === mark.y) continue;
          const owner = folderAt(groups.items, mark)?.id;
          for (const g of groups.items.filter((g) => g.bounds)) {
            const had = g.markIds?.includes(mark.id) ?? false,
              has = g.id === owner;
            if (had === has) continue;
            membershipChanged = true;
            g.markIds = (g.markIds ?? []).filter((id) => id !== mark.id);
            if (has) g.markIds.push(mark.id);
          }
        }
        if (membershipChanged) {
          groups.revision++;
          this.db
            .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
            .run(workspace, 'canvas-groups', encode(groups));
          this.event(workspace, 'groups.changed', null, null, 'human');
        }
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(workspace, 'canvas-board', encode(board));
        this.event(workspace, 'canvas.changed', null, board.revision, 'human');
        return board;
      });
    });
  },
  createWorkspace(session: string | null, name = '我的工作桌面', requestId = id('create')) {
    return this.tx(() => {
      if (session) {
        const existing = this.db
          .prepare('SELECT id FROM workspaces WHERE session=?')
          .get(session) as any;
        if (existing) return existing.id as string;
      }
      // Null-session creation is deduplicated without introducing a global current workspace.
      const receipt = this.db
        .prepare("SELECT result FROM receipts WHERE workspace='index' AND request=?")
        .get(requestId) as any;
      if (receipt) return decode<string>(receipt.result);
      const workspace = id('workspace');
      this.db
        .prepare('INSERT INTO workspaces(id,name,session,viewport) VALUES(?,?,?,?)')
        .run(workspace, name.slice(0, 80), session, encode({ x: 0, y: 0, zoom: 1 }));
      this.db
        .prepare("INSERT INTO receipts VALUES('index',?,?,?)")
        .run(requestId, hash(name), encode(workspace));
      return workspace;
    });
  },
  listUnbound() {
    return this.db
      .prepare(`SELECT id,name FROM workspaces WHERE session IS NULL
        AND id NOT IN (SELECT workspace FROM settings WHERE key='workspace-trashed')
        ORDER BY rowid DESC`)
      .all();
  },
};
