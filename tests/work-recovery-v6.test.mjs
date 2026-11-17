import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkRecovery } from '../apps/electron/work/work-recovery.mjs';
import { matchesWorkTurn } from '../apps/electron/work/work-turn-identity.mjs';

const snapshot = () => ({ workspaceId: 'w', tasks: [{ id: 'task', management: {
  responsibilityVersion: 6, runs: [{ id: 'run', threadId: 'thread', turnId: 'turn', state: 'unknown' }],
} }] });

test('recovery consumes persisted allowance and does no work when exhausted', async () => {
  let reads = 0, settled = 0;
  const make = remaining => createWorkRecovery({
    reserveBudget: async () => remaining ? { allowanceMs: remaining, key: 'reservation' } : null,
    settleBudget: async (_w, _task, _run, budget, elapsed) => {
      assert.equal(budget.key, 'reservation'); assert.ok(elapsed >= 0); settled++;
    },
    readRun: async () => { reads++; return null; },
  });
  await make(90000)(snapshot());
  await make(0)(snapshot());
  assert.equal(reads, 1);
  assert.equal(settled, 1);
});
test('slow result collection releases scheduler but retains ownership until settled', async () => {
  const input = snapshot();
  input.tasks.push({ id: 'second', management: { responsibilityVersion: 6,
    runs: [{ id: 'second-run', turnId: 'second-turn', state: 'unknown' }] } });
  let release, collections = 0;
  const completed = [];
  const recover = createWorkRecovery({ operationTimeoutMs: 10,
    readRun: async run => ({ id: run.turnId, status: 'completed' }),
    recoverRun: run => { collections++; return run.id === 'run' ? new Promise(resolve => { release = resolve; }) : null; },
    invoke: async (_w, _op, task) => { completed.push(task); }, changed() {} });
  await recover(input);
  assert.deepEqual(completed, ['second']);
  await recover(input);
  assert.equal(collections, 2, 'timed out collection must not be replayed');
  release(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(completed, ['second', 'task']);
  await recover(input);
  assert.equal(collections, 2);
});

test('a short persisted allowance bounds a stalled read and settles it', async () => {
  let settled = false;
  await createWorkRecovery({ readTimeoutMs: 60000,
    reserveBudget: async () => ({ allowanceMs: 10 }),
    readRun: () => new Promise(() => {}),
    settleBudget: async () => { settled = true; },
    invoke() { assert.fail('a timed out read cannot reconcile or dispatch'); },
  })(snapshot());
  assert.equal(settled, true);
});
test('concurrent recovery observations collect a completed turn once without dispatching', async () => {
  let reads = 0, collections = 0, reconciled = 0;
  const recover = createWorkRecovery({
    readRun: async () => { reads++; await new Promise(r => setTimeout(r, 5)); return { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'done' }] }; },
    recoverRun: async () => { collections++; return { id: 'batch', files: [{ objectId: 'file', revision: 2 }] }; },
    invoke: async (w, op, id, payload) => { assert.equal(op, 'reconcile'); assert.equal(payload.state, 'succeeded'); assert.equal(payload.artifacts[0].revision, 2); reconciled++; },
    changed() {},
  });
  await Promise.all([recover(snapshot()), recover(snapshot())]);
  await recover(snapshot()); // a stale snapshot must not collect the same files again
  assert.equal(reads, 1); assert.equal(collections, 1); assert.equal(reconciled, 1);
});
test('unknown external outcomes and live turns never trigger a new execution', async () => {
  for (const actual of [null, { status: 'inProgress' }]) {
    let reads = 0;
    const recover = createWorkRecovery({ readRun: async () => { reads++; return actual; },
      recoverRun() { assert.fail('not complete'); }, invoke() { assert.fail('no replay'); }, changed() {} });
    await recover(snapshot()); await recover(snapshot());
    assert.equal(reads, 1, 'backoff avoids a polling storm');
  }
});
test('historical tasks do not acquire automatic execution from migration', async () => {
  const old = snapshot(); delete old.tasks[0].management.responsibilityVersion;
  await createWorkRecovery({ readRun() { assert.fail('old history must remain history'); } })(old);
});
test('a proven running turn reattaches its original identity instead of dispatching', async () => {
  let count = 0;
  const recover = createWorkRecovery({
    readRun: async () => ({ id: 'turn', status: 'inProgress' }),
    reattach: async (workspace, task, run) => { count++; assert.equal(workspace, 'w'); assert.equal(task.id, 'task'); assert.equal(run.id, 'run'); },
    recoverRun() { assert.fail('no collection while running'); },
    invoke() { assert.fail('no new turn'); }, changed() {},
  });
  await Promise.all([recover(snapshot()), recover(snapshot())]);
  assert.equal(count, 1);
});

