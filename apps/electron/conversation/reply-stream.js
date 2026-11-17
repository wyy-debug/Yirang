// Paint the latest Codex output on the next display frame. Never pace its text.
export function createReplyStream(render, schedule = requestAnimationFrame, cancel = cancelAnimationFrame) {
  const frames = new Map();

  function paint(node) {
    if (node?.isConnected) render(node, node.dataset.source || '');
  }

  return {
    queue(node, delta) {
      node.dataset.source = (node.dataset.source || '') + delta;
      if (frames.has(node)) return;
      frames.set(node, schedule(() => {
        frames.delete(node);
        paint(node);
      }));
    },
    flush(node) {
      if (!node) return;
      if (frames.has(node)) {
        cancel(frames.get(node));
        frames.delete(node);
      }
      paint(node);
    },
    reset() {
      for (const frame of frames.values()) cancel(frame);
      frames.clear();
    },
  };
}
