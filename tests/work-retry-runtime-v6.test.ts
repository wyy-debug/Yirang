import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopStore } from '../packages/local-runtime/store.js';
import { completionObject } from '../packages/local-runtime/work/completion-object.js';
import { DesktopError } from '../packages/contracts/index.js';

test('only proven unreceived submissions persist Retry-After scheduling', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-retry-'));
  const store = new DesktopStore(directory);
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createWorkspace('retry');
  const w = (store.open('retry') as any).binding.workspaceId;
  let seq = 0;
  const cmd = (operation: string, taskId?: string, payload: any = {}) => store.workManagement.command(w,
    { operation, taskId, payload, requestId: 'retry-' + seq++ }, true) as any;
  for (const notReceived of [true, false]) {
    const task = cmd('intake', undefined, { text: '生成 retry.txt' }).task;
    const run = cmd('dispatch', task.id, { threadId: 'worker-' + seq, provider: 'codex', controlled: true, dispatchKey: 'start-' + seq }).run;
    const start = Date.now();
    const result = cmd('finish', task.id, { runId: run.id, state: 'failed', notReceived,
      retryableTransport: true, retryAfterMs: 120000, reason: 'temporary unavailable' });
    if (notReceived) {
      assert.equal(result.management.state, 'queued');
      assert.ok(Date.parse(result.management.schedule.notBefore) >= start + 120000);
      assert.equal(cmd('detail', task.id).management.schedule.notBefore, result.management.schedule.notBefore);
    } else assert.notEqual(result.management.state, 'queued', 'uncertainty cannot be retried');
  }
  const removed = cmd('intake', undefined, { text: '生成 deleted.txt' }).task;
  const run = cmd('dispatch', removed.id, { threadId: 'deleted-worker', provider: 'codex', controlled: true, dispatchKey: 'deleted-run' }).run;
  cmd('ack', removed.id, { runId: run.id, threadId: 'deleted-worker', turnId: 'deleted-turn' });
  const finished = cmd('finish', removed.id, { runId: run.id, state: 'succeeded',
    artifacts: [{ objectId: 'deleted-object', revision: 1 }],
    completionEvidence: [{ objectId: 'deleted-object', revision: 1, status: 'passed', code: 'structure_valid', detail: 'previously checked' }] });
  assert.equal(finished.management.state, 'attention');
  assert.equal(finished.management.continuation.evidence[0].status, 'unknown');
  assert.equal(finished.management.continuation.next, 'blocked');
});

test('deleted completion objects become absent evidence; unrelated errors propagate', () => {
  assert.equal(completionObject(() => { throw new DesktopError('NOT_FOUND', 'gone'); }), undefined);
  assert.throws(() => completionObject(() => { throw Error('disk error'); }), /disk error/);
});
