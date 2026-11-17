import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DesktopStore } from '../packages/local-runtime/store.js';
import { attachConversationReports } from '../apps/electron/work/conversation-reports.mjs';

const setup = (t: test.TestContext) => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-intake-'));
  let store = new DesktopStore(directory);
  store.createWorkspace('bot-test');
  const w = (store.open('bot-test') as any).binding.workspaceId;
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const command = (operation: string, options: Record<string, unknown> = {}) =>
    store.workManagement.command(w, { operation, ...options }, true);
  const intake = (operation: string, p: Record<string, unknown> = {}) =>
    command('orchestration', { payload: { operation, ...p } });
  const receive = (id = 'r1') =>
    intake('receive', {
      request: { id, text: '整理报告', mode: 'daily', capture: { blocks: [] } },
    });
  const plan = (id = 'r1', generation = 1) =>
    intake('plan', {
      id,
      generation,
      effects: [
        { intent: 'primary', command: { operation: 'intake', payload: { text: '整理报告' } } },
      ],
    });
  return {
    directory,
    command,
    intake,
    receive,
    plan,
    restart: () => {
      store.close();
      store = new DesktopStore(directory);
    },
  };
};

test('upgrade requeues only undelivered legacy direct messages, once', t => {
  const f = setup(t);
  const db = new DatabaseSync(join(f.directory, 'desktop.sqlite'));
  try {
    for (const state of ['queued','sending','acknowledged','unknown']) {
      f.intake('receive', { request: { id: state, text: '整理报告', mode: 'professional',
        capture: { route:'professional', blocks:[{ type:'text',text:'附件原文' }] } } });
      db.prepare("UPDATE bot_requests SET body=json_set(body,'$.state','committed','$.delivery',json(?)) WHERE id=?")
        .run(JSON.stringify({ state, threadId:'old-thread' }),state);
    }
  } finally { db.close(); }
  f.restart();
  f.restart();
  const queued = f.intake('read',{id:'queued'});
  assert.equal(queued.state,'received');
  assert.equal(queued.capture.route,'auto');
  assert.equal(queued.capture.blocks[0].text,'附件原文');
  assert.equal(queued.delivery,undefined);
  for (const state of ['sending','acknowledged','unknown'])
    assert.equal(f.intake('read',{id:state}).delivery.state,state);
  assert.equal(f.command('list').tasks.length,0);
});

test('intake, decision and effect survive restart; lost reply cannot duplicate a task', (t) => {
  const f = setup(t);
  f.receive();
  const planned = f.plan();
  f.restart();
  assert.equal(f.intake('pending')[0].state, 'routing');
  const effectId = planned.effects[0].id,
    result = f.intake('apply', { id: 'r1', generation: 1, effectId });
  f.restart();
  assert.deepEqual(
    f.intake('apply', { id: 'r1', generation: 1, effectId }),
    JSON.parse(JSON.stringify(result)),
  );
  assert.equal(f.command('list').tasks.length, 1);
  assert.equal(f.intake('read', { id: 'r1' }).state, 'committed');
});
test('cancel before dispatch fences a late decision and preserves the original', (t) => {
  const f = setup(t);
  f.receive();
  const planned = f.plan();
  f.intake('cancel', { id: 'r1' });
  f.restart();
  assert.throws(() =>
    f.intake('apply', { id: 'r1', generation: 1, effectId: planned.effects[0].id }),
  );
  assert.equal(f.command('list').tasks.length, 0);
  assert.equal(f.intake('read', { id: 'r1' }).text, '整理报告');
  assert.throws(() =>
    f.intake('receive', {
      request: { id: 'r1', text: '另外删除文件', mode: 'daily', capture: { blocks: [] } },
    }),
  );
});

