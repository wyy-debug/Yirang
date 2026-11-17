import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { registerRendererCrashRecovery } from '../apps/electron/platform/renderer-crash-recovery.mjs';

function fixture() {
  const events = [];
  const webContents = new EventEmitter();
  const window = { webContents, isDestroyed: () => false };
  let closing = false;
  const response = Promise.withResolvers();
  registerRendererCrashRecovery({
    window,
    dialog: {
      showMessageBox(owner, options) {
        assert.equal(owner, window);
        assert.equal(options.buttons.length, 2);
        events.push('prompt');
        return response.promise;
      },
    },
    app: { relaunch: () => events.push('relaunch') },
    lifecycle: (name) => events.push(name),
    closing: () => closing,
    close: () => events.push('shutdown'),
  });
  return {
    events,
    exit: (reason = 'crashed') =>
      webContents.emit('render-process-gone', {}, { reason, exitCode: -2147483645 }),
    beginClosing: () => { closing = true; },
    choose: async (index) => {
      response.resolve({ response: index });
      await new Promise(setImmediate);
    },
  };
}

test('renderer crash offers native recovery once and reopens through normal shutdown', async () => {
  const app = fixture();
  app.exit();
  app.exit();
  assert.deepEqual(app.events, ['render-process-gone', 'prompt', 'render-process-gone']);
  await app.choose(0);
  assert.deepEqual(app.events.slice(-3), ['renderer-crash-recovery', 'relaunch', 'shutdown']);
});

test('closing from recovery does not relaunch, and normal exit does not prompt', async () => {
  const app = fixture();
  app.exit('clean-exit');
  assert.deepEqual(app.events, ['render-process-gone']);
  app.exit('oom');
  await app.choose(1);
  assert.deepEqual(app.events.slice(-3), ['prompt', 'renderer-crash-recovery', 'shutdown']);
  app.beginClosing();
  app.exit();
  assert.equal(app.events.filter((event) => event === 'prompt').length, 1);
});
