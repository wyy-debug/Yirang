import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotFollowup } from '../apps/electron/work/bot-followup.mjs';
import { createConversationState } from '../apps/electron/conversation/conversation-state.mjs';

function setup(overrides = {}) {
  const queued = [];
  const notices = [];
  const followup = createBotFollowup({
    conversations: {
      primaryThread: () => 'main',
      enqueue: async (owner, item) => {
        if (!queued.some((entry) => entry.item.requestId === item.requestId)) queued.push({ owner, item });
      },
    },
    context: { resolve: (id) => id },
    runtime: () => ({ threadId: 'main', reviewEnabled: false }),
    emit: (type, payload) => notices.push({ type, payload }),
    ...overrides,
  });
  return { followup, queued, notices };
}

const payload = (extra = {}) => ({
  workspaceId: 'desk',
  threadId: 'main',
  originThreadId: 'main',
  taskId: 'task-a',
  runId: 'run-1',
  title: '制作架构图',
  state: 'review',
  resultText: '已完成',
  ...extra,
});

test('a work result is queued to the main conversation as a structured event', async () => {
  const { followup, queued } = setup();
  assert.equal(await followup(payload()), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].owner, 'main');
  assert.equal(queued[0].item.requestId, 'followup-run-1');
  assert.equal(queued[0].item.consultTaskId, 'task-a');
  assert.equal(queued[0].item.text, '工作「制作架构图」结果已更新');
});

test('queued result uses the durable event identity rather than worker text', async () => {
  const { followup, queued } = setup();
  await followup(payload({ artifacts: [{ objectId: 'file-a', revision: 2, title: 'report.txt' }],
    verification: { state: 'passed', missing: [], checkedRunId: 'run-1',
      evidence: [{ objectId: 'file-a', revision: 2, status: 'passed', code: 'structure_valid' }] } }));
  assert.equal(queued[0].item.requestId, 'followup-run-1');
  assert.equal(queued[0].item.text, '工作「制作架构图」结果已更新');
});

test('conversation state is read when delivering after startup', async () => {
  const queued = [];
  let conversations;
  const { followup } = setup({ conversations: () => conversations });
  conversations = { primaryThread: () => 'main',
    enqueue: async (_owner, item) => queued.push(item) };
  assert.equal(await followup(payload()), true);
  assert.equal(queued.length, 1);
});

test('the same run carries a stable request ID for durable queue deduplication', async () => {
  const { followup, queued } = setup();
  assert.equal(await followup(payload()), true);
  assert.equal(await followup(payload()), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queued.length, 1);
});

test('results owned by another conversation never enter the main conversation', async () => {
  const { followup, queued } = setup();
  assert.equal(await followup(payload({ originThreadId: 'other', threadId: 'other' })), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queued.length, 0);
});

test('a missing main Bot mapping cannot silently use the visible conversation', async () => {
  const { followup, queued } = setup({
    conversations: { primaryThread: () => null, enqueue: async () => assert.fail('must not enqueue') },
    runtime: () => ({ threadId: 'visible-other', reviewEnabled: false }),
  });
  await assert.rejects(followup(payload()), /主会话映射不存在/);
  assert.equal(queued.length, 0);
});

test('browsing another conversation does not discard the main Bot result', async () => {
  const { followup, queued } = setup({ runtime: () => ({ threadId: 'browsing-other', reviewEnabled: false }) });
  assert.equal(await followup(payload()), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].owner, 'main');
});

test('the main Bot result stays queued across restart while another conversation is visible', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bot-followup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'conversations.json');
  let conversations = await createConversationState({ path, emit: () => {} });
  await conversations.bindPrimary('desk', 'main');
  const followup = createBotFollowup({
    conversations,
    context: { resolve: (id) => id },
    runtime: () => ({ threadId: 'browsing-other', reviewEnabled: false }),
    emit: () => {},
  });
  assert.equal(await followup(payload()), true);
  await new Promise((resolve) => setImmediate(resolve));
  await conversations.flush();

  conversations = await createConversationState({ path, emit: () => {} });
  const queue = conversations.queues().find((entry) => entry.threadId === 'main');
  assert.equal(queue.queue.length, 1);
  assert.equal(queue.queue[0].requestId, 'followup-run-1');
  assert.equal(queue.queue[0].state, 'queued');
});

test('restart sends only verified-shape result reports through a paused conversation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bot-result-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'conversations.json');
  let conversations = await createConversationState({ path, emit: () => {} });
  await conversations.enqueue('main', { text: '用户排队工作', workspaceId: 'desk',
    requestId: 'user-request' });
  await conversations.enqueue('main', { text: '工作结果已更新', workspaceId: 'desk',
    requestId: 'followup-00000000-0000-4000-8000-000000000001', route: 'consult',
    consultTaskId: 'task-a' });
  conversations = await createConversationState({ path, emit: () => {} });
  const [user, result] = conversations.get('main').queue;
  assert.equal(conversations.get('main').paused, true);
  await assert.rejects(conversations.claim('main', user.id), /队列已变化/);
  await assert.rejects(conversations.claim('main', user.id, { systemResult: true }), /队列已变化/);
  await assert.rejects(conversations.claim('main', result.id), /队列已变化/);
  await conversations.claim('main', result.id, { systemResult: true });
  await conversations.mark('main', result.id, 'sent');
  assert.equal(conversations.get('main').queue.find(item => item.id === user.id).state, 'queued');
  assert.equal(conversations.get('main').paused, true);
});

test('a failed enqueue is surfaced for durable mailbox reconciliation', async () => {
  let fail = true;
  const { followup, notices } = setup({
    conversations: { primaryThread: () => 'main',
      enqueue: async () => { if (fail) throw Error('queue unavailable'); } },
  });
  await assert.rejects(followup(payload()), /queue unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.at(-1).payload, 'queue unavailable');
});
