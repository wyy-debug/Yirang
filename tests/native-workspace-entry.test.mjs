import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntentWorkbench } from '../apps/electron/composer/intent-workbench.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((done) => setTimeout(done, 0));

test('a late desktop A result never appears on desktop B or locates A files', async (t) => {
  const priorWindow = globalThis.window;
  const host = new EventTarget();
  const panel = new EventTarget();
  const sent = [];
  const requests = [];
  const responses = new Map();
  panel.postMessage = (value) => sent.push(value);
  host.desktop = {
    nativeWork: (workspaceId) => {
      requests.push(workspaceId);
      const response = deferred();
      responses.set(workspaceId, response);
      return response.promise;
    },
    onEvent: () => {},
  };
  globalThis.window = host;
  t.after(() => { globalThis.window = priorWindow; });
  createIntentWorkbench({ frame: Object.assign(new EventTarget(), { contentWindow: panel }),
    surface: { dock() {} }, status: { textContent: '' } });
  const send = (data) => host.dispatchEvent(Object.assign(new Event('message'),
    { source: panel, data }));
  send({ type: 'yirang:native-work-request', workspaceId: 'desk-A' });
  send({ type: 'yirang:native-work-request', workspaceId: 'desk-B' });
  responses.get('desk-A').resolve({ records: [{ requestId: 'A' }], batches: [{
    id: 'batch-A', workspaceId: 'desk-A', files: [{ objectId: 'file-A' }],
  }] });
  await flush();
  assert.deepEqual(requests, ['desk-A', 'desk-B']);
  responses.get('desk-B').resolve({ records: [{ requestId: 'B' }], batches: [{
    id: 'batch-B', workspaceId: 'desk-B', files: [{ objectId: 'file-B' }],
  }] });
  await flush();
  assert.deepEqual(sent.filter((item) => item.type === 'yirang:native-work-stream')
    .map((item) => [item.workspaceId, item.records.map((record) => record.requestId)]),
  [['desk-B', ['B']]]);
  send({ type: 'yirang:native-work-locate', batchId: 'batch-A', objectId: 'file-A' });
  send({ type: 'ai-desktop:locate-outputs', workspaceId: 'desk-A', objectIds: ['file-A'] });
  assert.equal(sent.filter((item) => item.type === 'ai-desktop:locate-outputs').length, 0);
  send({ type: 'yirang:native-work-locate', batchId: 'batch-B', objectId: 'file-B' });
  assert.deepEqual(sent.at(-1), { type: 'ai-desktop:locate-outputs',
    workspaceId: 'desk-B', objectIds: ['file-B'] });
});

test('a late desktop A query error does not overwrite desktop B status', async (t) => {
  const priorWindow = globalThis.window;
  const host = new EventTarget();
  const panel = new EventTarget();
  const responses = new Map();
  panel.postMessage = () => {};
  host.desktop = { nativeWork: (id) => {
    const response = deferred(); responses.set(id, response); return response.promise;
  }, onEvent: () => {} };
  globalThis.window = host;
  t.after(() => { globalThis.window = priorWindow; });
  const status = { textContent: '' };
  createIntentWorkbench({ frame: Object.assign(new EventTarget(), { contentWindow: panel }),
    surface: { dock() {} }, status });
  const send = (workspaceId) => host.dispatchEvent(Object.assign(new Event('message'),
    { source: panel, data: { type: 'yirang:native-work-request', workspaceId } }));
  send('desk-A'); send('desk-B');
  responses.get('desk-A').reject(Error('桌面 A 查询失败'));
  await flush();
  responses.get('desk-B').resolve({ records: [], batches: [] });
  await flush();
  assert.equal(status.textContent, '');
});
