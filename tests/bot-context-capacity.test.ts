import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BotCapacityStore } from '../packages/local-runtime/bot/bot-capacity.js';
import { buildWorkContext } from '../packages/local-runtime/bot/bot-work-context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopStore } from '../packages/local-runtime/store.js';

test('five background jobs reserve router and consultation capacity globally', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE work_runs(state TEXT);CREATE TABLE bot_requests(body TEXT);');
  const capacity = new BotCapacityStore(db);
  for (let i = 0; i < 5; i++) db.prepare('INSERT INTO work_runs VALUES(?)').run('running');
  const acquire = (id: string, role: string, w = 'one') =>
    capacity.command(w, { operation: 'capacity_acquire', id, threadId: id, role });
  assert.throws(() => acquire('sixth', 'background'));
  acquire('route', 'router');
  acquire('question', 'consult', 'two');
  assert.equal(capacity.counts().total, 7);
  assert.throws(() => acquire('another-question', 'consult'));
  capacity.command('two', { operation: 'capacity_unknown', id: 'question', threadId: 'question' });
  assert.throws(() =>
    capacity.command('two', {
      operation: 'capacity_release',
      id: 'question',
      threadId: 'question',
      status: 'completed',
      turnId: 'made-up',
    }),
  );
  capacity.command('two', {
    operation: 'capacity_ack',
    id: 'question',
    threadId: 'question',
    turnId: 'actual',
  });
  capacity.command('two', {
    operation: 'capacity_release',
    id: 'question',
    threadId: 'question',
    turnId: 'actual',
    status: 'completed',
  });
  assert.equal(capacity.counts().total, 6);
  db.close();
});

test('legacy six/seven executions drain without forcing a stop or exceeding seven', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE work_runs(state TEXT);CREATE TABLE bot_requests(body TEXT);');
  const capacity = new BotCapacityStore(db);
  for (let i = 0; i < 7; i++) db.prepare('INSERT INTO work_runs VALUES(?)').run('unknown');
  const acquire = (id: string, role: string) =>
    capacity.command('w', { operation: 'capacity_acquire', id, threadId: id, role });
  assert.throws(() => acquire('c', 'consult'));
  db.exec('DELETE FROM work_runs WHERE rowid=1');
  db.prepare('INSERT INTO bot_requests VALUES(?)').run(
    JSON.stringify({ state: 'received', consultationWaiting: true }),
  );
  assert.throws(() => acquire('r', 'router'));
  db.exec('DELETE FROM bot_requests');
  db.prepare('INSERT INTO bot_requests VALUES(?)').run(
    JSON.stringify({ delivery: { state: 'queued' } }),
  );
  assert.throws(() => acquire('r', 'router'));
  acquire('c', 'consult');
  assert.equal(capacity.counts().total, 7);
  db.close();
});

test('revision coalescing persists its deadline, fences old versions and retains original anchors', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-context-'));
  let store = new DesktopStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.createWorkspace('window');
  const w = (store.open('window') as any).binding.workspaceId;
  const call = (operation: string, options: any = {}) =>
    store.workManagement.command(w, { operation, ...options }, true);
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  t.after(() => {
    Date.now = now;
  });
  let task = call('intake', { requestId: 'r1', payload: { text: '制作报告，保留公式' } }).task;
  const opened = clock;
  for (let i = 0; i < 3; i++) {
    clock = opened + i * 1000;
    task = call('revise', {
      requestId: 'change' + i,
      taskId: task.id,
      expectedRevision: task.revision,
      payload: { text: '补充要求 ' + i },
    });
  }
  assert.equal(task.management.revisionWindow.readyAt, opened + 4000);
  assert.equal(
    call('dispatch', {
      requestId: 'early',
      taskId: task.id,
      payload: { threadId: 'thread', provider: 'codex', dispatchKey: 'early' },
    }).waiting,
    true,
  );
  store.close();
  store = new DesktopStore(directory);
  clock = opened + 4000;
  const run = call('dispatch', {
    requestId: 'ready',
    taskId: task.id,
    payload: { threadId: 'thread', provider: 'codex', dispatchKey: 'ready' },
  }).run;
  assert.equal(run.requirementsRevision, 4);
  const context = call('prepare', { requestId: 'context', taskId: task.id }).context;
  assert.equal(context.originals.length, 4);
  assert.match(context.requirements.goal, /保留公式/);
  assert.match(context.requirements.goal, /补充要求 2/);
  const huge = structuredClone(task);
  huge.management.requirements.at(-1).goal = '原文'.repeat(15000);
  assert.throws(() => buildWorkContext(huge), /预算/);
});
