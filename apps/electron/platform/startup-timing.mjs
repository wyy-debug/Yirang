import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Measure normal launches, not synthetic benchmarks. All times share one
// monotonic process clock and exclude the OS/shortcut time before this process.
export function createStartupTiming(directory, version) {
  const now = () => Math.round(process.uptime() * 1000);
  const data = {
    version,
    runId: randomUUID(),
    pid: process.pid,
    startedAt: new Date(Date.now() - now()).toISOString(),
    milestones: {},
    spans: {},
  };
  const path = join(directory, 'startup-latest.json');
  let timer,
    chain = Promise.resolve();
  const snapshot = () => structuredClone(data);
  function persist() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const saved = snapshot();
      chain = chain
        .catch(() => {})
        .then(async () => {
          const latest = await readFile(path, 'utf8')
            .then(JSON.parse)
            .catch(() => null);
          if (latest?.startedAt > saved.startedAt) return;
          const temporary = `${path}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify(saved, null, 2));
          await rename(temporary, path);
        })
        .catch(() => {});
    }, 100);
    timer.unref();
  }
  return {
    snapshot,
    mark(name) {
      if (data.milestones[name] !== undefined) return;
      data.milestones[name] = now();
      persist();
    },
    async measure(name, action) {
      if (data.spans[name]) return action();
      const span = { startMs: now(), durationMs: null, status: 'running' };
      data.spans[name] = span;
      persist();
      try {
        const result = await action();
        span.status = 'complete';
        return result;
      } catch (error) {
        span.status = 'failed';
        throw error;
      } finally {
        span.durationMs = now() - span.startMs;
        persist();
      }
    },
  };
}
