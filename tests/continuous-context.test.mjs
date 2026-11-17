import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createContinuousContext } from '../apps/electron/context/continuous-context.mjs';
import { createContextLedger, safeBoundary } from '../apps/electron/context/context-ledger.mjs';
import { createConversationState } from '../apps/electron/conversation/conversation-state.mjs';
import { PRIMARY_DECISION_MARKER } from '../apps/electron/conversation/internal-turn-marker.mjs';

const runtime = {
  known: true,
  running: false,
  waiting: false,
  tools: 0,
  queued: 0,
  tasks: [],
  workspaceId: 'desk',
};
const plan = () => ({
  summary: '阶段已结束',
  constraints: '',
  decisions: '',
  unfinished: '',
  references: '',
  memories: [],
  boundary: {
    safeToSwitch: true,
    stageComplete: true,
    unanswered: false,
    waitingConfirmation: false,
    reason: '用户问题已回答',
  },
});
function setup(t, { automatic = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'continuous-context-')),
    calls = [],
    events = [],
    pages = new Map();
  let context,
    counter = 0;
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read')
      return { thread: { id: params.threadId, status: { type: 'idle' } } };
    if (method === 'turn/interrupt') {
      context.notification('turn/completed', {
        threadId: params.threadId,
        turn: { id: params.turnId, status: 'interrupted' },
      });
      return {};
    }
    if (method === 'turn/start') {
      const turn = { id: 'checkpoint-' + ++counter };
      context.notification('turn/started', { threadId: params.threadId, turn });
      if (automatic)
        queueMicrotask(() =>
          context.notification('turn/completed', {
            threadId: params.threadId,
            turn: {
              ...turn,
              status: 'completed',
              items: [{ type: 'agentMessage', text: JSON.stringify(plan()) }],
            },
          }),
        );
      return { turn };
    }
    if (method === 'thread/compact/start') {
      queueMicrotask(() => {
        context.notification('item/completed', {
          threadId: params.threadId,
          item: { type: 'contextCompaction' },
        });
        context.notification('turn/completed', {
          threadId: params.threadId,
          turn: { id: 'compact', status: 'completed' },
        });
      });
      return {};
    }
    throw Error('Unexpected RPC ' + method);
  };
  context = createContinuousContext({
    path: join(dir, 'context.sqlite'),
    request,
    readHistory: async (id, cursor, limit = 100) => {
      const all = pages.get(id) || [],
        offset = Number(cursor || 0);
      return {
        data: all.slice(offset, offset + limit),
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      };
    },
    emit: (type, payload) => events.push({ type, ...payload }),
  });
  context.bind('old', 'desk');
  t.after(() => {
    context.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { context, dir, calls, pages, events };
}

test('rollover boundary rejects unanswered asks, live tools and unfinished work', () => {
  assert.equal(safeBoundary(plan(), runtime), true);
  for (const delta of [
    { known: false },
    { running: true },
    { waiting: true },
    { tools: 1 },
    { queued: 1 },
    { tasks: [{ state: 'running' }] },
    { tasks: [{ state: 'attention' }] },
  ])
    assert.equal(safeBoundary(plan(), { ...runtime, ...delta }), false);
  for (const delta of [
    { unanswered: true },
    { waitingConfirmation: true },
    { stageComplete: false },
  ])
    assert.equal(
      safeBoundary({ ...plan(), boundary: { ...plan().boundary, ...delta } }, runtime),
      false,
    );
});

test('history and exact originals survive two rollovers without exposing checkpoints', async (t) => {
  const { context: c, pages } = setup(t);
  c.record(
    'old',
    'desk',
    'request:1',
    'user',
    '修改报告.pdf，预算不超过100。',
    '2026-10-29T10:00:00.000Z',
  );
  c.tagReferences('old', 'request:1', { files: ['报告.pdf'], taskId: 'task-123' });
  const original = c.search('old', 'desk', '预算')[0];
  pages.set('old', [
    { id: 'visible', items: [], status: 'completed' },
    {
      id: 'internal',
      items: [
        {
          type: 'userMessage',
          content: [{ type: 'text', text: '[内部连续上下文交接，不是用户新请求]' }],
        },
      ],
    },
  ]);
  await c.rollover('old', {
    create: async () => ({ id: 'new' }),
    adopt: async () => {},
    assertActive: () => {},
    plan: plan(),
  });
  await c.rollover('new', {
    create: async () => ({ id: 'latest' }),
    adopt: async () => {},
    assertActive: () => {},
    plan: plan(),
  });
  assert.equal(c.resolve('old'), 'latest');
  assert.deepEqual(c.parts('latest'), ['latest', 'new', 'old']);
  assert.equal(c.search('latest', 'desk', '', { anchor: original.seq })[0].text, original.text);
  assert.equal(c.search('latest', 'other', '', { anchor: original.seq }).length, 0);
  assert.equal(
    c.search('latest', 'desk', '', {
      file: '报告.pdf',
      taskId: 'task-123',
      from: '2026-10-29',
      until: '2026-10-30',
      segment: 'old',
    }).length,
    1,
  );
  const history = await c.history('latest', 1);
  assert.equal(history.data[0].id, 'visible');
  assert.equal((await c.history('latest', 1, history.nextCursor)).data.length, 0);
  assert.equal(c.origin('latest', 'visible'), 'old');
  assert.match(c.seed('latest'), /阶段已结束/);
  c.seeded('latest');
  assert.equal(c.seed('latest'), '');
});

test('primary decision turns stay hidden after history reload', async (t) => {
  const { context, pages } = setup(t);
  pages.set('old', [
    { id: 'decision', status: 'completed', items: [{ type: 'userMessage',
      content: [{ type: 'text', text: `${PRIMARY_DECISION_MARKER}\n{}` }] }] },
    { id: 'visible', status: 'completed', items: [] },
  ]);
  const history = await context.history('old');
  assert.deepEqual(history.data.map((turn) => turn.id), ['visible']);
  assert.equal(context.visibleTurn('old', { id: 'decision' }), false);
  context.hideTurn('old', 'visible');
  assert.deepEqual((await context.history('old')).data, []);
});

test('cached checkpoints accept only the new question; corrections and work changes reevaluate', async (t) => {
  const { context: c, calls } = setup(t);
  c.record('old', 'desk', 'original', 'user', '你好');
  await c.assess('old', { runtime });
  const count = () => calls.filter((x) => x.method === 'turn/start').length;
  c.record('old', 'desk', 'request:next', 'user', '另一件事是什么？');
  await c.assess('old', { runtime, incomingKey: 'request:next', incomingText: '另一件事是什么？' });
  assert.equal(count(), 1);
  await c.assess('old', { runtime, incomingKey: 'request:next', incomingText: '不对，改为英文' });
  assert.equal(count(), 2);
  await c.assess('old', { runtime: { ...runtime, tasks: [{ state: 'running' }] } });
  assert.equal(count(), 3);
});

test('new input interrupts idle maintenance and releases the Bot without a visible answer', async (t) => {
  const { context: c, calls, events } = setup(t, { automatic: false });
  c.record('old', 'desk', 'request:1', 'user', '记住预算100');
  const idle = c.idle('old', runtime, () => true);
  while (!calls.some((x) => x.method === 'turn/start'))
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.busy('old'), true);
  c.touch('old');
  await idle;
  assert.equal(c.busy('old'), false);
  assert.ok(calls.some((x) => x.method === 'turn/interrupt'));
  assert.ok(events.every((x) => x.type === 'context-maintenance'));
});

