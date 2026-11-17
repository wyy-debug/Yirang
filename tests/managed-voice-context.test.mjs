import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedVoice } from '../apps/electron/voice/managed-voice.mjs';

test('voice handoff discovers the latest context and still rejects a stale selection', async () => {
  const context = {
    managed: true,
    threadId: 'voice',
    workspaceId: 'workspace',
    selectionReady: true,
    voiceSelection: { id: 'current', label: '', sources: [], sourceSnapshots: [], blocks: [] },
    acceptedRequests: new Map(),
    tasks: new Set(),
  };
  const commands = [];
  const voice = createManagedVoice({
    call: async () => ({ workspaceId: 'workspace' }),
    work: {
      command: async (c) => {
        commands.push(c);
        return c.command.operation === 'list' ? { tasks: [] } : { taskId: 'new-work' };
      },
    },
  });
  const list = await voice.handle(context, { threadId: 'voice', operation: 'list' });
  assert.equal(list.selection.contextId, 'current');
  assert.equal(list.selection.state, 'ready');
  await assert.rejects(
    voice.handle(context, {
      threadId: 'voice',
      operation: 'submit',
      requestId: 'stale',
      contextId: 'old',
      text: 'Create a new note',
    }),
    /selection/,
  );
  assert.equal(commands.length, 1);
  await voice.handle(context, {
    threadId: 'voice',
    operation: 'submit',
    requestId: 'new',
    contextId: list.selection.contextId,
    text: 'Create a new note',
  });
  assert.equal(commands[1].command.operation, 'intake');
  context.selectionReady = false;
  const pending = await voice.handle(context, { threadId: 'voice', operation: 'list' });
  assert.equal(pending.selection.state, 'pending');
  assert.equal(pending.selection.contextId, null);
});
