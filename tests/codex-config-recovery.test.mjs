import test from 'node:test';
import assert from 'node:assert/strict';
import { requestWithConfigRecovery } from '../apps/electron/cli/codex-config-recovery.mjs';
const failure = () =>
  new Error(
    'failed to load configuration: invalid type: string "", expected f64 in `mcp_servers.node_repl.tool_timeout_sec`',
  );
test('a failed new conversation recovers with a numeric timeout without changing approval or other settings', async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (calls.length === 1) throw failure();
    return { thread: { id: 'new' } };
  };
  const params = {
    cwd: 'example',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    config: { 'features.multi_agent': false },
  };
  assert.deepEqual(await requestWithConfigRecovery(request, 'thread/start', params), {
    thread: { id: 'new' },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, {
    ...params,
    config: { ...params.config, 'mcp_servers.node_repl.tool_timeout_sec': 60 },
  });
  assert.equal(Object.keys(params.config).length, 1);
});
test('never replay a message, explicit timeout or unrelated failure; recovery is bounded', async () => {
  for (const [method, params, error, expected] of [
    ['turn/start', {}, failure(), 1],
    ['thread/resume', { config: { 'mcp_servers.node_repl.tool_timeout_sec': 120 } }, failure(), 1],
    ['thread/resume', {}, new Error('permission denied'), 1],
    ['thread/resume', {}, failure(), 2],
  ]) {
    let calls = 0;
    await assert.rejects(
      requestWithConfigRecovery(
        async () => {
          calls++;
          throw error;
        },
        method,
        params,
      ),
      (e) => e === error,
    );
    assert.equal(calls, expected);
  }
});
