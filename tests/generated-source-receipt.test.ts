import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GeneratedFiles } from '../packages/local-runtime/files/generated-files.js';

test('collecting a committed source working copy reuses its object and never moves its original link', t => {
  const root = mkdtempSync(join(tmpdir(), 'source-receipt-'));
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE settings(workspace TEXT,key TEXT,value TEXT,PRIMARY KEY(workspace,key));
    CREATE TABLE events(seq INTEGER PRIMARY KEY,workspace TEXT,object_id TEXT,type TEXT,revision INTEGER,actor TEXT);
    CREATE TABLE work_runs(workspace TEXT,thread_id TEXT,turn_id TEXT,task_id TEXT,id TEXT);`);
  const content = '<svg xmlns="http://www.w3.org/2000/svg"><text>FLOW</text></svg>';
  const hash = createHash('sha256').update(content).digest('hex');
  const object: any = { id: 'original', kind: 'file', revision: 2, title: 'flow.svg',
    bounds: { x: 0, y: 0, width: 400, height: 300 }, content: { fileName: 'flow.svg', assetHash: hash, size: Buffer.byteLength(content) } };
  const originalPath = join(root, 'flow.svg');
  writeFileSync(originalPath, content);
  const links: any = { flush() {}, allowed: () => true,
    link: () => ({ objectId: object.id, path: originalPath, diskHash: hash }), find: () => undefined,
    bind() { assert.fail('must retain original file path'); }, accept() { assert.fail('working copy is not original disk acknowledgement'); },
    source: () => ({ relativePath: 'flow.svg' }), provenance() {}, conflict: () => undefined };
  const engine = new GeneratedFiles(db, root, { objects: () => [object], obstacles: () => [],
    receipt: () => undefined, save() { assert.fail('must not import a duplicate'); }, changed() {} }, links);
  const batch = engine.begin('owner', 'w', 'thread', 'repair', undefined, [object.id]);
  db.prepare('INSERT INTO events VALUES(1,?,?,?,?,?)').run('w', object.id, 'object.changed', 2, 'ai');
  writeFileSync(join(batch.directory, 'flow.svg'), content);
  for (let i = 0; i < 2; i++) {
    const result = engine.collect('owner', batch.id);
    assert.deepEqual(result.issues, []);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.objectId, object.id);
    assert.equal(result.files[0]!.revision, 2);
    assert.equal(result.files[0]!.result, 'updated');
  }
});
