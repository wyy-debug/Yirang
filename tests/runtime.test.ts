import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DesktopStore } from '../packages/local-runtime/store.js';
import { StorageMaintenance } from '../packages/local-runtime/storage/storage-maintenance.js';
import { regionMemberIds } from '../packages/components/canvas-folders.js';
import type { PanelBinding } from '../packages/contracts/index.js';
import type { OutputBatch } from '../packages/local-runtime/files/generated-files.js';
import { PNG } from 'pngjs';

const pixel = new PNG({ width: 1, height: 1 });
pixel.data.set([42, 128, 200, 255]);
const png = PNG.sync.write(pixel).toString('base64');
const bounds = { x: 0, y: 0, width: 350, height: 300 };
const content = (text: string) => ({ blocks: [{ id: 'block-1', text }] });
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-desktop-test-'));
  const store = new DesktopStore(directory);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  store.createWorkspace('session-a');
  const opened = store.open('session-a') as { binding: PanelBinding };
  const b = opened.binding;
  const create = (text = 'initial') =>
    store.createObject(b.workspaceId, b.credential, 'session-a', crypto.randomUUID(), {
      kind: 'text',
      title: '文字',
      content: content(text),
      bounds,
    });
  const write = (
    objectId: string,
    base: number,
    text: string,
    requestId: string = crypto.randomUUID(),
    credential = b.credential,
  ) =>
    store.commit(
      {
        workspaceId: b.workspaceId,
        credential,
        requestId,
        expectedRevisions: { [objectId]: base },
        operations: [{ type: 'replace_text', objectId, content: content(text) }],
        summary: 'test',
      },
      'session-a',
    );
  const prepare = (objects: any[]) =>
    store.prepare(b.workspaceId, b.credential, 'session-a', {
      requestId: crypto.randomUUID(),
      objectIds: objects.map((o) => o.id),
      expectedRevisions: Object.fromEntries(objects.map((o) => [o.id, o.revision])),
      instruction: '修改选中文字',
    });
  const execToken = (prepared: any) =>
    prepared.content[0].text.match(/credential=(execution_[\w-]+)/)[1];
  return { store, directory, b, create, write, prepare, execToken };
}
test('identities, bytes and separate layout revisions survive reopen', (t) => {
  const { store, directory, b, create } = setup(t);
  const text = create('持久文字');
  const image = store.createObject(b.workspaceId, b.credential, 'session-a', 'image-1', {
    kind: 'image',
    title: '图',
    data: png,
    bounds,
  });
  store.saveView(b.workspaceId, b.credential, 'session-a', {
    requestId: 'view-1',
    expected: 1,
    viewport: { x: 10, y: 20, zoom: 0.75 },
    objects: [{ objectId: text.id, bounds: { ...bounds, x: 450 } }],
  });
  const second = new DesktopStore(directory);
  const restored = second.open('session-a') as any;
  assert.equal(restored.binding.workspaceId, b.workspaceId);
  assert.notEqual(restored.binding.panelInstanceId, b.panelInstanceId);
  assert.equal(restored.workspace.objects[0].id, text.id);
  assert.equal(restored.workspace.objects[0].revision, 1);
  assert.equal(restored.workspace.objects[0].layoutRevision, 2);
  assert.equal(restored.workspace.objects[0].bounds.x, 450);
  assert.equal(restored.workspace.objects[1].id, image.id);
  assert.equal(restored.workspace.objects[1].dataUrl, `data:image/png;base64,${png}`);
  second.close();
});
test('no global workspace for missing host session; explicit recovery only', (t) => {
  const { store } = setup(t);
  assert.equal((store.open(null) as any).needsWorkspaceChoice, true);
  const id = store.createWorkspace(null, '离线', 'request');
  assert.equal(store.createWorkspace(null, '离线', 'request'), id);
  assert.equal((store.open(null, id) as any).binding.workspaceId, id);
  assert.equal((store.open(null) as any).needsWorkspaceChoice, true);
});

