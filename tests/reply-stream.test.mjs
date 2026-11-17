import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyStream } from '../apps/electron/conversation/reply-stream.js';

function fixture() {
  const callbacks = new Map();
  const painted = [];
  let next = 0;
  const stream = createReplyStream(
    (node, source) => painted.push([node, source]),
    (callback) => { callbacks.set(++next, callback); return next; },
    (frame) => callbacks.delete(frame),
  );
  const node = { dataset: {}, isConnected: true };
  return { callbacks, painted, stream, node };
}

test('Codex deltas paint together on the next frame without character pacing', () => {
  const { callbacks, painted, stream, node } = fixture();
  stream.queue(node, '我先');
  stream.queue(node, '读取选');
  assert.equal(callbacks.size, 1);
  assert.deepEqual(painted, []);
  callbacks.values().next().value();
  assert.deepEqual(painted, [[node, '我先读取选']]);
  stream.queue(node, '中文档');
  callbacks.values().next().value();
  assert.equal(painted.at(-1)[1], '我先读取选中文档');
});

test('completion flushes pending text and cancels its scheduled paint', () => {
  const { callbacks, painted, stream, node } = fixture();
  stream.queue(node, '完整回复');
  stream.flush(node);
  assert.equal(callbacks.size, 0);
  assert.deepEqual(painted, [[node, '完整回复']]);
});

test('switching history cancels stale paints', () => {
  const { callbacks, painted, stream, node } = fixture();
  stream.queue(node, '旧对话');
  stream.reset();
  assert.equal(callbacks.size, 0);
  assert.deepEqual(painted, []);
});
