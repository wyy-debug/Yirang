import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AgentPoolStore } from '../packages/local-runtime/agents/agent-pool.js';
import {
  validatePlan,
  legacyPlan,
  timeLimits,
  estimateSchedule,
  dependencyState,
} from '../packages/local-runtime/agents/agent-plan.js';
import { classifyError, UsageWatermark } from '../packages/local-runtime/agents/agent-queue.js';
import { BotCapacityStore } from '../packages/local-runtime/bot/bot-capacity.js';

const model = { provider: 'codex', account: 'default', model: 'm', effort: null };
const node = (id: string, extra: any = {}) => ({
  id,
  type: 'research',
  title: id,
  instructions: '分析 ' + id,
  acceptance: '有来源',
  modelProfile: model,
  ...extra,
});
const plan = (id: string, nodes: any[], edges: any[] = [], extra: any = {}) => ({
  id,
  workId: 'work-' + id,
  goal: '目标',
  nodes,
  edges,
  ...extra,
});
function setup() {
  let now = 1_000_000;
  const db = new DatabaseSync(':memory:');
  const objects = new Map<string, any>([['obj1', { revision: 1, content: '材料' }]]);
  const pool = new AgentPoolStore(db, {
    now: () => now,
    object: (_w, id) => {
      const o = objects.get(id);
      if (!o) throw Error('NOT_FOUND');
      return o;
    },
  });
  const advance = (ms: number) => {
    now += ms;
  };
  let turn = 0;
  const run = (w = 'w') => {
    advance(2001);
    const c = pool.claim(w);
    if (!c) return null;
    pool.sending(c.lease.dispatchKey, 't-' + c.lease.dispatchKey);
    const t = 'turn-' + turn++;
    pool.ack(c.lease.dispatchKey, t);
    return { ...c, turn: t };
  };
  const done = (r: any, summary = '结果', extra: any = {}) =>
    pool.finish(
      r.lease.dispatchKey,
      r.turn,
      'completed',
      { summary, ...extra },
      { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 },
    );
  return { db, pool, advance, run, done, objects };
}

test('32-node plan validates; cycles are rejected', () => {
  assert.equal(
    validatePlan(
      plan(
        'p',
        Array.from({ length: 32 }, (_, i) => node('n' + i)),
      ),
    ).nodes.length,
    32,
  );
  assert.throws(
    () =>
      validatePlan(
        plan(
          'c',
          [node('a'), node('b')],
          [
            { from: 'a', to: 'b', condition: 'success', groupId: 'g' },
            { from: 'b', to: 'a', condition: 'success', groupId: 'g' },
          ],
        ),
      ),
    /CYCLE/,
  );
  assert.throws(() =>
    validatePlan(
      plan(
        'x',
        Array.from({ length: 65 }, (_, i) => node('n' + i)),
      ),
    ),
  );
});

test('baseline schedule and S/R/H for 31 workers plus reduce', () => {
  const p = validatePlan(
    plan(
      'p',
      [...Array.from({ length: 31 }, (_, i) => node('n' + i)), node('r', { type: 'reduce' })],
      Array.from({ length: 31 }, (_, i) => ({
        from: 'n' + i,
        to: 'r',
        condition: 'success',
        groupId: 'g',
      })),
    ),
  );
  assert.throws(
    () =>
      validatePlan(
        plan(
          'p33',
          [...Array.from({ length: 33 }, (_, i) => node('n' + i)), node('r', { type: 'reduce' })],
          Array.from({ length: 33 }, (_, i) => ({
            from: 'n' + i,
            to: 'r',
            condition: 'success',
            groupId: 'g',
          })),
        ),
      ),
    /EDGE_LIMIT/,
  );
  assert.equal(estimateSchedule(p), 130);
  assert.deepEqual(timeLimits(p), { S: 330, R: 66, H: 340, Q: 32 });
});

