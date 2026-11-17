import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopStore } from '../packages/local-runtime/store.js';
import { createFollowupDelivery } from '../apps/electron/work/work-followup.mjs';

test('supplements steer a live run, then continue finished work with original requirements and results', async t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const directory = mkdtempSync(join(tmpdir(), 'work-followup-'));
  const store = new DesktopStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createWorkspace('followup');
  const w = (store.open('followup') as any).binding.workspaceId;
  let sequence = 0;
  const cmd = (operation: string, taskId?: string, payload: any = {}) =>
    store.workManagement.command(w, { operation, taskId, payload,
      requestId: 'followup-' + sequence++,
      ...(taskId ? { expectedRevision: (store.workManagement.command(w, { operation: 'detail', taskId }, true) as any).revision } : {}),
    }, true) as any;
  const task = cmd('intake', undefined, { text: '修复架构图，并制作 PPT' }).task;
  cmd('intake', undefined, { text: '今天星期几？', intent: 'consult' });
  assert.deepEqual(cmd('list').conversation.at(-1).taskLinks, [task.id]);
  const start = () => cmd('dispatch', task.id, { threadId: 'worker', provider: 'codex', controlled: true, dispatchKey: 'dispatch-' + sequence });
  const first = start().run;
  cmd('ack', task.id, { runId: first.id, threadId: 'worker', turnId: 'turn-1' });
  const revised = cmd('revise', task.id, { text: '保留原来的颜色', continueRun: true });
  assert.equal(revised.management.runs.length, 1);
  assert.equal(revised.management.runs[0].state, 'running');
  const inputs: any[] = [];
  const deliver = createFollowupDelivery({
    invoke: async (_w: string, op: string, id: string | undefined, payload?: any) => cmd(op, id, payload),
    steer: async (_run: any, context: any) => inputs.push(context),
    changed() {},
  });
  await Promise.all([deliver(w, task.id), deliver(w, task.id)]);
  assert.equal(inputs.length, 1, 'duplicate delivery must not steer twice');
  assert.match(inputs[0].requirements.goal, /修复架构图/);
  assert.match(inputs[0].requirements.goal, /保留原来的颜色/);
  cmd('finish', task.id, { runId: first.id, state: 'succeeded', resultText: '架构图已修改，PPT 尚未完成' });
  cmd('revise', task.id, { text: '继续完成 PPT', continueRun: true });
  clock += 6000;
  const next = start();
  assert.equal(next.task.id, task.id);
  assert.notEqual(next.run.id, first.id);
  const prepared = cmd('prepare', task.id);
  assert.match(prepared.context.requirements.goal, /保留原来的颜色/);
  assert.match(prepared.context.requirements.goal, /继续完成 PPT/);
  assert.equal(prepared.context.previousResults[0].excerpt, '架构图已修改，PPT 尚未完成');
  assert.equal(cmd('list').tasks.length, 1);
});

test('a turn completing before supplement acknowledgement cannot complete new requirements', t => {
  const directory = mkdtempSync(join(tmpdir(), 'work-followup-race-'));
  const store = new DesktopStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createWorkspace('race');
  const w = (store.open('race') as any).binding.workspaceId;
  let seq = 0;
  const cmd = (operation: string, taskId?: string, payload: any = {}) => store.workManagement.command(w, {
    operation, taskId, payload, requestId: 'race-' + seq++,
    ...(taskId ? { expectedRevision: (store.workManagement.command(w, { operation: 'detail', taskId }, true) as any).revision } : {}),
  }, true) as any;
  const task = cmd('intake', undefined, { text: '生成报告' }).task;
  const run = cmd('dispatch', task.id, { threadId: 'worker', provider: 'codex', controlled: true, dispatchKey: 'r' }).run;
  cmd('ack', task.id, { runId: run.id, threadId: 'worker', turnId: 't' });
  cmd('revise', task.id, { text: '增加图表', continueRun: true });
  const finished = cmd('finish', task.id, { runId: run.id, state: 'succeeded', resultText: '旧报告完成' });
  assert.equal(finished.management.state, 'revising');
  assert.equal(cmd('list').tasks.length, 1);
});

test('uncertain steering is not replayed or converted to another work', async () => {
  const run = { id: 'r', state: 'running', requirementsRevision: 2, submittedRequirementsRevision: 1 };
  const task = { management: { runs: [run], currentRequirementsRevision: 2 } };
  let sends = 0;
  const deliver = createFollowupDelivery({
    invoke: async (_w, op) => {
      if (op === 'detail') return task;
      if (op === 'orchestration') return { requirementsRevision: 2 };
      if (op === 'prepare') return { context: { requirementsRevision: 2 }, content: [] };
      if (op === 'finish') { run.state = 'unknown'; return task; }
      assert.fail('must not acknowledge or resume uncertain delivery');
    },
    steer: async () => { sends++; throw Error('transport disconnected'); },
    changed() {},
  });
  await deliver('w', 'task');
  await deliver('w', 'task');
  assert.equal(sends, 1);
  assert.equal(run.state, 'unknown');
});

test('a real Codex no-active-turn reply reads the original terminal before continuing', async () => {
  const run = { id: 'r', threadId: 'worker', turnId: 'turn', state: 'running',
    requirementsRevision: 2, submittedRequirementsRevision: 1 };
  const task = { management: { runs: [run], currentRequirementsRevision: 2 } };
  let sends = 0, reconciled = 0;
  const deliver = createFollowupDelivery({
    invoke: async (_w, op) => {
      if (op === 'detail') return task;
      if (op === 'orchestration') return { requirementsRevision: 2 };
      if (op === 'prepare') return { context: { requirementsRevision: 2 }, content: [] };
      assert.fail('a verified original terminal must not be overwritten or manually resumed');
    },
    steer: async () => {
      sends++;
      throw Object.assign(Error('no active turn to steer'), { code: -32600 });
    },
    reconcileEnded: async old => {
      assert.equal(old.id, run.id);
      reconciled++;
      run.state = 'succeeded';
      return true;
    },
    changed() {},
  });
  await deliver('w', 'task');
  await deliver('w', 'task');
  assert.equal(sends, 1);
  assert.equal(reconciled, 1);
});

test('an inactive turn without a readable terminal stays unknown and is never replayed', async () => {
  const run = { id: 'r', threadId: 'worker', turnId: 'turn', state: 'running',
    requirementsRevision: 2, submittedRequirementsRevision: 1 };
  const task = { management: { runs: [run], currentRequirementsRevision: 2 } };
  let sends = 0;
  const deliver = createFollowupDelivery({
    invoke: async (_w, op, _id, payload) => {
      if (op === 'detail') return task;
      if (op === 'orchestration') return { requirementsRevision: 2 };
      if (op === 'prepare') return { context: { requirementsRevision: 2 }, content: [] };
      if (op === 'finish') { assert.equal(payload?.state, 'unknown'); run.state = 'unknown'; return task; }
      assert.fail('an unreadable terminal cannot authorize a new run');
    },
    steer: async () => {
      sends++;
      throw Object.assign(Error('no active turn to steer'), { code: -32600 });
    },
    reconcileEnded: async () => false,
    changed() {},
  });
  await deliver('w', 'task');
  await deliver('w', 'task');
  assert.equal(sends, 1);
  assert.equal(run.state, 'unknown');
});