test('memory keeps evidence, replaces only grounded constraints, and consumes long-message tails', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE messages(seq INTEGER PRIMARY KEY,thread TEXT,scope TEXT,key TEXT,role TEXT,text TEXT,at TEXT)',
  );
  const ledger = createContextLedger(db, (id) => id),
    insert = (id, text) =>
      db
        .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)')
        .run(id, 'bot', 'desk', 'request:' + id, 'user', text, '2026-10-31');
  insert(1, '必须中文');
  const first = ledger.batch('bot', 'desk');
  ledger.save(
    'bot',
    'desk',
    {
      ...plan(),
      memories: [
        { kind: 'constraint', anchor: 1, quote: '必须中文', replaces: [] },
        { kind: 'constraint', anchor: 1, quote: '编造信息', replaces: [] },
      ],
    },
    first,
    runtime,
    1,
  );
  const old = ledger.list('bot', 'desk')[0];
  assert.equal(ledger.list('bot', 'desk').length, 1);
  insert(2, '更正：改为英文');
  ledger.save(
    'bot',
    'desk',
    {
      ...plan(),
      memories: [{ kind: 'correction', anchor: 2, quote: '更正：改为英文', replaces: [old.id] }],
    },
    ledger.batch('bot', 'desk'),
    runtime,
    2,
  );
  assert.deepEqual(
    ledger.list('bot', 'desk').map((x) => x.quote),
    ['更正：改为英文'],
  );
  assert.equal(db.prepare('SELECT text FROM messages WHERE seq=1').get().text, '必须中文');
  insert(3, '长'.repeat(7000) + '最后的限制');
  let batch = ledger.batch('bot', 'desk');
  assert.equal(batch[0].nextOffset, 6000);
  ledger.save('bot', 'desk', plan(), batch, runtime, 3);
  batch = ledger.batch('bot', 'desk');
  assert.equal(batch[0].offset, 6000);
  assert.match(batch[0].text, /最后的限制/);
  ledger.save('bot', 'desk', plan(), batch, runtime, 3);
  assert.equal(ledger.backlog('bot', 'desk'), false);
});

