import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createPreferences(path) {
  let state = {},
    queue = Promise.resolve();
  return {
    async load() {
      try {
        state = JSON.parse(await readFile(path, 'utf8'));
      } catch {}
      return { ...state };
    },
    get() {
      return { ...state };
    },
    async set(patch) {
      queue = queue
        .catch(() => {})
        .then(async () => {
          const next = { ...state, ...patch };
          await mkdir(dirname(path), { recursive: true });
          await writeFile(`${path}.pending`, JSON.stringify(next, null, 2));
          await rename(`${path}.pending`, path);
          state = next;
        });
      await queue;
      return { ...state };
    },
  };
}
