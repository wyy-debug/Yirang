import test from 'node:test';
import assert from 'node:assert/strict';
import { executionEvidence } from '../apps/electron/work/execution-evidence.mjs';
import { reviewCompletion } from '../apps/electron/work/completion-review.mjs';

test('review receives exact-turn command receipts while unavailable metrics stay unknown', async () => {
  const turn = { id: 't', status: 'completed', items: [
    { id: 'cmd', type: 'commandExecution', command: 'Start-Sleep -Seconds 45',
      status: 'completed', exitCode: 0, durationMs: 45010, aggregatedOutput: 'private output' },
    { type: 'mcpToolCall', arguments: { credential: 'never forward' } },
  ] };
  assert.equal(executionEvidence(turn, 'other'), null);
  const evidence = executionEvidence(turn, 't');
  assert.equal(evidence.commands[0].durationMs, 45010);
  assert.equal(JSON.stringify(evidence).includes('private output'), false);
  assert.equal(JSON.stringify(evidence).includes('never forward'), false);
  assert.equal(executionEvidence({ ...turn, items: [{ type: 'commandExecution' }] }, 't').commands[0].exitCode, null);
  await reviewCompletion(async (_w, request) => {
    assert.deepEqual(request.input.executionEvidence, evidence);
    assert.match(request.instructions, /不能证明任意外部服务/);
    return { text: '{}' };
  }, 'w', { profile: { model: 'test' }, requirements: {},
    files: [{ status: 'passed', text: 'OK' }], executionEvidence: evidence });
});