test('dependency truth table: all/any, completed, unknown waits', () => {
  const e = (from: string, condition: any, mode: any = 'all') => ({
    from,
    to: 'z',
    condition,
    groupId: 'g',
    mode,
    artifactRefs: condition === 'artifact' ? [{ objectId: 'o', revision: 1 }] : [],
  });
  const s = (m: Record<string, string>) =>
    new Map(Object.entries(m).map(([k, v]) => [k, { state: v as any }]));
  assert.equal(dependencyState('z', [e('a', 'success')], s({ a: 'failed' })), 'skipped');
  assert.equal(dependencyState('z', [e('a', 'completed')], s({ a: 'failed' })), 'ready');
  assert.equal(dependencyState('z', [e('a', 'completed')], s({ a: 'unknown' })), 'blocked');
  assert.equal(
    dependencyState(
      'z',
      [e('a', 'success', 'any'), e('b', 'success', 'any')],
      s({ a: 'failed', b: 'running' }),
    ),
    'blocked',
  );
  assert.equal(
    dependencyState(
      'z',
      [e('a', 'success', 'any'), e('b', 'success', 'any')],
      s({ a: 'failed', b: 'succeeded' }),
    ),
    'ready',
  );
  assert.equal(dependencyState('z', [e('a', 'artifact')], s({ a: 'succeeded' })), 'skipped');
});

test('per-plan 3 ordinary, global new work 4, follow-up uses F', () => {
  const { pool, run } = setup();
  pool.create(
    'w',
    plan(
      'a',
      Array.from({ length: 6 }, (_, i) => node('a' + i)),
    ),
    'r1',
  );
  pool.create(
    'w',
    plan(
      'b',
      Array.from({ length: 6 }, (_, i) => node('b' + i)),
    ),
    'r2',
  );
  const started = [run(), run(), run(), run(), run()].filter(Boolean);
  assert.equal(started.length, 4);
  const perPlan = started.filter((r) => r!.lease.planId === 'a').length;
  assert.ok(perPlan <= 3);
  assert.equal(pool.counts().background, 4);
});

test('large plan needs confirmation before any worker starts', () => {
  const { pool, run } = setup();
  pool.create(
    'w',
    plan(
      'big',
      Array.from({ length: 9 }, (_, i) => node('n' + i)),
    ),
    'r',
  );
  assert.equal(run(), null);
  const p = pool.plan('w', 'big');
  assert.throws(() => pool.confirm('w', 'big', 'stale'), /STALE/);
  pool.confirm('w', 'big', p.confirmationHash);
  assert.ok(run());
});

test('legacy 2-4 jobs map to observe plan with reduce and no confirmation', () => {
  const { pool, run, done } = setup();
  const p = legacyPlan({
    id: 'legacy',
    workId: 'w1',
    goal: '汇总',
    jobs: [
      { title: 'A', instructions: 'a', after: [] },
      { title: 'B', instructions: 'b', after: [0] },
    ],
    model,
  });
  assert.equal(p.nodes.length, 3);
  assert.equal(p.budgetMode, 'observe');
  pool.create('w', p, 'r');
  const a = run()!;
  assert.equal(a.lease.nodeId, 'worker-0');
  assert.equal(pool.claim('w'), null);
  pool.finish(a.lease.dispatchKey, a.turn, 'failed', null);
  assert.equal(
    pool.nodes('w', pool.plan('w', 'legacy')).find((n) => n.spec.id === 'worker-1')!.state,
    'skipped',
  );
  const reduce = run()!;
  assert.equal(reduce.lease.nodeId, 'reduce');
  const env = done(reduce, '部分完成');
  assert.deepEqual(env.failed, ['worker-0']);
  assert.deepEqual(env.skipped, ['worker-1']);
  assert.equal(pool.plan('w', 'legacy').state, 'review');
});

