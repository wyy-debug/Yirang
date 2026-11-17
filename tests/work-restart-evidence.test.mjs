import test from 'node:test';
import assert from 'node:assert/strict';
import { canRestartUnexecutedTurn } from '../apps/electron/work/restart-evidence.mjs';

test('only an exit-interrupted transcript without executable items permits continuation', () => {
  const run = { turnId: 'turn', restartRequestedAt: '2026-11-06T00:00:00Z' };
  const turn = { id: 'turn', status: 'interrupted', items: [{ type: 'userMessage' }] };
  assert.equal(canRestartUnexecutedTurn(run, turn), true);
  for (const type of ['commandExecution', 'mcpToolCall', 'fileChange', 'unknown'])
    assert.equal(canRestartUnexecutedTurn(run, { ...turn, items: [{ type }] }), false);
  assert.equal(canRestartUnexecutedTurn({ turnId: 'turn' }, turn), false);
  assert.equal(canRestartUnexecutedTurn(run, { ...turn, id: 'other' }), false);
  assert.equal(canRestartUnexecutedTurn(run, { ...turn, items: undefined }), false);
  assert.equal(canRestartUnexecutedTurn(run, { ...turn, status: 'inProgress' }), false);
});
