import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotEventPump } from '../apps/electron/work/bot-event-pump.mjs';

function fixture(deliver = async () => true) {
  const event = { id: 'work_result:run-a', runId: 'run-a', workspaceId: 'desk',
    delivery: { state: 'pending', attempt: 0 } };
  const calls = [];
  const pump = createBotEventPump({
    call: async ({ workspaceId, command }) => {
      const p = command.payload;
      if (p?.operation === 'host_workspaces') return { workspaces: [{ id: 'desk' }] };
      assert.equal(workspaceId, 'desk');
      calls.push(p.operation);
      if (p.operation === 'pending') return event.delivery.state === 'pending' ? [event] : [];
      if (p.operation === 'claim') {
        event.delivery = { state: 'claimed', attempt: event.delivery.attempt + 1, token: 'claim' };
        return structuredClone(event);
      }
      if (p.operation === 'ack' || p.operation === 'uncertain') {
        assert.equal(p.token, event.delivery.token);
        event.delivery.state = p.operation === 'ack' ? 'acknowledged' : 'unknown';
        return event;
      }
      throw Error('unexpected operation');
    },
    followup: deliver,
    emit: () => {},
  });
  return { event, calls, pump };
}

test('result is acknowledged only after the conversation queue has persisted it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { event, calls, pump } = fixture(async () => { await gate; return true; });
  const pending = pump.recover();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(event.delivery.state, 'claimed');
  assert.deepEqual(calls, ['pending', 'claim']);
  release();
  await pending;
  assert.equal(event.delivery.state, 'acknowledged');
  assert.deepEqual(calls, ['pending', 'claim', 'ack']);
});

test('a rejected enqueue keeps uncertain delivery for reconciliation', async () => {
  const { event, calls, pump } = fixture(async () => { throw Error('disk unavailable'); });
  await pump.drain('desk');
  assert.equal(event.delivery.state, 'unknown');
  assert.deepEqual(calls, ['pending', 'claim', 'uncertain']);
});
