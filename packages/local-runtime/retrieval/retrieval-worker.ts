import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as sqliteVec from 'sqlite-vec';
import { chunks, contentHash, digest, extract, terms } from './retrieval-extract.js';
import type { RetrievalConfig } from '../../contracts/retrieval.js';

const directory = String(workerData.directory),
  cache = join(directory, 'retrieval');
mkdirSync(cache, { recursive: true });
const source = new DatabaseSync(join(directory, 'desktop.sqlite'), { readOnly: true });
source.exec('PRAGMA busy_timeout=200');
const db = new DatabaseSync(join(cache, 'index.sqlite'), { allowExtension: true });
let vectorAvailable = true;
try {
  sqliteVec.load(db);
} catch {
  vectorAvailable = false;
} finally {
  db.enableLoadExtension(false);
}
db.exec(`PRAGMA busy_timeout=500; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;
 CREATE TABLE IF NOT EXISTS documents(workspace TEXT NOT NULL,object_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,content_hash TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS search_documents_workspace ON documents(workspace);
 CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,object_id TEXT NOT NULL REFERENCES documents(object_id) ON DELETE CASCADE,revision INTEGER NOT NULL,content_hash TEXT NOT NULL,location TEXT NOT NULL,target TEXT NOT NULL,text TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS search_chunks_object ON chunks(object_id);
 CREATE INDEX IF NOT EXISTS search_chunks_workspace ON chunks(workspace);
 CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED,title,body,tokenize='unicode61');
 CREATE TABLE IF NOT EXISTS vectors(chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,model_key TEXT NOT NULL,embedding BLOB NOT NULL);
 CREATE INDEX IF NOT EXISTS search_vectors_model ON vectors(model_key);
`);
let config: RetrievalConfig = {
    endpoint: '',
    model: '',
    apiKey: '',
    enabledWorkspaces: [],
    paused: false,
  },
  modelKey = '',
  generation = 0,
  networkError = '',
  retryAt = 0,
  embeddingBusy = false,
  queries = 0;
const requests = new Set<AbortController>(),
  queue = new Map<string, { workspace: string; id: string }>(),
  queryCache = new Map<string, number[]>();
let cursor = Number(
    (source.prepare('SELECT coalesce(max(seq),0) AS n FROM events').get() as any).n,
  ),
  bootstrapRow = 0,
  bootstrapped = false,
  cycle = 0,
  reconcileRow = 0,
  purgeCursor = '';
