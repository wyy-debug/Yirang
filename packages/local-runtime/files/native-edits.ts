// Native file editing surface of DesktopStore, extracted by responsibility
// boundary: replacing native files, the text/office/spreadsheet read-save
// pipelines, editor drafts, and the authority checks that let the original
// Codex conversation read or write back native files.
import type { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  Id,
  FileContent,
  fail,
  type DesktopObject,
  type MaterialRange,
  type Revision,
} from '../../contracts/index.js';
import { TextFileRead, TextFileSave } from '../../contracts/native-text.js';
import { OfficeRead, OfficeSave } from '../../contracts/office.js';
import { XlsxRead, XlsxSave, XlsxCalculate } from '../../contracts/xlsx.js';
import { NativeDraftSync } from '../../contracts/recovery.js';
import {
  nativeFormat,
  NATIVE_FILE_LIMIT,
  isNativeTextFile,
} from '../../components/native-files.js';
import { encodeNativeText, decodeNativeText } from '../documents/native-text.js';
import type { OfficeEditor } from '../documents/office-editor.js';
import type { XlsxEditor } from '../documents/spreadsheet/xlsx-editor.js';
import { decode, encode, now, canonical, hash } from '../storage/serde.js';
import type { NativeTasks, NativeTaskContext } from './native-tasks.js';
import type { CommitResult, FileAuthority, NativeFileSession } from './native-files.js';
import type { WorkManagementStore } from '../work/work-management.js';

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
export type NativeEditHost = {
  db: DatabaseSync;
  directory: string;
  nativeTasks: NativeTasks;
  workManagement: WorkManagementStore;
  executionContext: AsyncLocalStorage<string | undefined>;
  officeEditor: OfficeEditor;
  xlsxEditor: XlsxEditor;
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
  revision(
    workspace: string,
    token: string,
    session: string | null,
    objectId: string,
    revision: number,
  ): Revision;
};

export interface NativeEditMethods {
  replaceNativeFile(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): DesktopObject;
  textFileRead(workspace: string, token: string, session: string | null, input: unknown): unknown;
  textFileSave(workspace: string, token: string, session: string | null, input: unknown): unknown;
  officeRead(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): Promise<unknown>;
  officeSave(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): Promise<unknown>;
  spreadsheetRead(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): Promise<unknown>;
  spreadsheetCalculate(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): Promise<unknown>;
  spreadsheetSave(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): Promise<unknown>;
  nativeDraftSync(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ): { saved: number };
  nativeDraftList(workspace: string, token: string, session: string | null): unknown[];
  nativeFileAuthority(
    workspace: string,
    token: string,
    session: string | null,
    objectId: string,
    write: boolean,
  ): FileAuthority & { taskContext: NativeTaskContext | undefined };
  commitNativeResult(
    workspace: string,
    token: string,
    session: string | null,
    record: NativeFileSession,
    bytes: Buffer,
    summary: string,
  ): CommitResult;
}

type NativeEditInternals = {
  spreadsheetObject(
    workspace: string,
    token: string,
    session: string | null,
    objectId: string,
    revision: number,
  ): { object: DesktopObject; content: z.infer<typeof FileContent> };
};

