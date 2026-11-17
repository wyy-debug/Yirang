import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPermissions, executionTurnPermissions } from '../apps/electron/conversation/execution-permissions.mjs';

test('ordinary execution explicitly replaces consultation restrictions', () => {
  const resumed = { sandbox: 'read-only', approvalPolicy: 'never', ...executionPermissions({}) };
  assert.equal(resumed.sandbox, 'workspace-write');
  assert.equal(resumed.approvalPolicy, 'on-request');
});
test('explicit CLI read-only policy and selected reviewer are preserved', () => {
  assert.deepEqual(executionPermissions({ sandbox_mode: 'read-only', approval_policy: 'never' },
    { approvalsReviewer: 'auto_review' }), {
    sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'auto_review',
  });
});

test('ordinary Codex turns can write their output batch with automatic review', () => {
  const config = { sandbox_mode: 'workspace-write', approval_policy: 'on-request' };
  const turn = executionTurnPermissions(config, { approvalsReviewer: 'auto_review' }, 'F:/batch');
  assert.deepEqual(turn.sandboxPolicy.writableRoots, ['F:/batch']);
  assert.equal(turn.approvalPolicy, 'on-request');
  assert.equal(turn.approvalsReviewer, 'auto_review');
  assert.deepEqual(executionTurnPermissions({ sandbox_mode: 'read-only' }, {}, 'F:/batch').sandboxPolicy,
    { type: 'readOnly' });
});