test('deleting a desktop switches atomically and restoration preserves the desktop contents', (t) => {
  const { store } = setup(t);
  const { binding: source } = store.open('session-a') as { binding: PanelBinding };
  const other = store.createWorkspace(null, '备用桌面');
  const note = store.createObject(source.workspaceId, source.credential, 'session-a', 'note-before-trash', {
    kind: 'text', title: '保留的文件', content: content('原始内容'), bounds,
  });
  const request = { requestId: 'trash-active', operation: 'delete', targetId: other };
  assert.throws(() => store.switchWorkspace(source.workspaceId, source.credential, 'session-a', {
    ...request, targetId: source.workspaceId,
  }));
  const switched = store.switchWorkspace(source.workspaceId, source.credential, 'session-a', request) as {
    binding: PanelBinding;
  };
  assert.equal(switched.binding.workspaceId, other);
  assert.deepEqual(store.switchWorkspace(source.workspaceId, source.credential, 'session-a', request), switched);
  const active = switched.binding;
  assert.deepEqual(store.workspaceList(other, active.credential, 'session-a').map(({ id }) => id), [other]);
  assert.throws(() => store.open(null, source.workspaceId), { code: 'WORKSPACE_NOT_FOUND' });
  const trashed = store.workspaceTrash(other, active.credential, 'session-a', { operation: 'list' });
  assert.deepEqual(trashed, [{ id: source.workspaceId, name: '我的工作桌面' }]);
  store.workspaceTrash(other, active.credential, 'session-a', {
    operation: 'restore', targetId: source.workspaceId, requestId: 'restore-desktop',
  });
  assert.equal(store.snapshot(source.workspaceId).objects[0].id, note.id);
  assert.deepEqual(store.snapshot(source.workspaceId).objects[0].content, content('原始内容'));
  store.workspaceTrash(other, active.credential, 'session-a', {
    operation: 'delete', targetId: source.workspaceId, requestId: 'trash-inactive',
  });
  assert.deepEqual(store.workspaceList(other, active.credential, 'session-a').map(({ id }) => id), [other]);
});

test('desktop deletion respects pending work and frees an active desktop slot', async (t) => {
  const { store, b } = setup(t);
  const backup = await store.backups.create(b.workspaceId, b.credential, 'session-a', {
    requestId: 'before-cap', label: '容量测试',
  });
  const preview = await store.backups.inspect(b.workspaceId, b.credential, 'session-a', { id: backup.id });
  const targetId = store.createWorkspace(null, '准备删除');
  for (let i = 0; i < 98; i++) store.createWorkspace(null, `桌面 ${i}`);
  const create = { requestId: 'over-cap', operation: 'create' as const, name: '额外桌面' };
  assert.throws(() => store.switchWorkspace(b.workspaceId, b.credential, 'session-a', create), {
    code: 'WORKSPACE_LIMIT',
  });
  const request = { operation: 'delete', targetId, requestId: 'delete-with-work' };
  const { task } = store.workManagement.command(targetId, {
    operation: 'intake', requestId: 'new-work', payload: { text: '等待执行的工作' },
  }, true) as { task: { id: string; revision: number } };
  assert.throws(() => store.workspaceTrash(b.workspaceId, b.credential, 'session-a', request), {
    code: 'WORKSPACE_BUSY',
  });
  assert.equal(store.workspaceList(b.workspaceId, b.credential, 'session-a').length, 100);
  store.workManagement.command(targetId, {
    operation: 'control', taskId: task.id, expectedRevision: task.revision,
    requestId: 'cancel-work', payload: { action: 'cancel' },
  }, true);
  store.workspaceTrash(b.workspaceId, b.credential, 'session-a', request);
  assert.equal(store.workspaceList(b.workspaceId, b.credential, 'session-a').length, 99);
  await store.backups.restore(b.workspaceId, b.credential, 'session-a', {
    id: backup.id, digest: preview.digest, name: '已恢复', requestId: 'restore-to-slot',
  });
  assert.equal(store.workspaceList(b.workspaceId, b.credential, 'session-a').length, 100);
  assert.throws(() => store.workspaceTrash(b.workspaceId, b.credential, 'session-a', {
    operation: 'restore', targetId, requestId: 'restore-over-cap',
  }), { code: 'WORKSPACE_LIMIT' });
});

