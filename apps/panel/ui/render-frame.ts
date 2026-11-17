// One frame for layout readers, followed by one batch of React/DOM writes.
// Keep reads ahead of writes to avoid alternating forced layout across cards.
type Read = () => void | (() => void);
import { renderMetricsEnabled, recordFrameBatch } from './render-metrics.js';
const pending = new Map<object, Read>();
let frame = 0;
export function scheduleRenderFrame(key: object, read: Read) {
  pending.set(key, read);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const start = renderMetricsEnabled() ? performance.now() : null;
    const reads = [...pending.values()];
    pending.clear();
    const writes: (() => void)[] = [];
    for (const read of reads) {
      try {
        const write = read();
        if (write) writes.push(write);
      } catch (error) {
        reportError(error);
      }
    }
    for (const write of writes) {
      try {
        write();
      } catch (error) {
        reportError(error);
      }
    }
    if (start !== null) recordFrameBatch(performance.now() - start, reads.length);
  });
}
export function cancelRenderFrame(key: object) {
  pending.delete(key);
  if (!pending.size && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}
