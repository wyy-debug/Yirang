import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DesktopError, fail } from '../../contracts/index.js';
import {
  DesktopSearch,
  SearchHits,
  SearchLocate,
  RetrievalConfiguration,
} from '../../contracts/retrieval.js';
import { RetrievalClient } from './retrieval-client.js';

type Hit = {
  session: string;
  workspace: string;
  chunkId: string;
  objectId: string;
  revision: number;
  contentHash: string;
  regionId?: string;
  expires: number;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** Rebuildable index + short-lived citations. The source database is always authoritative. */
export class DesktopRetrieval {
  private client: RetrievalClient;
  private hits = new Map<string, Hit>();
  constructor(
    private db: DatabaseSync,
    directory: string,
  ) {
    this.client = new RetrievalClient(directory);
  }
  close() {
    this.hits.clear();
    this.client.close();
  }
  private current(session: string | null) {
    if (!session) fail('SESSION_REQUIRED', '请先打开工作桌面');
    const row = this.db
      .prepare('SELECT id,name FROM workspaces WHERE session=?')
      .get(session) as any;
    if (!row) fail('NOT_FOUND', '请先打开工作桌面');
    return row;
  }
  private object(hit: Hit) {
    if (this.current(hit.session).id !== hit.workspace)
      fail('WORKSPACE_CHANGED', '工作区已切换，请重新搜索');
    const row = this.db
      .prepare(
        `SELECT o.* FROM objects o
   LEFT JOIN settings a ON a.workspace=o.workspace AND a.key='archived:'||o.id
   LEFT JOIN settings p ON p.workspace=o.workspace AND p.key='policy:'||o.id
   WHERE o.workspace=? AND o.id=? AND coalesce(a.value,'false')!='true' AND coalesce(json_extract(p.value,'$.private'),0)!=1`,
      )
      .get(hit.workspace, hit.objectId) as any;
    if (
      !row ||
      row.revision !== hit.revision ||
      hash(row.kind === 'file' ? String(JSON.parse(row.content).assetHash) : row.content) !==
        hit.contentHash
    )
      fail('SEARCH_STALE', '材料已删除、设为私有或有新版本，请重新搜索');
    return row;
  }
  private async read(session: string, id: string) {
    const hit = this.hits.get(id);
    if (!hit || hit.session !== session || hit.expires < Date.now()) {
      this.hits.delete(id);
      fail('SEARCH_EXPIRED', '检索引用已过期，请重新搜索');
    }
    this.object(hit);
    const row = await this.client.request('read', {
      workspace: hit.workspace,
      chunkId: hit.chunkId,
      regionId: hit.regionId,
    });
    this.object(hit);
    return {
      hitId: id,
      workspaceId: hit.workspace,
      objectId: hit.objectId,
      revision: hit.revision,
      title: row.title,
      location: row.location,
      target: row.target,
      text: row.text,
    };
  }
  async command(session: string | null, operation: string, p: any = {}) {
    try {
      if (operation === 'configure') {
        if (process.env.AI_DESKTOP_SEARCH_OWNER !== '1')
          fail('PERMISSION_DENIED', '向量服务配置仅能从桌面设置修改');
        return await this.client.request('configure', RetrievalConfiguration.parse(p));
      }
      const current = this.current(session),
        workspace = current.id;
      if (p.workspaceId && p.workspaceId !== workspace)
        fail('WORKSPACE_CHANGED', '检索仅限当前工作区，请重新选择');
      if (operation === 'search') {
        const input = DesktopSearch.parse(p),
          result = await this.client.request('search', { ...input, workspace });
        if (this.current(session).id !== workspace)
          fail('WORKSPACE_CHANGED', '搜索期间切换了工作区，请重新搜索');
        const hits = [];
        for (const row of result.hits) {
          const hit: Hit = {
            session: session!,
            workspace,
            chunkId: row.id,
            objectId: row.object_id,
            revision: row.revision,
            contentHash: row.content_hash,
            regionId: input.regionId,
            expires: Date.now() + 10 * 60 * 1000,
          };
          try {
            this.object(hit);
          } catch {
            continue;
          }
          const hitId = randomUUID();
          this.hits.set(hitId, hit);
          hits.push({
            kind: 'material',
            hitId,
            workspaceId: workspace,
            workspaceName: current.name,
            objectId: row.object_id,
            revision: row.revision,
            title: row.title,
            location: row.location,
            target: row.target,
            text: row.text,
            score: row.score,
            matchedBy: row.matchedBy,
          });
        }
        for (const [id, hit] of this.hits) if (hit.expires < Date.now()) this.hits.delete(id);
        while (this.hits.size > 1000) this.hits.delete(this.hits.keys().next().value!);
        return { ...result, hits, workspaceId: workspace, workspaceName: current.name };
      }
      if (operation === 'read') {
        const { hitIds } = SearchHits.parse(p);
        const hits = [];
        for (const id of hitIds) hits.push(await this.read(session!, id));
        for (const id of hitIds) {
          const hit = this.hits.get(id);
          if (!hit || hit.expires < Date.now())
            fail('SEARCH_EXPIRED', '检索引用已过期，请重新搜索');
          this.object(hit);
        }
        return { hits };
      }
      if (operation === 'locate') {
        const input = SearchLocate.parse(p),
          hit = await this.read(session!, input.hitId);
        return {
          workspaceId: workspace,
          objectIds: [hit.objectId],
          openObject: input.openObject,
          target: hit.target,
          expectedRevisions: { [hit.objectId]: hit.revision },
        };
      }
      if (operation === 'status' || operation === 'rebuild') {
        const result = await this.client.request(operation, { workspace });
        if (this.current(session).id !== workspace)
          fail('WORKSPACE_CHANGED', '工作区已切换，请刷新');
        const row = this.db
          .prepare("SELECT value FROM settings WHERE workspace=? AND key='canvas-groups'")
          .get(workspace) as any;
        return {
          ...result,
          workspaceId: workspace,
          workspaceName: current.name,
          regions: (JSON.parse(row?.value || '{}').items || []).map((r: any) => ({
            id: r.id,
            name: r.name,
            parentId: r.parentId,
          })),
        };
      }
      fail('VALIDATION_FAILED', '未知检索操作');
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError(
        'RETRIEVAL_ERROR',
        error instanceof Error ? error.message : '桌面检索暂不可用',
      );
    }
  }
}
