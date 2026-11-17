import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopStore } from '../packages/local-runtime/store.js';

test('task ownership survives restart, revisions retain original requirements, and workspaces remain isolated', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'work-context-'));
  let store = new DesktopStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.createWorkspace('context-test');
  const w = (store.open('context-test') as any).binding.workspaceId;
  const command = (workspace: string, operation: string, options: any = {}) =>
    store.workManagement.command(workspace, { operation, ...options }, true) as any;
  const contract = command(w, 'intake', {
    requestId: 'contract',
    payload: { text: '整理合同，付款方式不能改变' },
  }).task;
  const mail = command(w, 'intake', { requestId: 'mail', payload: { text: '另外写邮件' } }).task;
  command(w, 'revise', {
    requestId: 'correction',
    taskId: contract.id,
    expectedRevision: contract.revision,
    payload: { text: '缩短到两页' },
  });
  command(w, 'intake', {
    requestId: 'question',
    payload: { text: '邮件进展怎么样', intent: 'consult', contextTaskId: mail.id },
  });
  const publicList = store.workManagement.command(w, { operation: 'list' }) as any;
  assert.equal(publicList.conversation, undefined);
  store.close();
  store = new DesktopStore(directory);
  const state = command(w, 'list');
  assert.equal(state.conversation.length, 1);
  assert.deepEqual(state.conversation.at(-1).taskLinks, [mail.id]);
  const detail = command(w, 'detail', { taskId: contract.id });
  assert.equal(detail.management.requirements[0].goal, '整理合同，付款方式不能改变');
  assert.match(detail.goal, /缩短到两页/);
  assert.deepEqual(
    command(w, 'intake', {
      requestId: 'question',
      payload: { text: '邮件进展怎么样', intent: 'consult', contextTaskId: mail.id },
    }).taskId,
    null,
  );
  assert.equal(command(w, 'list').conversation.length, 1);
  store.createWorkspace('context-other');
  const other = (store.open('context-other') as any).binding.workspaceId;
  assert.deepEqual(command(other, 'list').conversation, []);
  assert.throws(() =>
    command(other, 'intake', {
      requestId: 'cross',
      payload: { text: '继续', intent: 'consult', contextTaskId: mail.id },
    }),
  );
});
