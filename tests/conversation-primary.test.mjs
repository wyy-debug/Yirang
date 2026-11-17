import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationState } from '../apps/electron/conversation/conversation-state.mjs';

test('primary Bot thread survives restart and rollover without crossing workspaces', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bot-primary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'conversations.json');
  let state = await createConversationState({ path, emit: () => {} });
  await state.bindPrimary('desk-a', 'original');
  await assert.rejects(state.bindPrimary('desk-b', 'original'), /已绑定其他工作区/);
  assert.equal(state.primaryThread('desk-b'), null);
  await state.migrate('original', 'rolled');
  assert.equal(state.primaryThread('desk-a'), 'rolled');

  state = await createConversationState({ path, emit: () => {} });
  assert.equal(state.primaryThread('desk-a'), 'rolled');
  await state.bindPrimary('desk-b', 'independent');
  assert.equal(state.primaryThread('desk-b'), 'independent');
  await assert.rejects(state.migrate('rolled', 'independent'), /已绑定其他工作区/);
  assert.equal(state.primaryThread('desk-a'), 'rolled');
  assert.equal(state.primaryThread('desk-b'), 'independent');
});

test('primary lookup resolves a recovered context alias', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bot-primary-alias-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'conversations.json');
  const first = await createConversationState({ path, emit: () => {} });
  await first.bindPrimary('desk', 'old');
  const recovered = await createConversationState({
    path,
    emit: () => {},
    resolveThread: (id) => id === 'old' ? 'new' : id,
  });
  assert.equal(recovered.primaryThread('desk'), 'new');
});
