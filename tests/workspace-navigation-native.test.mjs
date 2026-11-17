import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceNavigation } from '../apps/electron/workspace/workspace-navigation.mjs';

const until = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('等待桌面切换超时');
    await new Promise((done) => setTimeout(done, 15));
  }
};

test('desktop switch waits for every native task and output collection', async (t) => {
  const events = [];
  const work = { first: true, second: true, collecting: true };
  const navigation = createWorkspaceNavigation({
    busy: () => Object.values(work).some(Boolean),
    emit: (type, value) => events.push({ type, value }),
  });
  t.after(() => navigation.close());
  const request = { requestId: 'switch-A-B', workspaceId: 'desk-A',
    targetId: 'desk-B', name: '桌面 B' };
  assert.equal(navigation.request(request).state, 'waiting_tasks');
  assert.equal(navigation.request(request).state, 'waiting_tasks');
  assert.throws(() => navigation.request({ ...request, targetId: 'desk-C' }),
    /请求 ID 已用于另一项桌面切换/);
  work.first = false;
  work.second = false;
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(events.some((event) => event.type === 'workspace-open'), false);
  work.collecting = false;
  await until(() => events.some((event) => event.type === 'workspace-open'));
  assert.equal(navigation.opening(), true);
  navigation.settle({ requestId: request.requestId });
  assert.equal(navigation.opening(), false);
  assert.equal(navigation.request(request).state, 'opened');
  assert.equal(events.filter((event) => event.type === 'workspace-open').length, 1);
});

test('failed desktop switch remains on the current desktop and keeps a retryable result', async (t) => {
  const events = [];
  const navigation = createWorkspaceNavigation({ busy: () => false,
    emit: (type, value) => events.push({ type, value }) });
  t.after(() => navigation.close());
  const request = { requestId: 'switch-failed', workspaceId: 'desk-A',
    targetId: 'desk-B', name: '桌面 B' };
  navigation.request(request);
  await until(() => navigation.opening());
  navigation.settle({ requestId: request.requestId, error: '草稿保存失败' });
  assert.equal(navigation.request(request).state, 'failed');
  assert.equal(events.at(-1).value.error, '草稿保存失败');
});