test('idempotent dispatch and result commits; conflicting result quarantined', () => {
  const { pool, run, done } = setup();
  pool.create('w', plan('p', [node('a')]), 'r');
  assert.deepEqual(pool.create('w', plan('p', [node('a')]), 'r'), { admitted: true, planId: 'p' });
  const r = run()!;
  assert.throws(() => pool.sending(r.lease.dispatchKey, 'other'), /STALE/);
  const first = done(r);
  assert.deepEqual(done(r), first);
  assert.equal(done(r, '不同').conflict, true);
});

test('rate-limit rejects do not consume execution retries; unknown not replayed', () => {
  const { pool, advance } = setup();
  pool.create('w', plan('p', [node('a')]), 'r');
  for (let i = 0; i < 3; i++) {
    advance(2001);
    const c = pool.claim('w')!;
    pool.sending(c.lease.dispatchKey, 't');
    pool.rejected(c.lease.dispatchKey, {
      version: 1,
      rpcRejected: true,
      status: 429,
      retryAfterMs: 1000,
    });
    advance(5000);
  }
  const n = pool.nodes('w', pool.plan('w', 'p'))[0]!;
  assert.equal(n.rateLimitRejectCount, 3);
  assert.equal(n.executionRetryCount, 0);
  assert.equal(pool.plan('w', 'p').state, 'needs_input');
  assert.equal(classifyError({ version: 1, rpcRejected: false, status: 429 }), 'unknown');
  assert.equal(classifyError({ version: 1, rpcRejected: true, status: 403 }), 'permission');
});

test('restart: unsent leases requeue, sent become unknown and keep the slot until manual resolve', () => {
  const { pool, advance } = setup();
  pool.create('w', plan('p', [node('a'), node('b')]), 'r');
  advance(2001);
  const a = pool.claim('w')!;
  pool.sending(a.lease.dispatchKey, 't');
  pool.claim('w');
  pool.recover();
  assert.equal(pool.leases().length, 1);
  assert.equal(pool.leases()[0]!.state, 'unknown');
  assert.equal(pool.counts().background, 1);
  assert.throws(() => pool.resolve(a.lease.dispatchKey, true, '已停止', true), /EVIDENCE/);
  pool.resolve(a.lease.dispatchKey, true, '执行器已关闭', false);
  assert.equal(pool.counts().background, 0);
});

test('resource keys allow one writer; pause stops dispatch and late result is not adopted', () => {
  const { pool, run, done } = setup();
  pool.create(
    'w',
    plan('p', [
      node('a', { requiredResources: ['obj1'] }),
      node('b', { requiredResources: ['obj1'] }),
    ]),
    'r',
  );
  const a = run()!;
  assert.equal(run(), null);
  assert.equal(
    pool.nodes('w', pool.plan('w', 'p')).find((n) => n.spec.id === 'b')!.state,
    'waiting_resource',
  );
  pool.control('w', 'p', 'pause');
  assert.equal(pool.interrupts('w', 'p').length, 1);
  done(a);
  const p = pool.plan('w', 'p');
  assert.equal(p.state, 'paused');
  assert.equal(pool.nodes('w', p).find((n) => n.spec.id === 'a')!.state, 'paused');
});

test('question releases slot; answer creates new segment without consuming retry', () => {
  const { pool, run, done } = setup();
  pool.create('w', plan('p', [node('a')]), 'r');
  const first = run()!;
  done(first, '需要月份', { question: { text: '哪个月？' } });
  let n = pool.nodes('w', pool.plan('w', 'p'))[0]!;
  assert.equal(n.state, 'waiting_user');
  assert.equal(pool.counts().background, 0);
  pool.followup('w', 'p', {
    messageId: 'm1',
    nodeId: 'a',
    questionId: n.question!.id,
    text: '十月',
  });
  pool.followup('w', 'p', {
    messageId: 'm1',
    nodeId: 'a',
    questionId: n.question!.id,
    text: '十月',
  });
  const second = run()!;
  assert.match(second.lease.dispatchKey, /\/0\/1$/);
  assert.equal(second.lease.reservation.pool, 'H');
  done(second, '十月结果', { handled: [{ messageId: 'm1', outcome: 'answered', reason: '已用' }] });
  n = pool.nodes('w', pool.plan('w', 'p'))[0]!;
  assert.equal(n.state, 'succeeded');
  assert.equal(n.executionRetryCount, 0);
});

