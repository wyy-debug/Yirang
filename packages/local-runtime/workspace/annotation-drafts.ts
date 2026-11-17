import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  AnnotationList,
  DesktopError,
  Id,
  fail,
  type AnnotationDraft,
  type AnnotationDraftSummary,
  type CommitInput,
  type DesktopObject,
} from '../../contracts/index.js';

type Auth = { owner: string; kind: 'panel' | 'execution' };
type Api = {
  tx: <T>(fn: () => T) => T;
  once: <T>(workspace: string, request: string, payload: unknown, fn: () => T) => T;
  auth: (
    workspace: string,
    credential: string,
    session: string | null,
    kind?: 'panel' | 'execution',
  ) => Auth;
  object: (workspace: string, id: string) => DesktopObject;
  commit: (
    input: CommitInput,
    session: string | null,
  ) => { changed: { objectId: string; revision: number }[]; cursor: number };
  payloadHash: (input: unknown) => string;
};
const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('get'), id: Id }).strict(),
  z
    .object({
      operation: z.literal('write'),
      id: Id,
      objectId: Id,
      expectedVersion: z.number().int().nonnegative(),
      baseRevision: z.number().int().positive(),
      annotations: AnnotationList,
      requestId: Id,
    })
    .strict(),
  z
    .object({
      operation: z.literal('claim'),
      id: Id,
      expectedVersion: z.number().int().positive(),
      requestId: Id,
    })
    .strict(),
  z
    .object({
      operation: z.literal('discard'),
      id: Id,
      expectedVersion: z.number().int().positive(),
      requestId: Id,
    })
    .strict(),
  z
    .object({ operation: z.literal('renew'), id: Id, expectedVersion: z.number().int().positive() })
    .strict(),
  z
    .object({
      operation: z.literal('release'),
      id: Id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('save'),
      id: Id,
      expectedVersion: z.number().int().positive(),
      requestId: Id,
    })
    .strict(),
]);
const now = () => new Date().toISOString();
const key = (id: string) => `annotation-draft:${id}`;

