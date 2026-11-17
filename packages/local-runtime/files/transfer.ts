// Material transfer surface of DesktopStore, extracted by responsibility
// boundary: bringing bytes into the desktop (attachments, generated run
// outputs, light apps, CSV/text/code files, the resumable import queue and
// original-file retrieval) and writing objects back out (export, bundle).
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  readFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import JSZip from 'jszip';
import {
  Bounds,
  CodeContent,
  Id,
  FileContent,
  TableContent,
  TextContent,
  type Table,
  fail,
  RelativeFilePath,
  type DesktopObject,
} from '../../contracts/index.js';
import { contentText, parseCsv, tableCsv } from '../../components/content.js';
import { freePosition } from '../../components/canvas-spatial.js';
import { nativeFormat, NATIVE_FILE_LIMIT } from '../../components/native-files.js';
import { ImportQueue } from '../../contracts/recovery.js';
import { decode, encode, now, hash, id, canonical } from '../storage/serde.js';
import type { GeneratedFileLinks } from './generated-file-links.js';
import type { CreationAuthority } from '../work/local-runs.js';
import type { WorkspaceOrganization } from '../workspace/organization.js';
import type { CanvasBoard } from '../../contracts/canvas-board.js';

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
export type TransferHost = {
  db: DatabaseSync;
  directory: string;
  organization: WorkspaceOrganization;
  tx<T>(fn: () => T): T;
  auth(workspace: string, credential: string, session: string | null, kind?: Auth['kind']): Auth;
  once<T>(workspace: string, request: string, payload: unknown, fn: () => T): T;
  object(workspace: string, objectId: string): DesktopObject;
  setting(workspace: string, key: string): string;
  event(
    workspace: string,
    type: string,
    objectId: string | null,
    revision: number | null,
    actor: string,
  ): void;
  writeAsset(bytes: Buffer): string;
  assertFileEditor(workspace: string, objectId: string, owner: string): void;
  currentWorkspaceOverview(session: string | null): { workspaceId: string };
  generatedLinks(): GeneratedFileLinks;
  workspaceFolder(workspace: string, parts?: string[]): string;
  placeNewObjectInRegion(workspace: string, objectId: string): void;
  readCanvasBoard(workspace: string): CanvasBoard;
  createObject(
    workspace: string,
    token: string,
    session: string | null,
    requestId: string,
    input: unknown,
    source?: { assetHash: string; fileName: string },
    authority?: CreationAuthority,
  ): DesktopObject;
};

export interface TransferMethods {
  importLightApp(
    session: string | null,
    p: { workspaceId: string; key: string; fileName: string; data: string },
  ): DesktopObject;
  importRunOutput(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
    authority: CreationAuthority,
  ): DesktopObject;
  importAttachment(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
    authority?: CreationAuthority & { outputRegionId?: string },
  ): DesktopObject;
  importQueue(workspace: string, token: string, session: string | null, input: unknown): unknown;
  importFile(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
    authority?: CreationAuthority,
  ): DesktopObject;
  originalFile(
    workspace: string,
    token: string,
    session: string | null,
    objectId: string,
  ): { fileName: string; data: string };
  exportFile(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): { path: string; bytes: number; sha256: string; revision: number; original: boolean };
  exportBundle(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): Promise<{ path: string; count: number; bytes: number }>;
}

