import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  linkSync,
  lstatSync,
  realpathSync,
  readdirSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  constants,
  rmSync,
} from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { z } from 'zod';
import { Id, fail, type WorkspaceSummary } from '../../contracts/index.js';
import { CanvasBoardSchema } from '../../contracts/canvas-board.js';
import {
  WorkflowDocumentSchema,
  WORKFLOW_BYTE_LIMIT,
  safeWorkflowPath,
} from '../../contracts/workflows.js';
import { WorkflowComponentSchema } from '../../contracts/workflow-composites.js';
import { WebProjectSchema } from '../../contracts/web-projects.js';
import type { CommentThread } from '../../contracts/comments.js';
import { requireWorkspaceSlot } from '../workspace/workspace-capacity.js';

const BackupId = z.string().regex(/^backup_[0-9a-f-]{36}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const FileEntry = z
  .object({
    path: z
      .string()
      .regex(
        /^(desktop\.sqlite|assets\/[a-f0-9]{64}|exports\/artifact_[0-9a-f-]{36}\.(pptx|xlsx|svg|png))$/,
      ),
    sha256: Hash,
    bytes: z.number().int().nonnegative(),
  })
  .strict();
const Manifest = z
  .object({
    format: z.literal('ai-desktop-workspace-backup'),
    version: z.literal(1),
    id: BackupId,
    schema: z.literal(6),
    createdAt: z.string(),
    label: z.string().max(80),
    workspace: z
      .object({
        id: Id,
        name: z.string(),
        objects: z.number().int(),
        revisions: z.number().int(),
        drafts: z.number().int(),
        tasks: z.number().int(),
        artifacts: z.number().int(),
      })
      .strict(),
    files: z.array(FileEntry).min(1).max(5000),
  })
  .strict();
export type BackupManifest = z.infer<typeof Manifest>;
export type BackupSummary = Omit<BackupManifest, 'files'> & {
  path: string;
  bytes: number;
  files: number;
};
type Api = {
  auth: (workspace: string, credential: string, session: string | null, kind: 'panel') => unknown;
  tx: <T>(fn: () => T) => T;
  once: <T>(workspace: string, request: string, payload: unknown, fn: () => T) => T;
  event: (
    workspace: string,
    type: string,
    objectId: string | null,
    revision: number | null,
    actor: string,
  ) => void;
  payloadHash: (input: unknown) => string;
};
// Dispatch payloads contain one-shot execution grants. Installation/prepare receipts
// are local work in progress, never transferable into a restored workspace.
const excludedSetting = (key: string) =>
  /^bot-(?:policy|certificate:|context-version:|capacity-resolution:|owner:|schema-disabled:|migration-freeze:|incident-freeze:|choice:)/.test(
    key,
  ) ||
  /^(generated[-:]|web-task-create:|web-task-payload:|web-task-binding:|web-task-report:|web-materialize:|workflow-desktop:|workflow-install:|workflow-source-copy:|workflow-prepare:|workflow-batch-prepare:|workflow-batch-install:|workflow-batch-pending:|workflow-dispatch:|workflow-dispatch-payload:|comment-payload:|comment-binding:|workflow-binding:|workflow-recovery:|workflow-python:|network-resources$|directory-connections$|directory-links$|editor-lease:|native-reference:|native-command:|native-edit-command:|native-dispatch:|native-execution-refs:|native-usage:|native-binding:|native-invitation:|execution-ranges:|annotation-active:|artifact-intent:|backup-create:|runtime:|local-run:|native-file:)/.test(
    key,
  );
function commentHistoryOnly(thread: CommentThread): CommentThread {
  return {
    ...thread,
    dispatches: thread.dispatches.map((dispatch) => {
      const history = { ...dispatch, session: '' };
      delete history.snapshotId;
      return history;
    }),
  };
}
function webTaskHistoryOnly(task: any) {
  return {
    ...task,
    session: '',
    dispatches: [],
    restoredAt: task.restoredAt ?? new Date().toISOString(),
    ...(!['completed', 'failed'].includes(task.status)
      ? { status: 'failed', summary: '从备份恢复的 Web 历史；浏览器会话与执行授权未恢复。' }
      : {}),
  };
}
const stamp = () => new Date().toISOString();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const flush = (path: string) => {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
function safePath(root: string, name: string) {
  const base = realpathSync(root),
    target = resolve(base, name),
    rel = relative(base, target);
  if (
    !rel ||
    rel.startsWith(`..${sep}`) ||
    rel === '..' ||
    resolve(target) === base ||
    rel.includes(':')
  )
    fail('INVALID_PATH', '备份路径不在私有目录内。');
  let cursor = base;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      fail('INVALID_PATH', '备份路径不能经过链接。');
  }
  return target;
}
async function fileHash(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_BACKUP', '备份文件类型不正确。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), bytes: stat.size };
}
function openSnapshot(path: string, readOnly = true) {
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
  const schema = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (schema !== 6) {
    db.close();
    fail('BACKUP_SCHEMA', '此备份需要兼容的数据版本，当前恢复器支持 schema 6。');
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view')").get()) {
    db.close();
    fail('INVALID_BACKUP', '备份包含不支持的数据库对象。');
  }
  return db;
}