/** Durable annotation buffers and short editing leases; canonical content changes only on Save. */
export class AnnotationDrafts {
  constructor(
    private db: DatabaseSync,
    private api: Api,
  ) {}
  private get(workspace: string, id: string) {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(workspace, key(id)) as { value: string } | undefined;
    if (!row) fail('NOT_FOUND', '批注草稿不存在。');
    return JSON.parse(row.value) as AnnotationDraft;
  }
  private put(workspace: string, draft: AnnotationDraft) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(workspace, key(draft.id), JSON.stringify(draft));
  }
  private receipt(workspace: string, draft: AnnotationDraft) {
    if (!draft.pending) return;
    const row = this.db
      .prepare('SELECT result,payload_hash FROM receipts WHERE workspace=? AND request=?')
      .get(workspace, draft.pending.requestId) as
      | { result: string; payload_hash: string }
      | undefined;
    if (!row) return;
    if (row.payload_hash !== draft.pending.payloadHash)
      fail('REQUEST_ID_REUSED', '保存回执与原批注请求不匹配。');
    const result = JSON.parse(row.result) as { changed?: { objectId: string; revision: number }[] };
    const changed = result.changed?.find((value) => value.objectId === draft.objectId);
    if (!changed) fail('REQUEST_ID_REUSED', '保存请求与草稿不匹配。');
    draft.state = 'saved';
    draft.savedRevision = changed.revision;
    draft.pending = undefined;
    draft.version++;
    draft.updatedAt = now();
    this.put(workspace, draft);
  }
  private own(draft: AnnotationDraft, auth: Auth, expectedVersion: number) {
    if (draft.state !== 'editing')
      fail('DRAFT_FINISHED', '这份草稿已经保存或放弃，请重新载入草稿记录。');
    if (draft.owner !== auth.owner) fail('DRAFT_OWNER', '请先恢复这份批注草稿，再继续编辑。');
    if (draft.version !== expectedVersion)
      fail('REVISION_CONFLICT', '草稿已更新，请重新载入后比较。');
  }
  private lease(workspace: string, draft: AnnotationDraft, acquire = false) {
    const other = this.db
      .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND owner<>? AND expires>?')
      .get(workspace, draft.objectId, draft.owner, Date.now());
    if (other) fail('DRAFT_ACTIVE', '另一个面板正在编辑此图片，请等待其保存或离开。');
    const activeKey = `annotation-active:${draft.owner}:${draft.objectId}`;
    const active = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(workspace, activeKey) as { value: string } | undefined;
    if (active?.value !== draft.id) {
      if (!acquire)
        fail('DRAFT_REPLACED', '此图片已经由另一份草稿继续编辑，请重新选择要恢复的草稿。');
      const ownLease = this.db
        .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND owner=? AND expires>?')
        .get(workspace, draft.objectId, draft.owner, Date.now());
      if (ownLease) fail('DRAFT_ACTIVE', '此面板已有这张图片的草稿，请先恢复、保存或放弃原草稿。');
      this.db
        .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
        .run(workspace, activeKey, draft.id);
    }
    const object = this.api.object(workspace, draft.objectId);
    if (object.kind !== 'image' || object.archived)
      fail('OBJECT_UNAVAILABLE', '图片已归档或不可编辑。');
    this.db
      .prepare(
        'INSERT INTO drafts VALUES(?,?,?,?,?,?) ON CONFLICT(workspace,object_id,owner) DO UPDATE SET base=excluded.base,content=excluded.content,expires=excluded.expires',
      )
      .run(
        workspace,
        draft.objectId,
        draft.owner,
        draft.baseRevision,
        JSON.stringify({ ...object.content, annotations: draft.annotations }),
        Date.now() + 30000,
      );
  }
  list(workspace: string, credential: string, session: string | null) {
    return this.api.tx(() => {
      const auth = this.api.auth(workspace, credential, session, 'panel');
      const rows = this.db
        .prepare("SELECT value FROM settings WHERE workspace=? AND key LIKE 'annotation-draft:%'")
        .all(workspace) as { value: string }[];
      const result: AnnotationDraftSummary[] = [];
      for (const row of rows) {
        const draft = JSON.parse(row.value) as AnnotationDraft;
        this.receipt(workspace, draft);
        if (draft.state !== 'editing') continue;
        const object = this.api.object(workspace, draft.objectId);
        const lease = this.db
          .prepare('SELECT MAX(expires) AS expires FROM drafts WHERE workspace=? AND object_id=?')
          .get(workspace, draft.objectId) as { expires: number | null };
        result.push({
          id: draft.id,
          objectId: draft.objectId,
          title: object.title,
          version: draft.version,
          baseRevision: draft.baseRevision,
          updatedAt: draft.updatedAt,
          annotationCount: draft.annotations.length,
          leaseUntil: lease.expires ?? 0,
          own: draft.owner === auth.owner,
          pending: !!draft.pending,
        });
      }
      return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }
  guard(workspace: string, auth: Auth, input: CommitInput) {
    const reference = input.annotationDraft;
    if (!reference) return;
    const draft = this.get(workspace, reference.id);
    this.own(draft, auth, reference.version);
    if (
      auth.kind !== 'panel' ||
      draft.pending?.requestId !== input.requestId ||
      draft.pending.version !== reference.version ||
      input.operations.length !== 1 ||
      input.operations[0].type !== 'annotate_image' ||
      input.operations[0].objectId !== draft.objectId ||
      input.expectedRevisions[draft.objectId] !== draft.baseRevision ||
      JSON.stringify(input.operations[0].annotations) !== JSON.stringify(draft.annotations)
    )
      fail('DRAFT_CHANGED', '草稿的所有者、内容或保存代次已变化，本次旧请求没有提交。');
    this.lease(workspace, draft);
  }
  action(workspace: string, credential: string, session: string | null, input: unknown): any {
    const p = Input.parse(input);
    const prepared: { draft: AnnotationDraft; commit?: CommitInput } = this.api.tx(() => {
      const auth = this.api.auth(workspace, credential, session, 'panel');
      if (p.operation === 'write') {
        return this.api.once(
          workspace,
          p.requestId,
          { ...p, scope: 'annotation-draft', owner: auth.owner },
          () => {
            let draft: AnnotationDraft;
            if (p.expectedVersion === 0) {
              if (
                this.db
                  .prepare('SELECT 1 FROM settings WHERE workspace=? AND key=?')
                  .get(workspace, key(p.id))
              )
                fail('REVISION_CONFLICT', '草稿标识已存在，请重新载入。');
              const rows = this.db
                .prepare(
                  "SELECT value FROM settings WHERE workspace=? AND key LIKE 'annotation-draft:%'",
                )
                .all(workspace) as { value: string }[];
              if (rows.filter((row) => JSON.parse(row.value).state === 'editing').length >= 200)
                fail('DRAFT_LIMIT', '未完成批注草稿已达 200 份，请整理后再创建。');
              draft = {
                id: p.id,
                objectId: p.objectId,
                owner: auth.owner,
                version: 0,
                baseRevision: p.baseRevision,
                before: [],
                annotations: p.annotations,
                state: 'editing',
                updatedAt: now(),
              };
            } else {
              draft = this.get(workspace, p.id);
              this.receipt(workspace, draft);
              this.own(draft, auth, p.expectedVersion);
              if (draft.pending) fail('SAVE_UNKNOWN', '上一次保存尚待确认，请先重试原保存。');
              if (draft.objectId !== p.objectId)
                fail('PERMISSION_DENIED', '不能把草稿改为其他图片。');
            }
            const object = this.api.object(workspace, p.objectId);
            if (object.kind !== 'image') fail('VALIDATION_FAILED', '此草稿只能用于图片批注。');
            const baseline = this.db
              .prepare(
                'SELECT content FROM revisions WHERE workspace=? AND object_id=? AND revision=?',
              )
              .get(workspace, p.objectId, p.baseRevision) as { content: string } | undefined;
            if (!baseline) fail('NOT_FOUND', '批注草稿的原版本不存在。');
            draft.baseRevision = p.baseRevision;
            draft.before = AnnotationList.parse(JSON.parse(baseline.content).annotations);
            draft.annotations = p.annotations;
            draft.version++;
            draft.updatedAt = now();
            this.lease(workspace, draft, p.expectedVersion === 0);
            this.put(workspace, draft);
            return { draft };
          },
        );
      }
      const draft = this.get(workspace, p.id);
      this.receipt(workspace, draft);
      if (p.operation === 'get') return { draft };
      if (p.operation === 'claim') {
        if (draft.state === 'saved') return { draft };
        return this.api.once(
          workspace,
          p.requestId,
          { ...p, scope: 'annotation-draft', owner: auth.owner },
          () => {
            if (draft.state !== 'editing' || draft.version !== p.expectedVersion)
              fail('REVISION_CONFLICT', '草稿已变化，请刷新后再恢复。');
            if (draft.owner === auth.owner) {
              this.lease(workspace, draft, true);
              return { draft };
            }
            // The old request's generation becomes invalid atomically with the new lease.
            draft.owner = auth.owner;
            draft.pending = undefined;
            draft.version++;
            draft.updatedAt = now();
            this.lease(workspace, draft, true);
            this.put(workspace, draft);
            return { draft };
          },
        );
      }
      if (p.operation === 'save' && draft.state === 'saved') return { draft };
      this.own(
        draft,
        auth,
        p.operation === 'save' && draft.pending?.requestId === p.requestId
          ? draft.version
          : p.expectedVersion,
      );
      if (p.operation === 'renew') {
        this.lease(workspace, draft);
        return { draft };
      }
      if (p.operation === 'release') {
        const active = this.db
          .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
          .get(workspace, `annotation-active:${auth.owner}:${draft.objectId}`) as
          | { value: string }
          | undefined;
        if (active?.value === draft.id)
          this.db
            .prepare('UPDATE drafts SET expires=? WHERE workspace=? AND object_id=? AND owner=?')
            .run(Date.now() - 1, workspace, draft.objectId, auth.owner);
        return { draft };
      }
      if (p.operation === 'discard') {
        if (draft.pending) fail('SAVE_UNKNOWN', '请先确认原保存结果，再放弃草稿。');
        draft.state = 'discarded';
        draft.version++;
        draft.updatedAt = now();
        this.put(workspace, draft);
        const active = this.db
          .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
          .get(workspace, `annotation-active:${auth.owner}:${draft.objectId}`) as
          | { value: string }
          | undefined;
        if (active?.value === draft.id)
          this.db
            .prepare('DELETE FROM drafts WHERE workspace=? AND object_id=? AND owner=?')
            .run(workspace, draft.objectId, auth.owner);
        return { draft };
      }
      if (draft.pending && draft.pending.requestId !== p.requestId)
        fail('SAVE_UNKNOWN', '请使用原请求继续确认保存。');
      if (!draft.pending) {
        if (
          this.db
            .prepare('SELECT 1 FROM receipts WHERE workspace=? AND request=?')
            .get(workspace, p.requestId)
        )
          fail('REQUEST_ID_REUSED', '此保存请求标识已经使用。');
        draft.version++;
        draft.pending = { requestId: p.requestId, version: draft.version };
        draft.updatedAt = now();
        this.put(workspace, draft);
      }
      this.lease(workspace, draft);
      const commit: CommitInput = {
        workspaceId: workspace,
        credential,
        requestId: p.requestId,
        expectedRevisions: { [draft.objectId]: draft.baseRevision },
        operations: [
          { type: 'annotate_image', objectId: draft.objectId, annotations: draft.annotations },
        ],
        summary: '用户编辑图片批注',
        annotationDraft: { id: draft.id, version: draft.version },
      };
      draft.pending!.payloadHash = this.api.payloadHash(commit);
      this.put(workspace, draft);
      return { draft, commit };
    });
    const commit = prepared.commit;
    if (!commit) return prepared;
    try {
      this.api.commit(commit, session);
      return this.api.tx(() => {
        const draft = this.get(workspace, p.id);
        this.receipt(workspace, draft);
        return { draft };
      });
    } catch (error) {
      if (!(error instanceof DesktopError)) throw error;
      return this.api.tx(() => {
        const draft = this.get(workspace, p.id);
        this.receipt(workspace, draft);
        if (draft.state === 'saved') return { draft };
        if (
          draft.pending?.requestId === commit.requestId &&
          draft.version === prepared.draft.version
        ) {
          draft.pending = undefined;
          draft.version++;
          draft.updatedAt = now();
          this.put(workspace, draft);
        }
        return { draft, error: { code: error.code, message: error.message } };
      });
    }
  }
}
