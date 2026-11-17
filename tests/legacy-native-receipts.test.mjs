import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { readLegacyNativeReceipts } from '../apps/electron/conversation/legacy-native-receipts.mjs';
import { outputWorkRecord } from '../apps/electron/workspace/output-work-record.mjs';

test('only a live turn or its tracked start pins a generated execution record', () => {
  const old = {
    id: 'old-batch', threadId: 'thread-A', title: 'editable version',
    state: 'running', updatedAt: '2026-11-06T05:10:44.842Z',
  };
  const current = { ...old, turnId: 'turn-B' };
  assert.equal(outputWorkRecord(old, {}).state, 'unknown');
  assert.equal(outputWorkRecord(old, { liveTurnId: 'turn-B' }).state, 'unknown');
  assert.equal(outputWorkRecord(old, { starting: true }).state, 'running');
  assert.equal(outputWorkRecord(current, { liveTurnId: 'turn-B' }).state, 'running');
  assert.equal(outputWorkRecord(current, { liveTurnId: 'turn-C' }).state, 'unknown');
  assert.equal(outputWorkRecord({ ...current, state: 'ready' }, {}).state, 'completed');
  assert.equal(outputWorkRecord(old, {}).updatedAt, old.updatedAt);
});

test('old execution cards remain readable without routing new work', async (t) => {
  const directory = await mkdtemp(join(process.cwd(), 'tmp-legacy-receipts-'));
  t.after(async () => {
    const root = resolve(process.cwd());
    const target = resolve(directory);
    if (!target.startsWith(root + sep) || !target.split(sep).at(-1)?.startsWith('tmp-legacy-receipts-'))
      throw Error('测试目录超出工作区');
    await rm(target, { recursive: true, force: true });
  });
  const path = join(directory, 'native-thread-receipts.json');
  assert.deepEqual(await readLegacyNativeReceipts(path, 'desk-A'), []);
  await writeFile(path, JSON.stringify({ version: 1, records: [
    { requestId: 'old-1', workspaceId: 'desk-A', threadId: 'thread-A', state: 'running' },
    { requestId: 'old-2', workspaceId: 'desk-B', threadId: 'thread-B' },
    { requestId: 'old-3', workspaceId: 'desk-A', threadId: 'thread-C', state: 'completed' },
  ] }));
  // An unfinished old receipt can never progress, so it must not look like running work.
  assert.deepEqual((await readLegacyNativeReceipts(path, 'desk-A'))
    .map((item) => [item.threadId, item.state]), [['thread-C', 'completed'], ['thread-A', 'unknown']]);
});