test('missing handled receipt auto-continues once, then becomes a manual item', () => {
  const { pool, run, done } = setup();
  pool.create('w', plan('p', [node('a')]), 'r');
  const r = run()!;
  pool.followup('w', 'p', { messageId: 'm', nodeId: 'a', text: '谢谢，改成英文' });
  done(r);
  let n = pool.nodes('w', pool.plan('w', 'p'))[0]!;
  assert.equal(n.state, 'ready');
  const again = run()!;
  done(again);
  n = pool.nodes('w', pool.plan('w', 'p'))[0]!;
  assert.equal(n.attention, '这条补充尚未处理');
  assert.equal(pool.claim('w'), null);
});

test('enforce budget blocks dispatch; observe never blocks on tokens', () => {
  const { pool, run } = setup();
  pool.create(
    'w',
    plan('e', [node('a')], [], { budgetMode: 'enforce', budget: { inputTokens: 10 } }),
    'r1',
  );
  assert.equal(run(), null);
  assert.equal(pool.plan('w', 'e').state, 'needs_input');
  pool.create('w', plan('o', [node('a')], [], { budget: { inputTokens: 10 } }), 'r2');
  assert.ok(run());
});

test('revision freezes old results and reuses only matching fingerprints', () => {
  const { pool, run, done } = setup();
  pool.create('w', plan('p', [node('a'), node('b')]), 'r');
  const a = run()!,
    b = run()!;
  const ea = done(a);
  const hashA = pool.nodes('w', pool.plan('w', 'p')).find((n) => n.spec.id === 'a')!.resultHash!;
  pool.revise(
    'w',
    'p',
    plan(
      'p',
      [
        node('a', { reuseFrom: { revision: 1, nodeId: 'a', resultHash: hashA } }),
        node('b', { instructions: '新要求' }),
      ],
      [],
      { planRevision: 2 },
    ),
  );
  done(b);
  const v2 = pool.plan('w', 'p');
  assert.equal(v2.spec.planRevision, 2);
  const nodes = pool.nodes('w', v2);
  assert.equal(nodes.find((n) => n.spec.id === 'a')!.state, 'succeeded');
  assert.equal(nodes.find((n) => n.spec.id === 'b')!.state, 'ready');
  assert.equal(ea.state, 'succeeded');
  assert.throws(
    () =>
      pool.revise(
        'w',
        'p',
        plan(
          'p',
          [
            node('a', {
              instructions: '改',
              reuseFrom: { revision: 2, nodeId: 'a', resultHash: hashA },
            }),
          ],
          [],
          { planRevision: 3 },
        ),
      ),
    /FINGERPRINT/,
  );
});

test('queue admission caps at 256 and network research is blocked', () => {
  const { pool } = setup();
  for (let i = 0; i < 5; i++)
    pool.create(
      'w',
      plan(
        'q' + i,
        Array.from({ length: 60 }, (_, j) => node('n' + j)),
      ),
      'r' + i,
    );
  for (let i = 0; i < 5; i++) pool.confirm('w', 'q' + i, pool.plan('w', 'q' + i).confirmationHash);
  assert.equal(pool.queueCount(), 256);
  assert.ok(pool.nodes('w', pool.plan('w', 'q4')).some((n) => n.state === 'admission_pending'));
  pool.create('w', plan('net', [node('a', { networkRequired: true })]), 'n');
  assert.equal(pool.plan('w', 'net').state, 'needs_input');
});

