import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeRegionFolder } from '../packages/local-runtime/files/region-files.ts';

const hash = 'a'.repeat(64);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'yirang-region-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'workspace');
  const bindings = new Map();
  const copies = [];
  const api = {
    workspaceId: 'workspace',
    regions: [
      { id: 'parent', name: 'Parent', objectIds: ['one'], bounds: {} },
      { id: 'child', name: 'Child', parentId: 'parent', objectIds: ['two'], bounds: {} },
    ],
    objects: ['one', 'two'].map((id) => ({
      id,
      kind: 'file',
      content: { fileName: `${id}.md`, mime: 'text/markdown', size: 4, assetHash: hash },
    })),
    folder: (parts = []) => {
      const path = join(root, ...parts);
      mkdirSync(path, { recursive: true });
      return path;
    },
    hasPendingWrite: () => false,
    links: {
      link: (_, id) => bindings.get(id),
      inspect: () => ({ diskHash: hash }),
      bind: (_, id, path) => bindings.set(id, { path }),
      materialize: (_, id, directory, name) => copies.push({ id, path: join(directory, name) }),
    },
  };
  api.folder();
  return { api, home, root, bindings, copies };
}

test('opening a region moves workspace files into the hierarchy and copies external sources', (t) => {
  const { api, root, home, bindings, copies } = fixture(t);
  const internal = join(root, 'one.md');
  const external = join(home, 'two.md');
  writeFileSync(internal, 'one');
  writeFileSync(external, 'two');
  bindings.set('one', { path: internal });
  bindings.set('two', { path: external });
  assert.deepEqual(materializeRegionFolder('parent', api), { path: join(root, 'Parent') });
  assert.equal(existsSync(internal), false);
  assert.equal(readFileSync(join(root, 'Parent', 'one.md'), 'utf8'), 'one');
  assert.equal(readFileSync(external, 'utf8'), 'two');
  assert.deepEqual(copies, [{ id: 'two', path: join(root, 'Parent', 'Child', 'two.md') }]);
});

test('failed binding restores the original native file', (t) => {
  const { api, root, bindings } = fixture(t);
  const original = join(root, 'one.md');
  writeFileSync(original, 'original');
  bindings.set('one', { path: original });
  api.links.bind = () => {
    throw new Error('binding failed');
  };
  assert.throws(() => materializeRegionFolder('parent', api), /binding failed/);
  assert.equal(readFileSync(original, 'utf8'), 'original');
  assert.equal(existsSync(join(root, 'Parent', 'one.md')), false);
});

test('pending writes, changed disk contents and name collisions prevent relocation', (t) => {
  const { api, root, bindings } = fixture(t);
  const original = join(root, 'one.md');
  writeFileSync(original, 'original');
  bindings.set('one', { path: original });
  api.hasPendingWrite = () => true;
  assert.throws(() => materializeRegionFolder('parent', api), { code: 'FILE_SYNC_PENDING' });
  api.hasPendingWrite = () => false;
  api.links.inspect = () => ({ diskHash: 'b'.repeat(64) });
  assert.throws(() => materializeRegionFolder('parent', api), { code: 'FILE_SYNC_CONFLICT' });
  api.links.inspect = () => ({ diskHash: hash });
  const destination = join(root, 'Parent', 'one.md');
  writeFileSync(destination, 'existing');
  assert.throws(() => materializeRegionFolder('parent', api), { code: 'NAME_CONFLICT' });
  assert.equal(readFileSync(original, 'utf8'), 'original');
  assert.equal(readFileSync(destination, 'utf8'), 'existing');
});