function exportContents(
  directory: string,
  object: DesktopObject,
  format: 'default' | 'markdown' = 'default',
  source?: { fileName: string; data: string },
) {
  let bytes: Buffer, extension: string;
  if (source) {
    bytes = Buffer.from(source.data, 'base64');
    extension =
      source.fileName
        .split('.')
        .pop()
        ?.replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 12) || 'txt';
  } else if (object.kind === 'file') {
    const content = object.content as { assetHash: string; fileName: string };
    bytes = readFileSync(join(directory, 'assets', content.assetHash));
    extension =
      content.fileName
        .split('.')
        .pop()
        ?.replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 12) || 'bin';
  } else if (object.kind === 'image') {
    const content = object.content as { assetHash: string };
    bytes = readFileSync(join(directory, 'assets', content.assetHash));
    extension = 'png';
  } else if (['diagram', 'deck', 'workbook'].includes(object.kind)) {
    bytes = Buffer.from(JSON.stringify(object.content, null, 2), 'utf8');
    extension = 'json';
  } else {
    bytes = Buffer.from(
      object.kind === 'table'
        ? `\uFEFF${tableCsv(object.content as Table)}`
        : contentText(object.content),
      'utf8',
    );
    extension =
      object.kind === 'table'
        ? 'csv'
        : object.kind === 'code'
          ? (
              {
                javascript: 'js',
                typescript: 'ts',
                python: 'py',
                json: 'json',
                html: 'html',
                css: 'css',
                markdown: 'md',
                text: 'txt',
              } as Record<string, string>
            )[(object.content as any).language]
          : format === 'markdown'
            ? 'md'
            : 'txt';
  }
  return { bytes, extension };
}

