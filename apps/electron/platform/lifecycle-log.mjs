import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createLifecycleLog(directory, version) {
  const path = join(directory, 'lifecycle.jsonl');
  const runId = randomUUID();
  return (event, details = {}) => {
    try {
      appendFileSync(path, JSON.stringify({
        at: new Date().toISOString(), runId, pid: process.pid, version, event, ...details,
      }) + '\n');
    } catch {
      // Logging must never prevent the desktop from starting or closing.
    }
  };
}
