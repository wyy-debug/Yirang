import test from 'node:test';
import assert from 'node:assert/strict';
import { startupThreadCandidates } from '../apps/electron/conversation/startup-thread.mjs';

test('startup opens the last used Codex chat before the older workspace Bot chat', () => {
  assert.deepEqual(startupThreadCandidates('recent', 'primary', 'draft'),
    ['recent', 'primary', 'draft', 'new']);
});

test('startup does not try the same chat twice', () => {
  assert.deepEqual(startupThreadCandidates('same', 'same', null), ['same', 'new']);
});