export const nativeEdits: NativeEditMethods &
  NativeEditInternals &
  ThisType<NativeEditHost & NativeEditMethods & NativeEditInternals> = {
  replaceNativeFile(workspace: string, token: string, session: string | null, input: unknown) {
    const p = z
      .object({
        requestId: Id,
        objectId: Id,
        expectedRevision: z.number().int().positive(),
        fileName: z.string().min(1).max(120),
        data: z.string().max(70000000),
        lastModified: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(input);
    this.auth(workspace, token, session, 'panel');
    if (/[\\/:\u0000-\u001f]/.test(p.fileName) || ['.', '..'].includes(p.fileName))
      fail('INVALID_FILE', '文件名无效。');
    const bytes = Buffer.from(p.data, 'base64');
    if (bytes.length > NATIVE_FILE_LIMIT || bytes.toString('base64') !== p.data)
      fail('INVALID_FILE', '原生文件必须完整，且不超过 50 MiB。');
    const assetHash = this.writeAsset(bytes);
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(
        workspace,
        p.requestId,
        { type: 'file.replace', ...p, data: assetHash },
        () => {
          const object = this.object(workspace, p.objectId);
          if (object.kind !== 'file' || object.archived)
            fail('INVALID_FILE', '请选择桌面上的原生文件。');
          if (object.revision !== p.expectedRevision)
            fail('REVISION_CONFLICT', '文件已更新，请重新载入后选择新版本。');
          const previous = FileContent.parse(object.content),
            revision = object.revision + 1,
            at = now();
          const content = FileContent.parse({
            assetHash,
            size: bytes.length,
            mime: nativeFormat(p.fileName).mime,
            fileName: p.fileName,
            storage: 'native',
            sourceRelativePath: previous.sourceRelativePath,
            sourceModifiedAt: p.lastModified,
          });
          this.db
            .prepare(
              "UPDATE objects SET content=?,title=?,revision=?,updated_at=?,actor='human' WHERE workspace=? AND id=?",
            )
            .run(
              encode(content),
              object.title === previous.fileName ? p.fileName : object.title,
              revision,
              at,
              workspace,
              object.id,
            );
          this.db
            .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
            .run(
              workspace,
              object.id,
              revision,
              encode(content),
              'human',
              '替换原生文件，保留历史版本',
              at,
            );
          this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
            workspace,
            `contribution:${object.id}:${revision}`,
            encode({
              operation: 'replace_native_file',
              baseRevision: object.revision,
              requestId: p.requestId,
              location: { type: 'object' },
              dependencies: [{ objectId: object.id, revision: object.revision }],
            }),
          );
          this.event(workspace, 'object.changed', object.id, revision, 'human');
          return this.object(workspace, object.id);
        },
      );
    });
  },
  textFileRead(workspace: string, token: string, session: string | null, input: unknown) {
    const p = TextFileRead.parse(input);
    this.auth(workspace, token, session, 'panel');
    const object = this.object(workspace, p.objectId);
    if (object.kind !== 'file' || object.archived)
      fail('TEXT_FILE', '请选择未归档的文本或代码文件。');
    const content = FileContent.parse(
      object.revision === p.expectedRevision
        ? object.content
        : this.revision(workspace, token, session, p.objectId, p.expectedRevision).content,
    );
    if (!isNativeTextFile(content.fileName)) fail('TEXT_FILE', '此格式尚未接入文本编辑。');
    return {
      objectId: object.id,
      revision: p.expectedRevision,
      fileName: content.fileName,
      ...decodeNativeText(readFileSync(join(this.directory, 'assets', content.assetHash))),
    };
  },
  nativeDraftSync(workspace: string, token: string, session: string | null, input: unknown) {
    const p = NativeDraftSync.parse(input);
    this.auth(workspace, token, session, 'panel');
    if (Buffer.byteLength(encode(p)) > 20 * 1024 * 1024)
      fail('DRAFT_LIMIT', '单次原生草稿同步最多 20 MiB。');
    return this.tx(() => {
      for (const entry of p.entries) {
        const leaseValue = this.setting(workspace, `editor-lease:${entry.objectId}`),
          lease = leaseValue ? decode(leaseValue) : null;
        if (
          lease &&
          lease.expires > Date.now() &&
          lease.owner !== this.auth(workspace, token, session, 'panel').owner
        )
          continue;
        const object = this.object(workspace, entry.objectId);
        if (object.kind !== 'file') fail('INVALID_FILE', '草稿必须属于原生文件。');
        const key = `native-editor-draft:${entry.objectId}:${entry.kind}`;
        if (entry.data === null)
          this.db.prepare('DELETE FROM settings WHERE workspace=? AND key=?').run(workspace, key);
        else {
          const parsed = JSON.parse(entry.data);
          if (parsed && typeof parsed === 'object')
            this.db
              .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
              .run(
                workspace,
                key,
                encode({ objectId: entry.objectId, kind: entry.kind, data: parsed }),
              );
          else fail('VALIDATION_FAILED', '原生草稿格式无效。');
        }
      }
      for (const objectId of new Set(p.entries.map((e) => e.objectId))) {
        const key = `editor-lease:${objectId}`,
          value = this.setting(workspace, key),
          lease = value ? decode(value) : null;
        if (lease?.owner === this.auth(workspace, token, session, 'panel').owner)
          this.db.prepare('UPDATE settings SET value=? WHERE workspace=? AND key=?').run(
            encode({
              ...lease,
              dirty: p.entries.some((e) => e.objectId === objectId && e.data !== null),
              expires: Date.now() + 90000,
            }),
            workspace,
            key,
          );
      }
      return { saved: p.entries.length };
    });
  },
  nativeDraftList(workspace: string, token: string, session: string | null) {
    this.auth(workspace, token, session, 'panel');
    return (
      this.db
        .prepare(
          "SELECT value FROM settings WHERE workspace=? AND key LIKE 'native-editor-draft:%'",
        )
        .all(workspace) as { value: string }[]
    ).map((row) => decode(row.value));
  },
  async officeRead(workspace: string, token: string, session: string | null, input: unknown) {
    const p = OfficeRead.parse(input);
    this.auth(workspace, token, session, 'panel');
    const object = this.object(workspace, p.objectId);
    if (object.kind !== 'file' || object.archived) fail('OFFICE_FILE', '请选择未归档的原生文档。');
    const content = FileContent.parse(
      object.revision === p.expectedRevision
        ? object.content
        : this.revision(workspace, token, session, object.id, p.expectedRevision).content,
    );
    if (!/\.(docx|pptx)$/i.test(content.fileName)) fail('OFFICE_FILE', '当前支持 DOCX 和PPTX。');
    const result = await this.officeEditor.read(
      readFileSync(join(this.directory, 'assets', content.assetHash)),
      content.fileName,
      object.id,
      p.expectedRevision,
      p.page,
      p.pageCount,
    );
    this.auth(workspace, token, session, 'panel');
    return result;
  },
  async officeSave(workspace: string, token: string, session: string | null, input: unknown) {
    const p = OfficeSave.parse(input),
      payload = { type: 'office.save', ...p };
    this.assertFileEditor(
      workspace,
      p.objectId,
      this.auth(workspace, token, session, 'panel').owner,
    );
    if (Buffer.byteLength(encode(p)) > 2 * 1024 * 1024)
      fail('OFFICE_LIMIT', '文档编辑草稿最多 2 MiB。');
    const receipt = this.db
      .prepare('SELECT payload_hash,result FROM receipts WHERE workspace=? AND request=?')
      .get(workspace, p.requestId) as any;
    if (receipt) {
      if (receipt.payload_hash !== hash(canonical(payload)))
        fail('REQUEST_ID_REUSED', '保存请求已用于不同内容。');
      return decode(receipt.result);
    }
    const object = this.object(workspace, p.objectId),
      previous = FileContent.parse(object.content);
    if (object.kind !== 'file' || object.archived || !/\.(docx|pptx)$/i.test(previous.fileName))
      fail('OFFICE_FILE', '请选择原生 DOCX 或 PPTX 文件。');
    if (object.revision !== p.expectedRevision)
      fail('REVISION_CONFLICT', '原文件已有新版本，请保留草稿并合并。');
    const bytes = await this.officeEditor.save(
      readFileSync(join(this.directory, 'assets', previous.assetHash)),
      previous.fileName,
      p.edits,
    );
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, p.requestId, payload, () => {
        const current = this.object(workspace, p.objectId);
        if (current.revision !== p.expectedRevision || current.archived)
          fail('REVISION_CONFLICT', '原文件已更新或归档，未覆盖。');
        if (
          this.db
            .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
            .get(workspace, current.id, Date.now())
        )
          fail('DRAFT_ACTIVE', '对象有其他未保存编辑。');
        const sha256 = hash(bytes);
        if (sha256 === previous.assetHash)
          return { objectId: object.id, revision: object.revision, changed: false };
        const content = FileContent.parse({
            ...previous,
            assetHash: this.writeAsset(bytes),
            size: bytes.length,
            storage: 'native',
          }),
          revision = current.revision + 1,
          at = now();
        this.db
          .prepare(
            "UPDATE objects SET content=?,revision=?,updated_at=?,actor='human' WHERE workspace=? AND id=?",
          )
          .run(encode(content), revision, at, workspace, current.id);
        this.db
          .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
          .run(
            workspace,
            current.id,
            revision,
            encode(content),
            'human',
            `原生文档编辑 ${p.edits.length} 处`,
            at,
          );
        this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
          workspace,
          `contribution:${current.id}:${revision}`,
          encode({
            operation: 'edit_native_office',
            baseRevision: current.revision,
            requestId: p.requestId,
            location: { type: 'object' },
            dependencies: [{ objectId: current.id, revision: current.revision }],
          }),
        );
        this.event(workspace, 'object.changed', current.id, revision, 'human');
        return { objectId: current.id, revision, sha256, changed: true };
      });
    });
  },
  textFileSave(workspace: string, token: string, session: string | null, input: unknown) {
    const p = TextFileSave.parse(input);
    this.assertFileEditor(
      workspace,
      p.objectId,
      this.auth(workspace, token, session, 'panel').owner,
    );
    return this.tx(() =>
      this.once(workspace, p.requestId, { type: 'text-file.save', ...p }, () => {
        const object = this.object(workspace, p.objectId);
        if (object.kind !== 'file' || object.archived)
          fail('TEXT_FILE', '请选择未归档的文本或代码文件。');
        if (object.revision !== p.expectedRevision)
          fail('REVISION_CONFLICT', '原文件已有新版本，未覆盖；请保留草稿并比较最新版本。');
        const previous = FileContent.parse(object.content);
        if (!isNativeTextFile(previous.fileName)) fail('TEXT_FILE', '此格式尚未接入文本编辑。');
        if (
          this.db
            .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
            .get(workspace, object.id, Date.now())
        )
          fail('DRAFT_ACTIVE', '对象有其他未保存编辑，请先处理。');
        const bytes = encodeNativeText(
            readFileSync(join(this.directory, 'assets', previous.assetHash)),
            p.text,
            p.newline,
          ),
          sha256 = hash(bytes);
        if (sha256 === previous.assetHash)
          return { objectId: object.id, revision: object.revision, sha256, changed: false };
        const content = FileContent.parse({
            ...previous,
            assetHash: this.writeAsset(bytes),
            size: bytes.length,
            storage: 'native',
          }),
          revision = object.revision + 1,
          at = now();
        this.db
          .prepare(
            "UPDATE objects SET content=?,revision=?,updated_at=?,actor='human' WHERE workspace=? AND id=?",
          )
          .run(encode(content), revision, at, workspace, object.id);
        this.db
          .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
          .run(
            workspace,
            object.id,
            revision,
            encode(content),
            'human',
            '文本编辑器保存原生文件',
            at,
          );
        this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
          workspace,
          `contribution:${object.id}:${revision}`,
          encode({
            operation: 'edit_native_text',
            baseRevision: object.revision,
            requestId: p.requestId,
            location: { type: 'object' },
            dependencies: [{ objectId: object.id, revision: object.revision }],
          }),
        );
        this.event(workspace, 'object.changed', object.id, revision, 'human');
        return { objectId: object.id, revision, sha256, changed: true };
      }),
    );
  },
  spreadsheetObject(
    workspace: string,
    token: string,
    session: string | null,
    objectId: string,
    revision: number,
  ) {
    this.auth(workspace, token, session, 'panel');
    const object = this.object(workspace, objectId);
    if (object.kind !== 'file' || object.archived)
      fail('XLSX_FILE', '请选择未归档的原生 XLSX 文件。');
    const content = FileContent.parse(object.content);
    if (!/\.xlsx$/i.test(content.fileName))
      fail('XLSX_FORMAT', '内嵌编辑当前支持 .xlsx；旧 .xls、宏工作簿与加密文件暂不支持。');
    if (object.revision !== revision)
      fail('REVISION_CONFLICT', '文件已在其他位置更新，本地编辑草稿已保留，请先比较最新文件。');
    return { object, content };
  },
  async spreadsheetRead(workspace: string, token: string, session: string | null, input: unknown) {
    const p = XlsxRead.parse(input);
    this.auth(workspace, token, session, 'panel');
    const object = this.object(workspace, p.objectId);
    if (Buffer.byteLength(encode(p)) > 2 * 1024 * 1024) fail('XLSX_LIMIT', '结构草稿最多2 MiB。');
    if (object.kind !== 'file' || object.archived)
      fail('XLSX_FILE', '请选择未归档的原生 XLSX 文件。');
    const content = FileContent.parse(
      p.expectedRevision === object.revision
        ? object.content
        : this.revision(workspace, token, session, p.objectId, p.expectedRevision).content,
    );
    if (!/\.xlsx$/i.test(content.fileName))
      fail('XLSX_FORMAT', '内嵌编辑当前支持 .xlsx；旧 .xls、宏工作簿与加密文件暂不支持。');
    const result = await this.xlsxEditor.page(
      readFileSync(join(this.directory, 'assets', content.assetHash)),
      content.assetHash,
      p,
      content.fileName,
    );
    this.auth(workspace, token, session, 'panel');
    if (this.object(workspace, p.objectId).archived) fail('OBJECT_ARCHIVED', '文件已归档。');
    return result;
  },
  async spreadsheetCalculate(
    workspace: string,
    token: string,
    session: string | null,
    input: unknown,
  ) {
    const p = XlsxCalculate.parse(input);
    this.auth(workspace, token, session, 'panel');
    if (Buffer.byteLength(encode(p)) > 2 * 1024 * 1024)
      fail('XLSX_LIMIT', '一次计算修改最多 2 MiB。');
    const object = this.object(workspace, p.objectId);
    if (object.kind !== 'file' || object.archived) fail('XLSX_FILE', '请选择未归档的 XLSX 文件。');
    const content = FileContent.parse(
      p.expectedRevision === object.revision
        ? object.content
        : this.revision(workspace, token, session, p.objectId, p.expectedRevision).content,
    );
    if (!/\.xlsx$/i.test(content.fileName)) fail('XLSX_FORMAT', '实时计算仅支持.xlsx 文件。');
    const result = await this.xlsxEditor.calculate(
      readFileSync(join(this.directory, 'assets', content.assetHash)),
      content.assetHash,
      p,
    );
    this.auth(workspace, token, session, 'panel');
    if (this.object(workspace, p.objectId).archived) fail('OBJECT_ARCHIVED', '文件已归档。');
    return result;
  },
  async spreadsheetSave(workspace: string, token: string, session: string | null, input: unknown) {
    const p = XlsxSave.parse(input),
      payload = { type: 'xlsx.save', ...p };
    this.assertFileEditor(
      workspace,
      p.objectId,
      this.auth(workspace, token, session, 'panel').owner,
    );
    const changedCells =
        p.edits.length +
        (p.operations ?? []).reduce((n, op) => n + (op.editsBefore?.length ?? 0), 0),
      structureChanges = p.operations?.length ?? 0;
    if (Buffer.byteLength(encode(p)) > 2 * 1024 * 1024 || changedCells > 2000)
      fail('XLSX_LIMIT', '一次编辑最多 2000 格 / 2 MiB，请分批保存。');
    const existing = this.db
      .prepare('SELECT payload_hash,result FROM receipts WHERE workspace=? AND request=?')
      .get(workspace, p.requestId) as { payload_hash: string; result: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== hash(canonical(payload)))
        fail('REQUEST_ID_REUSED', '保存请求标识已用于不同修改。');
      return decode(existing.result);
    }
    const { content } = this.spreadsheetObject(
      workspace,
      token,
      session,
      p.objectId,
      p.expectedRevision,
    );
    const bytes = await this.xlsxEditor.save(
      readFileSync(join(this.directory, 'assets', content.assetHash)),
      content.assetHash,
      p.edits,
      p.operations,
    );
    return this.tx(() => {
      this.auth(workspace, token, session, 'panel');
      return this.once(workspace, p.requestId, payload, () => {
        const { object, content: current } = this.spreadsheetObject(
          workspace,
          token,
          session,
          p.objectId,
          p.expectedRevision,
        );
        if (current.assetHash !== content.assetHash)
          fail('REVISION_CONFLICT', '文件源版本已改变，未覆盖当前文件。');
        if (
          this.db
            .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
            .get(workspace, object.id, Date.now())
        )
          fail('DRAFT_ACTIVE', '对象有其他未保存编辑，请先处理。');
        const updated = FileContent.parse({
            ...current,
            assetHash: this.writeAsset(bytes),
            size: bytes.length,
            storage: 'native',
          }),
          revision = object.revision + 1,
          at = now();
        this.db
          .prepare(
            "UPDATE objects SET content=?,revision=?,updated_at=?,actor='human' WHERE workspace=? AND id=?",
          )
          .run(encode(updated), revision, at, workspace, object.id);
        this.db
          .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
          .run(
            workspace,
            object.id,
            revision,
            encode(updated),
            'human',
            `表格编辑器修改 ${changedCells} 个单元格${structureChanges ? ` / ${structureChanges} 次结构操作` : ''}`,
            at,
          );
        this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
          workspace,
          `contribution:${object.id}:${revision}`,
          encode({
            operation: 'edit_native_xlsx',
            baseRevision: object.revision,
            requestId: p.requestId,
            location: { type: 'object' },
            cells: p.edits.map(({ sheetId, address }) => ({ sheetId, address })),
            structureOperations: p.operations?.map(({ editsBefore, ...operation }) => ({
              ...operation,
              cellsBefore: editsBefore?.map(({ sheetId, address }) => ({ sheetId, address })),
            })),
            dependencies: [{ objectId: object.id, revision: object.revision }],
          }),
        );
        this.event(workspace, 'object.changed', object.id, revision, 'human');
        this.event(workspace, 'spreadsheet.saved', object.id, revision, 'human');
        return {
          objectId: object.id,
          revision,
          fileName: updated.fileName,
          sha256: updated.assetHash,
          changedCells,
          structureChanges,
        };
      });
    });
  },
  nativeFileAuthority(
    workspace: string,
    token: string,
    session: string | null,
    objectId: string,
    write: boolean,
  ) {
    const auth = this.auth(workspace, token, session, 'execution');
    const taskContext = this.nativeTasks.fileAccess(auth, objectId, write);
    const binding = this.db.prepare('SELECT session FROM workspaces WHERE id=?').get(workspace) as
      | { session: string | null }
      | undefined;
    if (!taskContext && (!session || binding?.session !== session))
      fail('SESSION_MISMATCH', '请在此桌面关联的 Codex 原对话中处理文件。');
    if (!taskContext && auth.status !== 'active')
      fail('FILE_SELECTION_REQUIRED', '请使用原对话引用或当前任务的有效材料凭据。');
    if (!auth.scope.includes(objectId)) fail('PERMISSION_DENIED', '原生文件不在本次引用范围内。');
    const object = this.object(workspace, objectId);
    if (object.kind !== 'file' || object.archived || object.policy?.private)
      fail('PERMISSION_DENIED', '只能处理已引用、未归档且允许 AI 读取的原生文件。');
    if (write && (object.policy?.locked || object.policy?.protectedRanges.length))
      fail('LOCKED_CONTENT', '文件已设为保留项，不能由 AI 回写。');
    if (
      this.setting(workspace, `execution-ranges:${auth.owner}`) &&
      decode<Record<string, MaterialRange>>(
        this.setting(workspace, `execution-ranges:${auth.owner}`),
      )[objectId]
    )
      fail('FILE_SELECTION_REQUIRED', '原生文件需要引用完整对象。');
    if (write) {
      this.workManagement.guardWrite(workspace, this.executionContext.getStore(), [object.id]);
      this.assertFileEditor(workspace, object.id, auth.owner);
    }
    return {
      object,
      owner: auth.owner,
      observed: auth.observed,
      task: taskContext ? this.nativeTasks.fileBinding(taskContext) : undefined,
      taskContext,
    };
  },
  /** Called inside NativeFiles' transaction, so the revision and its receipt commit together. */
  commitNativeResult(
    workspace: string,
    token: string,
    session: string | null,
    record: NativeFileSession,
    bytes: Buffer,
    summary: string,
  ) {
    const { object, owner, observed, taskContext } = this.nativeFileAuthority(
      workspace,
      token,
      session,
      record.objectId,
      true,
    );
    this.assertFileEditor(workspace, object.id, owner);
    const execution = taskContext
      ? this.nativeTasks.beforeCommit(taskContext, [object.id])
      : undefined;
    const previous = FileContent.parse(object.content),
      sha256 = hash(bytes),
      at = now();
    if (object.revision !== record.baseRevision) {
      // The linked output file can reach the desktop before the explicit file-result commit.
      // Exact bytes mean this session's result is already present; keep the existing revision.
      if (previous.assetHash === sha256 && previous.size === bytes.length)
        return {
          objectId: object.id,
          revision: object.revision,
          sha256,
          bytes: bytes.length,
          changed: false,
          committedAt: at,
        };
      fail(
        'REVISION_CONFLICT',
        '桌面文件已有新版本。工作副本已保留，请重新引用最新文件，比较合并后再回写。',
      );
    }
    for (const [objectId, revision] of Object.entries(observed)) {
      if (this.object(workspace, objectId).revision !== revision)
        fail('STALE_INPUT', '引用的资料已有变化，请重新引用最新材料后继续回写同一工作副本。');
    }
    for (const dependency of record.dependencies)
      if (this.object(workspace, dependency.objectId).revision !== dependency.revision)
        fail('STALE_INPUT', '工作副本所依据的材料已变化，请按最新任务来源重新准备文件。');
    if (
      this.db
        .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
        .get(workspace, object.id, Date.now())
    )
      fail('DRAFT_ACTIVE', '文件有未保存编辑，工作副本已保留。');
    if (previous.assetHash !== record.baseSha256)
      fail('REVISION_CONFLICT', '源文件与本次处理的基础版本不一致，未覆盖桌面文件。');
    if (sha256 === previous.assetHash)
      return {
        objectId: object.id,
        revision: object.revision,
        sha256,
        bytes: bytes.length,
        changed: false,
        committedAt: at,
      };
    const content = FileContent.parse({
        ...previous,
        storage: 'native',
        assetHash: this.writeAsset(bytes),
        size: bytes.length,
      }),
      revision = object.revision + 1;
    this.db
      .prepare(
        "UPDATE objects SET content=?,revision=?,updated_at=?,actor='ai' WHERE workspace=? AND id=?",
      )
      .run(encode(content), revision, at, workspace, object.id);
    this.db
      .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
      .run(workspace, object.id, revision, encode(content), 'ai', summary, at);
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)').run(
      workspace,
      `contribution:${object.id}:${revision}`,
      encode({
        operation: 'replace_native_file',
        baseRevision: record.baseRevision,
        requestId: record.id,
        snapshotId: owner,
        preparedSnapshotId: record.owner,
        location: { type: 'object' },
        dependencies: record.dependencies,
        ...(execution ? { execution } : {}),
      }),
    );
    observed[object.id] = revision;
    this.db
      .prepare('UPDATE credentials SET observed=? WHERE token_hash=?')
      .run(encode(observed), hash(token));
    this.event(workspace, 'object.changed', object.id, revision, 'ai');
    if (taskContext)
      this.nativeTasks.committed(taskContext, [{ objectId: object.id, revision }], {});
    return {
      objectId: object.id,
      revision,
      sha256,
      bytes: bytes.length,
      changed: true,
      committedAt: at,
    };
  },
};