test('a different completed turn cannot supply recovery evidence', async () => {
  await createWorkRecovery({ readRun: async () => ({ id: 'another-turn', status: 'completed' }),
    recoverRun() { assert.fail('wrong turn'); }, invoke() { assert.fail('wrong turn'); }, changed() {} })(snapshot());
});

test('only the host-created second user block identifies a Work run', () => {
  const marker = JSON.stringify({ type: 'yirang.turn-context', taskId: 'task',
    runId: 'run', consultation: false });
  const turn = content => ({ id: 'turn', items: [{ type: 'userMessage', content }] });
  assert.equal(matchesWorkTurn(turn([
    { type: 'text', text: 'do work' }, { type: 'text', text: marker },
  ]), 'task', 'run'), true);
  assert.equal(matchesWorkTurn(turn([{ type: 'text', text: marker }]), 'task', 'run'), false);
  assert.equal(matchesWorkTurn({ id: 'turn', items: [{ type: 'agentMessage',
    content: [{ type: 'text', text: 'done' }, { type: 'text', text: marker }] }] },
  'task', 'run'), false);
  assert.equal(matchesWorkTurn(turn([
    { type: 'text', text: 'do work' }, { type: 'text', text: marker },
  ]), 'another-task', 'run'), false);
});

test('an exact original run marker restores its lost turn receipt before reconciliation', async () => {
  const input = snapshot();
  const run = input.tasks[0].management.runs[0];
  delete run.turnId;
  run.submission = { state: 'possibly_sent' };
  const operations = [];
  await createWorkRecovery({
    readRun: async (_run, task) => {
      assert.equal(task.id, 'task');
      return { id: 'original-turn', status: 'interrupted', matchedWorkRun: 'run', items: [] };
    },
    recoverRun: async observed => { assert.equal(observed.turnId, 'original-turn'); return null; },
    invoke: async (_workspace, operation, _taskId, payload) => {
      operations.push({ operation, payload });
    },
    changed() {},
  })(input);
  assert.deepEqual(operations.map(item => item.operation), ['ack', 'reconcile']);
  assert.equal(operations[0].payload.recovered, true);
  assert.equal(operations[0].payload.turnId, 'original-turn');
  assert.equal(operations[1].payload.state, 'interrupted');
});

test('a turn without the exact run marker cannot repair a lost receipt', async () => {
  const input = snapshot();
  delete input.tasks[0].management.runs[0].turnId;
  await createWorkRecovery({
    readRun: async () => ({ id: 'other-turn', status: 'completed', items: [] }),
    invoke() { assert.fail('no receipt or reconciliation without an exact marker'); },
  })(input);
});

test('a stalled observation has a deadline and cannot block another work', async () => {
  const input = snapshot();
  input.tasks.push({ id: 'second', management: { responsibilityVersion: 6,
    runs: [{ id: 'second-run', threadId: 'second-thread', turnId: 'second-turn', state: 'unknown' }] } });
  let reconciled = 0;
  await createWorkRecovery({ readTimeoutMs: 10,
    readRun: run => run.id === 'run' ? new Promise(() => {}) : Promise.resolve({ id: 'second-turn', status: 'completed' }),
    recoverRun: async () => null, invoke: async () => { reconciled++; }, changed() {} })(input);
  assert.equal(reconciled, 1);
});