test('usage watermark de-duplicates cumulative updates and flags resets', () => {
  const u = new UsageWatermark();
  assert.deepEqual(u.update({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 40 }), {
    inputTokens: 100,
    outputTokens: 5,
    cachedInputTokens: 40,
  });
  assert.deepEqual(u.update({ inputTokens: 150, outputTokens: 9, cachedInputTokens: 40 }), {
    inputTokens: 50,
    outputTokens: 4,
    cachedInputTokens: 0,
  });
  assert.equal(u.update({ inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 }), null);
});

test('progress guard flags three identical failures; segment timeout goes to stopping then unknown', () => {
  const { pool, run, advance } = setup();
  pool.create('w', plan('p', [node('a', { budget: { maxMinutes: 1 } })]), 'r');
  const r = run()!;
  for (let i = 0; i < 3; i++)
    pool.guard(r.lease.dispatchKey, {
      toolActive: false,
      thinking: false,
      progress: false,
      failureHash: 'x',
    });
  assert.equal(pool.nodes('w', pool.plan('w', 'p'))[0]!.attention, '同一步骤连续失败，可能卡住');
  advance(61000);
  pool.tick();
  assert.equal(pool.leases()[0]!.state, 'stopping');
  advance(31000);
  pool.tick();
  assert.equal(pool.leases()[0]!.state, 'unknown');
});

test('pool slots count toward capacity but conversation capacity cannot restore or release them', () => {
  const { db, pool, run } = setup();
  const capacity = new BotCapacityStore(db);
  pool.create('w', plan('cap', [node('a')]), 'req-cap');
  const r = run()!;
  const read = capacity.command('w', { operation: 'capacity_read' }) as any;
  assert.equal(
    read.slots.some((s: any) => s.id === r.lease.dispatchKey),
    false,
  );
  assert.equal(read.pool, 1);
  assert.equal(read.total, 1);
  assert.equal(read.background, 1);
  for (const operation of [
    'capacity_release',
    'capacity_unknown',
    'capacity_resolve',
    'capacity_ack',
  ])
    assert.throws(
      () =>
        capacity.command('w', {
          operation,
          id: r.lease.dispatchKey,
          threadId: 't-' + r.lease.dispatchKey,
          turnId: r.turn,
          status: 'completed',
          confirmedStopped: true,
          note: 'x',
        }),
      /POOL_SLOT|并行计划/,
    );
  assert.ok(db.prepare('SELECT 1 FROM bot_slots WHERE id=?').get(r.lease.dispatchKey));
});

test('two answers keep one current queue item; a finished node is never claimed again', () => {
  const { pool, run, done } = setup();
  pool.create('w', plan('q', [node('a')]), 'r');
  const first = run()!;
  done(first, '需要确认', { question: { text: '哪个月？' } });
  const n0 = pool.nodes('w', pool.plan('w', 'q'))[0]!;
  assert.equal(n0.state, 'waiting_user');
  pool.followup('w', 'q', {
    messageId: 'm1',
    nodeId: 'a',
    questionId: n0.question!.id,
    text: '十月',
  });
  pool.followup('w', 'q', { messageId: 'm2', nodeId: 'a', text: '只看华东' });
  const second = run()!;
  assert.equal(second.context.messages.length, 2);
  done(second, '十月华东结果', {
    handled: [
      { messageId: 'm1', outcome: 'answered', reason: '' },
      { messageId: 'm2', outcome: 'acted', reason: '' },
    ],
  });
  assert.equal(pool.nodes('w', pool.plan('w', 'q'))[0]!.state, 'succeeded');
  assert.equal(run(), null);
});

test('an unknown lease with a recorded turn can still commit after a late ack', () => {
  const { pool, advance } = setup();
  pool.create('w', plan('u', [node('a')]), 'r');
  advance(2001);
  const c = pool.claim('w')!,
    key = c.lease.dispatchKey;
  pool.sending(key, 't');
  pool.unknown(key, '登记失败', 'turn-x');
  assert.equal(pool.leases().find((l) => l.dispatchKey === key)!.turnId, 'turn-x');
  pool.ack(key, 'turn-x');
  pool.finish(key, 'turn-x', 'completed', { summary: '已完成' });
  assert.equal(pool.nodes('w', pool.plan('w', 'u'))[0]!.state, 'succeeded');
});

