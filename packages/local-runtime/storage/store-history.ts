// History, revisions and change-sync surface of DesktopStore, extracted by
// responsibility boundary: everything that reads or rewrites the object event
// log, version history and per-object activity feeds.
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fail, Id, type DesktopObject, type Revision, type Workspace } from '../../contracts/index.js';
import { Annotation } from '../../contracts/index.js';
import { parseEditable } from '../../components/content.js';
import { updateProtection } from '../../components/protection.js';
import { undoRevision } from '../../components/undo.js';
import { structuredLocation } from '../../components/contributions.js';
import { now, decode, encode } from './serde.js';
import type { WorkspaceChanges, WorkspaceDelta, WorkspaceEvent } from '../../contracts/workspace-sync.js';
import type { ObjectActivity } from '../../contracts/object-activity.js';
import type { CanvasBoard } from '../../contracts/canvas-board.js';
import type { WorkspaceOrganization } from '../workspace/organization.js';
import type { WorkTask } from '../../contracts/index.js';

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
export type StoreHistoryHost = {
  db: DatabaseSync;
  organization: WorkspaceOrganization;
  tx: <T>(fn: () => T) => T;
  auth(workspace: string, credential: string, session: string | null, kind?: Auth['kind']): Auth;
  once: <T>(workspace: string, request: string, payload: unknown, fn: () => T) => T;
  object(workspace: string, objectId: string): DesktopObject;
  withAsset(object: DesktopObject): DesktopObject;
  cursor(workspace: string): number;
  snapshot(workspace: string): Workspace;
  setting(workspace: string, key: string): string;
  event(
    workspace: string,
    type: string,
    objectId: string | null,
    revision: number | null,
    actor: string,
  ): void;
  readCanvasBoard(workspace: string): CanvasBoard;
  listTasks(workspace: string, token: string, session: string | null): WorkTask[];
};

export interface StoreHistoryMethods {
  changes(
    workspace: string,
    token: string,
    session: string | null,
    after: number,
    incremental?: boolean,
  ): WorkspaceChanges;
  activity(workspace: string, token: string, session: string | null, before?: number): {
    events: WorkspaceEvent[];
    next: number | null;
  };
  objectActivity(workspace: string, token: string, session: string | null): Record<string, ObjectActivity>;
  revisions(
    workspace: string,
    token: string,
    session: string | null,
    objectId: string,
    before?: number,
  ): { objectId: string; currentRevision: number; revisions: Omit<Revision, 'content'>[]; next: number | null };
  revision(
    workspace: string,
    token: string,
    session: string | null,
    objectId: string,
    revision: number,
  ): Revision;
  restore(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): { objectId: string; revision: number; restoredFrom: number; cursor: number };
  undo(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): { objectId: string; revision: number; cursor: number };
  cancel(workspace: string, token: string, session: string | null, snapshotId: string): { ok: true };
  recordDelivery(
    workspace: string,
    token: string,
    session: string | null,
    snapshotId: string,
    outcome: 'sent' | 'unknown' | 'draft' | 'attached',
  ): { ok: true };
}

