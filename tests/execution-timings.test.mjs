import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionTimings } from '../apps/electron/timing/execution-timings.mjs';
import { timingView } from '../apps/electron/timing/timing-view-model.mjs';
import {
  captureModelSettings,
  validateModelSettings,
} from '../apps/electron/cli/model-settings.mjs';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'timings-'));
  let stamp = 1000;
  const path = join(directory, 'timings.sqlite'),
    stores = [];
  const create = () => {
    const value = createExecutionTimings({ path, now: () => stamp });
    stores.push(value);
    return value;
  };
  t.after(() => {
    stores.forEach((s) => s.close());
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    create,
    at: (value) => {
      stamp = value;
    },
  };
}
test('overlapping tools, multiple approvals and duplicate events do not inflate elapsed time', (t) => {
  const { create, at } = setup(t),
    store = create();
  store.prepare('thread', { model: 'alpha', effort: 'high' });
  store.handle('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  const item = (method, id) =>
    store.handle('item/' + method, {
      threadId: 'thread',
      turnId: 'turn',
      item: { id, type: 'mcpToolCall' },
    });
  at(2000);
  item('started', 'a');
  item('started', 'a');
  at(3000);
  item('started', 'b');
  at(4000);
  store.handle('item/permissions/requestApproval', { threadId: 'thread', turnId: 'turn' }, 1);
  store.handle('item/permissions/requestApproval', { threadId: 'thread', turnId: 'turn' }, 2);
  at(5000);
  store.approvalReply('thread', 1);
  at(6000);
  store.approvalReply('thread', 2);
  at(7000);
  item('completed', 'a');
  item('completed', 'a');
  at(8000);
  item('completed', 'b');
  at(10000);
  store.handle('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  store.handle('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  const data = store.read({ threadIds: ['thread'] }),
    view = timingView(data);
  assert.equal(data.runs.length, 1);
  assert.equal(view.elapsed, 9000);
  assert.deepEqual(view.root.totals, {
    model: 3000,
    tool: 4000,
    approval: 2000,
    wait: 0,
    unknown: 0,
  });
  assert.equal(view.root.tools.length, 2);
  assert.equal(view.root.tools[0].duration, 3000);
  assert.equal(data.runs[0].model, 'alpha');
});
test('late events cannot finish the next turn; interrupted clocks never include offline time', (t) => {
  const { create, at } = setup(t),
    store = create();
  store.prepare('one');
  store.bind('one', 'old');
  at(2000);
  store.handle('turn/completed', { threadId: 'one', turn: { id: 'old', status: 'completed' } });
  at(3000);
  store.prepare('one');
  store.handle('turn/completed', { threadId: 'one', turn: { id: 'old', status: 'completed' } });
  store.bind('one', 'new');
  store.handle('turn/completed', { threadId: 'one', turn: { id: 'old', status: 'completed' } });
  at(5000);
  store.close();
  at(1000000);
  const reopened = create(),
    data = reopened.read({ threadIds: ['one'] });
  assert.equal(data.runs.at(-1).status, 'unknown');
  assert.equal(timingView(data).elapsed, 2000);
  assert.equal(timingView(data).incomplete, true);
});
test('parallel children align with the parent and do not add to wall time', (t) => {
  const { create, at } = setup(t),
    store = create();
  const begin = (id, task, parent) => {
    store.prepare(id, {
      runId: id,
      taskId: task,
      parentTaskId: parent,
      workspaceId: 'w',
      model: 'alpha',
    });
    store.bind(id, id);
  };
  const end = (id) =>
    store.handle('turn/completed', { threadId: id, turn: { id, status: 'completed' } });
  begin('plan', 'root');
  at(5000);
  end('plan');
  begin('a', 'child-a', 'root');
  begin('b', 'child-b', 'root');
  at(17000);
  end('a');
  at(25000);
  end('b');
  begin('integrate', 'root');
  at(37000);
  store.handle('item/started', {
    threadId: 'integrate',
    turnId: 'integrate',
    item: { id: 'save', type: 'fileChange' },
  });
  at(43000);
  store.handle('item/completed', {
    threadId: 'integrate',
    turnId: 'integrate',
    item: { id: 'save', type: 'fileChange' },
  });
  end('integrate');
  const tasks = [
      { id: 'root', title: 'Report', state: 'review' },
      { id: 'child-a', title: 'Verify', parentTaskId: 'root' },
      { id: 'child-b', title: 'Draft', parentTaskId: 'root' },
    ],
    view = timingView({
      ...store.read({ workspaceId: 'w', taskIds: tasks.map((t) => t.id) }),
      tasks,
    });
  assert.equal(view.elapsed, 42000);
  assert.equal(view.childrenElapsed, 20000);
  assert.deepEqual(view.root.totals, {
    model: 16000,
    tool: 6000,
    approval: 0,
    wait: 20000,
    unknown: 0,
  });
  assert.equal(view.rows[1].elapsed, 12000);
  assert.equal(view.rows[2].elapsed, 20000);
  assert.equal(view.root.spans.at(-1).kind, 'model'); // The zero-length final model phase follows the tool completion.
  assert.equal(store.read({ workspaceId: 'other', taskIds: ['root'] }).runs.length, 0);
});
test('missing tool starts are marked unclassified, not presented as measured model time', (t) => {
  const { create, at } = setup(t),
    store = create();
  store.prepare('thread');
  store.bind('thread', 'turn');
  at(5000);
  store.handle('item/completed', {
    threadId: 'thread',
    turnId: 'turn',
    item: { id: 'missing-start', type: 'mcpToolCall' },
  });
  at(6000);
  store.handle('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  const view = timingView(store.read({ threadIds: ['thread'] }));
  assert.equal(view.root.totals.unknown, 4000);
  assert.equal(view.root.totals.model, 1000);
  assert.equal(view.incomplete, true);
});
test('missing history stays unknown and a queued child is not reported as zero duration', () => {
  const view = timingView({
    observedAt: 2000,
    tasks: [
      { id: 'old', title: 'Old work', runs: [{ id: 'old' }] },
      { id: 'queued', title: 'Queued', parentTaskId: 'old' },
    ],
    runs: [],
  });
  assert.equal(view.missing, true);
  assert.equal(view.rows[1].elapsed, undefined);
});
test('task model snapshots resolve defaults and separate workers from future preferences', async () => {
  const catalog = ['alpha', 'beta'].map((model) => ({
    model,
    isDefault: model === 'alpha',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
  }));
  const request = async (method) =>
    method === 'model/list'
      ? { data: catalog }
      : { config: { model: 'alpha', model_reasoning_effort: 'high' } };
  const first = await captureModelSettings(request, {});
  assert.deepEqual(first, {
    model: 'alpha',
    effort: 'high',
    childModel: 'alpha',
    childEffort: 'high',
  });
  const settings = await validateModelSettings(
      request,
      { model: 'alpha', effort: 'high' },
      { childModel: 'beta', childEffort: 'medium' },
    ),
    second = await captureModelSettings(request, settings);
  settings.model = 'beta';
  assert.equal(second.model, 'alpha');
  assert.equal(second.childModel, 'beta');
  await assert.rejects(() => validateModelSettings(request, {}, { model: 'absent' }), /模型列表/);
  await assert.rejects(
    () => validateModelSettings(request, {}, { model: 'alpha', effort: 'ultra' }),
    /思考强度/,
  );
});