test('a blocked recovery directory leaves revisions intact and lets cleanup retry', (t) => {
  const { store, directory, b, create, write } = setup(t);
  const note = create();
  for (let revision = 1; revision <= 8; revision++) write(note.id, revision, String(revision));
  const orphan = join(directory, 'assets', 'a'.repeat(64));
  writeFileSync(orphan, 'unused file');
  const maintenance = new StorageMaintenance(store.db, directory, b.workspaceId);
  const preview = maintenance.action({ operation: 'preview', keep: 5 });
  assert.ok(preview.remove?.length);
  const blocked = join(directory, 'recovery-trash');
  writeFileSync(blocked, 'blocks folder creation');
  const apply = { operation: 'apply', keep: 5, token: preview.token };
  assert.throws(() => maintenance.action(apply));
  assert.equal(maintenance.action({ operation: 'preview', keep: 5 }).token, preview.token);
  assert.equal(existsSync(orphan), true);
  unlinkSync(blocked);
  const result = maintenance.action(apply);
  assert.equal(result.removedRevisions, preview.remove.length);
  assert.equal(result.deferredAssets, 0);
  assert.equal(existsSync(orphan), false);
});

test('file migration applies scanned matches and preserves workspace binding', async (t) => {
  const { store, directory, b } = setup(t);
  const previous = process.env.AI_DESKTOP_SESSION_REF;
  process.env.AI_DESKTOP_SESSION_REF = 'session-a';
  t.after(() => {
    if (previous === undefined) delete process.env.AI_DESKTOP_SESSION_REF;
    else process.env.AI_DESKTOP_SESSION_REF = previous;
  });
  const data = Buffer.from('file to relink');
  const object = store.importAttachment(b.workspaceId, b.credential, 'session-a', {
    requestId: 'import-migrated-file', fileName: 'fixture.txt', data: data.toString('base64'), bounds,
  });
  const path = join(directory, 'migrated');
  mkdirSync(path);
  const file = join(path, 'fixture.txt');
  writeFileSync(file, data);
  const scan = await store.generatedFiles('session-a', { operation: 'migration_scan', path }) as {
    workspaceId: string; items: { matches: string[]; hash: string }[];
  };
  assert.deepEqual(scan.items[0].matches, [file]);
  const result = await store.generatedFiles('session-a', {
    operation: 'migration_apply', path, viewWorkspaceId: scan.workspaceId,
    targets: [{ objectId: object.id, revision: object.revision, path: file, hash: scan.items[0].hash }],
  });
  assert.deepEqual(result, { workspaceId: b.workspaceId, linked: 1 });
});

test('ZIP export leaves no individual files or events when a later revision is stale', async (t) => {
  const { store, directory, b, create } = setup(t);
  const first = create('first'), second = create('second');
  const request = { requestId: 'bundle-no-side-effects', objects: [
    { id: first.id, revision: first.revision },
    { id: second.id, revision: second.revision + 1 },
  ] };
  const exports = join(directory, 'exports');
  const listExports = () => existsSync(exports) ? readdirSync(exports) : [];
  const before = listExports();
  await assert.rejects(store.exportBundle(b.workspaceId, b.credential, 'session-a', request), {
    code: 'REVISION_CONFLICT',
  });
  assert.deepEqual(listExports(), before);
  assert.equal(store.db.prepare("SELECT 1 FROM events WHERE type='object.exported'").get(), undefined);
  request.objects[1].revision = second.revision;
  const result = await store.exportBundle(b.workspaceId, b.credential, 'session-a', request);
  assert.equal(result.count, 2);
  assert.equal(listExports().length, before.length + 1);
});

