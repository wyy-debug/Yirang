import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createShutdownController } from '../apps/electron/platform/shutdown-controller.mjs';

test('quit waits for a slow sync and skips renderer handshake after a crash', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = Object.assign(new EventEmitter(), { hide() {} });
  const actions = [];
  const app = Object.assign(new EventEmitter(), {
    quit() { actions.push('quit'); },
    exit() { actions.push('exit'); },
  });
  const shutdown = createShutdownController({
    window: () => window,
    app,
    emit: (name) => actions.push(name),
    state: () => ({ running: false }),
    finish: () => new Promise((resolve) => {
      setTimeout(() => { actions.push('synced'); resolve(); }, 3000);
    }),
  });
  const closing = shutdown.close({ rendererGone: true });
  t.mock.timers.tick(2500);
  assert.deepEqual(actions, ['closing']);
  t.mock.timers.tick(500);
  await closing;
  assert.deepEqual(actions, ['closing', 'synced', 'quit']);
});

test('a timed-out shutdown stops its sync loop and forces cleanup only once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = Object.assign(new EventEmitter(), { hide() {} });
  const actions = [];
  const app = Object.assign(new EventEmitter(), {
    quit() { actions.push('quit'); },
    exit() { actions.push('exit'); },
  });
  let signal;
  const shutdown = createShutdownController({
    window: () => window,
    app,
    emit: (name, { id } = {}) => {
      if (name === 'prepare-close') shutdown.respond(id);
    },
    state: () => ({ running: false }),
    finish: (current) => {
      signal = current;
      return new Promise(() => {});
    },
    forceCleanup: () => actions.push('cleaned'),
  });
  const closing = shutdown.close();
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await closing;
  t.mock.timers.tick(13000);
  assert.equal(signal.aborted, true);
  assert.deepEqual(actions, ['cleaned', 'exit']);
});
