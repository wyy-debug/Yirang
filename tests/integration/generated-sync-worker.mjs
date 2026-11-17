import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Run after the production build: exercises the exact worker entry shipped in the installer.
test(
  'bundled sync worker writes the current file and preserves conflicting external edits',
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'yirang-sync-worker-'));
    const outputRoot = join(directory, 'output');
    const assets = join(directory, 'assets');
    mkdirSync(outputRoot);
    mkdirSync(assets);
    const db = new DatabaseSync(join(directory, 'desktop.sqlite'));
    db.exec(`CREATE TABLE settings(workspace TEXT,key TEXT,value TEXT,PRIMARY KEY(workspace,key));
    CREATE TABLE objects(workspace TEXT,id TEXT,content TEXT,revision INTEGER,kind TEXT);
    CREATE TABLE events(seq INTEGER PRIMARY KEY,workspace TEXT,type TEXT,object_id TEXT,revision INTEGER,actor TEXT,created_at TEXT);`);
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    const put = (key, value) =>
      db
        .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
        .run('desk', key, JSON.stringify(value));
    const get = (key) =>
      db.prepare('SELECT value FROM settings WHERE workspace=? AND key=?').get('desk', key);
    const path = join(outputRoot, 'report.md');
    writeFileSync(path, 'before');
    writeFileSync(join(assets, hash('after')), 'after');
    put('generated-object:file', { path, diskHash: hash('before') });
    put('generated-write:file', { hash: hash('after'), revision: 2 });
    db.prepare('INSERT INTO objects VALUES(?,?,?,?,?)').run(
      'desk',
      'file',
      JSON.stringify({ assetHash: hash('after') }),
      2,
      'file',
    );
    const worker = new Worker(new URL('../../dist/generated-sync-worker.mjs', import.meta.url), {
      workerData: { directory, outputRoot },
    });
    t.after(async () => {
      await worker.terminate();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const flush = () =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          worker.off('message', message);
          worker.off('error', error);
        };
        const error = (value) => {
          cleanup();
          reject(value);
        };
        const message = (value) => {
          if (value.error) error(Error(value.error));
          else if (value.done) {
            cleanup();
            resolve();
          }
        };
        worker.on('message', message);
        worker.once('error', error);
        worker.postMessage({ workspace: 'desk' });
      });
    await flush();
    assert.equal(readFileSync(path, 'utf8'), 'after');
    assert.equal(get('generated-write:file'), undefined);
    assert.equal(JSON.parse(get('generated-object:file').value).diskHash, hash('after'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);

    writeFileSync(path, 'external edit');
    writeFileSync(join(assets, hash('third')), 'third');
    put('generated-write:file', { hash: hash('third'), revision: 3 });
    db.prepare('UPDATE objects SET content=?,revision=3').run(
      JSON.stringify({ assetHash: hash('third') }),
    );
    await flush();
    assert.equal(readFileSync(path, 'utf8'), 'external edit');
    assert.match(JSON.parse(get('generated-write:file').value).error, /磁盘文件也有修改/);
  },
);