test('checkpoint leaves the newly accepted question for the next user turn', async t => {
  const { context: c, calls } = setup(t);
  c.record('old','desk','prior','user','已回答的旧问题');
  c.record('old','desk','request:new','user','尚未发送的新问题代号XYZ');
  await c.assess('old',{ runtime, incomingKey:'request:new', incomingText:'尚未发送的新问题代号XYZ' });
  const summary = calls.find(call => call.method === 'turn/start');
  assert.ok(summary);
  assert.doesNotMatch(JSON.stringify(summary.params.input), /尚未发送的新问题代号XYZ/);
  assert.match(c.recall('old','desk','XYZ'), /尚未发送的新问题代号XYZ/);
});

test('compression waits for completion and preserves original recall', async (t) => {
  const { context: c, calls } = setup(t);
  c.record('old', 'desk', 'r', 'user', '保留这个要求');
  c.notification('thread/tokenUsage/updated', {
    threadId: 'old',
    tokenUsage: { modelContextWindow: 100000, last: { totalTokens: 85000 } },
  });
  assert.equal(c.needsMaintenance('old'), true);
  // The checkpoint call updates usage after the maintenance decision.
  c.notification('thread/tokenUsage/updated', {
    threadId: 'old',
    tokenUsage: { modelContextWindow: 100000, last: { totalTokens: 2000 } },
  });
  await c.beforeTurn('old', 0, plan());
  assert.ok(calls.some((x) => x.method === 'thread/compact/start'));
  assert.equal(c.busy('old'), false);
  assert.match(c.recall('old', 'desk', '要求'), /保留这个要求/);
});

test('a prepared rollover is reused and queue ownership preserves order and pause state', async (t) => {
  const { context: c, dir } = setup(t),
    store = await createConversationState({
      path: join(dir, 'queue.json'),
      emit: () => {},
      resolveThread: c.owner,
    });
  await store.enqueue('old', {
    text: '第一条',
    blocks: [],
    workspaceId: 'desk',
    requestId: 'first',
  });
  await store.pause('old', true);
  let creations = 0;
  await assert.rejects(
    c.rollover('old', {
      plan: plan(),
      assertActive: () => {},
      create: async () => {
        creations++;
        return { id: 'new' };
      },
      adopt: async () => {
        throw Error('simulated migration failure');
      },
    }),
    /simulated/,
  );
  await store.enqueue('old', {
    text: '第二条',
    blocks: [],
    workspaceId: 'desk',
    requestId: 'second',
  });
  await c.rollover('old', {
    assertActive: () => {},
    create: async () => {
      throw Error('must reuse prepared target');
    },
    adopt: (id) => store.migrate('old', id),
  });
  assert.equal(creations, 1);
  assert.equal(c.resolve('old'), 'new');
  assert.equal(store.get('new').paused, true);
  assert.deepEqual(
    store.get('new').queue.map((x) => x.text),
    ['第一条', '第二条'],
  );
  await store.flush();
});
