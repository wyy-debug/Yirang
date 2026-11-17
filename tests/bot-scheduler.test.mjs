import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DesktopStore } from '../packages/local-runtime/store.ts';
import { createWorkManager } from '../apps/electron/work/work-manager.mjs';

function fixture(t, workspaceTemp = false) {
  const root = workspaceTemp ? resolve('test-results/orchestration-implementation') : tmpdir();
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'bot-scheduler-')),
    store = new DesktopStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  return { store, directory };
}

test('offline Codex still marks an interrupted host run unknown without redispatch', async t => {
  const { store } = fixture(t);
  const workspace = store.createWorkspace(null, 'offline');
  let sequence = 0;
  const local = (operation, taskId, payload = {}) => store.workManagement.command(workspace,
    { operation, taskId, payload, requestId: `offline-${sequence++}` }, true);
  const task = local('intake', undefined, { text: '创建 proof.txt' }).task;
  const run = local('dispatch', task.id, { threadId: 'offline-worker', provider: 'codex',
    controlled: true, dispatchKey: 'offline-run' }).run;
  local('ack', task.id, { runId: run.id, threadId: 'offline-worker', turnId: 'offline-turn' });
  let dispatched = 0, observed = 0;
  const manager = createWorkManager({
    ready: () => false,
    controlled: () => true,
    emit() {},
    run: async () => { dispatched++; },
    readRun: async () => { observed++; return null; },
    call: async args => args.command.payload?.operation === 'host_workspaces'
      ? { workspaces: [{ id: workspace }] }
      : store.workManagement.command(args.workspaceId, args.command, true),
  });
  t.after(() => manager.dispose());
  await manager.command({ workspaceId: workspace,
    command: { operation: 'configure', requestId: 'wake-offline-recovery',
      payload: { maxConcurrent: 1 } } });
  let restored;
  for (let i = 0; i < 100; i++) {
    restored = local('detail', task.id);
    if (restored.management.runs[0].state === 'unknown') break;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.equal(restored.management.runs[0].state, 'unknown');
  assert.equal(restored.management.runs[0].id, run.id);
  assert.equal(dispatched, 0);
  assert.equal(observed, 0, 'CLI observation waits until Codex is available');
});

test('prepared pre-submission run is settled as not received and retried only after CLI returns', async t => {
  const { store } = fixture(t);
  const workspace = store.createWorkspace(null, 'prepared');
  let sequence = 0;
  const local = (operation, taskId, payload = {}) => store.workManagement.command(workspace,
    { operation, taskId, payload, requestId: `prepared-${sequence++}` }, true);
  const task = local('intake', undefined, { text: '创建 proof.txt' }).task;
  const run = local('dispatch', task.id, { threadId: 'pending', provider: 'codex',
    controlled: true, dispatchKey: 'prepared-run' }).run;
  assert.equal(run.submission.state, 'prepared');
  let dispatched = 0;
  const manager = createWorkManager({
    ready: () => false,
    controlled: () => true,
    emit() {},
    run: async () => { dispatched++; },
    call: async args => args.command.payload?.operation === 'host_workspaces'
      ? { workspaces: [{ id: workspace }] }
      : store.workManagement.command(args.workspaceId, args.command, true),
  });
  t.after(() => manager.dispose());
  await manager.command({ workspaceId: workspace,
    command: { operation: 'configure', requestId: 'wake-prepared-recovery',
      payload: { maxConcurrent: 1 } } });
  let restored;
  for (let i = 0; i < 100; i++) {
    restored = local('detail', task.id);
    if (restored.management.runs[0].submission.state === 'not_received') break;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.equal(restored.management.runs[0].submission.state, 'not_received');
  assert.equal(restored.management.runs[0].state, 'failed');
  assert.equal(restored.management.state, 'queued');
  assert.equal(restored.management.runs.length, 1);
  assert.equal(dispatched, 0);
});

test('only a trusted host can attach a recovered turn receipt to the original unknown run', t => {
  const { store } = fixture(t);
  const workspace = store.createWorkspace(null, 'lost-turn-receipt');
  let sequence = 0;
  const command = (operation, taskId, payload = {}, host = true) =>
    store.workManagement.command(workspace,
      { operation, taskId, payload, requestId: `lost-receipt-${sequence++}` }, host);
  const task = command('intake', undefined, { text: '创建 proof.txt' }).task;
  const run = command('dispatch', task.id, { threadId: 'original-thread',
    provider: 'codex', controlled: true, dispatchKey: 'lost-receipt' }).run;
  command('ack', task.id, { runId: run.id, threadId: 'original-thread', submitting: true });
  command('recover');
  const receipt = { runId: run.id, threadId: 'original-thread',
    turnId: 'original-turn', recovered: true };
  assert.throws(() => command('ack', task.id, receipt, false), /可信宿主/);
  assert.throws(() => command('ack', task.id, { ...receipt,
    threadId: 'another-thread' }), /不匹配/);
  const recovered = command('ack', task.id, receipt);
  const original = recovered.management.runs[0];
  assert.equal(original.id, run.id);
  assert.equal(original.state, 'unknown');
  assert.equal(original.turnId, 'original-turn');
  assert.equal(original.submission.state, 'received');
  assert.equal(original.reception.turnId, 'original-turn');
  assert.equal(command('ack', task.id, receipt).management.runs[0].turnId, 'original-turn');
  const reconciled = command('reconcile', task.id, { runId: run.id,
    state: 'interrupted', reason: '原回合已中断' });
  assert.equal(reconciled.management.runs[0].id, run.id);
  assert.equal(reconciled.management.runs[0].state, 'interrupted');
});

test('a ready desktop does not dispatch Codex work while its CLI is absent', async t => {
  const { store } = fixture(t);
  const workspace = store.createWorkspace(null, 'offline-dispatch');
  const task = store.workManagement.command(workspace, { operation: 'intake',
    requestId: 'offline-dispatch-intake', payload: { text: '创建 proof.txt' } }, true).task;
  let checks = 0, dispatched = 0;
  const manager = createWorkManager({
    ready: () => true,
    providerReady: () => { checks++; return false; },
    controlled: () => true,
    emit() {},
    run: async () => { dispatched++; },
    call: async args => args.command.payload?.operation === 'host_workspaces'
      ? { workspaces: [{ id: workspace }] }
      : store.workManagement.command(args.workspaceId, args.command, true),
  });
  t.after(() => manager.dispose());
  await manager.command({ workspaceId: workspace,
    command: { operation: 'configure', requestId: 'wake-offline-dispatch',
      payload: { maxConcurrent: 1 } } });
  for (let i = 0; i < 100 && checks === 0; i++)
    await new Promise(done => setTimeout(done, 20));
  assert.ok(checks > 0, 'scheduler inspected the offline candidate');
  assert.equal(dispatched, 0);
  assert.equal(store.workManagement.command(workspace, { operation: 'detail',
    taskId: task.id }, true).management.runs.length, 0);
});

test('multiple desktops receive turns fairly while both interaction reservations remain available', async (t) => {
  const { store } = fixture(t),
    a = store.createWorkspace(null, 'A'),
    b = store.createWorkspace(null, 'B'),
    started = [];
  let manager;
  const invoke = (w, operation, payload = {}, taskId) =>
    store.workManagement.command(
      w,
      { operation, taskId, requestId: crypto.randomUUID(), payload },
      true,
    );
  for (const w of [a, b]) for (let i = 0; i < 5; i++) invoke(w, 'intake', { text: w + '-' + i });
  manager = createWorkManager({
    ready: () => true,
    controlled: () => true,
    emit: () => {},
    interrupt: async () => {},
    readRun: async () => null,
    call: async (args) =>
      args.command.payload?.operation === 'host_workspaces'
        ? { workspaces: [{ id: a }, { id: b }] }
        : store.workManagement.command(args.workspaceId, args.command, true),
    run: async (task, _run, w) => {
      started.push({ id: task.id, w });
      await manager.bindThread(task.id, 'thread-' + task.id);
    },
  });
  t.after(() => manager.dispose());
  await manager.command({
    workspaceId: a,
    command: { operation: 'configure', requestId: 'configure', payload: { maxConcurrent: 5 } },
  });
  for (let i = 0; i < 100 && started.length < 5; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started.length, 5);
  assert.notEqual(started[0].w, started[1].w);
  assert.equal(started.filter((s) => s.w === b).length, 2);
  invoke(a, 'orchestration', {
    operation: 'capacity_acquire',
    id: 'router',
    threadId: 'router',
    role: 'router',
  });
  invoke(b, 'orchestration', {
    operation: 'capacity_acquire',
    id: 'consult',
    threadId: 'consult',
    role: 'consult',
  });
  assert.equal(invoke(a, 'orchestration', { operation: 'capacity_read' }).total, 7);
});

test('the host prepares and delegates a background task using its captured desktop', (t) => {
  const { store } = fixture(t),
    oldEnv = {
      host: process.env.AI_DESKTOP_WORK_HOST,
      session: process.env.AI_DESKTOP_SESSION_REF,
    };
  process.env.AI_DESKTOP_WORK_HOST = '1';
  process.env.AI_DESKTOP_SESSION_REF = 'host';
  t.after(() => {
    for (const [key, value] of [
      ['AI_DESKTOP_WORK_HOST', oldEnv.host],
      ['AI_DESKTOP_SESSION_REF', oldEnv.session],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  store.createWorkspace('host', 'visible');
  const background = store.createWorkspace(null, 'background'),
    privateDesktop = store.createWorkspace('other-session', 'private');
  const cmd = (operation, payload = {}, taskId) =>
    store.workManagement.command(
      background,
      { operation, taskId, requestId: crypto.randomUUID(), payload },
      true,
    );
  const task = cmd('intake', { text: '在原桌面整理内容' }).task,
    run = store.workHost('host', background, {
      operation: 'dispatch',
      taskId: task.id,
      requestId: 'dispatch',
      payload: {
        threadId: 'background-thread',
        provider: 'codex',
        dispatchKey: 'key',
        controlled: true,
      },
    }).run;
  const prepared = store.workHost('host', background, {
    operation: 'prepare',
    taskId: task.id,
    requestId: 'prepare',
    payload: {},
  });
  assert.equal(prepared.context.taskId, task.id);
  const delegated = store.workHost('host', background, {
    operation: 'delegate',
    taskId: task.id,
    requestId: 'delegate',
    payload: {
      runId: run.id,
      jobs: [
        { title: '核对', instructions: '检查事实', after: [] },
        { title: '整理', instructions: '整理结构', after: [] },
      ],
    },
  });
  assert.equal(delegated.children.length, 2);
  assert.throws(() => store.workHost('host', privateDesktop, { operation: 'list' }));
});

test('portable backup restores routing history without reviving execution or replay authority', async (t) => {
  const { store } = fixture(t, true),
    session = 'backup-test';
  store.createWorkspace(session);
  const b = store.open(session).binding,
    w = b.workspaceId;
  const call = (operation, p = {}) =>
    store.workManagement.command(
      w,
      { operation: 'orchestration', payload: { operation, ...p } },
      true,
    );
  call('receive', {
    request: { id: 'saved', text: '整理报告', mode: 'daily', capture: { blocks: [] } },
  });
  const plan = call('plan', {
    id: 'saved',
    generation: 1,
    effects: [
      { intent: 'primary', command: { operation: 'intake', payload: { text: '整理报告' } } },
    ],
  });
  const task = call('apply', { id: 'saved', generation: 1, effectId: plan.effects[0].id }).result
    .task;
  store.workManagement.command(
    w,
    {
      operation: 'dispatch',
      taskId: task.id,
      requestId: 'run',
      payload: { threadId: 'thread', provider: 'codex', dispatchKey: 'run' },
    },
    true,
  );
  const backup = await store.backups.create(w, b.credential, session, {
    requestId: 'backup',
    label: 'test',
  });
  const inspected = await store.backups.inspect(w, b.credential, session, { id: backup.id });
  const restored = await store.backups.restore(w, b.credential, session, {
      id: backup.id,
      digest: inspected.digest,
      requestId: 'restore',
      name: 'restored',
    }),
    read = store.workManagement.command(
      restored.id,
      { operation: 'orchestration', payload: { operation: 'read', id: 'saved' } },
      true,
    );
  assert.equal(read.state, 'rejected');
  assert.equal(read.delivery, undefined);
  assert.throws(() =>
    store.workManagement.command(
      restored.id,
      { operation: 'orchestration', payload: { operation: 'retry', id: 'saved' } },
      true,
    ),
  );
  const tasks = store.workManagement.command(
    restored.id,
    { operation: 'recover', requestId: 'recover' },
    true,
  ).tasks;
  assert.equal(tasks[0].management.restoredHistory, true);
  assert.equal(tasks[0].management.state, 'cancelled');
});
