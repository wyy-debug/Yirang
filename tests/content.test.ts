import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DesktopStore } from '../packages/local-runtime/store.js';
import { parseCsv, tableCsv } from '../packages/components/content.js';
import type { PanelBinding, Table } from '../packages/contracts/index.js';

const bounds = { x: 0, y: 0, width: 350, height: 300 };
const table = {
  columns: [
    { id: 'col-item', label: '项目' },
    { id: 'col-count', label: '数量' },
  ],
  rows: [
    { id: 'row-a', cells: ['A', '1'] },
    { id: 'row-b', cells: ['B', '2'] },
  ],
};
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-desktop-content-'));
  const store = new DesktopStore(directory);
  store.createWorkspace('test-A');
  const b = (store.open('test-A') as { binding: PanelBinding }).binding;
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const create = (kind: 'table' | 'code', content: any) =>
    store.createObject(b.workspaceId, b.credential, 'test-A', crypto.randomUUID(), {
      kind,
      title: '材料',
      content,
      bounds,
    });
  const commit = (
    objectId: string,
    revision: number,
    op: any,
    credential = b.credential,
    requestId = crypto.randomUUID(),
  ) =>
    store.commit(
      {
        workspaceId: b.workspaceId,
        credential,
        requestId,
        expectedRevisions: { [objectId]: revision },
        operations: [{ ...op, objectId }],
      },
      'test-A',
    );
  const grant = (o: any) =>
    store.prepare(b.workspaceId, b.credential, 'test-A', {
      requestId: crypto.randomUUID(),
      objectIds: [o.id],
      expectedRevisions: { [o.id]: o.revision },
      instruction: '修改材料',
    }).content[0];
  const token = (o: any) =>
    (grant(o) as { text: string }).text.match(/credential=(execution_[\w-]+)/)![1];
  return { store, b, create, commit, token, directory };
}
test('CSV parses quoted Unicode, CRLF, embedded newlines and literal formulas', () => {
  let index = 0;
  const parsed = parseCsv(
    '\uFEFF名称,备注\r\n"中,文","一行\r\n""二行"""\r\n=1+2,@test\r\n',
    () => `id-${index++}`,
  );
  assert.equal(parsed.rows[0].cells[0], '中,文');
  assert.equal(parsed.rows[0].cells[1], '一行\r\n"二行"');
  assert.equal(parsed.rows[1].cells[0], '=1+2');
  assert.ok(tableCsv(parsed).includes("'=1+2,'@test"));
  const again = parseCsv(tableCsv(parsed, false), () => `new-${index++}`);
  assert.deepEqual(
    again.rows.map((r) => r.cells),
    parsed.rows.map((r) => r.cells),
  );
  assert.throws(() => parseCsv('a,b\n"unterminated', () => crypto.randomUUID()), /未闭合/);
  assert.throws(() => parseCsv('a,b\n1,2,3', () => crypto.randomUUID()), /列数/);
  assert.throws(() => parseCsv('a,b\n"a"b,c', () => crypto.randomUUID()), /引号/);
});
test('CSV import retries preserve identity and exact original bytes after edits', (t) => {
  const { store, b, commit } = setup(t),
    data = Buffer.from('\uFEFF项目,数量\r\nA,1\r\n').toString('base64');
  const input = { requestId: 'import-1', fileName: '测试.csv', kind: 'table', data, bounds };
  const object = store.importFile(b.workspaceId, b.credential, 'test-A', input);
  assert.equal(store.importFile(b.workspaceId, b.credential, 'test-A', input).id, object.id);
  const content = object.content as Table;
  commit(object.id, 1, {
    type: 'update_cells',
    cells: [{ rowId: content.rows[0].id, columnId: content.columns[1].id, value: '3' }],
  });
  assert.equal(store.originalFile(b.workspaceId, b.credential, 'test-A', object.id).data, data);
  assert.throws(
    () =>
      store.importFile(b.workspaceId, b.credential, 'test-A', {
        ...input,
        data: Buffer.from('different').toString('base64'),
      }),
    { code: 'REQUEST_ID_REUSED' },
  );
  assert.throws(
    () =>
      store.importFile(b.workspaceId, b.credential, 'test-A', { ...input, fileName: '../bad.csv' }),
    { code: 'INVALID_FILE' },
  );
  assert.throws(
    () =>
      store.importFile(b.workspaceId, b.credential, 'test-A', {
        ...input,
        requestId: 'bad',
        data: '//4=',
      }),
    { code: 'INVALID_FILE' },
  );
});
test('model cell edits address stable row IDs, reject missing/duplicate cells and structure replacement', (t) => {
  const { store, b, create, commit, token } = setup(t),
    o = create('table', table),
    key = token(o);
  assert.throws(() => commit(o.id, 1, { type: 'replace_table', content: table }, key), {
    code: 'PERMISSION_DENIED',
  });
  assert.throws(
    () =>
      commit(
        o.id,
        1,
        { type: 'update_cells', cells: [{ rowId: 'missing', columnId: 'col-count', value: '4' }] },
        key,
      ),
    { code: 'NOT_FOUND' },
  );
  assert.throws(
    () =>
      commit(
        o.id,
        1,
        {
          type: 'update_cells',
          cells: Array(2).fill({ rowId: 'row-b', columnId: 'col-count', value: '4' }),
        },
        key,
      ),
    { code: 'VALIDATION_FAILED' },
  );
  commit(
    o.id,
    1,
    { type: 'update_cells', cells: [{ rowId: 'row-b', columnId: 'col-count', value: '4' }] },
    key,
  );
  const current = store.getWorkspace(b.workspaceId, b.credential, 'test-A').objects[0];
  assert.deepEqual(
    (current.content as Table).rows.map((r) => r.cells),
    [
      ['A', '1'],
      ['B', '4'],
    ],
  );
  assert.equal(current.lastActor, 'ai');
  assert.throws(() => store.originalFile(b.workspaceId, key, 'test-A', o.id), {
    code: 'PERMISSION_DENIED',
  });
});
test('table and code drafts block stale model writes and survive reopening', (t) => {
  const { store, b, create, commit, token, directory } = setup(t);
  for (const [kind, content, next] of [
    ['table', table, { ...table, rows: [{ id: 'row-a', cells: ['new', '3'] }] }],
    ['code', { code: 'before', language: 'python' }, { code: 'human()', language: 'python' }],
  ] as const) {
    const o = create(kind, content),
      key = token(o);
    store.saveDraft(b.workspaceId, b.credential, 'test-A', o.id, 1, next);
    assert.throws(
      () =>
        commit(
          o.id,
          1,
          kind === 'table'
            ? {
                type: 'update_cells',
                cells: [{ rowId: 'row-a', columnId: 'col-count', value: '0' }],
              }
            : { type: 'replace_code', content: { code: 'wrong', language: 'python' } },
          key,
        ),
      { code: 'DRAFT_ACTIVE' },
    );
  }
  const second = new DesktopStore(directory);
  try {
    const reopened = second.open('test-A') as any;
    assert.equal(reopened.drafts.length, 2);
    assert.equal(reopened.drafts.find((d: any) => 'code' in d.content).content.code, 'human()');
  } finally {
    second.close();
  }
});
test('restore is a new revision, idempotent and rejects stale comparisons, drafts and execution tokens', (t) => {
  const { store, b, create, commit, token } = setup(t),
    o = create('code', { code: 'v1', language: 'text' }),
    key = token(o);
  commit(o.id, 1, { type: 'replace_code', content: { code: 'v2', language: 'text' } });
  const request = { requestId: 'restore', objectId: o.id, expectedRevision: 2, targetRevision: 1 };
  assert.throws(() => store.restore(b.workspaceId, key, 'test-A', request), {
    code: 'PERMISSION_DENIED',
  });
  assert.throws(
    () => store.restore(b.workspaceId, b.credential, 'test-A', { ...request, expectedRevision: 1 }),
    { code: 'REVISION_CONFLICT' },
  );
  store.saveDraft(b.workspaceId, b.credential, 'test-A', o.id, 2, {
    code: 'draft',
    language: 'text',
  });
  assert.throws(() => store.restore(b.workspaceId, b.credential, 'test-A', request), {
    code: 'DRAFT_ACTIVE',
  });
  store.discardDraft(b.workspaceId, b.credential, 'test-A', o.id);
  const restored = store.restore(b.workspaceId, b.credential, 'test-A', request);
  assert.equal(restored.revision, 3);
  assert.deepEqual(store.restore(b.workspaceId, b.credential, 'test-A', request), restored);
  assert.equal(
    (store.revision(b.workspaceId, b.credential, 'test-A', o.id, 2).content as any).code,
    'v2',
  );
  assert.equal(
    (store.revision(b.workspaceId, b.credential, 'test-A', o.id, 3).content as any).code,
    'v1',
  );
  assert.equal(store.revisions(b.workspaceId, b.credential, 'test-A', o.id).revisions.length, 3);
  assert.throws(() => store.revision(b.workspaceId, b.credential, 'other-session', o.id, 1), {
    code: 'SESSION_MISMATCH',
  });
  assert.equal(
    store.activity(b.workspaceId, b.credential, 'test-A').events[0].type,
    'object.restored',
  );
});
test('history pagination is stable and activity is available after restart', (t) => {
  const { store, b, create, commit, directory } = setup(t),
    o = create('code', { code: '0', language: 'text' });
  for (let i = 1; i <= 55; i++)
    commit(o.id, i, { type: 'replace_code', content: { code: String(i), language: 'text' } });
  const first = store.revisions(b.workspaceId, b.credential, 'test-A', o.id);
  assert.equal(first.revisions.length, 30);
  assert.equal(first.revisions[0].revision, 56);
  const second = store.revisions(b.workspaceId, b.credential, 'test-A', o.id, first.next!);
  assert.equal(second.revisions[0].revision, 26);
  assert.equal(second.next, null);
    store.close();
  const reopened = new DesktopStore(directory);
  try {
    const a = reopened.activity(b.workspaceId, b.credential, 'test-A'),
      c = reopened.activity(b.workspaceId, b.credential, 'test-A', a.next!);
    assert.equal(a.events.length, 50);
    assert.equal(c.events.length, 6);
    assert.ok(a.events.at(-1)!.seq > c.events[0].seq);
  } finally {
    reopened.close();
  }
});
test('v1 upgrade backs up a consistent database and retains object identity/content', (t) => {
  const { store, b, create, directory } = setup(t),
    o = create('code', { code: 'preserved', language: 'text' });
  store.db.exec('DROP TABLE object_sources; PRAGMA user_version=1;');
  store.close();
  const upgraded = new DesktopStore(directory);
  try {
    assert.equal(upgraded.getWorkspace(b.workspaceId, b.credential, 'test-A').objects[0].id, o.id);
    const backup = readdirSync(directory).find((file) => file.startsWith('before-v6-'));
    assert.ok(backup);
    const original = new DatabaseSync(join(directory, backup!), { readOnly: true });
    assert.equal((original.prepare('PRAGMA user_version').get() as any).user_version, 1);
    assert.equal((original.prepare('SELECT COUNT(*) AS count FROM objects').get() as any).count, 1);
    original.close();
    assert.equal((upgraded.db.prepare('PRAGMA user_version').get() as any).user_version, 6);
  } finally {
    upgraded.close();
  }
});
test('local exports have real bytes, retain the original and never accept an output path', (t) => {
  const { store, b } = setup(t),
    bytes = Buffer.from('项目,数值\r\nA,=1+2\r\n');
  const object = store.importFile(b.workspaceId, b.credential, 'test-A', {
    requestId: 'csv',
    fileName: 'literal.csv',
    kind: 'table',
    data: bytes.toString('base64'),
    bounds,
  });
  const request = { requestId: 'export', objectId: object.id, expectedRevision: 1 };
  const result = store.exportFile(b.workspaceId, b.credential, 'test-A', request);
  assert.ok(result.path.startsWith(join(store.directory, 'exports')));
  assert.ok(readFileSync(result.path, 'utf8').includes("'=1+2"));
  assert.equal(readFileSync(result.path).length, result.bytes);
  assert.deepEqual(store.exportFile(b.workspaceId, b.credential, 'test-A', request), result);
  const original = store.exportFile(b.workspaceId, b.credential, 'test-A', {
    ...request,
    requestId: 'original',
    original: true,
  });
  assert.ok(readFileSync(original.path).equals(bytes));
  assert.throws(() =>
    store.exportFile(b.workspaceId, b.credential, 'test-A', {
      ...request,
      requestId: 'escape',
      path: 'C:/outside.csv',
    }),
  );
  assert.throws(
    () =>
      store.exportFile(b.workspaceId, b.credential, 'test-A', {
        ...request,
        requestId: 'stale',
        expectedRevision: 2,
      }),
    { code: 'REVISION_CONFLICT' },
  );
});
test('materialText returns stable text with revision checks', async (t) => {
  const { store, b, create, commit } = setup(t),
    o = create('code', { language: 'text', code: '甲乙丙' }) as any;
  const first = await store.materialText('test-A', [o.id], { [o.id]: o.revision });
  assert.equal(first.objects[0]!.revision, o.revision);
  assert.ok(first.objects[0]!.text.includes('甲乙丙'));
  const again = await store.materialText('test-A', [o.id], { [o.id]: o.revision });
  assert.equal(again.objects[0]!.contentHash, first.objects[0]!.contentHash);
  await assert.rejects(
    store.materialText('test-A', [o.id], { [o.id]: o.revision + 1 }),
    /材料已改变/,
  );
  await assert.rejects(store.materialText('test-A', ['missing'], { missing: 1 }), /1–10/);
  void b;
  void commit;
});
test('materialText never widens a partial selection', async (t) => {
  const { store, create } = setup(t),
    o = create('code', { language: 'text', code: '甲乙丙丁' }) as any;
  const part = await store.materialText(
    'test-A',
    [o.id],
    { [o.id]: o.revision },
    { [o.id]: { type: 'code', start: 1, end: 3, baseRevision: o.revision } },
  );
  assert.equal(part.objects[0]!.text, '乙丙');
  assert.deepEqual((part.objects[0] as any).selection, {
    type: 'code',
    start: 1,
    end: 3,
    baseRevision: o.revision,
  });
  await assert.rejects(
    store.materialText(
      'test-A',
      [o.id],
      { [o.id]: o.revision },
      { [o.id]: { type: 'code', start: 1, end: 30, baseRevision: o.revision } },
    ),
    /选区已过期/,
  );
  await assert.rejects(
    store.materialText(
      'test-A',
      [o.id],
      { [o.id]: o.revision },
      { [o.id]: { type: 'native', selectionId: 'gone', baseRevision: o.revision } },
    ),
    /选区已过期/,
  );
});