export class WorkspaceBackups {
  readonly root: string;
  constructor(
    private db: DatabaseSync,
    private directory: string,
    private api: Api,
  ) {
    mkdirSync(join(directory, 'backups'), { recursive: true });
    this.root = realpathSync(join(directory, 'backups'));
  }
  policy(workspace: string, credential: string, session: string | null, input: any = {}) {
    this.api.auth(workspace, credential, session, 'panel');
    const row = this.db
      .prepare("SELECT value FROM settings WHERE workspace=? AND key='backup-policy'")
      .get(workspace) as { value: string } | undefined;
    const policy = row
      ? JSON.parse(row.value)
      : { enabled: true, minutes: 60, keep: 14, lastAt: 0, automaticIds: [] };
    if (input.command === 'save') {
      const changes = z
        .object({
          enabled: z.boolean(),
          minutes: z.number().int().min(15).max(1440),
          keep: z.number().int().min(3).max(90),
        })
        .parse(input);
      Object.assign(policy, changes);
      this.db
        .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
        .run(workspace, 'backup-policy', JSON.stringify(policy));
    }
    return policy;
  }
  async automatic(workspace: string, credential: string, session: string | null) {
    const policy = this.policy(workspace, credential, session);
    if (!policy.enabled || Date.now() - policy.lastAt < policy.minutes * 60000)
      return { skipped: true };
    const leases = this.db
      .prepare("SELECT value FROM settings WHERE workspace=? AND key LIKE 'editor-lease:%'")
      .all(workspace) as { value: string }[];
    if (
      leases.some((row) => {
        const lease = JSON.parse(row.value);
        return lease.dirty && lease.expires > Date.now();
      })
    )
      return { skipped: true, reason: '正在编辑' };
    const requestId = `auto-backup:${workspace}:${Math.floor(Date.now() / (policy.minutes * 60000))}`;
    const backup = await this.create(workspace, credential, session, {
      requestId,
      label: `自动备份 · ${new Date(Math.floor(Date.now() / (policy.minutes * 60000)) * policy.minutes * 60000).toLocaleString('zh-CN')}`,
    });
    const current = this.policy(workspace, credential, session);
    current.lastAt = Date.now();
    current.automaticIds = [
      backup.id,
      ...(current.automaticIds || []).filter((id: string) => id !== backup.id),
    ];
    const issues: string[] = [];
    for (const id of current.automaticIds.slice(current.keep))
      try {
        const info = await this.validate(workspace, id);
        if (
          info.manifest.workspace.id !== workspace ||
          !info.manifest.label.startsWith('自动备份 ·')
        )
          continue;
        // Only verified, app-created automatic backups under this private root can expire.
        const target = safePath(this.root, BackupId.parse(id)),
          rel = relative(this.root, realpathSync(target));
        if (!rel || rel.startsWith('..') || rel.includes(sep))
          fail('INVALID_PATH', '备份清理路径无效。');
        rmSync(target, { recursive: true, force: false });
        for (const row of this.db
          .prepare(
            "SELECT key,value FROM settings WHERE workspace=? AND key LIKE 'backup-create:%'",
          )
          .all(workspace) as { key: string; value: string }[])
          if (JSON.parse(row.value).id === id)
            this.db
              .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
              .run(workspace, row.key);
        current.automaticIds = current.automaticIds.filter((value: string) => value !== id);
      } catch (error) {
        issues.push(String(error));
      }
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(workspace, 'backup-policy', JSON.stringify(current));
    return { backup, issues };
  }
  async transfer(workspace: string, credential: string, session: string | null, input: any) {
    this.api.auth(workspace, credential, session, 'panel');
    const p = z
      .object({
        command: z.enum(['import', 'export']),
        path: z.string().min(1).max(4096),
        id: BackupId.optional(),
      })
      .parse(input);
    const root = realpathSync(p.path);
    if (!lstatSync(root).isDirectory()) fail('INVALID_BACKUP', '请选择备份文件夹。');
    if (p.command === 'export') {
      const info = await this.validate(workspace, BackupId.parse(p.id)),
        target = safePath(root, info.manifest.id);
      if (existsSync(target)) fail('BACKUP_EXISTS', '目标已存在同名备份，请选择另一个目录。');
      mkdirSync(target);
      for (const file of info.manifest.files) {
        const to = safePath(target, file.path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(safePath(info.folder, file.path), to, constants.COPYFILE_EXCL);
      }
      writeFileSync(safePath(target, 'manifest.json'), JSON.stringify(info.manifest, null, 2), {
        flag: 'wx',
      });
      return { path: target };
    }
    const manifestPath = safePath(root, 'manifest.json');
    if (lstatSync(manifestPath).size > 2 * 1024 * 1024) fail('INVALID_BACKUP', '备份清单过大。');
    const manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (manifest.files.reduce((sum, item) => sum + item.bytes, 0) > 4 * 1024 * 1024 * 1024)
      fail('BACKUP_LIMIT', '单个迁移备份最多 4 GiB。');
    const destination = safePath(this.root, manifest.id);
    if (existsSync(destination)) {
      await this.validate(workspace, manifest.id, sha(JSON.stringify(manifest, null, 2)));
      return this.summary(manifest);
    }
    const stage = safePath(this.root, `.import-${randomUUID()}`);
    mkdirSync(stage);
    for (const file of manifest.files) {
      const source = safePath(root, file.path),
        actual = await fileHash(source);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
        fail('BACKUP_DAMAGED', `迁移备份不完整：${file.path}`);
      const to = safePath(stage, file.path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(source, to, constants.COPYFILE_EXCL);
      const copied = await fileHash(to);
      if (copied.sha256 !== file.sha256) fail('BACKUP_CHANGED', '复制期间备份内容发生变化。');
    }
    writeFileSync(safePath(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      flag: 'wx',
    });
    this.api.auth(workspace, credential, session, 'panel');
    renameSync(stage, destination);
    await this.validate(workspace, manifest.id);
    return this.summary(manifest);
  }
  private read(id: string, workspace: string) {
    const folder = safePath(this.root, BackupId.parse(id)),
      path = safePath(folder, 'manifest.json');
    if (lstatSync(path).size > 2 * 1024 * 1024) fail('INVALID_BACKUP', '备份清单过大。');
    const raw = readFileSync(path),
      manifest = Manifest.parse(JSON.parse(raw.toString('utf8')));
    if (manifest.id !== id) fail('INVALID_BACKUP', '备份标识与文件夹不一致。');
    if (manifest.workspace.id !== workspace) {
      const original = this.db
        .prepare('SELECT session FROM workspaces WHERE id=?')
        .get(manifest.workspace.id) as { session: string | null } | undefined;
      if (original?.session) fail('PERMISSION_DENIED', '此备份的原工作区正由其他对话使用。');
    }
    if (
      new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length ||
      !manifest.files.some((file) => file.path === 'desktop.sqlite')
    )
      fail('INVALID_BACKUP', '备份文件清单不完整或包含重复路径。');
    return { manifest, folder, digest: sha(raw) };
  }
  private summary(manifest: BackupManifest): BackupSummary {
    const { files, ...metadata } = manifest;
    return {
      ...metadata,
      path: safePath(this.root, manifest.id),
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files: files.length,
    };
  }
  list(workspace: string, credential: string, session: string | null) {
    this.api.auth(workspace, credential, session, 'panel');
    const items: BackupSummary[] = [],
      unreadable: { id: string; label: string; createdAt: string }[] = [];
    const known = (
      this.db
        .prepare("SELECT value FROM settings WHERE workspace=? AND key LIKE 'backup-create:%'")
        .all(workspace) as { value: string }[]
    ).map((row) => JSON.parse(row.value));
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !BackupId.safeParse(entry.name).success) continue;
      try {
        const { manifest } = this.read(entry.name, workspace);
        items.push(this.summary(manifest));
      } catch {
        const own = known.find((job) => job.id === entry.name);
        if (own) unreadable.push({ id: own.id, label: own.label, createdAt: own.createdAt });
      }
    }
    for (const job of known)
      if (
        job.state === 'completed' &&
        !items.some((item) => item.id === job.id) &&
        !unreadable.some((item) => item.id === job.id)
      )
        unreadable.push({ id: job.id, label: job.label, createdAt: job.createdAt });
    const jobs = known
      .filter(
        (job) =>
          job.state !== 'completed' &&
          !items.some((item) => item.id === job.id) &&
          !unreadable.some((item) => item.id === job.id),
      )
      .map((job) => ({ id: job.id, state: job.state, createdAt: job.createdAt, label: job.label }));
    return {
      items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      jobs,
      unreadable,
    };
  }
  async create(workspace: string, credential: string, session: string | null, input: unknown) {
    const p = z
        .object({ requestId: Id, label: z.string().trim().max(80).default('') })
        .strict()
        .parse(input),
      intentKey = `backup-create:${sha(p.requestId)}`;
    const job = this.api.tx(() => {
      this.api.auth(workspace, credential, session, 'panel');
      const row = this.db
        .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
        .get(workspace, intentKey) as { value: string } | undefined;
      if (row) {
        const previous = JSON.parse(row.value);
        if (previous.label !== p.label) fail('REQUEST_ID_REUSED', '此请求已用于另一份备份。');
        if (existsSync(safePath(this.root, previous.id))) return previous;
        if (previous.state === 'creating') {
          let alive = false;
          try {
            process.kill(previous.pid, 0);
            alive = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') alive = true;
          }
          if (alive) fail('BACKUP_BUSY', '这次备份仍在创建，请稍后刷新结果。');
        }
      }
      const next = {
        id: row ? JSON.parse(row.value).id : `backup_${randomUUID()}`,
        label: p.label,
        createdAt: stamp(),
        state: 'creating',
        pid: process.pid,
      };
      this.db
        .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
        .run(workspace, intentKey, JSON.stringify(next));
      return next;
    });
    const destination = safePath(this.root, job.id);
    if (existsSync(destination)) {
      const ready = this.read(job.id, workspace);
      this.db
        .prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?')
        .run(JSON.stringify({ ...job, state: 'completed' }), workspace, intentKey);
      return this.summary(ready.manifest);
    }
    const stage = safePath(this.root, `.creating-${randomUUID()}`);
    mkdirSync(stage);
    // The raw database may contain other workspaces; never put it inside the published folder.
    const raw = safePath(this.root, `.snapshot-${randomUUID()}.sqlite`),
      snapshot = safePath(stage, 'desktop.sqlite');
    try {
      // SQLite produces a consistent snapshot even while other local processes edit.
      this.db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
      const copy = openSnapshot(raw, false);
      try {
        copy.exec('BEGIN IMMEDIATE');
        for (const table of [
          'objects',
          'events',
          'revisions',
          'snapshots',
          'drafts',
          'settings',
          'object_sources',
          'work_requests',
          'work_runs',
          'work_claims',
          'work_artifact_receipts',
          'work_consultations',
          'work_voice_coordinators',
          'bot_requests',
          'bot_effects',
          'bot_route_batches',
          'bot_slots',
          'bot_memories',
          'bot_incidents',
          'bot_migrations',
          'bot_audits',
        ])
          if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            copy.prepare(`DELETE FROM ${table} WHERE workspace<>?`).run(workspace);
        copy.prepare('DELETE FROM workspaces WHERE id<>?').run(workspace);
        copy.exec('DELETE FROM credentials; UPDATE workspaces SET session=NULL;');
        // Resolve known image commits before excluding transient credentials and receipts.
        for (const row of copy
          .prepare("SELECT key,value FROM settings WHERE key LIKE 'annotation-draft:%'")
          .all() as { key: string; value: string }[]) {
          const draft = JSON.parse(row.value);
          if (draft.pending) {
            const receipt = copy
              .prepare('SELECT payload_hash,result FROM receipts WHERE workspace=? AND request=?')
              .get(workspace, draft.pending.requestId) as
              | { payload_hash: string; result: string }
              | undefined;
            if (receipt?.payload_hash === draft.pending.payloadHash) {
              const change = JSON.parse(receipt!.result).changed?.find(
                (value: any) => value.objectId === draft.objectId,
              );
              if (change) {
                draft.state = 'saved';
                draft.savedRevision = change.revision;
                draft.pending = undefined;
                draft.version++;
              }
            }
            copy
              .prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?')
              .run(JSON.stringify(draft), workspace, row.key);
          }
        }
        for (const row of copy
          .prepare(
            "SELECT key,value FROM settings WHERE key LIKE 'native-editor-draft:%' OR key LIKE 'import-queue:item:%'",
          )
          .all() as { key: string; value: string }[]) {
          const value = JSON.parse(row.value);
          if (row.key.startsWith('native-editor-draft:')) {
            const data = value.kind === 'text' ? value.data.draft : value.data,
              pending = data?.pending;
            if (pending) {
              const receipt = copy
                .prepare('SELECT payload_hash FROM receipts WHERE workspace=? AND request=?')
                .get(workspace, pending.requestId) as { payload_hash: string } | undefined;
              const type =
                value.kind === 'text'
                  ? 'text-file.save'
                  : value.kind === 'xlsx'
                    ? 'xlsx.save'
                    : 'office.save';
              if (receipt?.payload_hash === this.api.payloadHash({ type, ...pending })) {
                copy
                  .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
                  .run(workspace, row.key);
                continue;
              }
            }
          } else {
            const receipt = copy
              .prepare('SELECT result FROM receipts WHERE workspace=? AND request=?')
              .get(workspace, value.requestId) as { result: string } | undefined;
            if (receipt) value.objectId = JSON.parse(receipt.result).id;
          }
          copy
            .prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?')
            .run(JSON.stringify(value), workspace, row.key);
        }
        const folders = copy
          .prepare("SELECT value FROM settings WHERE key='import-queue:folders'")
          .get() as { value: string } | undefined;
        if (
          folders &&
          copy
            .prepare('SELECT 1 FROM receipts WHERE workspace=? AND request=?')
            .get(workspace, JSON.parse(folders.value).requestId)
        )
          copy.prepare("DELETE FROM settings WHERE key='import-queue:folders'").run();
        for (const row of copy
          .prepare("SELECT key,value FROM settings WHERE key LIKE 'ocr-job:%'")
          .all() as { key: string; value: string }[]) {
          const value = JSON.parse(row.value);
          if (value.pending) {
            const receipt = copy
              .prepare('SELECT result FROM receipts WHERE workspace=? AND request=?')
              .get(workspace, value.pending.id) as { result: string } | undefined;
            if (receipt) {
              const result = JSON.parse(receipt.result);
              if (result.id && result.revision) {
                value.result = { id: result.id, revision: result.revision };
                delete value.pending;
                copy
                  .prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?')
                  .run(JSON.stringify(value), workspace, row.key);
              }
            }
          }
        }
        copy.exec('DELETE FROM receipts;');
        // Keep discussions, never preserve their active conversation or execution grant.
        for (const row of copy
          .prepare("SELECT key,value FROM settings WHERE key LIKE 'comment-thread:%'")
          .all() as { key: string; value: string }[])
          copy
            .prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?')
            .run(JSON.stringify(commentHistoryOnly(JSON.parse(row.value))), workspace, row.key);
        for (const row of copy.prepare('SELECT key FROM settings').all() as { key: string }[]) {
          if (row.key.startsWith('web-task:')) {
            const original = copy
              .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
              .get(workspace, row.key) as { value: string };
            copy
              .prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?')
              .run(
                JSON.stringify(webTaskHistoryOnly(JSON.parse(original.value))),
                workspace,
                row.key,
              );
          }
          if (excludedSetting(row.key))
            copy
              .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
              .run(workspace, row.key);
        }
        copy.exec('COMMIT');
        // A second VACUUM removes free pages containing other workspaces' data.
        copy.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      } finally {
        copy.close();
      }
      flush(snapshot);
      unlinkSync(raw);
      const source = openSnapshot(snapshot),
        files: BackupManifest['files'] = [];
      let manifest: BackupManifest;
      try {
        const workspaceRow = source.prepare('SELECT id,name FROM workspaces').get() as {
          id: string;
          name: string;
        };
        if (!workspaceRow || workspaceRow.id !== workspace) fail('NOT_FOUND', '工作区不存在。');
        const assets = new Set<string>();
        for (const row of source
          .prepare(
            "SELECT content FROM revisions WHERE object_id IN (SELECT id FROM objects WHERE kind IN ('image','file'))",
          )
          .all() as { content: string }[])
          assets.add(Hash.parse(JSON.parse(row.content).assetHash));
        for (const row of source.prepare('SELECT asset_hash FROM object_sources').all() as {
          asset_hash: string;
        }[])
          assets.add(Hash.parse(row.asset_hash));
        for (const row of source
          .prepare("SELECT value FROM settings WHERE key LIKE 'import-queue:item:%'")
          .all() as { value: string }[])
          assets.add(Hash.parse(JSON.parse(row.value).assetHash));
        for (const asset of assets) {
          mkdirSync(join(stage, 'assets'), { recursive: true });
          const from = safePath(this.directory, `assets/${asset}`),
            to = safePath(stage, `assets/${asset}`);
          copyFileSync(from, to, constants.COPYFILE_EXCL);
          flush(to);
          const info = await fileHash(to);
          if (info.sha256 !== asset) fail('ASSET_CORRUPT', '原始资产不完整，备份未发布。');
          files.push({ path: `assets/${asset}`, ...info });
        }
        const artifacts = source
          .prepare("SELECT value FROM settings WHERE key LIKE 'artifact:%'")
          .all() as { value: string }[];
        for (const row of artifacts) {
          const artifact = JSON.parse(row.value),
            entry = FileEntry.parse({
              path: `exports/${artifact.fileName}`,
              sha256: artifact.sha256,
              bytes: artifact.bytes,
            });
          mkdirSync(join(stage, 'exports'), { recursive: true });
          const to = safePath(stage, entry.path);
          copyFileSync(safePath(this.directory, entry.path), to, constants.COPYFILE_EXCL);
          flush(to);
          const info = await fileHash(to);
          if (info.sha256 !== entry.sha256 || info.bytes !== entry.bytes)
            fail('ARTIFACT_CORRUPT', '已登记产物缺失或改变，备份未发布。');
          files.push(entry);
        }
        files.unshift({ path: 'desktop.sqlite', ...(await fileHash(snapshot)) });
        const count = (table: string) =>
          Number((source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
        const settings = source.prepare('SELECT key,value FROM settings').all() as {
          key: string;
          value: string;
        }[];
        manifest = Manifest.parse({
          format: 'ai-desktop-workspace-backup',
          version: 1,
          id: job.id,
          schema: 6,
          createdAt: job.createdAt,
          label: p.label,
          workspace: {
            ...workspaceRow,
            objects: count('objects'),
            revisions: count('revisions'),
            drafts:
              Number(
                (
                  source
                    .prepare(
                      "SELECT COUNT(*) AS n FROM drafts WHERE object_id IN (SELECT id FROM objects WHERE kind<>'image')",
                    )
                    .get() as { n: number }
                ).n,
              ) +
              settings.filter(
                (row) =>
                  (row.key.startsWith('annotation-draft:') &&
                    JSON.parse(row.value).state === 'editing') ||
                  row.key.startsWith('native-editor-draft:'),
              ).length,
            tasks: settings.filter((row) => row.key.startsWith('prototype-task:')).length,
            artifacts: artifacts.length,
          },
          files,
        });
      } finally {
        source.close();
      }
      this.api.auth(workspace, credential, session, 'panel');
      const manifestPath = safePath(stage, 'manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
      flush(manifestPath);
      renameSync(stage, destination);
      this.api.tx(() => {
        this.db
          .prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?')
          .run(JSON.stringify({ ...job, state: 'completed' }), workspace, intentKey);
        this.api.event(workspace, 'backup.created', null, null, 'human');
      });
      return this.summary(manifest);
    } catch (error) {
      this.db
        .prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?')
        .run(
          JSON.stringify({ ...job, state: existsSync(destination) ? 'completed' : 'failed' }),
          workspace,
          intentKey,
        );
      // Incomplete private staging folders are kept for diagnosis, never listed as backups.
      throw error;
    }
  }
  private async validate(workspace: string, id: string, digest?: string) {
    const info = this.read(id, workspace);
    if (digest && info.digest !== digest) fail('BACKUP_CHANGED', '备份清单已变化，请重新预览。');
    for (const file of info.manifest.files) {
      const actual = await fileHash(safePath(info.folder, file.path));
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
        fail('BACKUP_DAMAGED', `备份文件缺失或改变：${file.path}`);
    }
    const source = openSnapshot(safePath(info.folder, 'desktop.sqlite'));
    try {
      const workspaces = source.prepare('SELECT id FROM workspaces').all() as { id: string }[];
      const origin = info.manifest.workspace.id;
      if (workspaces.length !== 1 || workspaces[0].id !== origin)
        fail('INVALID_BACKUP', '数据库与工作区备份清单不一致。');
      if (
        source.prepare('SELECT 1 FROM credentials').get() ||
        source.prepare('SELECT 1 FROM receipts').get()
      )
        fail('INVALID_BACKUP', '工作区备份不应包含执行凭据或请求回执。');
      for (const table of [
        'objects',
        'events',
        'revisions',
        'snapshots',
        'drafts',
        'settings',
        'object_sources',
      ])
        if (source.prepare(`SELECT 1 FROM ${table} WHERE workspace<>?`).get(origin))
          fail('INVALID_BACKUP', '备份混入了其他工作区数据。');
      const assets = new Set(
        info.manifest.files
          .filter((file) => file.path.startsWith('assets/') && file.path.slice(7) === file.sha256)
          .map((file) => file.sha256),
      );
      for (const row of source
        .prepare(
          "SELECT content FROM revisions WHERE object_id IN (SELECT id FROM objects WHERE kind IN ('image','file'))",
        )
        .all() as { content: string }[])
        if (!assets.has(JSON.parse(row.content).assetHash))
          fail('INVALID_BACKUP', '备份缺少历史版本引用的资产。');
      for (const row of source.prepare('SELECT asset_hash FROM object_sources').all() as {
        asset_hash: string;
      }[])
        if (!assets.has(row.asset_hash)) fail('INVALID_BACKUP', '备份缺少导入的原始文件。');
      for (const row of source
        .prepare("SELECT value FROM settings WHERE key LIKE 'import-queue:item:%'")
        .all() as { value: string }[])
        if (!assets.has(Hash.parse(JSON.parse(row.value).assetHash)))
          fail('INVALID_BACKUP', '备份缺少暂存导入文件。');
      for (const row of source
        .prepare("SELECT value FROM settings WHERE key LIKE 'artifact:%'")
        .all() as { value: string }[]) {
        const artifact = JSON.parse(row.value);
        if (
          !info.manifest.files.some(
            (file) =>
              file.path === `exports/${artifact.fileName}` &&
              file.sha256 === artifact.sha256 &&
              file.bytes === artifact.bytes,
          )
        )
          fail('INVALID_BACKUP', '备份缺少已登记产物。');
      }
    } finally {
      source.close();
    }
    return info;
  }
  async inspect(workspace: string, credential: string, session: string | null, input: unknown) {
    const p = z.object({ id: BackupId }).strict().parse(input);
    this.api.auth(workspace, credential, session, 'panel');
    const info = await this.validate(workspace, p.id),
      source = openSnapshot(safePath(info.folder, 'desktop.sqlite'));
    try {
      const objects = source
        .prepare('SELECT id,title,kind,revision FROM objects ORDER BY rowid')
        .all();
      this.api.auth(workspace, credential, session, 'panel');
      this.read(p.id, workspace);
      return { backup: this.summary(info.manifest), digest: info.digest, objects };
    } finally {
      source.close();
    }
  }
  private async installFile(from: string, name: string, expected: z.infer<typeof FileEntry>) {
    const target = safePath(this.directory, name);
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      const actual = await fileHash(target);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
        fail('FILE_CONFLICT', '恢复位置存在内容不同的文件，未覆盖。');
      return;
    }
    const temp = safePath(this.directory, `${name}.restoring-${randomUUID()}`);
    copyFileSync(from, temp, constants.COPYFILE_EXCL);
    try {
      flush(temp);
      const actual = await fileHash(temp);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
        fail('BACKUP_DAMAGED', '恢复复制期间文件发生变化。');
      try {
        linkSync(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await fileHash(target);
        if (existing.sha256 !== expected.sha256 || existing.bytes !== expected.bytes)
          fail('FILE_CONFLICT', '恢复位置出现不同文件，未覆盖。');
      }
    } finally {
      unlinkSync(temp);
    }
  }
  async restore(workspace: string, credential: string, session: string | null, input: unknown) {
    const p = z
      .object({ id: BackupId, digest: Hash, requestId: Id, name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(input);
    this.api.auth(workspace, credential, session, 'panel');
    const payload = { operation: 'backup.restore', ...p };
    const receipt = this.db
      .prepare('SELECT payload_hash,result FROM receipts WHERE workspace=? AND request=?')
      .get(workspace, p.requestId) as { payload_hash: string; result: string } | undefined;
    if (receipt) {
      if (receipt.payload_hash !== this.api.payloadHash(payload))
        fail('REQUEST_ID_REUSED', '此恢复请求已用于不同操作。');
      return JSON.parse(receipt.result) as WorkspaceSummary;
    }
    const info = await this.validate(workspace, p.id, p.digest);
    for (const file of info.manifest.files)
      if (file.path !== 'desktop.sqlite')
        await this.installFile(safePath(info.folder, file.path), file.path, file);
    const source = openSnapshot(safePath(info.folder, 'desktop.sqlite'));
    try {
      return this.api.tx(() => {
        this.api.auth(workspace, credential, session, 'panel');
        if (this.read(p.id, workspace).digest !== p.digest)
          fail('BACKUP_CHANGED', '备份清单已变化，请重新预览。');
        return this.api.once(workspace, p.requestId, payload, () =>
          this.copyWorkspace(source, info.manifest, p.name),
        );
      });
    } finally {
      source.close();
    }
  }
  private copyWorkspace(
    source: DatabaseSync,
    manifest: BackupManifest,
    name: string,
  ): WorkspaceSummary {
    requireWorkspaceSlot(this.db);
    const origin = manifest.workspace.id,
      workspace = `workspace_${randomUUID()}`,
      at = stamp();
    const objects = source.prepare('SELECT * FROM objects WHERE workspace=?').all(origin) as any[];
    const ids = new Map(objects.map((object) => [object.id, `object_${randomUUID()}`]));
    const objectId = (id: string) => {
      const value = ids.get(id);
      if (!value) fail('INVALID_BACKUP', '备份中的对象关联不完整。');
      return value;
    };
    const flowObjectId = (id: string) => ids.get(id) ?? id;
    const flowAssets = new Map<string, { assetHash: string; size: number }>();
    const definitionIds = new Set(
      objects
        .filter(
          (object) =>
            object.kind === 'file' &&
            /\.(flow|component|web-project)\.json$/i.test(
              JSON.parse(object.content).fileName ?? '',
            ),
        )
        .map((object) => object.id),
    );
    const remapFlowFile = (file: any, optionalHash = false) => {
      if (!file?.objectId) return file;
      const next = { ...file, objectId: flowObjectId(file.objectId) },
        asset = file.assetHash && flowAssets.get(file.assetHash);
      if (asset) {
        next.assetHash = asset.assetHash;
        if (Object.hasOwn(file, 'size')) next.size = asset.size;
      }
      // During native asset rewriting a referenced definition may be rewritten
      // later, or may refer back to this one. File-value hashes are optional;
      // discard stale digests instead of retaining an impossible cyclic hash.
      else if (optionalHash && definitionIds.has(file.objectId) && next.assetHash)
        delete next.assetHash;
      return next;
    };
    const remapFileSelection = (value: any): any =>
      typeof value === 'string'
        ? flowObjectId(value)
        : Array.isArray(value)
          ? value.map(remapFileSelection)
          : remapFlowFile(value, true);
    // Only explicit file-reference shapes are rewritten inside arbitrary JSON.
    // User text, dataset IDs, port names and graph-internal node IDs stay intact.
    const remapFileReferences = (value: any, depth = 0): any => {
      if (depth > 64) fail('INVALID_BACKUP', '流程数据嵌套过深，无法安全恢复文件关联。');
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map((item) => remapFileReferences(item, depth + 1));
      if (
        typeof value.objectId === 'string' &&
        Number.isInteger(value.revision) &&
        Object.keys(value).every((key) =>
          ['objectId', 'revision', 'fileName', 'assetHash'].includes(key),
        )
      )
        return remapFlowFile(value, true);
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, remapFileReferences(item, depth + 1)]),
      );
    };
    const remapFlowNode = (node: any) => {
      const next = {
        ...node,
        ...(node.origin
          ? { origin: { ...node.origin, objectId: flowObjectId(node.origin.objectId) } }
          : {}),
        config: {
          ...node.config,
          ...(node.config.objectIds ? { objectIds: node.config.objectIds.map(flowObjectId) } : {}),
          ...(node.config.targetObjectId
            ? { targetObjectId: flowObjectId(node.config.targetObjectId) }
            : {}),
          ...(node.config.codeObjectId
            ? { codeObjectId: flowObjectId(node.config.codeObjectId) }
            : {}),
          ...(node.config.requirementsObjectId
            ? { requirementsObjectId: flowObjectId(node.config.requirementsObjectId) }
            : {}),
        },
      };
      for (const container of ['parameters', 'arguments', 'value']) {
        if (next.config[container] !== undefined)
          next.config[container] = remapFileReferences(next.config[container]);
      }
      for (const [name, schema] of Object.entries(node.config.parameterSchema ?? {}) as [
        string,
        { type: string },
      ][]) {
        if (!['file', 'files'].includes(schema.type)) continue;
        for (const container of ['parameters', 'arguments'])
          if (next.config[container] && Object.hasOwn(next.config[container], name))
            Object.defineProperty(next.config[container], name, {
              value: remapFileSelection(next.config[container][name]),
              enumerable: true,
              writable: true,
              configurable: true,
            });
      }
      return next;
    };
    const remapWidgetFile = (node: any, field: { target: string; path?: string }) => {
      // A file input widget stores its selection in objectIds, already handled above.
      if (
        field.target === 'value' &&
        node.type === 'input' &&
        (node.config.inputMode ?? 'files') === 'files'
      )
        return;
      if (!field.path) {
        if (node.config[field.target] !== undefined)
          node.config[field.target] = remapFileSelection(node.config[field.target]);
        return;
      }
      if (!safeWorkflowPath(field.path)) return;
      const parts = field.path.split('.');
      let container = node.config[field.target];
      for (const part of parts.slice(0, -1)) {
        if (!container || typeof container !== 'object' || !Object.hasOwn(container, part)) return;
        container = container[part];
      }
      const leaf = parts.at(-1)!;
      if (container && typeof container === 'object' && Object.hasOwn(container, leaf))
        Object.defineProperty(container, leaf, {
          value: remapFileSelection(container[leaf]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    };
    const remapFlow = (value: unknown) => {
      const parsed = WorkflowDocumentSchema.safeParse(value);
      if (!parsed.success) return value;
      const next = { ...parsed.data, nodes: parsed.data.nodes.map(remapFlowNode) };
      for (const field of parsed.data.widget?.fields ?? [])
        if (field.type === 'file' || field.type === 'files') {
          const node = next.nodes.find((node) => node.id === field.nodeId);
          if (node) remapWidgetFile(node, field);
        }
      return next;
    };
    const remapFlowContent = (raw: string) => {
      let content: any;
      try {
        content = JSON.parse(raw);
      } catch {
        return raw;
      }
      if (
        !/\.(flow|component|web-project)\.json$/i.test(content.fileName ?? '') ||
        typeof content.assetHash !== 'string' ||
        content.size > WORKFLOW_BYTE_LIMIT
      )
        return raw;
      let replacement = flowAssets.get(content.assetHash);
      if (!replacement) {
        const bytes = readFileSync(
          safePath(this.directory, `assets/${Hash.parse(content.assetHash)}`),
        );
        if (bytes.length > WORKFLOW_BYTE_LIMIT) return raw;
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          return raw;
        }
        const flow = WorkflowDocumentSchema.safeParse(value),
          component = WorkflowComponentSchema.safeParse(value),
          webProject = WebProjectSchema.safeParse(value);
        if (!flow.success && !component.success && !webProject.success) return raw;
        let next: unknown;
        if (flow.success) next = remapFlow(flow.data);
        else if (component.success)
          next =
            component.data.schemaVersion === 1
              ? { ...component.data, node: remapFlowNode(component.data.node) }
              : { ...component.data, document: remapFlow(component.data.document) };
        else if (webProject.success)
          next = {
            ...webProject.data,
            files: Object.fromEntries(
              Object.entries(webProject.data.files).map(([role, id]) => [role, flowObjectId(id)]),
            ),
          };
        else return raw;
        const remapped = Buffer.from(JSON.stringify(next, null, 2) + '\n'),
          assetHash = sha(remapped),
          path = safePath(this.directory, `assets/${assetHash}`);
        if (!existsSync(path)) {
          writeFileSync(path, remapped, { flag: 'wx' });
          flush(path);
        }
        replacement = { assetHash, size: remapped.length };
        flowAssets.set(content.assetHash, replacement);
      }
      return JSON.stringify({ ...content, ...replacement });
    };
    const remapFlowValue = (value: any) =>
      value?.type === 'file'
        ? { ...value, value: remapFlowFile(value.value) }
        : value?.type === 'files' && Array.isArray(value.value)
          ? { ...value, value: value.value.map((file: any) => remapFlowFile(file)) }
          : value?.type === 'json'
            ? { ...value, value: remapFileReferences(value.value) }
            : value;
    const remapFlowRun = (run: any) => ({
      ...run,
      flowObjectId: flowObjectId(run.flowObjectId),
      objectIds: (run.objectIds ?? []).map(flowObjectId),
      expectedRevisions: Object.fromEntries(
        Object.entries(run.expectedRevisions ?? {}).map(([id, revision]) => [
          flowObjectId(id),
          revision,
        ]),
      ),
      document: remapFlow(run.document),
      ...(run.frozenFiles
        ? {
            frozenFiles: Object.fromEntries(
              Object.entries(run.frozenFiles).map(([id, value]) => [
                flowObjectId(id),
                remapFlowFile(value),
              ]),
            ),
          }
        : {}),
      nodes: Object.fromEntries(
        Object.entries(run.nodes ?? {}).map(([id, node]: [string, any]) => [
          id,
          {
            ...node,
            resultObjectIds: (node.resultObjectIds ?? []).map(flowObjectId),
            ...(node.outputs
              ? {
                  outputs: Object.fromEntries(
                    Object.entries(node.outputs).map(([port, value]) => [
                      port,
                      remapFlowValue(value),
                    ]),
                  ),
                }
              : {}),
            ...(node.python
              ? {
                  python: {
                    ...node.python,
                    source: remapFlowFile(node.python.source),
                    requirements: remapFlowFile(node.python.requirements),
                    inputFiles: (node.python.inputFiles ?? []).map((file: any) =>
                      remapFlowFile(file),
                    ),
                  },
                }
              : {}),
          },
        ]),
      ),
      logs: (run.logs ?? []).map((entry: any) => ({
        ...entry,
        resultObjectIds: (entry.resultObjectIds ?? []).map(flowObjectId),
      })),
      restoredAt: at,
    });
    const sourceWorkspace = source
      .prepare('SELECT * FROM workspaces WHERE id=?')
      .get(origin) as any;
    this.db
      .prepare('INSERT INTO workspaces VALUES(?,?,NULL,?,?)')
      .run(workspace, name, sourceWorkspace.viewport, sourceWorkspace.view_revision);
    for (const object of objects)
      this.db
        .prepare('INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          objectId(object.id),
          workspace,
          object.title,
          object.kind,
          remapFlowContent(object.content),
          object.revision,
          object.bounds,
          object.layout_revision,
          object.updated_at,
          object.actor,
        );
    for (const row of source
      .prepare('SELECT * FROM revisions WHERE workspace=?')
      .all(origin) as any[])
      this.db
        .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
        .run(
          workspace,
          objectId(row.object_id),
          row.revision,
          remapFlowContent(row.content),
          row.actor,
          row.summary,
          row.created_at,
        );
    const owners = new Map<string, string>(),
      owner = (old: string) => {
        if (!owners.has(old)) owners.set(old, `recovered_${randomUUID()}`);
        return owners.get(old)!;
      };
    for (const row of source
      .prepare('SELECT * FROM drafts WHERE workspace=?')
      .all(origin) as any[]) {
      if (objects.find((object) => object.id === row.object_id)?.kind === 'image') continue;
      this.db
        .prepare('INSERT INTO drafts VALUES(?,?,?,?,?,0)')
        .run(workspace, objectId(row.object_id), owner(row.owner), row.base, row.content);
    }
    for (const row of source
      .prepare('SELECT * FROM object_sources WHERE workspace=?')
      .all(origin) as any[])
      this.db
        .prepare('INSERT INTO object_sources VALUES(?,?,?,?)')
        .run(
          workspace,
          objectId(row.object_id),
          /\.(flow|component|web-project)\.json$/i.test(row.file_name)
            ? (flowAssets.get(row.asset_hash)?.assetHash ?? row.asset_hash)
            : row.asset_hash,
          row.file_name,
        );
    const snapshots = new Map<string, string>();
    for (const row of source
      .prepare('SELECT * FROM snapshots WHERE workspace=?')
      .all(origin) as any[]) {
      const snapshotId = `selection_${randomUUID()}`,
        value = JSON.parse(row.payload);
      snapshots.set(row.id, snapshotId);
      value.snapshotId = snapshotId;
      value.workspaceId = workspace;
      if (Array.isArray(value.objects))
        value.objects = value.objects.map((object: any) => ({
          ...object,
          id: objectId(object.id),
          workspaceId: workspace,
          ...(object.content && typeof object.content === 'object'
            ? { content: JSON.parse(remapFlowContent(JSON.stringify(object.content))) }
            : {}),
        }));
      if (value.workflow) value.workflow = remapFlowRun(value.workflow);
      this.db
        .prepare('INSERT INTO snapshots VALUES(?,?,?,?)')
        .run(snapshotId, workspace, JSON.stringify(value), row.created_at);
    }
    const remapRecord = (record: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(record ?? {}).map(([id, value]) => [objectId(id), value]));
    for (const row of source
      .prepare('SELECT key,value FROM settings WHERE workspace=?')
      .all(origin) as { key: string; value: string }[]) {
      if (excludedSetting(row.key)) continue;
      let key = row.key,
        value: any;
      if (key === 'instruction') {
        this.db.prepare('INSERT INTO settings VALUES(?,?,?)').run(workspace, key, row.value);
        continue;
      }
      value = JSON.parse(row.value);
      const keyed =
        /^(native-search-index|native-conversion|file-annotations|policy|archived|contribution|undone):([^:]+)(.*)$/.exec(
          key,
        );
      if (keyed) key = `${keyed[1]}:${objectId(keyed[2])}${keyed[3]}`;
      if (row.key === 'backup-policy') {
        value = { ...value, automaticIds: [], lastAt: Date.now() };
      } else if (row.key.startsWith('ocr-latest:')) {
        const parts = row.key.split(':');
        key = `ocr-latest:${objectId(parts[1])}:${parts[2]}`;
      } else if (row.key.startsWith('ocr-job:')) {
        value.objectId = objectId(value.objectId);
        value.pending = undefined;
        if (value.result) value.result.id = objectId(value.result.id);
      } else if (row.key.startsWith('ocr-source:') || row.key.startsWith('browser-source:')) {
        const [prefix, id] = row.key.split(':');
        key = `${prefix}:${objectId(id)}`;
        if (value.objectId) value.objectId = objectId(value.objectId);
        delete value.path;
        delete value.originalPath;
      } else if (row.key.startsWith('web-page:')) {
        value = {
          ...value,
          linkedObjects: Object.fromEntries(
            Object.entries(value.linkedObjects ?? {}).map(([format, id]) => [
              format,
              objectId(id as string),
            ]),
          ),
        };
      } else if (row.key.startsWith('web-task:')) {
        value = {
          ...webTaskHistoryOnly(value),
          objectId: objectId(value.objectId),
          restoredAt: at,
        };
      } else if (row.key.startsWith('workflow-run:')) {
        value = remapFlowRun(value);
      } else if (row.key.startsWith('workflow-batch:')) {
        // Batch/item/run IDs are workspace-local history IDs; only native object
        // links change. The marker forbids retrying an old batch as a live run.
        value = {
          ...value,
          flowObjectId: flowObjectId(value.flowObjectId),
          restoredAt: at,
          items: (value.items ?? []).map((item: any) => ({
            ...item,
            objectId: flowObjectId(item.objectId),
          })),
        };
      } else if (row.key.startsWith('comment-thread:')) {
        const thread = commentHistoryOnly(value as CommentThread);
        // Thread/message/dispatch IDs are workspace-scoped history identifiers.
        // Native selection IDs deliberately remain historical: references and grants
        // are excluded, and restoredAt requires the user to reanchor before sending.
        value = {
          ...thread,
          objectId: objectId(thread.objectId),
          revision: thread.revision + 1,
          updatedAt: at,
          restoredAt: at,
          messages: thread.messages.map((message) => ({
            ...message,
            ...(message.resultRevisions
              ? { resultRevisions: remapRecord(message.resultRevisions) }
              : {}),
          })),
          dispatches: thread.dispatches.map((dispatch) => ({
            ...dispatch,
            resultRevisions: remapRecord(dispatch.resultRevisions),
            restoredAt: at,
            ...(!['completed', 'failed'].includes(dispatch.status)
              ? {
                  status: 'failed',
                  updatedAt: at,
                  message: `${dispatch.message ? dispatch.message.slice(0, 1200) + '\n' : ''}已从备份恢复历史记录，原会话和执行授权未恢复，不会自动继续或重发。请重新定位评论范围，再明确发起新的处理请求。`,
                }
              : {}),
          })),
        };
      } else if (row.key.startsWith('native-editor-draft:')) {
        value.objectId = objectId(value.objectId);
        key = `native-editor-draft:${value.objectId}:${value.kind}`;
        if (value.data.objectId) value.data.objectId = value.objectId;
        const draft = value.kind === 'text' ? value.data.draft : value.data;
        if (draft?.pending) draft.pending = null;
      } else if (row.key.startsWith('import-queue:item:')) {
        value.requestId = `import_${randomUUID()}`;
        key = `import-queue:item:${value.requestId}`;
        if (value.objectId) value.objectId = objectId(value.objectId);
        if (/\.(flow|component|web-project)\.json$/i.test(value.fileName ?? ''))
          value = JSON.parse(remapFlowContent(JSON.stringify(value)));
      } else if (row.key === 'import-queue:folders') {
        value.requestId = `folders_${randomUUID()}`;
      } else if (row.key.startsWith('contribution:')) {
        if (value.dependencies)
          value.dependencies = value.dependencies.map((item: any) => ({
            ...item,
            objectId: objectId(item.objectId),
          }));
        if (snapshots.has(value.snapshotId)) value.snapshotId = snapshots.get(value.snapshotId);
      } else if (key === 'canvas-groups')
        value.items = value.items.map((item: any) => ({
          ...item,
          objectIds: item.objectIds.map(objectId),
          ...(item.linkedObjectIds ? { linkedObjectIds: item.linkedObjectIds.map(objectId) } : {}),
        }));
      else if (key === 'canvas-board') {
        const board = CanvasBoardSchema.parse(value);
        value = {
          ...board,
          links: board.links.map((link) => ({
            ...link,
            sourceId: objectId(link.sourceId),
            targetId: objectId(link.targetId),
          })),
        };
      } else if (key === 'file-tree') value.locations = remapRecord(value.locations);
      else if (key === 'desktop-library') {
        value.favoriteIds = (value.favoriteIds ?? []).map(objectId);
        value.recentIds = (value.recentIds ?? []).map(objectId);
      } else if (key === 'layout-library')
        value.items = value.items.map((item: any) => ({
          ...item,
          objects: item.objects.map((o: any) => ({ ...o, objectId: objectId(o.objectId) })),
          groups: item.groups.map((g: any) => ({ ...g, objectIds: g.objectIds.map(objectId) })),
        }));
      else if (key.startsWith('prototype-task:')) {
        value.sources = value.sources.map((item: any) => ({
          ...item,
          objectId: objectId(item.objectId),
        }));
        value.writeObjectIds = (value.writeObjectIds ?? []).map(objectId);
        if (value.management) {
          value.management = {
            ...value.management,
            legacy: true,
            restoredHistory: true,
            state: ['completed', 'cancelled'].includes(value.management.state)
              ? value.management.state
              : 'cancelled',
            generation: value.management.generation + 1,
            reason: '从备份恢复的历史；执行资格不恢复',
            sources: undefined,
            artifacts: (value.management.artifacts || []).map((a: any) => ({
              ...a,
              objectId: objectId(a.objectId),
            })),
          };
        }
        if (value.execution) {
          value.execution.originOwner = `restored_${randomUUID()}`;
          for (const participant of value.execution.participants)
            participant.lastReads = remapRecord(participant.lastReads);
          for (const feedback of value.execution.feedbacks)
            feedback.basedOn = remapRecord(feedback.basedOn);
        }
        if (!['completed', 'cancelled'].includes(value.status)) {
          value.status = 'cancelled';
          value.resumeStatus = undefined;
          value.gate = undefined;
          value.events.push({
            id: `event_${randomUUID()}`,
            actor: 'human',
            title: '从备份恢复任务记录',
            body: '原执行资格不恢复。继续任务请在原对话重新引用材料。',
            at,
          });
        }
      } else if (key.startsWith('annotation-draft:')) {
        value.objectId = objectId(value.objectId);
        value.owner = owner(value.owner);
        value.pending = undefined;
        value.version++;
      } else if (key.startsWith('artifact:')) {
        value.objectId = objectId(value.objectId);
        value.path = safePath(this.directory, `exports/${value.fileName}`);
      } else if (key === 'prototype-environment') {
        value = {
          revision: value.revision + 1,
          resources: value.resources.map((item: any) => ({ ...item, state: 'revoked_demo' })),
        };
      }
      this.db
        .prepare('INSERT INTO settings VALUES(?,?,?)')
        .run(workspace, key, JSON.stringify(value));
    }
    // Preserve intake history without restoring dispatch authority.
    for (const table of ['work_requests', 'bot_requests', 'bot_effects']) {
      if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        continue;
      for (const row of source
        .prepare(`SELECT * FROM ${table} WHERE workspace=?`)
        .all(origin) as any[]) {
        const body = JSON.parse(row.body);
        body.restoredAt = at;
        body.originalWorkspace = origin;
        if (table === 'bot_requests') {
          body.state = 'rejected';
          body.reason = '从备份恢复的历史输入；请重新引用材料后发起新请求';
          delete body.delivery;
          this.db
            .prepare('INSERT INTO bot_requests VALUES(?,?,?,?)')
            .run(workspace, row.id, row.sequence, JSON.stringify(body));
        } else if (table === 'bot_effects') {
          if (body.state === 'queued') body.state = 'cancelled';
          this.db
            .prepare('INSERT INTO bot_effects VALUES(?,?,?,?)')
            .run(workspace, row.id, row.request_id, JSON.stringify(body));
        } else
          this.db
            .prepare('INSERT INTO work_requests VALUES(?,?,?,?)')
            .run(workspace, row.id, row.idempotency_key, JSON.stringify(body));
      }
    }
    for (const row of source
      .prepare('SELECT * FROM events WHERE workspace=? ORDER BY seq')
      .all(origin) as any[])
      this.db
        .prepare(
          'INSERT INTO events(workspace,type,object_id,revision,actor,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          workspace,
          row.type,
          row.object_id ? objectId(row.object_id) : null,
          row.revision,
          row.actor,
          row.created_at,
        );
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
      workspace,
      'restore-origin',
      JSON.stringify({
        backupId: manifest.id,
        workspaceId: origin,
        restoredAt: at,
        objectIds: Object.fromEntries(ids),
      }),
    );
    this.api.event(workspace, 'workspace.restored', null, null, 'human');
    return { id: workspace, name, objectCount: objects.length, updatedAt: at, current: false };
  }
}