test('old groups become movable regions without duplicating ownership or moving existing cards', (t) => {
  const { store, directory, b, create } = setup(t);
  const shared = create('shared');
  const own = create('ordinary group only');
  const previous = {
    revision: 3,
    items: [
      { id: 'owner', name: '原有区域', color: 'blue', folder: true, bounds, objectIds: [shared.id] },
      { id: 'legacy', name: '旧分组', color: 'sage', objectIds: [shared.id, own.id] },
    ],
  };
  const db = new DatabaseSync(join(directory, 'desktop.sqlite'));
  try {
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(b.workspaceId, 'canvas-groups', JSON.stringify(previous));
  } finally { db.close(); }
  const opened = store.snapshot(b.workspaceId);
  const migrated = opened.groups.items.find((area) => area.id === 'legacy')!;
  assert.equal(migrated.name, '旧分组');
  assert.ok(migrated.bounds);
  assert.deepEqual(migrated.objectIds, [own.id]);
  assert.deepEqual(new Set(regionMemberIds(migrated)), new Set([own.id, shared.id]));
  assert.deepEqual(opened.objects.map((object) => object.bounds), [bounds, bounds]);
  const moved = store.moveRegion(b.workspaceId, b.credential, 'session-a', {
    requestId: 'move-migrated-region', id: migrated.id,
    groupsRevision: opened.groups.revision, viewRevision: opened.viewRevision,
    boardRevision: opened.canvasBoard!.revision, dx: 120, dy: 60,
  });
  assert.deepEqual(moved.objects.find((object) => object.id === shared.id)?.bounds, bounds);
  assert.equal(moved.objects.find((object) => object.id === own.id)?.bounds.x, 120);
});
test('copy and cut transfer the current file between desktops with a retryable atomic receipt', (t) => {
  const { store, b } = setup(t);
  const targetWorkspaceId = store.createWorkspace(null, '收件桌面');
  const otherSession = store.createWorkspace('host-private');
  const fileName = '中文说明.md';
  const file = store.importAttachment(b.workspaceId, b.credential, 'session-a', {
    requestId: 'file-in',
    fileName,
    data: Buffer.from('旧版').toString('base64'),
    relativePath: `材料/${fileName}`,
    bounds,
  });
  const data = Buffer.from('# 最新版\r\n内容\r\n').toString('base64');
  const updated = store.replaceNativeFile(b.workspaceId, b.credential, 'session-a', {
    requestId: 'file-update',
    objectId: file.id,
    expectedRevision: file.revision,
    fileName,
    data,
  });
  store.manageObject(b.workspaceId, b.credential, 'session-a', {
    requestId: 'file-policy',
    objectId: file.id,
    expectedRevision: updated.revision,
    operation: 'policy',
    policy: { private: true, locked: true, note: '', revision: 0, protectedRanges: [] },
  });
  const payload = { objectId: file.id, expectedRevision: updated.revision, targetWorkspaceId };
  const move = { ...payload, requestId: 'file-cut', operation: 'cut' };
  const transfer = (input: unknown) =>
    store.transferFile(b.workspaceId, b.credential, 'session-a', input);
  assert.throws(() => transfer({ ...move, targetWorkspaceId: otherSession }), {
    code: 'WORKSPACE_NOT_FOUND',
  });
  assert.throws(() => transfer({ ...move, expectedRevision: file.revision }), {
    code: 'REVISION_CONFLICT',
  });
  const draft = { objectId: file.id, kind: 'text', data: '{}' };
  store.nativeDraftSync(b.workspaceId, b.credential, 'session-a', { entries: [draft] });
  assert.throws(() => transfer(move), { code: 'DRAFT_ACTIVE' });
  store.nativeDraftSync(b.workspaceId, b.credential, 'session-a', {
    entries: [{ ...draft, data: null }],
  });
  assert.deepEqual(store.snapshot(targetWorkspaceId).objects, []);

  const copy = transfer({ ...payload, requestId: 'file-copy', operation: 'copy' });
  assert.equal(store.snapshot(b.workspaceId).objects[0].id, file.id);
  assert.equal(copy.targetName, '收件桌面');
  assert.notEqual(copy.objectId, file.id);
  const [copied] = store.snapshot(targetWorkspaceId).objects;
  assert.equal(copied.id, copy.objectId);
  assert.equal(copied.title, fileName);
  assert.equal(copied.revision, 1);
  assert.equal(copied.policy?.private, true);
  assert.equal(copied.policy?.locked, true);
  const target = (store.open(null, targetWorkspaceId) as { binding: PanelBinding }).binding;
  const exported = store.exportFile(targetWorkspaceId, target.credential, null, {
    requestId: 'export-copy',
    objectId: copied.id,
    expectedRevision: 1,
  });
  assert.equal(readFileSync(exported.path).toString('base64'), data);

  // Force a failure after the destination insert, while archiving the source.
  store.db.exec(`CREATE TEMP TRIGGER interrupt_cut BEFORE INSERT ON settings
    WHEN NEW.key LIKE 'archived:%' BEGIN SELECT RAISE(ABORT, 'interrupted cut'); END;`);
  assert.throws(() => transfer(move), /interrupted cut/);
  assert.equal(store.snapshot(targetWorkspaceId).objects.length, 1);
  assert.equal(store.snapshot(b.workspaceId).objects[0].id, file.id);
  store.db.exec('DROP TRIGGER interrupt_cut');

  const moved = transfer(move);
  assert.deepEqual(transfer(move), moved);
  const destination = store.snapshot(targetWorkspaceId).objects;
  assert.equal(destination.length, 2);
  assert.equal(destination[1].id, moved.objectId);
  assert.deepEqual(destination[1].content, copied.content);
  assert.notDeepEqual(destination[1].bounds, copied.bounds);
  assert.deepEqual(store.snapshot(b.workspaceId).objects, []);
  assert.equal(store.archivedObjects(b.workspaceId, b.credential, 'session-a')[0].id, file.id);
});
test('generated files retain the exact request and the source used for nearby placement', (t) => {
  const { store, directory, b } = setup(t);
  const previousSession = process.env.AI_DESKTOP_SESSION_REF;
  const previousOutputDir = process.env.AI_DESKTOP_OUTPUT_DIR;
  process.env.AI_DESKTOP_SESSION_REF = 'session-a';
  process.env.AI_DESKTOP_OUTPUT_DIR = join(directory, 'generated-output');
  t.after(() => {
    if (previousSession === undefined) delete process.env.AI_DESKTOP_SESSION_REF;
    else process.env.AI_DESKTOP_SESSION_REF = previousSession;
    if (previousOutputDir === undefined) delete process.env.AI_DESKTOP_OUTPUT_DIR;
    else process.env.AI_DESKTOP_OUTPUT_DIR = previousOutputDir;
  });
  const source = store.importAttachment(b.workspaceId, b.credential, 'session-a', {
    requestId: 'budget-source',
    fileName: '预算规划.csv',
    data: Buffer.from('项目,预算\n产品设计,120000\n').toString('base64'),
    bounds: { ...bounds, x: 2400, y: 1000 },
  });
  const begin = (title: string) =>
    store.generatedFiles('session-a', {
      operation: 'begin',
      workspaceId: b.workspaceId,
      threadId: 'budget-thread',
      title,
      sourceIds: [source.id],
      view: { x: 0, y: 0, width: 900, height: 600 },
      viewWorkspaceId: b.workspaceId,
    }) as OutputBatch;
  begin('检查预算');
  const batch = begin('按季度拆分预算');
  store.generatedFiles('session-a', { operation: 'bind', id: batch.id, turnId: 'budget-turn' });
  writeFileSync(join(batch.directory, '季度预算.csv'), '季度,预算\nQ1,120000\n');
  const collect = () =>
    store.generatedFiles('session-a', { operation: 'collect', id: batch.id }) as OutputBatch;
  const result = collect();
  assert.equal(result.turnId, 'budget-turn');
  assert.deepEqual(result.issues, []);
  assert.equal(result.files.length, 1);
  const id = result.files[0].objectId;
  const object = store.snapshot(b.workspaceId).objects.find((item) => item.id === id)!;
  assert.equal(object.bounds.x, source.bounds.x + source.bounds.width + 56);
  assert.equal(object.bounds.y, source.bounds.y);
  assert.equal(object.generation?.request, '按季度拆分预算');
  assert.equal(object.generation?.anchorSourceId, source.id);
  assert.deepEqual(object.generation?.sources, [
    { id: source.id, title: source.title, revision: source.revision },
  ]);
  store.db
    .prepare("UPDATE settings SET value=json_remove(value,'$.request') WHERE workspace=? AND key=?")
    .run(b.workspaceId, `generated-source:${id}`);
  assert.equal(
    store.snapshot(b.workspaceId).objects.find((item) => item.id === id)?.generation?.request,
    '按季度拆分预算',
  );
  assert.deepEqual(collect().files.map((file) => file.objectId), [id]);
});