test('main transcript preserves all parallel work links without execution payloads', (t) => {
  const f = setup(t);
  f.receive();
  const planned = f.intake('plan', { id: 'r1', generation: 1, effects: [{
    intent: 'primary', command: { operation: 'intake', payload: {
      text: '生成两份报告', deliveries: ['甲报告', '乙报告'],
    } },
  }] });
  assert.deepEqual(f.intake('transcript').requests[0].taskLinks, []);
  f.intake('apply', { id: 'r1', generation: 1, effectId: planned.effects[0].id });
  const ids = f.command('list').tasks.map((task: any) => task.id).sort();
  assert.equal(ids.length, 2);
  f.restart();
  const request = f.intake('transcript').requests[0];
  assert.deepEqual(request.taskLinks.sort(), ids);
  assert.ok(request.workRequestIds.includes(planned.effects[0].command.requestId));
  const snapshot = f.command('list');
  const reports = attachConversationReports({ workspaceId: snapshot.workspaceId, requests: [request] }, snapshot);
  assert.equal(reports.requests[0].reports.length, 2);
  assert.equal(request.effects, undefined);
  assert.deepEqual(f.intake('transcript').requests[0].taskLinks.sort(), ids);
  assert.equal(f.command('list').tasks.length, 2);
});
test('RPC acknowledgement records submission, never model adoption', (t) => {
  const f = setup(t),
    task = f.command('intake', { requestId: 'task', payload: { text: '整理报告' } }).task;
  const { run } = f.command('dispatch', {
    requestId: 'dispatch',
    taskId: task.id,
    payload: { threadId: 'thread', provider: 'codex', dispatchKey: 'dispatch' },
  });
  const ack = f.command('ack', {
    requestId: 'ack',
    taskId: task.id,
    payload: { runId: run.id, threadId: 'thread', turnId: 'turn' },
  }).management.runs[0];
  assert.equal(ack.appliedRequirementsRevision, null);
  assert.equal(ack.submittedRequirementsRevision, 1);
  assert.equal(ack.reception.turnId, 'turn');
});
test('uncertain consultation send is not replayed, explicit RPC rejection can retry', (t) => {
  const f = setup(t);
  f.receive();
  const p = f.intake('plan', {
    id: 'r1',
    generation: 1,
    effects: [
      {
        intent: 'primary',
        command: { operation: 'intake', payload: { text: '为什么', intent: 'consult' } },
      },
    ],
  });
  f.intake('apply', { id: 'r1', generation: 1, effectId: p.effects[0].id });
  f.intake('send_prepare', { id: 'r1', threadId: 'thread' });
  f.restart();
  assert.throws(() => f.intake('send_prepare', { id: 'r1', threadId: 'thread' }));
  f.intake('send_failed', { id: 'r1', threadId: 'thread', notReceived: false });
  assert.equal(f.intake('read', { id: 'r1' }).delivery.state, 'unknown');
  f.intake('send_ack', { id: 'r1', threadId: 'thread', turnId: 'turn' });
  assert.throws(() => f.intake('send_prepare', { id: 'r1', threadId: 'thread' }));
});

test('recovery pages past an older blocked backlog without losing immutable input order', (t) => {
  const f = setup(t);
  for (let n = 0; n < 105; n++) f.receive('pending-' + n);
  const first = f.intake('pending');
  assert.equal(first.length, 100);
  const second = f.intake('pending', { afterSequence: first.at(-1).sequence });
  assert.equal(second.length, 5);
  assert.equal(second[0].id, 'pending-100');
  assert.equal(new Set([...first, ...second].map((r: any) => r.id)).size, 105);
  assert.equal(f.intake('pending', { afterSequence: second.at(-1).sequence }).length, 0);
});

test('a cancelled prerequisite asks for input instead of waiting forever or dispatching its dependent', (t) => {
  const f = setup(t);
  f.receive();
  const planned = f.intake('plan', {
    id: 'r1',
    generation: 1,
    effects: [
      { intent: 'source', command: { operation: 'intake', payload: { text: '先整理材料' } } },
      {
        intent: 'dependent',
        afterIntents: ['source'],
        command: { operation: 'intake', payload: { text: '依据材料写报告' } },
      },
    ],
  });
  const first = f.intake('apply', { id: 'r1', generation: 1, effectId: planned.effects[0].id });
  f.command('control', {
    requestId: 'cancel-source',
    expectedRevision: first.result.task.revision,
    taskId: first.result.task.id,
    payload: { action: 'cancel' },
  });
  const dependent = f.intake('apply', { id: 'r1', generation: 1, effectId: planned.effects[1].id });
  assert.equal(dependent.state, 'failed');
  assert.equal(f.intake('read', { id: 'r1' }).state, 'needs_input');
  assert.equal(f.command('list').tasks.length, 1);
});
