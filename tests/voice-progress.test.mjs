import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createVoiceSession } from '../apps/electron/voice/voice-session.mjs';

test('task revisions refresh the UI without repeatedly prompting voice replies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [],
    events = [];
  let failNext = false;
  let rows = [
    {
      id: 'work',
      title: 'Note',
      state: 'running',
      revision: 1,
      requirementsRevision: 1,
      reason: 'Executing',
    },
  ];
  const voice = createVoiceSession({
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'thread/realtime/appendText' && failNext) {
        failNext = false;
        throw Error('temporary failure');
      }
    },
    emit: (type, payload) => events.push({ type, payload }),
    prepare: async () => ({
      managed: true,
      threadId: 'voice',
      voiceSelection: { id: 'selection', references: '' },
    }),
    managed: { instructions: 'Voice test', progress: async () => rows },
    isRunning: () => false,
  });
  await voice.prepare();
  await voice.start({ threadId: 'voice', sdp: 'test' });
  const refresh = async () => {
    voice.refreshWork();
    t.mock.timers.tick(500);
    await setImmediate();
  };
  const spoken = () => calls.filter((c) => c.method === 'thread/realtime/appendText');
  await refresh();
  assert.equal(spoken().length, 1);
  rows = [{ ...rows[0], revision: 2 }];
  await refresh();
  assert.equal(spoken().length, 1);
  assert.equal(
    events.filter((e) => e.payload.method === 'work-status').at(-1).payload.tasks[0].revision,
    2,
  );
  rows = [{ ...rows[0], revision: 3, state: 'attention', reason: 'Approval required' }];
  await refresh();
  assert.equal(spoken().length, 2);
  assert.match(spoken().at(-1).payload.text, /Approval required/);
  rows = [{ ...rows[0], revision: 4, requirementsRevision: 2 }];
  await refresh();
  assert.equal(spoken().length, 3);
  rows = [{ ...rows[0], revision: 5, state: 'review', reason: 'Result ready' }];
  failNext = true;
  await refresh();
  assert.equal(events.at(-1).payload.method, 'work-status-error');
  await refresh();
  assert.equal(spoken().length, 5);
  assert.match(spoken().at(-1).payload.text, /Result ready/);
  await voice.stop();
  voice.refreshWork();
  t.mock.timers.tick(500);
  await setImmediate();
  assert.equal(spoken().length, 5);
});