test('an unsent unknown lease is not re-queued by tick or recover', () => {
  const { pool, advance } = setup();
  pool.create('w', plan('v', [node('a')]), 'r');
  advance(2001);
  const c = pool.claim('w')!,
    key = c.lease.dispatchKey;
  pool.unknown(key, '发送未知');
  advance(61000);
  pool.tick();
  pool.recover();
  advance(2001);
  assert.equal(pool.claim('w'), null);
  assert.equal(pool.leases().find((l) => l.dispatchKey === key)!.state, 'unknown');
  assert.equal(pool.nodes('w', pool.plan('w', 'v'))[0]!.state, 'unknown');
});

test('large materials are cut to fit one execution instead of freezing the plan', () => {
  const { pool, objects, advance } = setup();
  const big = '销'.repeat(34000);
  objects.set('big1', { revision: 1, title: '大表一', content: big });
  objects.set('big2', { revision: 1, title: '大表二', content: big });
  pool.create(
    'w',
    plan('big', [
      node('a', {
        inputRefs: [
          { objectId: 'big1', revision: 1 },
          { objectId: 'big2', revision: 1 },
          { objectId: 'obj1', revision: 1 },
        ],
      }),
    ]),
    'r',
  );
  advance(2001);
  const c = pool.claim('w');
  assert.ok(c, String(pool.plan('w', 'big').reason));
  assert.ok(Buffer.byteLength(JSON.stringify(c.context), 'utf8') <= 96000);
  const [one, two, small] = c.context.inputs;
  assert.equal(one.truncated, true);
  assert.equal(two.truncated, true);
  assert.equal(one.totalChars, 34000);
  assert.ok(one.includedChars > 10000);
  assert.equal(small.truncated, false);
  assert.equal(small.text, '材料');
  assert.match(String(c.context.materialNote), /question/);
});

test('materials the host has not extracted yet hold the node without freezing the plan', () => {
  let ready = false;
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  const pool = new AgentPoolStore(db, {
    now: () => now,
    object: () => ({
      revision: 1,
      title: '笔记.md',
      content: { fileName: '笔记.md', assetHash: 'h' },
    }),
    text: () => (ready ? '正文内容' : null),
  });
  pool.create('w', plan('m', [node('a', { inputRefs: [{ objectId: 'f', revision: 1 }] })]), 'r');
  now += 2001;
  assert.equal(pool.claim('w'), null);
  assert.equal(pool.plan('w', 'm').frozen, false);
  assert.deepEqual(pool.pendingMaterials('w'), [{ objectId: 'f', revision: 1 }]);
  ready = true;
  now += 2001;
  const c = pool.claim('w')!;
  assert.equal(c.context.inputs[0].text, '正文内容');
  assert.deepEqual(pool.pendingMaterials('w'), []);
});

test('pausing asks an unknown lease with a known turn to stop, without re-queuing it', () => {
  const { pool, advance } = setup();
  pool.create('w', plan('s', [node('a')]), 'r');
  advance(2001);
  const c = pool.claim('w')!,
    key = c.lease.dispatchKey;
  pool.sending(key, 'th');
  pool.unknown(key, '回执登记失败', 'turn-z');
  pool.control('w', 's', 'pause');
  assert.deepEqual(pool.interrupts('w', 's'), [
    { dispatchKey: key, threadId: 'th', turnId: 'turn-z' },
  ]);
  assert.equal(pool.leases().find((l) => l.dispatchKey === key)!.state, 'unknown');
  advance(2001);
  assert.equal(pool.claim('w'), null);
});