export const storeHistory: StoreHistoryMethods & ThisType<StoreHistoryHost & StoreHistoryMethods> = {
  changes(workspace, token, session, after, incremental = false): WorkspaceChanges {
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      const latest = this.cursor(workspace);
      const rows = this.db
        .prepare(
          'SELECT seq,type,object_id AS objectId,revision,actor,created_at AS createdAt FROM events WHERE workspace=? AND seq>? ORDER BY seq LIMIT 101',
        )
        .all(workspace, after) as unknown as WorkspaceEvent[];
      const events = rows.slice(0, 100),
        hasMore = rows.length > 100;
      // Older panels keep the snapshot protocol. New panels acknowledge one event page at a time.
      if (!incremental)
        return {
          cursor: latest,
          events,
          hasMore: false,
          workspace: latest !== after ? this.snapshot(workspace) : undefined,
        };
      if (after > latest || events.some((event) => event.type === 'workspace.restored'))
        return {
          cursor: latest,
          events,
          hasMore: false,
          workspace: this.snapshot(workspace),
          reset: true,
        };
      const cursor = hasMore ? events[events.length - 1].seq : latest;
      const delta: WorkspaceDelta = {
        workspaceId: workspace,
        after,
        cursor,
        upsert: [],
        removed: [],
      };
      const types = new Set(events.map((event) => event.type));
      const changedIds = new Set(
        events
          .filter(
            (event) =>
              event.objectId &&
              event.type.startsWith('object.') &&
              !['object.read', 'object.exported'].includes(event.type),
          )
          .map((event) => event.objectId!),
      );
      for (const objectId of changedIds) {
        if (
          !this.db
            .prepare('SELECT 1 FROM objects WHERE workspace=? AND id=?')
            .get(workspace, objectId)
        ) {
          delta.removed.push(objectId);
          continue;
        }
        const object = this.object(workspace, objectId);
        if (object.archived) delta.removed.push(objectId);
        else delta.upsert.push(this.withAsset(object));
      }
      if (types.has('workspace.renamed'))
        delta.name = (
          this.db.prepare('SELECT name FROM workspaces WHERE id=?').get(workspace) as any
        ).name;
      if (types.has('groups.changed') || types.has('layout.restored'))
        delta.groups = decode(
          this.setting(workspace, 'canvas-groups') || '{"revision":0,"items":[]}',
        );
      if (types.has('folders.changed')) delta.fileTree = this.organization.tree(workspace);
      if (types.has('canvas.changed')) delta.canvasBoard = this.readCanvasBoard(workspace);
      if (types.has('view.changed') || types.has('layout.restored')) {
        const row = this.db
          .prepare('SELECT viewport,view_revision FROM workspaces WHERE id=?')
          .get(workspace) as any;
        const layouts = this.db
          .prepare('SELECT id,bounds,layout_revision FROM objects WHERE workspace=?')
          .all(workspace) as any[];
        delta.view = {
          revision: row.view_revision,
          viewport: decode(row.viewport),
          objects: layouts.map((o) => ({
            id: o.id,
            bounds: decode(o.bounds),
            layoutRevision: o.layout_revision,
          })),
        };
      }
      return { cursor, events, hasMore, delta };
    });
  },
  activity(workspace, token, session, before?) {
    this.auth(workspace, token, session, 'panel');
    const rows = this.db
      .prepare(
        'SELECT seq,type,object_id AS objectId,revision,actor,created_at AS createdAt FROM events WHERE workspace=? AND seq<? ORDER BY seq DESC LIMIT 51',
      )
      .all(workspace, before ?? Number.MAX_SAFE_INTEGER) as any[];
    return { events: rows.slice(0, 50), next: rows.length > 50 ? rows[49].seq : null };
  },
  objectActivity(workspace, token, session) {
    this.auth(workspace, token, session, 'panel');
    const values: Record<string, ObjectActivity> = {};
    const labels: Record<string, string> = {
      'object.read': 'AI 读取了材料引用',
      'object.changed': 'AI 已保存修改',
      'native_file.prepared': '文件副本已准备',
      'native_file.returned': '文件已回写',
      'native_file.pending': '文件回写待处理',
      'local_run.collection_pending': '运行结果待收回',
      'local_run.collected': '运行结果已收回',
    };
    const rows = this.db
      .prepare(
        "SELECT type,object_id AS objectId,revision,actor,created_at AS at FROM events WHERE workspace=? AND object_id IS NOT NULL AND actor='ai' ORDER BY seq DESC LIMIT 2000",
      )
      .all(workspace) as any[];
    for (const row of rows) {
      if (!labels[row.type]) continue;
      const value = (values[row.objectId] ??= {
        label: labels[row.type],
        at: row.at,
        type: row.type,
        revision: row.revision ?? undefined,
        events: [],
      });
      if (value.events.length < 6)
        value.events.push({
          type: row.type,
          actor: row.actor,
          at: row.at,
          revision: row.revision ?? undefined,
        });
    }
    const phases: Record<string, string> = {
      writing: '任务进入写入阶段',
      reviewing: '任务等待审阅',
      revising: '任务等待修订',
      ready: '任务结果待确认',
      approved: '任务审阅已通过',
    };
    for (const task of this.listTasks(workspace, token, session)) {
      if (!task.execution) continue;
      const label =
        task.status === 'paused'
          ? '任务已暂停'
          : task.status === 'cancelled'
            ? '任务已取消'
            : task.status === 'conflict'
              ? '任务遇到版本冲突'
              : task.status === 'completed'
                ? '任务已完成'
                : phases[task.execution.phase];
      if (!label) continue;
      for (const source of task.sources) {
        const previous = values[source.objectId];
        if (!previous || task.updatedAt > previous.at)
          values[source.objectId] = {
            label,
            at: task.updatedAt,
            type: 'task.phase',
            taskId: task.id,
            events: previous?.events ?? [],
          };
      }
    }
    return values;
  },
  revisions(workspace, token, session, objectId, before?) {
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      const object = this.object(workspace, objectId);
      // Lists contain metadata only, so a large object does not multiply payload size by 30.
      const rows = this.db
        .prepare(
          'SELECT revision,actor,summary,created_at AS createdAt FROM revisions WHERE workspace=? AND object_id=? AND revision<? ORDER BY revision DESC LIMIT 31',
        )
        .all(workspace, objectId, before ?? Number.MAX_SAFE_INTEGER) as unknown as Omit<
        Revision,
        'content'
      >[];
      return {
        objectId,
        currentRevision: object.revision,
        revisions: rows.slice(0, 30),
        next: rows.length > 30 ? rows[29].revision : null,
      };
    });
  },
  revision(workspace, token, session, objectId, revision): Revision {
    this.auth(workspace, token, session, 'panel');
    this.object(workspace, objectId);
    const row = this.db
      .prepare(
        'SELECT revision,content,actor,summary,created_at AS createdAt FROM revisions WHERE workspace=? AND object_id=? AND revision=?',
      )
      .get(workspace, objectId, revision) as any;
    if (!row) fail('NOT_FOUND', '历史版本不存在。');
    const contribution = this.setting(workspace, `contribution:${objectId}:${revision}`);
    return {
      ...row,
      content: decode(row.content),
      ...(contribution
        ? {
            contribution: {
              dependencies: [],
              location: { type: 'object' },
              ...decode(contribution),
            },
          }
        : {}),
    };
  },
  restore(workspace, token, session, input) {
    const p = z
      .object({
        requestId: Id,
        objectId: Id,
        expectedRevision: z.number().int().positive(),
        targetRevision: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, p.requestId, { action: 'restore', ...p }, () => {
        const current = this.object(workspace, p.objectId);
        if (current.revision !== p.expectedRevision)
          fail('REVISION_CONFLICT', '比较期间对象已更新，请重新查看当前内容。');
        if (current.revision === p.targetRevision) fail('VALIDATION_FAILED', '已经是当前版本。');
        if (
          this.db
            .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
            .get(workspace, p.objectId, Date.now())
        )
          fail('DRAFT_ACTIVE', '请先保存或处理未完成草稿，再恢复历史。');
        const target = this.revision(workspace, token, session, p.objectId, p.targetRevision);
        const revision = current.revision + 1,
          time = now(),
          summary = `恢复 v${p.targetRevision}（基于 v${current.revision} 比较）`;
        if (current.archived) fail('OBJECT_ARCHIVED', '请先恢复已归档的材料。');
        const conversion = this.setting(workspace, `native-conversion:${current.id}`),
          converted = conversion ? decode(conversion) : null;
        const restoredKind = converted
          ? 'fileName' in target.content
            ? 'file'
            : converted.from
          : current.kind;
        const protection =
          restoredKind === current.kind
            ? updateProtection(current, target.content, false)
            : undefined;
        if (protection)
          this.db
            .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
            .run(workspace, `policy:${current.id}`, encode(protection));
        this.db
          .prepare(
            "UPDATE objects SET content=?,revision=?,updated_at=?,actor='human' WHERE workspace=? AND id=?",
          )
          .run(encode(target.content), revision, time, workspace, p.objectId);
        this.db
          .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
          .run(workspace, p.objectId, revision, encode(target.content), 'human', summary, time);
        this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
          workspace,
          `contribution:${current.id}:${revision}`,
          encode({
            operation: 'restore',
            baseRevision: current.revision,
            requestId: p.requestId,
            location:
              restoredKind === current.kind
                ? structuredLocation(current.kind, current.content, target.content)
                : { type: 'object' },
            dependencies: [{ objectId: current.id, revision: p.targetRevision }],
          }),
        );
        if (restoredKind !== current.kind)
          this.db
            .prepare('UPDATE objects SET kind=? WHERE workspace=? AND id=?')
            .run(restoredKind, workspace, current.id);
        this.event(workspace, 'object.restored', p.objectId, revision, 'human');
        return {
          objectId: p.objectId,
          revision,
          restoredFrom: p.targetRevision,
          cursor: this.cursor(workspace),
        };
      });
    });
  },
  undo(workspace, token, session, input) {
    const p = z
      .object({
        requestId: Id,
        objectId: Id,
        expectedRevision: z.number().int().positive(),
        targetRevision: z.number().int().min(2),
      })
      .strict()
      .parse(input);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, p.requestId, { action: 'undo', ...p }, () => {
        const current = this.object(workspace, p.objectId);
        if (current.archived) fail('OBJECT_ARCHIVED', '请先恢复已归档的材料。');
        if (current.revision !== p.expectedRevision)
          fail('REVISION_CONFLICT', '内容已更新，请重新查看后撤销。');
        if (p.targetRevision > current.revision) fail('NOT_FOUND', '待撤销版本不存在。');
        if (this.setting(workspace, `undone:${current.id}:${p.targetRevision}`))
          fail('ALREADY_UNDONE', '这次修改已经单独撤销，记录仍保留在历史中。');
        if (current.revision - p.targetRevision > 200)
          fail('UNDO_LIMIT', '后续修订超过 200 个，请比较后手动合并。');
        if (
          this.db
            .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
            .get(workspace, current.id, Date.now())
        )
          fail('DRAFT_ACTIVE', '请先保存或处理草稿，再撤销历史修改。');
        const before = this.revision(workspace, token, session, current.id, p.targetRevision - 1);
        const target = this.revision(workspace, token, session, current.id, p.targetRevision);
        const bytes = (
          this.db
            .prepare(
              'SELECT COALESCE(SUM(length(content)),0) AS size FROM revisions WHERE workspace=? AND object_id=? AND revision>?',
            )
            .get(workspace, current.id, p.targetRevision) as { size: number }
        ).size;
        if (bytes > 20000000) fail('UNDO_LIMIT', '后续修订内容过多，请比较后手动合并。');
        const later = (
          this.db
            .prepare(
              'SELECT content FROM revisions WHERE workspace=? AND object_id=? AND revision>? ORDER BY revision',
            )
            .all(workspace, current.id, p.targetRevision) as { content: string }[]
        ).map((r) => decode<DesktopObject['content']>(r.content));
        const undone = undoRevision(current.kind, before.content, target.content, later);
        const content =
          current.kind === 'image'
            ? {
                ...undone,
                annotations: z
                  .array(Annotation)
                  .max(100)
                  .parse((undone as { annotations: unknown }).annotations),
              }
            : parseEditable(current.kind, undone);
        const protection = updateProtection(current, content, false);
        if (protection)
          this.db
            .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
            .run(workspace, `policy:${current.id}`, encode(protection));
        const revision = current.revision + 1,
          at = now(),
          summary = `单独撤销 v${p.targetRevision} 的修改（保留独立的后续改动）`;
        this.db
          .prepare(
            "UPDATE objects SET content=?,revision=?,updated_at=?,actor='human' WHERE workspace=? AND id=?",
          )
          .run(encode(content), revision, at, workspace, current.id);
        this.db
          .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
          .run(workspace, current.id, revision, encode(content), 'human', summary, at);
        this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
          workspace,
          `contribution:${current.id}:${revision}`,
          encode({
            operation: 'undo',
            baseRevision: current.revision,
            requestId: p.requestId,
            undoOf: p.targetRevision,
            location: structuredLocation(current.kind, current.content, content),
            dependencies: [
              { objectId: current.id, revision: p.targetRevision },
              { objectId: current.id, revision: current.revision },
            ],
          }),
        );
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(workspace, `undone:${current.id}:${p.targetRevision}`, encode(revision));
        this.event(workspace, 'object.undone', current.id, revision, 'human');
        return { objectId: current.id, revision, cursor: this.cursor(workspace) };
      });
    });
  },
  cancel(workspace, token, session, snapshotId) {
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      this.db
        .prepare(
          "UPDATE credentials SET status='cancelled' WHERE workspace=? AND owner=? AND kind IN ('execution','run-recovery')",
        )
        .run(workspace, snapshotId);
      this.event(workspace, 'task.cancelled', null, null, 'human');
      return { ok: true };
    });
  },
  recordDelivery(workspace, token, session, snapshotId, outcome) {
    this.auth(workspace, token, session, 'panel');
    if (
      !this.db
        .prepare('SELECT id FROM snapshots WHERE id=? AND workspace=?')
        .get(snapshotId, workspace)
    )
      fail('NOT_FOUND', '选区不存在。');
    this.event(workspace, `selection.${outcome}`, null, null, 'host-ack');
    return { ok: true };
  },
};
