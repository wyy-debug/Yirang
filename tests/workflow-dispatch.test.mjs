import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WorkflowDispatches } from '../packages/local-runtime/workflows/workflow-dispatch.ts';
import { createWorkflowDelivery, hasWorkflowDelivery } from '../apps/electron/conversation/workflow-delivery.mjs';
import { buildTurnInput } from '../apps/electron/conversation/turn-prompt.mjs';
import { dispatchTurn } from '../apps/electron/conversation/turn-dispatch.mjs';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE settings(workspace TEXT, key TEXT, value TEXT, PRIMARY KEY(workspace, key));
    CREATE TABLE credentials(workspace TEXT, owner TEXT, kind TEXT, status TEXT, expires INTEGER);
  `);
  const put = (key, value) =>
    db.prepare('INSERT INTO settings VALUES (?,?,?)').run('desk', key, JSON.stringify(value));
  const content = [{ type: 'text', text: 'prepared material' }];
  put('workflow-dispatch:dispatch', {
    id: 'dispatch', session: 'session', objectId: 'flow', runIds: ['run'],
    state: 'prepared', snapshotIds: ['snapshot'], revisions: {}, policies: {},
  });
  put('workflow-dispatch-payload:dispatch', content);
  put('workflow-run:run', { status: 'prepared' });
  put('workflow-binding:run:run', { owner: 'snapshot' });
  db.prepare('INSERT INTO credentials VALUES (?,?,?,?,?)')
    .run('desk', 'snapshot', 'execution', 'active', Date.now() + 60000);
  const receipts = new Map();
  const dispatches = new WorkflowDispatches(db, {
    auth: () => ({ owner: 'panel' }),
    object: () => { throw Error('No source objects in this fixture'); },
    assertReady: () => {},
    tx: (fn) => fn(),
    once: (_w, id, _payload, fn) => {
      if (!receipts.has(id)) receipts.set(id, fn());
      return receipts.get(id);
    },
    recover: () => { throw Error('The run is already prepared'); },
    prepare: () => { throw Error('The run is already prepared'); },
  });
  return { db, content, dispatches };
}

test('workflow claim returns material once and clears the persisted payload', (t) => {
  const { db, content, dispatches } = setup(t);
  const request = { operation: 'claim', requestId: 'claim', dispatchId: 'dispatch' };
  assert.deepEqual(dispatches.action('desk', 'credential', 'session', request), {
    dispatchId: 'dispatch', send: true, content,
  });
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key='workflow-dispatch-payload:dispatch'").get(), undefined);
  assert.deepEqual(dispatches.action('desk', 'credential', 'session', request), {
    dispatchId: 'dispatch', send: false,
  });
});

test('lost read and claim replies, concurrent retries, and repeated delivery start one turn', async (t) => {
  const { db, content, dispatches } = setup(t);
  const scope = { workspaceId: 'desk', credential: 'credential', dispatchId: 'dispatch' };
  const call = (payload) => dispatches.action('desk', 'credential', 'session', payload);
  let drop = 'host_read', starts = 0;
  const makeHost = () => createWorkflowDelivery({
    activeThread: () => 'original',
    command: async (_scope, payload) => {
      const result = call(payload);
      if (drop === payload.operation) {
        drop = '';
        throw Error('reply lost');
      }
      return result;
    },
    readHistory: async () => false,
    unresolved: () => Error('unconfirmed'),
    send: async (_target, blocks, delivery) => {
      assert.deepEqual(blocks, content);
      await delivery.beforeStart('original');
      starts++;
      delivery.accepted();
      return { threadId: 'original', turnId: 'turn' };
    },
  });
  const host = makeHost();
  await assert.rejects(host({ ...scope, attemptId: 'first' }), /reply lost/);
  assert.equal(starts, 0);
  drop = 'host_start';
  const results = await Promise.all([
    host({ ...scope, attemptId: 'second' }),
    host({ ...scope, attemptId: 'concurrent' }),
  ]);
  assert.ok(results.every((item) => item.sent));
  assert.equal(starts, 1);
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key='workflow-dispatch-payload:dispatch'").get(), undefined);
  drop = 'host_read';
  await assert.rejects(makeHost()({ ...scope, attemptId: 'third' }), /reply lost/);
  assert.deepEqual(await makeHost()({ ...scope, attemptId: 'fourth' }), {
    sent: true, receiptPending: false,
  });
  assert.equal(starts, 1);
});

test('losing the saved delivery reply still returns the existing receipt', async (t) => {
  const { dispatches } = setup(t);
  const scope = { workspaceId: 'desk', credential: 'credential', dispatchId: 'dispatch' };
  let starts = 0, dropped = false;
  const host = createWorkflowDelivery({
    activeThread: () => 'original',
    command: async (_scope, payload) => {
      const result = dispatches.action('desk', 'credential', 'session', payload);
      if (payload.operation === 'host_finish' && !dropped) {
        dropped = true;
        throw Error('receipt reply lost');
      }
      return result;
    },
    send: async (_target, _blocks, delivery) => {
      await delivery.beforeStart('original');
      starts++;
      delivery.accepted();
      return { threadId: 'original', turnId: 'turn' };
    },
    readHistory: async () => { throw Error('saved receipt should be sufficient'); },
    unresolved: () => Error('unconfirmed'),
  });
  assert.equal((await host({ ...scope, attemptId: 'first' })).sent, true);
  assert.deepEqual(await host({ ...scope, attemptId: 'second' }), {
    sent: true, receiptPending: false,
  });
  assert.equal(starts, 1);
});

test('lost Codex acknowledgement is recovered from the original thread without replay', async (t) => {
  const { dispatches } = setup(t);
  const scope = { workspaceId: 'desk', credential: 'credential', dispatchId: 'dispatch' };
  const turns = [];
  let starts = 0;
  const makeHost = (active) => createWorkflowDelivery({
    activeThread: () => active,
    command: async (_scope, payload) =>
      dispatches.action('desk', 'credential', 'session', payload),
    send: async (_target, _blocks, delivery) => {
      const batch = { id: 'output', directory: 'workspace' };
      return dispatchTurn({
        sendId: 'original', batch, workflowDelivery: delivery,
        blocks: buildTurnInput({ text: 'run workflow', attached: [], extra: [],
          batch, workflowDispatchId: delivery.id }),
        assertActive() {},
        recordTiming() {},
        outputs: { async failedStart() {} },
        async request(method, params) {
          assert.equal(method, 'turn/start');
          assert.equal(params.clientUserMessageId, 'dispatch');
          assert.equal(params.threadId, 'original');
          starts++;
          turns.push({ items: [{ type: 'agentMessage', content: params.input }] });
          throw Error('turn/start reply lost');
        },
      });
    },
    readHistory: async (threadId, dispatchId) => {
      assert.equal(threadId, 'original');
      return hasWorkflowDelivery(turns, dispatchId);
    },
    unresolved: () => Error('unconfirmed'),
  });
  await assert.rejects(makeHost('original')({ ...scope, attemptId: 'first' }), /reply lost/);
  await assert.rejects(makeHost('other')({ ...scope, attemptId: 'second' }), /unconfirmed/);
  turns[0].items[0].type = 'userMessage';
  assert.deepEqual(await makeHost('other')({ ...scope, attemptId: 'fourth' }), {
    sent: true, receiptPending: false,
  });
  assert.equal(starts, 1);
});