test('A/B sessions cannot cross-read or cross-write using a valid panel token', (t) => {
  const { store, b, create, write } = setup(t);
  const a = create();
  store.createWorkspace('session-b');
  const b2 = (store.open('session-b') as any).binding;
  assert.throws(() => store.getWorkspace(b.workspaceId, b.credential, 'session-b'), {
    code: 'SESSION_MISMATCH',
  });
  assert.throws(() => store.getWorkspace(b2.workspaceId, b.credential, 'session-a'), {
    code: 'PERMISSION_DENIED',
  });
  assert.throws(
    () =>
      store.commit(
        {
          workspaceId: b.workspaceId,
          credential: b.credential,
          requestId: 'cross',
          expectedRevisions: { [a.id]: 1 },
          operations: [{ type: 'replace_text', objectId: a.id, content: content('wrong') }],
        },
        'session-b',
      ),
    { code: 'SESSION_MISMATCH' },
  );
  assert.equal(write(a.id, 1, 'okay').changed[0].revision, 2);
});
test('same request is exactly replayed; changed payload and stale revision are rejected', (t) => {
  const { store, b, create, write } = setup(t);
  const o = create();
  assert.deepEqual(write(o.id, 1, 'new', 'same'), write(o.id, 1, 'new', 'same'));
  assert.throws(() => write(o.id, 1, 'different', 'same'), { code: 'REQUEST_ID_REUSED' });
  assert.throws(() => write(o.id, 1, 'old'), { code: 'REVISION_CONFLICT' });
  assert.equal(store.getWorkspace(b.workspaceId, b.credential, 'session-a').objects[0].revision, 2);
});
test('multi-object commit rolls back every write on any version conflict', (t) => {
  const { store, b, create, write } = setup(t);
  const a = create(),
    c = create();
  write(c.id, 1, 'updated');
  assert.throws(
    () =>
      store.commit(
        {
          workspaceId: b.workspaceId,
          credential: b.credential,
          requestId: 'atomic',
          expectedRevisions: { [a.id]: 1, [c.id]: 1 },
          operations: [
            { type: 'replace_text', objectId: a.id, content: content('bad') },
            { type: 'replace_text', objectId: c.id, content: content('bad') },
          ],
        },
        'session-a',
      ),
    { code: 'REVISION_CONFLICT' },
  );
  assert.equal(store.getWorkspace(b.workspaceId, b.credential, 'session-a').objects[0].revision, 1);
});
test('selection contains actual image bytes and excludes unselected text', (t) => {
  const { store, b, create, prepare, execToken } = setup(t);
  const selected = create('selected material');
  create('secret unselected material');
  const image = store.createObject(b.workspaceId, b.credential, 'session-a', 'image', {
    kind: 'image',
    title: 'test',
    data: png,
    bounds,
  });
  const p = prepare([selected, image]);
  assert.equal(p.content[1].type, 'image');
  assert.equal((p.content[1] as any).data, png);
  assert.ok(!(p.content[0] as any).text.includes('secret unselected material'));
  const read = store.read(b.workspaceId, execToken(p), 'session-a', [image.id]);
  assert.equal((read.content[1] as any).data, png);
});
test('execution token cannot read unselected data or masquerade as panel', (t) => {
  const { store, b, create, prepare, execToken } = setup(t);
  const a = create(),
    other = create();
  const token = execToken(prepare([a]));
  assert.throws(() => store.read(b.workspaceId, token, 'session-a', [other.id]), {
    code: 'PERMISSION_DENIED',
  });
  assert.throws(() => store.getWorkspace(b.workspaceId, token, 'session-a'), {
    code: 'PERMISSION_DENIED',
  });
  assert.throws(
    () => store.saveDraft(b.workspaceId, token, 'session-a', a.id, 1, content('fake human')),
    { code: 'PERMISSION_DENIED' },
  );
});
test('AI dependency changes and human drafts reject AI writes while preserving human edits', (t) => {
  const { store, b, create, write, prepare, execToken } = setup(t);
  const a = create(),
    dependency = create();
  const token = execToken(prepare([a, dependency]));
  store.saveDraft(b.workspaceId, b.credential, 'session-a', a.id, 1, content('human typing'));
  assert.throws(() => write(a.id, 1, 'AI', 'draft-test', token), { code: 'DRAFT_ACTIVE' });
  write(a.id, 1, 'human saved');
  assert.throws(() => write(a.id, 2, 'AI', 'stale-test', token), { code: 'STALE_INPUT' });
  const fresh = execToken(
    prepare([store.getWorkspace(b.workspaceId, b.credential, 'session-a').objects[0], dependency]),
  );
  write(dependency.id, 1, 'changed dependency');
  assert.throws(() => write(a.id, 2, 'AI', 'dependency-test', fresh), { code: 'STALE_INPUT' });
});
test('prepare refuses unsaved or stale snapshots; saved latest value is frozen', (t) => {
  const { store, b, create, write, prepare } = setup(t);
  const a = create();
  store.saveDraft(b.workspaceId, b.credential, 'session-a', a.id, 1, content('new typing'));
  assert.throws(() => prepare([a]), { code: 'DRAFT_ACTIVE' });
  write(a.id, 1, 'new typing');
  assert.throws(() => prepare([a]), { code: 'REVISION_CONFLICT' });
  const p = prepare(store.getWorkspace(b.workspaceId, b.credential, 'session-a').objects);
  assert.ok((p.content[0] as any).text.includes('new typing'));
});
test('second panel cannot replace a live draft; expired recovery retains original base', (t) => {
  const { store, b, create, write } = setup(t);
  const a = create();
  store.saveDraft(b.workspaceId, b.credential, 'session-a', a.id, 1, content('draft'));
  const second = (store.open('session-a') as any).binding;
  assert.throws(
    () => store.saveDraft(b.workspaceId, second.credential, 'session-a', a.id, 1, content('other')),
    { code: 'DRAFT_ACTIVE' },
  );
  store.db.prepare('UPDATE drafts SET expires=0').run();
  write(a.id, 1, 'saved elsewhere', crypto.randomUUID(), second.credential);
  assert.equal(
    store.saveDraft(b.workspaceId, b.credential, 'session-a', a.id, 1, content('recover')).conflict,
    true,
  );
  assert.throws(() => write(a.id, 2, 'force old draft'), { code: 'REVISION_CONFLICT' });
});
test('cancel is durable and late submissions cannot commit or retry successfully', (t) => {
  const { store, b, create, write, prepare, execToken } = setup(t);
  const a = create();
  const p = prepare([a]),
    token = execToken(p);
  store.cancel(b.workspaceId, b.credential, 'session-a', p.snapshotId);
  assert.throws(() => write(a.id, 1, 'late', 'late', token), { code: 'TASK_CANCELLED' });
});
test('two controller connections enforce revisions using SQLite transactions', (t) => {
  const { store, directory, b, create, write } = setup(t);
  const a = create();
  const other = new DesktopStore(directory);
  write(a.id, 1, 'first');
  assert.throws(
    () =>
      other.commit(
        {
          workspaceId: b.workspaceId,
          credential: b.credential,
          requestId: 'second',
          expectedRevisions: { [a.id]: 1 },
          operations: [{ type: 'replace_text', objectId: a.id, content: content('lost update') }],
        },
        'session-a',
      ),
    { code: 'REVISION_CONFLICT' },
  );
  assert.equal(other.getWorkspace(b.workspaceId, b.credential, 'session-a').objects[0].revision, 2);
  other.close();
});
test('native file writeback accepts identical external sync but keeps different-content conflicts', (t) => {
  const { store, directory, b, prepare, execToken } = setup(t);
  const make = (fileName: string) =>
    store.importAttachment(b.workspaceId, b.credential, 'session-a', {
      requestId: crypto.randomUUID(),
      fileName,
      data: Buffer.from('original').toString('base64'),
      bounds,
    });
  const start = (object: ReturnType<typeof make>, candidate: Buffer) => {
    const credential = execToken(prepare([object]));
    const file = store.nativeFiles.prepare(b.workspaceId, credential, 'session-a', {
      requestId: crypto.randomUUID(),
      objectId: object.id,
      expectedRevision: object.revision,
      intent: 'edit',
    }) as { fileSessionId: string; workingPath: string };
    writeFileSync(file.workingPath, candidate);
    return { credential, file };
  };
  const sync = (object: ReturnType<typeof make>, bytes: Buffer) => {
    const assetHash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(directory, 'assets', assetHash), bytes);
    const content = { ...object.content, assetHash, size: bytes.length };
    store.db
      .prepare("UPDATE objects SET content=?,revision=2,actor='human' WHERE workspace=? AND id=?")
      .run(JSON.stringify(content), b.workspaceId, object.id);
    store.db
      .prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)')
      .run(
        b.workspaceId,
        object.id,
        2,
        JSON.stringify(content),
        'human',
        '同步外部文件修改',
        new Date().toISOString(),
      );
  };

  const same = make('same.svg'),
    matching = Buffer.from('<svg>updated</svg>'),
    first = start(same, matching);
  sync(same, matching);
  const ready = store.nativeFiles.result(b.workspaceId, first.credential, 'session-a', {
    operation: 'status',
    fileSessionId: first.file.fileSessionId,
  }) as { conflict: boolean; nextAction: string };
  assert.equal(ready.conflict, false);
  assert.match(ready.nextAction, /当前版本/);
  const result = store.nativeFiles.result(b.workspaceId, first.credential, 'session-a', {
    operation: 'commit',
    fileSessionId: first.file.fileSessionId,
    expectedRevision: 1,
    summary: '更新 SVG',
  }) as { state: string; result: { objectId: string; revision: number; changed: boolean } };
  assert.equal(result.state, 'unchanged');
  assert.deepEqual(
    {
      objectId: result.result.objectId,
      revision: result.result.revision,
      changed: result.result.changed,
    },
    { objectId: same.id, revision: 2, changed: false },
  );
  assert.equal(
    store
      .getWorkspace(b.workspaceId, b.credential, 'session-a')
      .objects.find((o) => o.id === same.id)?.revision,
    2,
  );

  const different = make('different.svg'),
    second = start(different, Buffer.from('<svg>my work</svg>'));
  sync(different, Buffer.from('<svg>someone else</svg>'));
  assert.throws(
    () =>
      store.nativeFiles.result(b.workspaceId, second.credential, 'session-a', {
        operation: 'commit',
        fileSessionId: second.file.fileSessionId,
        expectedRevision: 1,
        summary: '更新另一个 SVG',
      }),
    { code: 'REVISION_CONFLICT' },
  );
  const pending = store.nativeFiles.result(b.workspaceId, second.credential, 'session-a', {
    operation: 'status',
    fileSessionId: second.file.fileSessionId,
  }) as { state: string; lastError?: { code: string } };
  assert.equal(pending.state, 'prepared');
  assert.equal(pending.lastError?.code, 'REVISION_CONFLICT');
});
test('offline changes are returned after reconnect with increasing cursor', (t) => {
  const { store, b, create, write, prepare, execToken } = setup(t);
  const a = create(),
    p = prepare([a]);
  const before = store.getWorkspace(b.workspaceId, b.credential, 'session-a').cursor;
  write(a.id, 1, 'AI changed', 'ai', execToken(p));
  const changes = store.changes(b.workspaceId, b.credential, 'session-a', before);
  assert.ok(changes.cursor > before);
  assert.equal(changes.workspace?.objects[0].revision, 2);
  assert.equal(changes.events[0].actor, 'ai');
  assert.equal(
    store.changes(b.workspaceId, b.credential, 'session-a', changes.cursor).workspace,
    undefined,
  );
});
test('reject active content and oversized images before creating an object', (t) => {
  const { store, b } = setup(t);
  assert.throws(
    () =>
      store.createObject(b.workspaceId, b.credential, 'session-a', 'svg', {
        kind: 'image',
        title: 'bad',
        bounds,
        data: Buffer.from("<svg onload='alert(1)'></svg>").toString('base64'),
      }),
    { code: 'INVALID_IMAGE' },
  );
  assert.equal(store.getWorkspace(b.workspaceId, b.credential, 'session-a').objects.length, 0);
});

test('generated storage paths do not create canvas wrappers; folder imports still do', (t) => {
  const { store, b } = setup(t);
  const make = (requestId: string, authority?: any) =>
    store.importAttachment(
      b.workspaceId,
      b.credential,
      'session-a',
      {
        requestId,
        fileName: 'result.md',
        relativePath: 'AI产出/task/result.md',
        data: Buffer.from('result').toString('base64'),
        bounds,
      },
      authority,
    );
  const generated = make('generated-flat', {
    actor: 'ai',
    summary: 'AI output',
    authorize: () => {},
  });
  let workspace = (store.open('session-a') as any).workspace;
  assert.equal(workspace.groups.items.length, 0);
  assert.ok(workspace.fileTree.locations[generated.id]);
  make('human-folder');
  workspace = (store.open('session-a') as any).workspace;
  assert.equal(workspace.groups.items.length, 2);
});
