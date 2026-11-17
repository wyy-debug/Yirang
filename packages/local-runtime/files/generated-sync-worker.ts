import { GeneratedFileLinks } from './generated-file-links.js';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFileSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { join, dirname } from 'node:path';

const db = new DatabaseSync(join(workerData.directory, 'desktop.sqlite'));
db.exec('PRAGMA busy_timeout=5000');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const get = (workspace: string, key: string) => {
  const row = db
    .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
    .get(workspace, key) as any;
  return row ? JSON.parse(row.value) : undefined;
};
const put = (workspace: string, key: string, value: unknown) =>
  db
    .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
    .run(workspace, key, JSON.stringify(value));
const links = new GeneratedFileLinks(db, workerData.directory, workerData.outputRoot);
let active = false;
const fingerprints = new Map<string, string>();
const observations = new Map<string, string>();
let scanOffset = 0;
const stamp = (info: Stats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
function adoptExternal(
  workspace: string,
  objectId: string,
  link: any,
  bytes: Buffer,
  diskHash: string,
  expectedStamp: string,
) {
  // Keep all I/O off the UI service thread; serialize the final compare-and-swap with editors.
  const asset = join(workerData.directory, 'assets', diskHash);
  try {
    const fd = openSync(asset, 'wx');
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !readFileSync(asset).equals(bytes))
      throw error;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentLink = get(workspace, `generated-object:${objectId}`);
    const object = db
      .prepare('SELECT kind,content,revision FROM objects WHERE workspace=? AND id=?')
      .get(workspace, objectId) as any;
    if (
      !object ||
      object.kind !== 'file' ||
      get(workspace, `archived:${objectId}`) ||
      currentLink?.path !== link.path ||
      currentLink?.diskHash !== link.diskHash ||
      existsSync(join(workerData.directory, 'maintenance.lock'))
    ) {
      db.exec('ROLLBACK');
      return false;
    }
    const content = JSON.parse(object.content),
      policy = get(workspace, `policy:${objectId}`),
      lease = get(workspace, `editor-lease:${objectId}`),
      prefix = `native-editor-draft:${objectId}:`;
    const dirty =
      (lease?.dirty && lease.expires > Date.now()) ||
      db
        .prepare('SELECT 1 FROM drafts WHERE workspace=? AND object_id=? AND expires>?')
        .get(workspace, objectId, Date.now()) ||
      db
        .prepare('SELECT 1 FROM settings WHERE workspace=? AND substr(key,1,?)=? LIMIT 1')
        .get(workspace, prefix.length, prefix) ||
      db
        .prepare(
          "SELECT 1 FROM settings WHERE workspace=? AND key LIKE 'annotation-draft:%' AND json_extract(value,'$.objectId')=? AND json_extract(value,'$.state')='editing' LIMIT 1",
        )
        .get(workspace, objectId);
    if (
      dirty ||
      policy?.locked ||
      policy?.protectedRanges?.length ||
      get(workspace, `generated-write:${objectId}`) ||
      (content.assetHash !== link.diskHash && content.assetHash !== diskHash)
    ) {
      notice(workspace, objectId, {
        diskHash,
        message: '外部文件已修改，桌面有编辑或保护设置，请在文件同步中处理',
      });
      db.exec('COMMIT');
      return false;
    }
    const latest = lstatSync(link.path);
    if (
      !latest.isFile() ||
      latest.isSymbolicLink() ||
      latest.nlink !== 1 ||
      stamp(latest) !== expectedStamp
    ) {
      db.exec('ROLLBACK');
      return false;
    }
    const at = new Date().toISOString(),
      revision = object.revision + (content.assetHash === diskHash ? 0 : 1);
    if (revision !== object.revision) {
      const next = JSON.stringify({ ...content, assetHash: diskHash, size: bytes.length });
      db.prepare(
        "UPDATE objects SET content=?,revision=?,updated_at=?,actor='human' WHERE workspace=? AND id=?",
      ).run(next, revision, at, workspace, objectId);
      db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)').run(
        workspace,
        objectId,
        revision,
        next,
        'human',
        '同步外部文件修改',
        at,
      );
    }
    put(workspace, `generated-object:${objectId}`, { ...link, diskHash });
    db.prepare('DELETE FROM settings WHERE workspace=? AND key=?').run(
      workspace,
      `generated-disk-change:${objectId}`,
    );
    db.prepare(
      'INSERT INTO events(workspace,type,object_id,revision,actor,created_at) VALUES(?,?,?,?,?,?)',
    ).run(workspace, 'object.changed', objectId, revision, 'human', at);
    const dependents = db
      .prepare(
        "SELECT key FROM settings WHERE workspace=? AND key LIKE 'generated-source:%' AND EXISTS (SELECT 1 FROM json_each(settings.value,'$.sources') WHERE json_extract(json_each.value,'$.id')=?)",
      )
      .all(workspace, objectId) as any[];
    for (const row of dependents)
      db.prepare(
        'INSERT INTO events(workspace,type,object_id,revision,actor,created_at) VALUES(?,?,?,?,?,?)',
      ).run(workspace, 'object.metadata', row.key.slice(17), null, 'host-ack', at);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function notice(workspace: string, objectId: string, value: unknown) {
  const key = `generated-disk-change:${objectId}`,
    previous = get(workspace, key);
  if (JSON.stringify(previous ?? null) === JSON.stringify(value ?? null)) return;
  if (value) put(workspace, key, value);
  else db.prepare('DELETE FROM settings WHERE workspace=? AND key=?').run(workspace, key);
  db.prepare(
    'INSERT INTO events(workspace,type,object_id,revision,actor,created_at) VALUES(?,?,?,?,?,?)',
  ).run(workspace, 'object.metadata', objectId, null, 'host-ack', new Date().toISOString());
}
// Detect external edits without reading large files on the UI service's thread.
const scanTimer = setInterval(() => {
  if (active || existsSync(join(workerData.directory, 'maintenance.lock'))) return;
  try {
    const rows = db
      .prepare(
        "SELECT workspace,key,value FROM settings WHERE key LIKE 'generated-object:%' ORDER BY workspace,key LIMIT 64 OFFSET ?",
      )
      .all(scanOffset) as any[];
    scanOffset = rows.length < 64 ? 0 : scanOffset + rows.length;
    for (const row of rows) {
      const link = JSON.parse(row.value),
        objectId = link.objectId,
        key = `${row.workspace}:${objectId}`;
      if (get(row.workspace, `archived:${objectId}`)) continue;
      try {
        const info = lstatSync(link.path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          info.size > 50 * 1024 * 1024
        )
          throw Error('原文件不可同步，请重新关联');
        if (!links.allowed(row.workspace, link.path)) throw Error('关联目录已移动，请重新选择文件');
        const fingerprint = `${link.path}:${link.diskHash}:${stamp(info)}`;
        if (fingerprints.get(key) === fingerprint) continue;
        // Require two unchanged observations so replace-on-save and multi-write saves settle.
        if (observations.get(key) !== fingerprint) {
          observations.set(key, fingerprint);
          continue;
        }
        const bytes = readFileSync(link.path),
          after = lstatSync(link.path);
        if (after.isSymbolicLink() || after.nlink !== 1 || stamp(after) !== stamp(info)) {
          observations.delete(key);
          continue;
        }
        const current = sha(bytes);
        if (current === link.diskHash) {
          fingerprints.set(key, fingerprint);
          notice(row.workspace, objectId, null);
        } else if (adoptExternal(row.workspace, objectId, link, bytes, current, stamp(info)))
          fingerprints.set(key, `${link.path}:${current}:${stamp(info)}`);
      } catch (error) {
        fingerprints.delete(key);
        notice(row.workspace, objectId, {
          message:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? '原文件已移走，请重新关联'
              : error instanceof Error
                ? error.message
                : String(error),
        });
      }
    }
    if (fingerprints.size > 10000) fingerprints.clear();
    if (observations.size > 10000) observations.clear();
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
}, 1000);
scanTimer.unref();
parentPort!.on('message', ({ workspace, retry }) => {
  if (active) return;
  active = true;
  try {
    if (existsSync(join(workerData.directory, 'maintenance.lock'))) return;
    const rows = db
      .prepare(
        `SELECT workspace,key,value FROM settings WHERE key LIKE 'generated-write:%'${workspace ? ' AND workspace=?' : ''}`,
      )
      .all(...(workspace ? [workspace] : [])) as any[];
    for (const row of rows) {
      const objectId = row.key.slice(16),
        pending = JSON.parse(row.value),
        lockKey = `generated-lock:${objectId}`,
        claim = randomUUID();
      if (pending.error && !retry) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        const lock = get(row.workspace, lockKey);
        if (lock && lock.expires > Date.now()) {
          db.exec('ROLLBACK');
          continue;
        }
        put(row.workspace, lockKey, { claim, expires: Date.now() + 300000 });
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      let temporary = '';
      try {
        const link = get(row.workspace, `generated-object:${objectId}`);
        if (!link) throw Error('文件关联已移除');
        const parent = realpathSync(dirname(link.path));
        if (!links.allowed(row.workspace, link.path)) throw Error('保存目录已移动，请重新关联文件');
        const before = lstatSync(link.path);
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1 ||
          before.size > 50 * 1024 * 1024
        )
          throw Error('原文件不是可同步的普通文件');
        const hash = sha(readFileSync(link.path));
        if (hash !== link.diskHash && hash !== pending.hash)
          throw Error('磁盘文件也有修改，请打开文件同步处理差异');
        if (hash !== pending.hash) {
          const bytes = readFileSync(join(workerData.directory, 'assets', pending.hash));
          if (sha(bytes) !== pending.hash) throw Error('保存内容不完整');
          temporary = join(parent, `.desktop-${claim}.tmp`);
          const fd = openSync(temporary, 'wx');
          try {
            writeFileSync(fd, bytes);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        // Expensive hashing and I/O are outside the database write lock.
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = get(row.workspace, row.key),
            currentLink = get(row.workspace, `generated-object:${objectId}`),
            lock = get(row.workspace, lockKey);
          if (
            lock?.claim !== claim ||
            current?.hash !== pending.hash ||
            currentLink?.path !== link.path ||
            currentLink?.diskHash !== link.diskHash
          ) {
            db.exec('ROLLBACK');
            continue;
          }
          const object = db
            .prepare('SELECT content,revision FROM objects WHERE workspace=? AND id=?')
            .get(row.workspace, objectId) as any;
          if (
            !object ||
            get(row.workspace, `archived:${objectId}`) === true ||
            JSON.parse(object.content).assetHash !== pending.hash
          ) {
            db.exec('ROLLBACK');
            continue;
          }
          const after = lstatSync(link.path);
          if (
            after.isSymbolicLink() ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs
          )
            throw Error('原文件正在编辑，稍后再同步');
          if (temporary) renameSync(temporary, link.path);
          put(row.workspace, `generated-object:${objectId}`, { ...link, diskHash: pending.hash });
          db.prepare('DELETE FROM settings WHERE workspace=? AND key=?').run(
            row.workspace,
            row.key,
          );
          db.prepare('DELETE FROM settings WHERE workspace=? AND key=?').run(
            row.workspace,
            `generated-disk-change:${objectId}`,
          );
          db.prepare(
            'INSERT INTO events(workspace,type,object_id,revision,actor,created_at) VALUES(?,?,?,?,?,?)',
          ).run(
            row.workspace,
            'object.metadata',
            objectId,
            object.revision,
            'host-ack',
            new Date().toISOString(),
          );
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } catch (error) {
        const current = get(row.workspace, row.key);
        if (current?.hash === pending.hash) {
          put(row.workspace, row.key, {
            ...current,
            error: error instanceof Error ? error.message : String(error),
          });
          db.prepare(
            'INSERT INTO events(workspace,type,object_id,revision,actor,created_at) VALUES(?,?,?,?,?,?)',
          ).run(
            row.workspace,
            'object.metadata',
            objectId,
            pending.revision,
            'host-ack',
            new Date().toISOString(),
          );
        }
      } finally {
        if (temporary && existsSync(temporary)) unlinkSync(temporary);
        const lock = get(row.workspace, lockKey);
        if (lock?.claim === claim)
          db.prepare('DELETE FROM settings WHERE workspace=? AND key=?').run(
            row.workspace,
            lockKey,
          );
      }
    }
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    active = false;
    parentPort!.postMessage({ done: true });
  }
});