const settings = (workspace: string, key: string) => {
  const row = source
    .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
    .get(workspace, key) as any;
  return row ? JSON.parse(row.value) : null;
};
function live(workspace: string, id: string) {
  const row = source
    .prepare('SELECT * FROM objects WHERE workspace=? AND id=?')
    .get(workspace, id) as any;
  return row &&
    !settings(workspace, `archived:${id}`) &&
    !settings(workspace, `policy:${id}`)?.private
    ? row
    : null;
}
function purge(id: string) {
  db.exec('BEGIN');
  try {
    db.prepare(
      'DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE object_id=?)',
    ).run(id);
    db.prepare('DELETE FROM documents WHERE object_id=?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function same(row: any, other: any) {
  return (
    !!other &&
    row.revision === other.revision &&
    row.title === other.title &&
    row.content === other.content
  );
}
async function indexObject(workspace: string, id: string) {
  const row = live(workspace, id);
  if (!row) {
    purge(id);
    return;
  }
  const hash = contentHash(row),
    previous = db.prepare('SELECT * FROM documents WHERE object_id=?').get(id) as any;
  if (
    previous &&
    previous.revision === row.revision &&
    previous.title === row.title &&
    previous.content_hash === hash
  )
    return;
  // Content-identical saves only change revision. No parsing or vector request is needed.
  if (previous && previous.content_hash === hash && previous.title === row.title) {
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE documents SET revision=?,updated_at=? WHERE object_id=?').run(
        row.revision,
        Date.now(),
        id,
      );
      db.prepare('UPDATE chunks SET revision=? WHERE object_id=?').run(row.revision, id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return;
  }
  let parsed: { segments: any[]; note: string },
    state = 'ready';
  try {
    parsed = await extract(row, directory);
  } catch {
    parsed = { segments: [], note: '正文提取失败，已保留名称检索；可重建索引重试' };
    state = 'failed';
  }
  if (!same(row, live(workspace, id))) {
    queue.set(id, { workspace, id });
    return;
  }
  const parts = chunks(row, parsed.segments),
    ids = parts.map((p) => p.id);
  if (parsed.note && state === 'ready') state = 'partial';
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO documents VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,title=excluded.title,status=excluded.status,note=excluded.note,updated_at=excluded.updated_at`,
    ).run(workspace, id, row.revision, hash, row.title, state, parsed.note, Date.now());
    db.prepare(
      'DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE object_id=?)',
    ).run(id);
    db.prepare(
      'DELETE FROM chunks WHERE object_id=? AND id NOT IN (SELECT value FROM json_each(?))',
    ).run(id, JSON.stringify(ids));
    const put = db.prepare(
        `INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash`,
      ),
      fts = db.prepare('INSERT INTO chunks_fts(chunk_id,title,body) VALUES(?,?,?)'),
      title = terms(row.title).join(' ');
    for (const p of parts) {
      put.run(
        p.id,
        workspace,
        id,
        row.revision,
        hash,
        p.location,
        JSON.stringify(p.target),
        p.text,
      );
      fts.run(p.id, title, p.tokens);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function collectChanges() {
  if (!bootstrapped) {
    const rows = source
      .prepare('SELECT rowid AS n,id,workspace FROM objects WHERE rowid>? ORDER BY rowid LIMIT 100')
      .all(bootstrapRow) as any[];
    for (const row of rows) {
      bootstrapRow = row.n;
      queue.set(row.id, { id: row.id, workspace: row.workspace });
    }
    if (rows.length < 100) bootstrapped = true;
  }
  const changes = source
    .prepare('SELECT seq,type,object_id,workspace FROM events WHERE seq>? ORDER BY seq LIMIT 400')
    .all(cursor) as any[];
  for (const e of changes) {
    cursor = e.seq;
    if (
      e.object_id &&
      /^object\.(created|changed|rename|archive|archived|unarchive|policy|metadata|restored|undone|purged)$/.test(
        e.type,
      )
    )
      queue.set(e.object_id, { id: e.object_id, workspace: e.workspace });
  }
  // Purges and archives are removed even after a restart or a pruned event stream.
  if (cycle++ % 20 === 0) {
    const deleted = db
      .prepare(
        'SELECT object_id,workspace FROM documents WHERE object_id>? ORDER BY object_id LIMIT 100',
      )
      .all(purgeCursor) as any[];
    for (const row of deleted) {
      purgeCursor = row.object_id;
      if (!live(row.workspace, row.object_id)) purge(row.object_id);
    }
    if (deleted.length < 100) purgeCursor = '';
    const rows = source
      .prepare(
        'SELECT rowid AS n,id,workspace,revision,title FROM objects WHERE rowid>? ORDER BY rowid LIMIT 100',
      )
      .all(reconcileRow) as any[];
    for (const row of rows) {
      reconcileRow = row.n;
      const old = db
        .prepare('SELECT revision,title FROM documents WHERE object_id=?')
        .get(row.id) as any;
      if (!old || old.revision !== row.revision || old.title !== row.title)
        queue.set(row.id, { id: row.id, workspace: row.workspace });
    }
    if (rows.length < 100) reconcileRow = 0;
  }
}
function allowed(workspace: string, regionId?: string, objectIds?: string[]) {
  const rows = source
    .prepare(
      `SELECT o.id,o.revision,o.bounds FROM objects o
 LEFT JOIN settings a ON a.workspace=o.workspace AND a.key='archived:'||o.id
 LEFT JOIN settings p ON p.workspace=o.workspace AND p.key='policy:'||o.id
 WHERE o.workspace=? AND coalesce(a.value,'false')!='true' AND coalesce(json_extract(p.value,'$.private'),0)!=1`,
    )
    .all(workspace) as any[];
  let regionIds: Set<string> | null = null;
  if (regionId) {
    const groups = settings(workspace, 'canvas-groups')?.items || [],
      root = groups.find((g: any) => g.id === regionId);
    if (!root) throw Error('区域已删除，请重新选择');
    const selected = new Set([regionId]);
    let count = 0;
    while (selected.size !== count) {
      count = selected.size;
      for (const g of groups) if (selected.has(g.parentId)) selected.add(g.id);
    }
    regionIds = new Set(
      groups.filter((g: any) => selected.has(g.id)).flatMap((g: any) => g.objectIds || []),
    );
    if (root.bounds)
      for (const r of rows) {
        const b = JSON.parse(r.bounds),
          a = root.bounds;
        if (
          b.x >= a.x &&
          b.y >= a.y &&
          b.x + b.width <= a.x + a.width &&
          b.y + b.height <= a.y + a.height
        )
          regionIds.add(r.id);
      }
  }
  return new Map(
    rows
      .filter(
        (r) => (!objectIds || objectIds.includes(r.id)) && (!regionIds || regionIds.has(r.id)),
      )
      .map((r) => [r.id, Number(r.revision)]),
  );
}
function canEmbed(workspace: string) {
  return (
    vectorAvailable &&
    !!config.apiKey &&
    !!modelKey &&
    !config.paused &&
    config.enabledWorkspaces.includes(workspace)
  );
}
function publicStatus(workspace: string) {
  const ids = [...allowed(workspace).keys()],
    json = JSON.stringify(ids),
    indexed = db
      .prepare(
        'SELECT count(*) AS n FROM documents WHERE object_id IN (SELECT value FROM json_each(?))',
      )
      .get(json) as any;
  const counts = db
    .prepare('SELECT count(*) AS n FROM chunks WHERE object_id IN (SELECT value FROM json_each(?))')
    .get(json) as any;
  const vectors = db
    .prepare(
      'SELECT count(*) AS n FROM vectors v JOIN chunks c ON c.id=v.chunk_id WHERE v.model_key=? AND c.object_id IN (SELECT value FROM json_each(?))',
    )
    .get(modelKey, json) as any;
  const issues = db
    .prepare(
      "SELECT object_id AS objectId,title,note FROM documents WHERE object_id IN (SELECT value FROM json_each(?)) AND note!='' LIMIT 20",
    )
    .all(json);
  return {
    total: ids.length,
    indexed: indexed.n,
    chunks: counts.n,
    embedded: vectors.n,
    pending: [...queue.values()].filter((v) => v.workspace === workspace).length,
    initializing: !bootstrapped,
    semantic: canEmbed(workspace),
    model: config.model || null,
    paused: config.paused,
    embeddingBusy,
    error: vectorAvailable ? networkError : '本机向量扩展未加载，关键词检索仍可使用',
    issues,
  };
}
async function embed(texts: string[], timeout: number) {
  const controller = new AbortController();
  requests.add(controller);
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        encoding_format: 'float',
        ...(config.dimensions ? { dimensions: config.dimensions } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`向量服务返回 HTTP ${response.status}；关键词检索仍可使用`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error('向量服务没有返回内容');
    let data = '',
      size = 0;
    const decoder = new TextDecoder();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw Error('向量响应超过大小限制');
      }
      data += decoder.decode(part.value, { stream: true });
    }
    data += decoder.decode();
    const result = JSON.parse(data);
    if (!Array.isArray(result.data) || result.data.length !== texts.length)
      throw Error('向量响应数量不一致');
    const output: number[][] = Array(texts.length);
    let dimensions = 0;
    for (const item of result.data) {
      const values = item.embedding;
      if (
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= texts.length ||
        output[item.index] ||
        !Array.isArray(values) ||
        !values.length ||
        values.length > 8192 ||
        values.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))
      )
        throw Error('向量响应格式无效');
      if (
        (dimensions && values.length !== dimensions) ||
        (config.dimensions && values.length !== config.dimensions)
      )
        throw Error('向量维度与配置不一致');
      dimensions = values.length;
      const norm = Math.sqrt(values.reduce((sum: number, n: number) => sum + n * n, 0));
      if (!Number.isFinite(norm) || norm === 0) throw Error('向量响应数值无效');
      output[item.index] = values.map((n: number) => n / norm);
    }
    return output;
  } catch (error) {
    if (controller.signal.aborted) throw Error('向量请求已暂停或超时；关键词检索仍可使用');
    if (error instanceof Error && /^(向量|检索)/.test(error.message)) throw error;
    throw Error('向量服务连接失败；请检查地址、模型和密钥');
  } finally {
    clearTimeout(timer);
    requests.delete(controller);
  }
}
function blob(values: number[]) {
  return new Uint8Array(new Float32Array(values).buffer);
}
async function embedPending() {
  if (
    !vectorAvailable ||
    embeddingBusy ||
    queries ||
    !config.apiKey ||
    config.paused ||
    Date.now() < retryAt ||
    !config.enabledWorkspaces.length
  )
    return;
  const rows = db
    .prepare(
      `SELECT c.* FROM chunks c LEFT JOIN vectors v ON v.chunk_id=c.id AND v.model_key=? WHERE v.chunk_id IS NULL AND c.workspace IN (SELECT value FROM json_each(?)) LIMIT 12`,
    )
    .all(modelKey, JSON.stringify(config.enabledWorkspaces)) as any[];
  const valid = rows.filter((r) => {
    const object = live(r.workspace, r.object_id);
    return object && object.revision === r.revision && contentHash(object) === r.content_hash;
  });
  if (!valid.length) return;
  embeddingBusy = true;
  const version = generation,
    key = modelKey;
  try {
    const embeddings = await embed(
      valid.map((r) => r.text),
      18000,
    );
    if (version !== generation) return;
    db.exec('BEGIN');
    try {
      for (let i = 0; i < valid.length; i++) {
        const row = valid[i],
          object = live(row.workspace, row.object_id),
          chunk = db.prepare('SELECT id FROM chunks WHERE id=?').get(row.id);
        if (
          chunk &&
          object &&
          object.revision === row.revision &&
          contentHash(object) === row.content_hash &&
          canEmbed(row.workspace)
        )
          db.prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?)').run(
            row.id,
            key,
            blob(embeddings[i]),
          );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    networkError = '';
  } catch (e) {
    if (version === generation) {
      networkError = e instanceof Error ? e.message : '向量索引暂不可用';
      retryAt = Date.now() + 60000;
    }
  } finally {
    embeddingBusy = false;
  }
}
async function search(p: any) {
  queries++;
  try {
    const visible = allowed(p.workspace, p.regionId, p.objectIds),
      ids = JSON.stringify([...visible.keys()]),
      tokens = terms(p.query).slice(0, 32),
      lists: any[][] = [];
    const match = tokens.map((token) => '"' + token.replace(/"/g, '""') + '"').join(' OR ');
    if (match)
      lists.push(
        db
          .prepare(
            `SELECT c.*,d.title,bm25(chunks_fts,0,6,1) AS rank FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.chunk_id JOIN documents d ON d.object_id=c.object_id WHERE chunks_fts MATCH ? AND c.workspace=? AND c.object_id IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT 150`,
          )
          .all(match, p.workspace, ids),
      );
    else lists.push([]);
    let semanticUsed = false,
      note = '';
    if (p.mode !== 'keyword' && canEmbed(p.workspace)) {
      const version = generation,
        key = modelKey;
      if (Date.now() < retryAt) note = networkError;
      else
        try {
          const cached = queryCache.get(key + ':' + p.query),
            vector = cached || (await embed([p.query], 4500))[0];
          if (version === generation) {
            if (!cached) {
              if (queryCache.size >= 64) queryCache.delete(queryCache.keys().next().value!);
              queryCache.set(key + ':' + p.query, vector);
            }
            lists.push(
              db
                .prepare(
                  `SELECT c.*,d.title,vec_distance_cosine(v.embedding,?) AS distance FROM vectors v JOIN chunks c ON c.id=v.chunk_id JOIN documents d ON d.object_id=c.object_id WHERE v.model_key=? AND length(v.embedding)=? AND c.workspace=? AND c.object_id IN (SELECT value FROM json_each(?)) ORDER BY distance LIMIT 150`,
                )
                .all(blob(vector), key, vector.length * 4, p.workspace, ids),
            );
            semanticUsed = true;
          }
        } catch (e) {
          note = e instanceof Error ? e.message : '语义检索暂不可用';
        }
    } else if (p.mode !== 'keyword')
      note = '当前使用关键词检索；在向量服务设置中为此工作区启用商业 API';
    // The model request may have overlapped deletion, privacy changes or region moves.
    const current = allowed(p.workspace, p.regionId, p.objectIds);
    visible.clear();
    for (const [id, revision] of current) visible.set(id, revision);
    const hits = new Map<string, any>();
    lists.forEach((list, index) =>
      list.forEach((row, rank) => {
        if (visible.get(row.object_id) !== row.revision) return;
        let hit = hits.get(row.id);
        if (!hit) {
          hit = { ...row, target: JSON.parse(row.target), score: 0, matchedBy: [] };
          delete hit.rank;
          delete hit.distance;
          hits.set(row.id, hit);
        }
        hit.score += 1 / (60 + rank + 1);
        hit.matchedBy.push(index === 0 ? 'keyword' : 'semantic');
      }),
    );
    const counts = new Map<string, number>(),
      selected = [...hits.values()]
        .sort((a, b) => b.score - a.score)
        .filter((hit) => {
          const n = counts.get(hit.object_id) || 0;
          counts.set(hit.object_id, n + 1);
          return n < 3;
        })
        .slice(0, p.limit);
    return { hits: selected, semanticUsed, note, status: publicStatus(p.workspace) };
  } finally {
    queries--;
  }
}
async function command(operation: string, p: any) {
  if (operation === 'configure') {
    generation++;
    for (const request of requests) request.abort();
    config = p;
    modelKey = p.apiKey ? digest(JSON.stringify([p.endpoint, p.model, p.dimensions || null])) : '';
    queryCache.clear();
    retryAt = 0;
    networkError = '';
    // Remove vectors from a different model; never compare incompatible spaces.
    if (modelKey) db.prepare('DELETE FROM vectors WHERE model_key!=?').run(modelKey);
    return { configured: !!config.apiKey };
  }
  if (operation === 'status') return publicStatus(p.workspace);
  if (operation === 'search') return search(p);
  if (operation === 'read') {
    const row = db
      .prepare(
        'SELECT c.*,d.title FROM chunks c JOIN documents d ON d.object_id=c.object_id WHERE c.id=? AND c.workspace=?',
      )
      .get(p.chunkId, p.workspace) as any;
    if (!row || allowed(p.workspace, p.regionId).get(row.object_id) !== row.revision)
      throw Error('检索结果已失效，请重新搜索');
    const object = live(row.workspace, row.object_id);
    if (!object || contentHash(object) !== row.content_hash) throw Error('文件已更新，请重新搜索');
    return { ...row, target: JSON.parse(row.target) };
  }
  if (operation === 'rebuild') {
    for (const row of db
      .prepare('SELECT object_id FROM documents WHERE workspace=?')
      .all(p.workspace) as any[])
      purge(row.object_id);
    for (const row of source
      .prepare('SELECT id,workspace FROM objects WHERE workspace=?')
      .all(p.workspace) as any[])
      queue.set(row.id, row);
    return publicStatus(p.workspace);
  }
  throw Error('未知检索操作');
}
parentPort!.on('message', ({ id, operation, payload }) => {
  void command(operation, payload).then(
    (result) => parentPort!.postMessage({ id, result }),
    (error) =>
      parentPort!.postMessage({ id, error: error instanceof Error ? error.message : '检索失败' }),
  );
});
async function background() {
  for (;;) {
    try {
      if (!existsSync(join(directory, 'maintenance.lock'))) {
        collectChanges();
        if (!config.paused && !queries) {
          const first = queue.entries().next().value;
          if (first) {
            queue.delete(first[0]);
            await indexObject(first[1].workspace, first[1].id);
          }
          void embedPending();
        }
      }
    } catch {
      networkError = '索引后台暂时繁忙，稍后自动继续';
    }
    await delay(queue.size && !queries && !config.paused ? 120 : 1500);
  }
}
void background();
