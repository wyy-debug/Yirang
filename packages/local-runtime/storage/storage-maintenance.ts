import { DatabaseSync } from 'node:sqlite';
import { readdirSync, lstatSync, realpathSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from '../../contracts/index.js';
export class StorageMaintenance {
  constructor(
    private db: DatabaseSync,
    private directory: string,
    private workspace: string,
  ) {}
  private references() {
    const refs = new Set<string>(),
      tables = [
        'objects',
        'revisions',
        'settings',
        'object_sources',
        'snapshots',
        'receipts',
        'drafts',
      ];
    const collect = (db: DatabaseSync) => {
      const existing = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
      for (const table of tables) {
        if (!existing.has(table)) continue;
        for (const row of db.prepare(`SELECT * FROM ${table}`).iterate())
          for (const value of Object.values(row))
            if (typeof value === 'string')
              for (const match of value.matchAll(/\b[a-f0-9]{64}\b/g)) refs.add(match[0]);
      }
    };
    collect(this.db);
    // Offline database snapshots share immutable assets; cleanup must retain their files as well.
    const snapshots = readdirSync(this.directory).filter((name) =>
      /^before-(?:v\d+|rollback)-[\w-]+\.sqlite$/.test(name),
    );
    if (snapshots.length > 100)
      fail('STORAGE_SNAPSHOTS', '恢复快照超过 100 份；请先整理离线备份，再预览清理。');
    for (const name of snapshots) {
      const path = join(this.directory, name),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        fail('STORAGE_SNAPSHOT', '恢复快照路径异常，已停止清理。');
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(path, { readOnly: true });
        collect(db);
      } catch {
        fail('STORAGE_SNAPSHOT', '有恢复快照无法读取，已停止清理，避免移走恢复所需文件。');
      } finally {
        db?.close();
      }
    }
    return refs;
  }
  private assets() {
    const folder = join(this.directory, 'assets'),
      refs = this.references();
    return readdirSync(folder)
      .filter((n) => /^[a-f0-9]{64}$/.test(n))
      .flatMap((name) => {
        const path = join(folder, name),
          stat = lstatSync(path);
        return stat.isFile() && !stat.isSymbolicLink()
          ? [{ name, size: stat.size, orphan: !refs.has(name) }]
          : [];
      });
  }
  action(input: any) {
    const p = z
      .object({
        operation: z.enum(['inspect', 'preview', 'apply']),
        keep: z.number().int().min(5).max(10000).default(50),
        token: z.string().optional(),
      })
      .strict()
      .parse(input);
    const assets = this.assets();
    if (p.operation === 'inspect')
      return {
        assetCount: assets.length,
        bytes: assets.reduce((n, a) => n + a.size, 0),
        orphanBytes: assets.filter((a) => a.orphan).reduce((n, a) => n + a.size, 0),
        revisions: (
          this.db
            .prepare('SELECT count(*) AS n FROM revisions WHERE workspace=?')
            .get(this.workspace) as any
        ).n,
        policy: this.db
          .prepare("SELECT value FROM settings WHERE workspace=? AND key='retention-policy'")
          .get(this.workspace),
        dataDirectory: this.directory,
      };
    const retained = new Set<string>();
    const scan = (v: any) => {
      if (!v || typeof v !== 'object') return;
      if (v.objectId)
        for (const k of ['revision', 'baseRevision', 'expectedRevision', 'sourceRevision'])
          if (Number.isInteger(v[k])) retained.add(`${v.objectId}:${v[k]}`);
      if (v.id && v.revision && v.content) retained.add(`${v.id}:${v.revision}`);
      Object.values(v).forEach(scan);
    };
    for (const table of ['settings', 'snapshots', 'drafts']) {
      for (const row of this.db
        .prepare(`SELECT * FROM ${table} WHERE workspace=?`)
        .all(this.workspace) as any[]) {
        if (
          table === 'settings' &&
          /^(contribution:|storage-plan:|native-edit-command:|retention-policy)/.test(row.key)
        )
          continue;
        for (const field of ['value', 'payload', 'content'])
          if (row[field]) {
            try {
              scan(JSON.parse(row[field]));
            } catch {}
          }
        if (table === 'drafts') retained.add(`${row.object_id}:${row.base}`);
      }
    }
    const remove: any[] = [];
    for (const object of this.db
      .prepare('SELECT id,revision FROM objects WHERE workspace=?')
      .all(this.workspace) as any[]) {
      const rows = this.db
        .prepare(
          'SELECT revision FROM revisions WHERE workspace=? AND object_id=? ORDER BY revision DESC',
        )
        .all(this.workspace, object.id) as any[];
      for (const row of rows.slice(p.keep + 1))
        if (
          row.revision !== 1 &&
          row.revision !== object.revision &&
          !retained.has(`${object.id}:${row.revision}`)
        )
          remove.push({ objectId: object.id, revision: row.revision });
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ remove, assets: assets.filter((a) => a.orphan), keep: p.keep }))
      .digest('hex');
    if (p.operation === 'preview')
      return {
        token: fingerprint,
        keep: p.keep,
        remove,
        orphanCount: assets.filter((a) => a.orphan).length,
        orphanBytes: assets.filter((a) => a.orphan).reduce((n, a) => n + a.size, 0),
      };
    if (p.token !== fingerprint) fail('STORAGE_CHANGED', '存储内容已改变，请重新预览清理计划。');
    const orphans = assets.filter((a) => a.orphan);
    const trash = orphans.length ? join(resolve(this.directory), 'recovery-trash', randomUUID()) : null;
    if (trash) {
      mkdirSync(trash, { recursive: true });
      if (realpathSync(trash) !== trash || lstatSync(trash).isSymbolicLink())
        fail('STORAGE_PATH', '回收目录无效。');
    }
    this.db.exec('BEGIN IMMEDIATE');
    let refs: Set<string> | null;
    let recovered = 0,
      deferredAssets = 0;
    try {
      refs = trash ? this.references() : null;
      for (const r of remove) {
        this.db
          .prepare('DELETE FROM revisions WHERE workspace=? AND object_id=? AND revision=?')
          .run(this.workspace, r.objectId, r.revision);
        this.db
          .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
          .run(this.workspace, `contribution:${r.objectId}:${r.revision}`);
      }
      this.db
        .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
        .run(
          this.workspace,
          'retention-policy',
          JSON.stringify({ keep: p.keep, appliedAt: new Date().toISOString() }),
        );
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (trash) {
      for (const asset of orphans) {
        const source = join(resolve(this.directory), 'assets', asset.name);
        try {
          const stat = lstatSync(source);
          if (refs?.has(asset.name) || !stat.isFile() || stat.isSymbolicLink() ||
              stat.size !== asset.size || realpathSync(source) !== source) {
            deferredAssets++;
            continue;
          }
          renameSync(source, join(trash, asset.name));
          recovered += asset.size;
        } catch {
          deferredAssets++;
        }
      }
    }
    return { removedRevisions: remove.length, recoveredBytes: recovered, recoveryDirectory: trash, deferredAssets };
  }
}
