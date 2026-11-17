import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSystemOpen } from '../packages/local-runtime/files/system-open.ts';

function fixture() {
  const object = {
    id: 'file',
    content: { fileName: 'notes.md', mime: 'text/markdown', size: 4, assetHash: 'a'.repeat(64) },
  };
  const state = { pending: undefined, flushes: [], diskHash: 'current', desktopHash: 'current' };
  const api = {
    workspaceId: 'workspace',
    directory: () => {
      throw Error('An existing linked file must not be rematerialized');
    },
    pendingWrite: () => state.pending,
    links: {
      link: () => ({ diskHash: 'baseline' }),
      materialize: () => {
        throw Error('Unexpected materialize');
      },
      flush: (workspace) => state.flushes.push(workspace),
      inspect: () => ({ path: 'original.md', ...state }),
    },
  };
  return { object, state, api };
}

test('system opening waits for writes, and never flushes over an existing sync error', () => {
  const { object, state, api } = fixture();
  state.pending = {};
  assert.deepEqual(prepareSystemOpen(object, api), { pending: true });
  assert.deepEqual(state.flushes, ['workspace']);
  state.pending = { error: 'conflicting disk edit' };
  assert.throws(() => prepareSystemOpen(object, api), /conflicting disk edit/);
  assert.deepEqual(state.flushes, ['workspace']);
});

test('system opening preserves independently edited disk content and blocks divergent desktop edits', () => {
  const { object, state, api } = fixture();
  state.diskHash = 'external-edit';
  state.desktopHash = 'baseline';
  assert.equal(prepareSystemOpen(object, api).path, 'original.md');
  state.desktopHash = 'desktop-edit';
  assert.throws(() => prepareSystemOpen(object, api), /尚未同步/);
  state.missing = true;
  assert.throws(() => prepareSystemOpen(object, api), /原文件已移动或删除/);
  assert.deepEqual(state.flushes, []);
});