export const transfer: TransferMethods & ThisType<TransferHost & TransferMethods> = {
  importLightApp(
    session: string | null,
    p: { workspaceId: string; key: string; fileName: string; data: string },
  ) {
    const w = this.currentWorkspaceOverview(session).workspaceId;
    if (w !== p.workspaceId) fail('WORKSPACE_CHANGED', '工作区已切换');
    const key = 'light-app:' + hash(p.key),
      previous = this.setting(w, key),
      saved = previous ? decode<{ id: string; assetHash: string }>(previous) : null;
    const bytes = Buffer.from(p.data, 'base64');
    if (bytes.length > NATIVE_FILE_LIMIT) fail('INVALID_FILE', '产出超过 50 MiB');
    const assetHash = this.writeAsset(bytes);
    let result: DesktopObject;
    if (saved) {
      result = this.tx(() => {
        const object = this.object(w, saved.id),
          content = FileContent.parse(object.content);
        if (
          object.archived ||
          object.policy?.private ||
          object.policy?.locked ||
          object.policy?.protectedRanges.length
        )
          fail('LOCKED_CONTENT', '原对象已删除或受到保护');
        if (content.assetHash === assetHash) return object;
        if (content.assetHash !== saved.assetHash)
          fail('REVISION_CONFLICT', '原对象已被编辑，请比较后手动合并');
        this.assertFileEditor(w, object.id, 'light-app');
        if (
          this.db
            .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
            .get(w, object.id, Date.now())
        )
          fail('DRAFT_ACTIVE', '请先保存原对象编辑');
        const next = { ...content, assetHash, size: bytes.length },
          revision = object.revision + 1,
          at = now();
        this.db
          .prepare(
            "UPDATE objects SET content=?,revision=?,updated_at=?,actor='ai' WHERE workspace=? AND id=?",
          )
          .run(encode(next), revision, at, w, object.id);
        this.db
          .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
          .run(w, object.id, revision, encode(next), 'ai', '轻应用产出回写', at);
        this.generatedLinks().accept(w, object.id, assetHash);
        this.event(w, 'object.changed', object.id, revision, 'ai');
        this.db
          .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
          .run(w, key, encode({ id: object.id, assetHash }));
        return this.object(w, object.id);
      });
    } else {
      // importAttachment rechecks authority inside its transaction. Only read the
      // binding here; currentWorkspaceOverview can start another transaction.
      result = this.importRunOutput(
        w,
        '',
        session,
        {
          requestId: 'app:' + hash(p.key + assetHash).slice(0, 48),
          fileName: p.fileName,
          data: p.data,
          bounds: { x: 80, y: 80, width: 360, height: 260 },
        },
        {
          actor: 'ai',
          summary: '轻应用',
          authorize: () => {
            const binding = this.db
              .prepare('SELECT id FROM workspaces WHERE session=?')
              .get(session) as { id: string } | undefined;
            if (binding?.id !== w) fail('WORKSPACE_CHANGED', '工作区已切换');
          },
        },
      );
      this.generatedLinks().materialize(
        w,
        result.id,
        this.workspaceFolder(w, ['轻应用', p.key.split(':')[1]]),
        p.fileName,
        assetHash,
      );
      this.db
        .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
        .run(w, key, encode({ id: result.id, assetHash }));
    }
    return result;
  },
  importRunOutput(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
    authority: CreationAuthority,
  ) {
    const p = z
      .object({
        requestId: Id,
        fileName: z.string().min(1).max(120),
        data: z.string().max(70000000),
        bounds: Bounds,
      })
      .strict()
      .parse(input);
    authority.authorize();
    const receipt = this.db
      .prepare('SELECT result FROM receipts WHERE workspace=? AND request=?')
      .get(workspace, p.requestId) as { result: string } | undefined;
    if (receipt) return decode<DesktopObject>(receipt.result);
    const placementKey = `local-run:placement:${p.requestId}`,
      placement = this.setting(workspace, placementKey);
    let bounds = placement ? Bounds.parse(decode(placement)) : undefined;
    if (!bounds) {
      const objects = (
        this.db.prepare('SELECT id FROM objects WHERE workspace=?').all(workspace) as {
          id: string;
        }[]
      )
        .map((row) => this.object(workspace, row.id))
        .filter((object) => !object.archived);
      const groups = decode(this.setting(workspace, 'canvas-groups') || '{"items":[]}').items;
      bounds = freePosition(
        p.bounds,
        [
          ...objects.map((object) => ({ ...object.bounds, height: object.bounds.height + 40 })),
          ...this.readCanvasBoard(workspace).items,
          ...groups.filter((group: any) => group.bounds).map((group: any) => group.bounds),
        ],
        { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width + 48, height: p.bounds.height + 48 },
      );
      this.db
        .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
        .run(workspace, placementKey, encode(bounds));
    }
    return this.importAttachment(workspace, token, session, { ...p, bounds }, authority);
  },
  importAttachment(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
    authority?: CreationAuthority & { outputRegionId?: string },
  ) {
    const p = z
      .object({
        requestId: Id,
        fileName: z.string().min(1).max(120),
        data: z.string().max(70000000),
        bounds: Bounds,
        relativePath: RelativeFilePath.optional(),
        lastModified: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(input);
    const authorize =
        authority?.authorize ??
        (() => {
          this.auth(workspace, token, session, 'panel');
        }),
      actor = authority?.actor ?? 'human';
    authorize();
    if (/[\\/:\u0000-\u001f]/.test(p.fileName) || ['.', '..'].includes(p.fileName))
      fail('INVALID_FILE', '文件名不能包含路径。');
    if (p.relativePath && p.relativePath.split('/').pop() !== p.fileName)
      fail('INVALID_FILE', '相对路径与文件名不一致。');
    const bytes = Buffer.from(p.data, 'base64');
    if (bytes.length > NATIVE_FILE_LIMIT || bytes.toString('base64') !== p.data)
      fail('INVALID_FILE', '原生文件大小不能超过 50 MiB，且必须是完整文件内容。');
    const assetHash = this.writeAsset(bytes);
    const { mime } = nativeFormat(p.fileName);
    return this.tx(() => {
      authorize();
      return this.once(
        workspace,
        p.requestId,
        { type: 'attachment', ...p, data: assetHash },
        () => {
          const links = this.generatedLinks(),
            source = links.importSource(workspace, p.requestId);
          if (source) {
            if (source.diskHash !== assetHash || basename(source.path) !== p.fileName)
              fail('IMPORT_CHANGED', '导入期间原文件已修改，请重新拖入。');
            const linked = source.linked ? links.find(workspace, source.path) : undefined;
            if (linked) {
              const existing = this.object(workspace, linked.objectId);
              if (existing.archived) {
                this.db
                  .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
                  .run(workspace, `archived:${existing.id}`);
                this.event(workspace, 'object.metadata', existing.id, existing.revision, 'human');
              }
              return this.object(workspace, existing.id);
            }
          }
          const objectId = id('object'),
            at = now(),
            content = FileContent.parse({
              assetHash,
              mime,
              size: bytes.length,
              fileName: p.fileName,
              storage: 'native',
              sourceRelativePath: p.relativePath ?? p.fileName,
              sourceModifiedAt: p.lastModified,
            });
          this.db
            .prepare('INSERT INTO objects VALUES(?,?,?,?,?,1,?,1,?,?)')
            .run(
              objectId,
              workspace,
              p.fileName,
              'file',
              encode(content),
              encode(p.bounds),
              at,
              actor,
            );
          this.db
            .prepare('INSERT INTO revisions VALUES(?,?,1,?,?,?,?)')
            .run(
              workspace,
              objectId,
              encode(content),
              actor,
              authority?.summary ?? '导入原文件',
              at,
            );
          this.db
            .prepare('INSERT INTO object_sources VALUES(?,?,?,?)')
            .run(workspace, objectId, assetHash, p.fileName);
          if (authority?.outputRegionId)
            this.organization.placeGenerated(
              workspace,
              objectId,
              authority.outputRegionId,
              p.relativePath,
            );
          else if (p.relativePath && authority?.actor === 'ai')
            this.organization.recordGeneratedLocation(workspace, objectId, p.relativePath);
          else if (p.relativePath)
            this.organization.placeImported(workspace, objectId, p.relativePath);
          const linkedRoot =
              this.setting(workspace, 'workspace-linked') &&
              this.setting(workspace, 'generated-workspace-root'),
            root = linkedRoot ? decode<string>(linkedRoot) : null;
          const relativeSource = root && source ? relative(root, source.path) : null;
          if (
            source?.linked &&
            relativeSource !== null &&
            relativeSource !== '..' &&
            !relativeSource.startsWith('..\\') &&
            !relativeSource.startsWith('../') &&
            !isAbsolute(relativeSource)
          )
            links.attachImport(workspace, p.requestId, objectId, assetHash);
          else if (!authority) {
            const parts = (p.relativePath ?? p.fileName).split('/');
            parts.pop();
            const directory = this.workspaceFolder(workspace, parts);
            links.materialize(workspace, objectId, directory, p.fileName, assetHash);
          }
          this.event(workspace, 'object.created', objectId, 1, actor);
          this.placeNewObjectInRegion(workspace, objectId);
          return this.object(workspace, objectId);
        },
      );
    });
  },
  importQueue(workspace: string, token: string, session: string | null, input: unknown) {
    const p = ImportQueue.parse(input);
    this.auth(workspace, token, session, 'panel');
    const rows = () =>
      this.db
        .prepare(
          "SELECT key,value FROM settings WHERE workspace=? AND key LIKE 'import-queue:item:%'",
        )
        .all(workspace) as { key: string; value: string }[];
    if (p.operation === 'list') {
      const items = rows().map((row) => {
        const item = decode(row.value),
          receipt = this.db
            .prepare('SELECT result FROM receipts WHERE workspace=? AND request=?')
            .get(workspace, item.requestId) as { result: string } | undefined,
          result = receipt && decode(receipt.result);
        return {
          ...item,
          originalPath: this.generatedLinks().importSource(workspace, item.requestId)?.path,
          objectId: result?.id ?? item.objectId,
        };
      });
      const raw = this.setting(workspace, 'import-queue:folders'),
        job = raw ? decode(raw) : null;
      return {
        items,
        folders:
          job &&
          !this.db
            .prepare('SELECT 1 FROM receipts WHERE workspace=? AND request=?')
            .get(workspace, job.requestId)
            ? job
            : null,
      };
    }
    if (p.operation === 'folders') {
      this.db
        .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
        .run(workspace, 'import-queue:folders', encode(p.job));
      return { saved: true };
    }
    if (p.operation === 'forget') {
      return this.tx(() => {
        for (const id of p.ids)
          this.db
            .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
            .run(workspace, `import-queue:item:${id}`);
        return { removed: p.ids.length };
      });
    }
    if (p.operation === 'request') {
      const raw = this.setting(workspace, `import-queue:item:${p.id}`);
      if (!raw) fail('NOT_FOUND', '导入队列记录不存在，请重新选择原文件。');
      const { assetHash, size, ...entry } = decode(raw);
      delete entry.objectId;
      const bytes = readFileSync(join(this.directory, 'assets', assetHash));
      if (hash(bytes) !== assetHash) fail('ASSET_CORRUPT', '暂存文件已改变。');
      return { action: 'import_attachment', payload: { ...entry, data: bytes.toString('base64') } };
    }
    const { data, ...metadata } = p.entry;
    if (
      /[\\/:\u0000-\u001f]/.test(metadata.fileName) ||
      metadata.relativePath.split('/').at(-1) !== metadata.fileName
    )
      fail('INVALID_FILE', '文件名与路径不一致。');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > NATIVE_FILE_LIMIT || bytes.toString('base64') !== data)
      fail('INVALID_FILE', '文件内容无效或超过 50 MiB。');
    return this.tx(() => {
      const key = `import-queue:item:${metadata.requestId}`,
        old = this.setting(workspace, key),
        record = { ...metadata, assetHash: hash(bytes), size: bytes.length };
      if (old) {
        const value = decode(old);
        delete value.objectId;
        if (canonical(value) !== canonical(record))
          fail('REQUEST_ID_REUSED', '导入请求已用于不同文件。');
        return { saved: true };
      }
      const items = rows().map((r) => decode(r.value));
      if (
        items.length >= 500 ||
        items.reduce((n, r) => n + r.size, 0) + bytes.length > 256 * 1024 * 1024
      )
        fail('IMPORT_LIMIT', '暂存队列最多 500 项 / 256 MiB，请先清除完成记录。');
      this.writeAsset(bytes);
      this.db.prepare('INSERT INTO settings VALUES(?,?,?)').run(workspace, key, encode(record));
      return { saved: true };
    });
  },
  importFile(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
    authority?: CreationAuthority,
  ) {
    const p = z
      .object({
        requestId: Id,
        fileName: z.string().min(1).max(120),
        data: z.string().max(1400000),
        kind: z.enum(['table', 'code', 'text']),
        language: CodeContent.shape.language.default('text'),
        bounds: Bounds,
      })
      .strict()
      .parse(input);
    if (authority) authority.authorize();
    else this.auth(workspace, token, session, 'panel');
    if (/[\\/:]/.test(p.fileName)) fail('INVALID_FILE', '文件名不能包含路径。');
    const bytes = Buffer.from(p.data, 'base64');
    if (bytes.length > 1000000 || bytes.toString('base64') !== p.data)
      fail('INVALID_FILE', '文件必须小于 1 MB。');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('INVALID_FILE', '请选择 UTF-8 编码的文本或 CSV 文件。');
    }
    if (text.includes('\0')) fail('INVALID_FILE', '不支持二进制文件。');
    let content;
    try {
      // Deterministic IDs keep import retries identical.
      let counter = 0;
      content =
        p.kind === 'table'
          ? parseCsv(text, () => `csv_${hash(p.requestId).slice(0, 16)}_${counter++}`)
          : p.kind === 'text'
            ? TextContent.parse({
                blocks: [{ id: `text_${hash(p.requestId).slice(0, 16)}`, text }],
              })
            : CodeContent.parse({ code: text, language: p.language });
    } catch (e) {
      fail('INVALID_FILE', e instanceof z.ZodError ? '内容超过支持范围。' : String(e));
    }
    const assetHash = this.writeAsset(bytes);
    return this.createObject(
      workspace,
      token,
      session,
      p.requestId,
      { kind: p.kind, title: p.fileName, content, bounds: p.bounds },
      { assetHash, fileName: p.fileName },
      authority,
    );
  },
  originalFile(workspace: string, token: string, session: string | null, objectId: string) {
    this.auth(workspace, token, session, 'panel');
    this.object(workspace, objectId);
    const source = this.db
      .prepare('SELECT asset_hash,file_name FROM object_sources WHERE workspace=? AND object_id=?')
      .get(workspace, objectId) as any;
    if (!source) fail('NOT_FOUND', '此对象没有导入原文件。');
    return {
      fileName: source.file_name,
      data: readFileSync(join(this.directory, 'assets', source.asset_hash)).toString('base64'),
    };
  },
  exportFile(workspace: string, token: string, session: string | null, input: unknown) {
    const p = z
      .object({
        requestId: Id,
        objectId: Id,
        expectedRevision: z.number().int().positive(),
        original: z.boolean().default(false),
        format: z.enum(['default', 'markdown']).default('default'),
      })
      .strict()
      .parse(input);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, p.requestId, { action: 'export', ...p }, () => {
        const object = this.object(workspace, p.objectId);
        if (object.revision !== p.expectedRevision)
          fail('REVISION_CONFLICT', '内容已更新，请重新导出。');
        if (
          this.db
            .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
            .get(workspace, p.objectId, Date.now())
        )
          fail('DRAFT_ACTIVE', '请先保存或处理草稿，再撤销历史修改。');
        const original = p.original
          ? this.originalFile(workspace, token, session, object.id)
          : undefined;
        const { bytes, extension } = exportContents(this.directory, object, p.format, original);
        const directory = join(this.directory, 'exports');
        mkdirSync(directory, { recursive: true });
        // Generated names only; no caller path reaches the filesystem.
        let path = join(
          directory,
          `${p.original ? 'original' : 'export'}-${randomUUID()}.${extension}`,
        );
        if (object.kind === 'file') {
          const fileName = original?.fileName ?? FileContent.parse(object.content).fileName;
          if (/[\\/:\u0000-\u001f]/.test(fileName) || ['.', '..'].includes(fileName))
            fail('INVALID_FILE', '文件名不能包含路径。');
          const folder = join(directory, `file-${randomUUID()}`);
          mkdirSync(folder);
          path = join(folder, fileName);
        }
        const fd = openSync(path, 'wx');
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        this.event(workspace, 'object.exported', object.id, object.revision, 'human');
        return {
          path,
          bytes: bytes.length,
          sha256: hash(bytes),
          revision: object.revision,
          original: p.original,
        };
      });
    });
  },
  async exportBundle(workspace: string, token: string, session: string | null, input: unknown) {
    const p = z
      .object({
        requestId: Id,
        objects: z
          .array(z.object({ id: Id, revision: z.number().int().positive() }).strict())
          .min(1)
          .max(200),
      })
      .strict()
      .parse(input);
    this.auth(workspace, token, session, 'panel');
    const zip = new JSZip(),
      names = new Set<string>();
    let total = 0;
    // Capture every selected revision before yielding; no filesystem paths come from the client.
    for (const item of p.objects) {
      const object = this.object(workspace, item.id);
      if (object.archived) fail('REVISION_CONFLICT', '材料已删除，请重新选择。');
      if (object.revision !== item.revision)
        fail('REVISION_CONFLICT', '内容已更新，请重新导出。');
      if (
        this.db.prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
          .get(workspace, object.id, Date.now())
      )
        fail('DRAFT_ACTIVE', '请先保存或处理草稿，再打包。');
      const { bytes: data, extension } = exportContents(this.directory, object);
      total += data.length;
      if (total > 256 * 1024 * 1024) fail('VALIDATION_FAILED', '所选文件超过256 MB，请分批打包。');
      let name = object.kind === 'file' ? FileContent.parse(object.content).fileName : object.title;
      name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || '材料';
      if (!name.toLowerCase().endsWith('.' + extension.toLowerCase())) name += '.' + extension;
      const dot = name.lastIndexOf('.'),
        stem = name.slice(0, dot),
        suffix = name.slice(dot);
      let n = 2;
      while (names.has(name.toLowerCase())) name = stem + ' (' + n++ + ')' + suffix;
      names.add(name.toLowerCase());
      zip.file(name, data);
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    this.auth(workspace, token, session, 'panel');
    const directory = join(this.directory, 'exports');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `材料打包-${randomUUID()}.zip`);
    const fd = openSync(path, 'wx');
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { path, count: p.objects.length, bytes: bytes.length };
  },
};
