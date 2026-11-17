import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  lstatSync,
  realpathSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freePosition, type Rect } from '../../components/canvas-spatial.js';
import { fail, type DesktopObject, type GeneratedSource } from '../../contracts/index.js';
import { GeneratedFileLinks } from './generated-file-links.js';
import type { GeneratedControl } from '../../contracts/generated-control.js';
import type { z } from 'zod';

type OutputFile = {
  path: string;
  hash: string;
  requestId: string;
  bounds: Rect;
  objectId?: string;
  revision?: number;
  size: number;
  result?: 'created' | 'updated';
  anchorSourceId?: string;
  external?: boolean;
  directory?: string;
};
type Baseline = { objectId: string; revision: number; hash: string };
export type OutputBatch = {
  id: string;
  workspaceId: string;
  owner: string;
  threadId: string;
  turnId?: string;
  title: string;
  taskName?: string;
  workspaceDirectory?: string;
  directory: string;
  createdAt: string;
  updatedAt: string;
  state: 'running' | 'ready' | 'partial' | 'interrupted';
  view?: Rect;
  sourceIds: string[];
  sources?: GeneratedSource['sources'];
  files: OutputFile[];
  issues: { path: string; message: string }[];
  startCursor?: number;
  endCursor?: number;
  baseline?: Record<string, Baseline>;
};
type API = {
  objects: (workspace: string) => DesktopObject[];
  obstacles: (workspace: string) => Rect[];
  receipt: (workspace: string, request: string) => DesktopObject | undefined;
  save: (batch: OutputBatch, file: OutputFile, bytes: Buffer) => DesktopObject;
  changed: (workspace: string, object: DesktopObject) => void;
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const safePart = (value: string) => {
  const name =
    Array.from(
      value
        .split(/[\r\n]/)[0]
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, 48)
      .join('')
      .replace(/[. ]+$/g, '') || '任务';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `任务 ${name}` : name;
};
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
};
const ignored = new Set(['_work', '.git', 'node_modules', '__pycache__', '.venv', '.cache']);
type OutputTask = {
  id: string;
  owner: string;
  name: string;
  directory: string;
  workspaceDirectory: string;
};
/** Only the app-owned output directory is collected. Never follow links into arbitrary files. */
export class GeneratedFiles {
  constructor(
    private db: DatabaseSync,
    private root: string,
    private api: API,
    private links: GeneratedFileLinks,
  ) {}
  private put(batch: OutputBatch) {
    batch.updatedAt = new Date().toISOString();
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(batch.workspaceId, `generated:${batch.id}`, JSON.stringify(batch));
    return batch;
  }
  private cursor(workspace: string) {
    return Number(
      (
        this.db
          .prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE workspace=?')
          .get(workspace) as { seq: number }
      ).seq,
    );
  }
  list(owner: string, threadId?: string): OutputBatch[] {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key LIKE 'generated:%'").all() as {
        value: string;
      }[]
    )
      .map((row) => JSON.parse(row.value) as OutputBatch)
      .filter((batch) => batch.owner === owner && (!threadId || batch.threadId === threadId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }
  get(owner: string, id: string) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(`generated:${id}`) as
      | { value: string }
      | undefined;
    const batch = row ? (JSON.parse(row.value) as OutputBatch) : null;
    if (!batch || batch.owner !== owner) fail('NOT_FOUND', '产出记录不存在。');
    return batch;
  }
  visible(batch: OutputBatch, availableIds?: Set<string>): OutputBatch {
    const available =
      availableIds ??
      new Set(
        this.api
          .objects(batch.workspaceId)
          .filter((object) => !object.policy?.private)
          .map((object) => object.id),
      );
    const inactive = (path: string) => {
      const id =
        batch.files.find((file) => file.path === path)?.objectId ??
        this.links.find(batch.workspaceId, resolve(batch.directory, path))?.objectId;
      return !!id && !available.has(id);
    };
    const issues = batch.issues.filter(
      (issue) => !inactive(issue.path) && !issue.message.startsWith('原卡片已删除；'),
    );
    return {
      ...batch,
      files: batch.files.filter((file) => !file.objectId || available.has(file.objectId)),
      sources: (batch.sources || []).filter((source) => available.has(source.id)),
      sourceIds: batch.sourceIds.filter((id) => available.has(id)),
      baseline: Object.fromEntries(
        Object.entries(batch.baseline || {}).filter(([, file]) => available.has(file.objectId)),
      ),
      issues,
      state: batch.state === 'partial' && !issues.length ? 'ready' : batch.state,
    };
  }
  private read<T>(workspace: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(workspace, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  private write(workspace: string, key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(workspace, key, JSON.stringify(value));
  }
  private createTask(owner: string, workspace: string, title: string): OutputTask {
    const workspaceDirectory =
        this.read<string>(workspace, 'generated-workspace-root') || join(this.root, workspace),
      parent = join(workspaceDirectory, 'AI产出');
    mkdirSync(parent, { recursive: true });
    const name = safePart(title);
    for (let suffix = 0; suffix < 1000; suffix++) {
      const directory = join(parent, `${name}${suffix ? ` (${suffix + 1})` : ''}`);
      try {
        mkdirSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      const task = { id: randomUUID(), owner, name, directory, workspaceDirectory };
      this.write(workspace, `generated-task-definition:${task.id}`, task);
      return task;
    }
    throw Error('同名任务过多，请整理工作区目录');
  }
  control(owner: string, workspace: string, p: z.infer<typeof GeneratedControl>) {
    const key = p.threadId ? `generated-task:${p.threadId}` : 'generated-task:pending',
      selected = this.read<OutputTask>(workspace, key);
    if (p.operation === 'root_set') {
      if (!p.path || !isAbsolute(p.path)) throw Error('请选择绝对保存目录');
      mkdirSync(p.path, { recursive: true });
      const path = realpathSync(p.path);
      this.write(workspace, 'generated-workspace-root', path);
      this.write(workspace, 'generated-roots', [
        ...new Set([...(this.read<string[]>(workspace, 'generated-roots') || []), path]),
      ]);
    } else if (p.operation === 'task_create') {
      if (!p.name) throw Error('请输入任务名称');
      const task = this.createTask(owner, workspace, p.name);
      this.write(workspace, key, task);
    } else if (p.operation === 'task_select' || p.operation === 'task_rename') {
      const task = p.taskId
        ? this.read<OutputTask>(workspace, `generated-task-definition:${p.taskId}`)
        : undefined;
      if (!task || task.owner !== owner) throw Error('任务不存在');
      if (p.operation === 'task_select') {
        this.write(workspace, key, task);
      } else {
        if (!p.name) throw Error('请输入任务名称');
        task.name = p.name;
        this.write(workspace, `generated-task-definition:${task.id}`, task);
        const pointers = this.db
          .prepare(
            "SELECT key,value FROM settings WHERE workspace=? AND key LIKE 'generated-task:%'",
          )
          .all(workspace) as { key: string; value: string }[];
        for (const pointer of pointers)
          if (JSON.parse(pointer.value).id === task.id) this.write(workspace, pointer.key, task);
      }
    }
    const tasks = (
      this.db
        .prepare(
          "SELECT value FROM settings WHERE workspace=? AND key LIKE 'generated-task-definition:%'",
        )
        .all(workspace) as { value: string }[]
    )
      .map((row) => JSON.parse(row.value) as OutputTask)
      .filter((task) => task.owner === owner);
    return {
      workspaceId: workspace,
      tasks,
      activeTaskId: this.read<OutputTask>(workspace, key)?.id,
      workspaceDirectory:
        this.read<string>(workspace, 'generated-workspace-root') || join(this.root, workspace),
    };
  }
  begin(
    owner: string,
    workspaceId: string,
    threadId: string,
    title: string,
    view?: Rect,
    sourceIds: string[] = [],
  ) {
    this.links.flush(workspaceId);
    const id = randomUUID(),
      at = new Date().toISOString(),
      key = `generated-task:${threadId}`;
    let task: OutputTask;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
        .get(workspaceId, key) as { value: string } | undefined;
      if (row) {
        task = JSON.parse(row.value);
        if (task.owner !== owner) fail('SESSION_MISMATCH', '任务目录属于另一桌面。');
      } else {
        const chosen = this.read<OutputTask>(workspaceId, 'generated-task:pending');
        task = chosen?.owner === owner ? chosen : this.createTask(owner, workspaceId, title);
        if (chosen?.owner === owner)
          this.db
            .prepare("DELETE FROM settings WHERE workspace=? AND key='generated-task:pending'")
            .run(workspaceId);
      }
      task.id ??= randomUUID();
      task.workspaceDirectory ??= dirname(dirname(task.directory));
      this.write(workspaceId, key, task);
      this.write(workspaceId, `generated-task-definition:${task.id}`, task);
      const target = this.read<string>(workspaceId, `generated-target-thread:${threadId}`);
      if (target) this.write(workspaceId, `generated-target:${id}`, target);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const taskInfo = lstatSync(task.directory);
    if (
      !taskInfo.isDirectory() ||
      taskInfo.isSymbolicLink() ||
      !this.links.allowed(workspaceId, join(task.directory, '_work'))
    )
      fail('INVALID_OUTPUT', '任务目录已移动或成为外部链接，请恢复原文件夹。');
    mkdirSync(join(task.directory, '_work'), { recursive: true });
    const objects = this.api.objects(workspaceId),
      baseline: Record<string, Baseline> = {};
    for (const object of objects) {
      const link = this.links.link(workspaceId, object.id);
      if (link && inside(resolve(task.directory), resolve(link.path)))
        baseline[relative(task.directory, link.path).replace(/\\/g, '/')] = {
          objectId: object.id,
          revision: object.revision,
          hash: (object.content as { assetHash: string }).assetHash,
        };
    }
    const sources = objects
      .filter((object) => sourceIds.includes(object.id) && !object.policy?.private)
      .map((object) => ({ id: object.id, title: object.title, revision: object.revision }));
    return this.put({
      id,
      workspaceId,
      owner,
      threadId,
      title: title.slice(0, 120),
      taskName: task.name,
      workspaceDirectory: task.workspaceDirectory,
      directory: task.directory,
      createdAt: at,
      updatedAt: at,
      state: 'running',
      view,
      sourceIds: sources.map((source) => source.id),
      sources,
      files: [],
      issues: [],
      baseline,
      startCursor: this.cursor(workspaceId),
    });
  }
  bind(owner: string, id: string, turnId: string) {
    const batch = this.get(owner, id);
    if (batch.turnId && batch.turnId !== turnId) fail('TURN_MISMATCH', '产出已经关联另一回合。');
    batch.turnId = turnId;
    return this.put(batch);
  }
  collect(owner: string, id: string, interrupted = false, view?: Rect) {
    const batch = this.get(owner, id);
    batch.issues = [];
    if (
      this.list(owner, batch.threadId).some(
        (other) => other.directory === batch.directory && other.createdAt > batch.createdAt,
      )
    )
      fail('OUTPUT_SUPERSEDED', '此任务已有更新回合，请在最新产出卡片中继续收回。');
    if (view) batch.view = view;
    this.links.flush(batch.workspaceId, true);
    const managed = this.db
      .prepare('SELECT task_id,id FROM work_runs WHERE workspace=? AND thread_id=? AND turn_id=?')
      .get(batch.workspaceId, batch.threadId, batch.turnId || '') as any;
    if (managed) {
      const row = this.db
        .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
        .get(batch.workspaceId, 'prototype-task:' + managed.task_id) as any;
      const m = JSON.parse(row.value).management,
        r = m.runs.find((r: any) => r.id === managed.id);
      if (r.generation !== m.generation) {
        batch.state = 'interrupted';
        batch.issues = [
          { path: '', message: '要求已经修订，旧执行文件留在原目录，不覆盖当前成果。' },
        ];
        return this.put(batch);
      }
    }
    const events = managed
      ? (this.db
          .prepare(
            'SELECT object_id,type,revision FROM work_artifact_receipts WHERE workspace=? AND run_id=?',
          )
          .all(batch.workspaceId, managed.id) as {
          object_id: string;
          type: string;
          revision: number;
        }[])
      : batch.startCursor === undefined
        ? []
        : (this.db
            .prepare(
              "SELECT object_id,type,revision FROM events WHERE workspace=? AND actor='ai' AND seq>? AND seq<=? AND object_id IS NOT NULL",
            )
            .all(
              batch.workspaceId,
              batch.startCursor,
              batch.endCursor ?? this.cursor(batch.workspaceId),
            ) as { object_id: string; type: string; revision: number }[]);
    batch.endCursor ??= this.cursor(batch.workspaceId);
    const sourceObjects = this.api.objects(batch.workspaceId),
      sourceIds = new Set([
        ...batch.sourceIds,
        ...events
          .filter((event) => ['object.read', 'object.referenced'].includes(event.type))
          .map((event) => event.object_id),
      ]);
    const changedIds = new Set(
        events
          .filter((event) => ['object.changed', 'object.created'].includes(event.type))
          .map((event) => event.object_id),
      ),
      createdIds = new Set(
        events.filter((event) => event.type === 'object.created').map((event) => event.object_id),
      );
    batch.sources = [...(batch.sources ?? [])].filter((source) =>
      sourceObjects.some((object) => object.id === source.id && !object.policy?.private),
    );
    for (const object of sourceObjects.filter(
      (object) => sourceIds.has(object.id) && !object.policy?.private,
    ))
      if (!batch.sources.some((source) => source.id === object.id))
        batch.sources.push({ id: object.id, title: object.title, revision: object.revision });
    batch.sources = batch.sources.slice(0, 50);
    batch.sourceIds = batch.sources.map((source) => source.id);
    this.put(batch);
    const root = resolve(batch.directory),
      rootInfo = lstatSync(root);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      !this.links.allowed(batch.workspaceId, join(root, '_work'))
    )
      fail('INVALID_OUTPUT', '产出目录已被移动或替换为链接。');
    const activeIds = new Set(sourceObjects.map((object) => object.id));
    const intentionallyRemoved = (path: string, absolute: string) => {
      const objectId =
        batch.files.find((file) => file.path === path && !file.external)?.objectId ??
        this.links.find(batch.workspaceId, absolute)?.objectId;
      return !!objectId && !activeIds.has(objectId);
    };
    const files: { path: string; absolute: string }[] = [];
    let visited = 0;
    const walk = (folder: string, depth: number) => {
      if (depth > 12) {
        batch.issues.push({
          path: relative(root, folder),
          message: '目录层级超过 12 层，文件保留在原目录。',
        });
        return;
      }
      for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (ignored.has(entry.name) || entry.name.startsWith('.') || entry.name.startsWith('~$'))
          continue;
        if (++visited > 2000) {
          batch.issues.push({ path: '', message: '目录项目过多，请整理后重试收回。' });
          return;
        }
        const absolute = join(folder, entry.name),
          path = relative(root, absolute).replace(/\\/g, '/');
        if (entry.isSymbolicLink()) {
          batch.issues.push({ path, message: '未收取链接文件。' });
          continue;
        }
        if (entry.isDirectory()) {
          if (!inside(root, realpathSync(absolute)))
            batch.issues.push({ path, message: '目录链接不在产出范围内。' });
          else walk(absolute, depth + 1);
        } else if (entry.isFile() && !intentionallyRemoved(path, absolute))
          files.push({ path, absolute });
      }
    };
    walk(root, 0);
    if (files.length > 64)
      batch.issues.push({ path: '', message: '每次收回最多 64 份文件，其余保留在文件夹中。' });
    let total = 0;
    for (const entry of files.slice(0, 64))
      try {
        if (
          basename(entry.path).length > 120 ||
          entry.path.length > 1024 ||
          entry.path.split('/').some((part) => part.length > 120)
        )
          throw Error('文件名或相对路径过长。');
        const info = lstatSync(entry.absolute);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          !inside(root, realpathSync(entry.absolute))
        )
          throw Error('文件必须是产出目录内的普通文件。');
        if (info.size > 50 * 1024 * 1024 || total + info.size > 256 * 1024 * 1024)
          throw Error('文件超过 50 MiB 或本次总量超过 256 MiB，已保留在原目录。');
        total += info.size;
        const fd = openSync(entry.absolute, 'r');
        let bytes: Buffer;
        try {
          const before = fstatSync(fd);
          if (
            before.ino !== info.ino ||
            before.dev !== info.dev ||
            before.size !== info.size ||
            before.nlink !== 1
          )
            throw Error('文件正在替换，请稍后重试。');
          bytes = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count) break;
            offset += count;
          }
          const after = fstatSync(fd);
          if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            offset !== after.size ||
            readSync(fd, Buffer.alloc(1), 0, 1, offset) > 0
          )
            throw Error('文件仍在写入，请稍后重试。');
        } finally {
          closeSync(fd);
        }
        const hash = digest(bytes);
        let file = batch.files.find((file) => !file.external && file.path === entry.path);
        // Recover a committed import if the app closed before recording its object id.
        if (file && file.requestId) {
          const saved = this.api.receipt(batch.workspaceId, file.requestId);
          if (saved) {
            file.objectId = saved.id;
            file.revision = saved.revision;
            file.hash = (saved.content as { assetHash: string }).assetHash;
            file.size = (saved.content as { size: number }).size;
          }
        }
        const link = this.links.find(batch.workspaceId, entry.absolute),
          objects = this.api.objects(batch.workspaceId);
        const matching = objects.filter(
          (object) =>
            changedIds.has(object.id) &&
            object.kind === 'file' &&
            (object.content as { fileName: string; assetHash: string }).fileName ===
              basename(entry.path) &&
            (object.content as { assetHash: string }).assetHash === hash &&
            (!this.links.link(batch.workspaceId, object.id) ||
              (sourceIds.has(object.id) && events.some((event) =>
                event.object_id === object.id && event.type === 'object.changed' &&
                event.revision === object.revision))),
        );
        const existingId =
            file?.objectId ??
            link?.objectId ??
            (matching.length === 1 ? matching[0].id : undefined),
          existing = objects.find((object) => object.id === existingId);
        if (existingId && !existing) continue; // A deleted card is an intentional exclusion, not a failed import.
        if (
          existing &&
          (existing.policy?.private ||
            existing.policy?.locked ||
            existing.policy?.protectedRanges.length)
        )
          throw Error('原卡片受到保护，未自动更新。');
        const baseline = batch.baseline?.[entry.path];
        if (!file && batch.files.filter((item) => item.objectId && item.hash).length >= 64)
          throw Error('本批次最多关联 64 份结果，其余文件保留在任务目录。');
        if (existing && (existing.content as { assetHash: string }).assetHash === hash) {
          // A committed source edit can also leave a working copy in the output
          // directory. Reuse its receipt, without replacing the original file link.
          const originalLink = this.links.link(batch.workspaceId, existing.id);
          const samePath = !originalLink || resolve(originalLink.path) === resolve(entry.absolute);
          if (samePath) {
            this.links.bind(batch.workspaceId, existing.id, entry.absolute, hash);
            this.links.accept(batch.workspaceId, existing.id, hash);
          }
          if (file) {
            file.hash = hash;
            file.revision = existing.revision;
            file.size = bytes.length;
            this.remember(batch, file, existing, samePath ? entry.absolute : undefined);
          } else if (!baseline || baseline.hash !== hash) {
            file = {
              path: entry.path,
              hash,
              requestId: '',
              bounds: existing.bounds,
              objectId: existing.id,
              revision: existing.revision,
              size: bytes.length,
              result: createdIds.has(existing.id) ? 'created' : 'updated',
              directory: dirname(entry.absolute),
            };
            batch.files.push(file);
            this.remember(batch, file, existing, samePath ? entry.absolute : undefined);
          }
          continue;
        }
        if (existing) {
          const conflict = this.links.conflict(batch.workspaceId, existing.id);
          if (conflict) throw Error(`${conflict} 请先在桌面保存合并后的版本。`);
        }
        if (!file) {
          const occupied = [
            ...objects.map((object) => ({ ...object.bounds, height: object.bounds.height + 44 })),
            ...this.api.obstacles(batch.workspaceId),
          ];
          const source = objects
            .filter((object) => batch.sourceIds.includes(object.id))
            .sort(
              (a, b) => this.distance(a.bounds, batch.view) - this.distance(b.bounds, batch.view),
            )[0];
          file = {
            path: entry.path,
            hash: '',
            requestId: '',
            size: bytes.length,
            result: existing ? 'updated' : 'created',
            directory: dirname(entry.absolute),
            ...(!existing && source ? { anchorSourceId: source.id } : {}),
            ...(existing
              ? { objectId: existing.id, revision: baseline?.revision ?? existing.revision }
              : {}),
            bounds:
              existing?.bounds ??
              freePosition({ width: 400, height: 290 }, occupied, batch.view, source?.bounds),
          };
          batch.files.push(file);
        }
        file.requestId = `generated-${batch.id}-${digest(entry.path).slice(0, 16)}-${hash.slice(0, 20)}-${file.revision ?? 0}`;
        this.put(batch); // Keep placement stable across retries, before the object transaction.
        const saved = this.api.save(batch, file, bytes);
        file.objectId = saved.id;
        file.revision = saved.revision;
        file.hash = hash;
        file.size = bytes.length;
        this.remember(batch, file, saved, entry.absolute);
      } catch (error) {
        batch.issues.push({
          path: entry.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    // Native-file tools already committed these changes. Surface the same object in chat.
    for (const object of this.api.objects(batch.workspaceId))
      if (
        changedIds.has(object.id) &&
        object.kind === 'file' &&
        !object.policy?.private &&
        !batch.files.some((file) => file.objectId === object.id)
      ) {
        const content = object.content as { fileName: string; assetHash: string; size: number };
        try {
          if (
            batch.files.filter((file) => file.objectId && file.hash).length >= 64 ||
            content.size > 50 * 1024 * 1024 ||
            total + content.size > 256 * 1024 * 1024
          )
            throw Error('本次文件数量或大小达到收回上限，原对象版本已保留。');
          total += content.size;
          const path = this.links.materialize(
              batch.workspaceId,
              object.id,
              batch.directory,
              content.fileName,
              content.assetHash,
            ),
            inTask = inside(root, resolve(path));
          const file: OutputFile = {
            path: inTask ? relative(root, path).replace(/\\/g, '/') : content.fileName,
            hash: content.assetHash,
            size: content.size,
            requestId: '',
            bounds: object.bounds,
            objectId: object.id,
            revision: object.revision,
            result: createdIds.has(object.id) ? 'created' : 'updated',
            external: !inTask,
            directory: dirname(path),
          };
          batch.files.push(file);
          this.remember(batch, file, object, inTask ? path : undefined);
        } catch (error) {
          batch.issues.push({
            path: content.fileName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    for (const file of batch.files)
      if (file.objectId && activeIds.has(file.objectId)) {
        const error = this.links.source(batch.workspaceId, file.objectId)?.syncError;
        if (error) batch.issues.push({ path: file.path, message: error });
      }
    batch.state = batch.issues.length ? 'partial' : interrupted ? 'interrupted' : 'ready';
    return this.put(batch);
  }
  private distance(bounds: Rect, view?: Rect) {
    return view
      ? Math.hypot(
          bounds.x + bounds.width / 2 - view.x - view.width / 2,
          bounds.y + bounds.height / 2 - view.y - view.height / 2,
        )
      : 0;
  }
  private remember(batch: OutputBatch, file: OutputFile, object: DesktopObject, path?: string) {
    if (path && !this.links.link(batch.workspaceId, object.id))
      this.links.bind(batch.workspaceId, object.id, path, file.hash);
    const source: GeneratedSource = {
      batchId: batch.id,
      taskName: batch.taskName ?? batch.title,
      request: batch.title,
      anchorSourceId: file.anchorSourceId,
      action: file.result ?? 'created',
      sources: (batch.sources ?? []).filter((source) => source.id !== object.id),
      relativePath: path
        ? `AI产出/${batch.taskName ?? basename(batch.directory)}/${file.path}`
        : this.links.source(batch.workspaceId, object.id)?.relativePath,
    };
    this.links.provenance(batch.workspaceId, object.id, source);
    this.api.changed(batch.workspaceId, object);
    this.put(batch);
  }
}
