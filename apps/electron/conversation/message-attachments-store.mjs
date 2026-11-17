import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

// Separate small records keep image bytes out of the frequently saved draft
// store, and history reads touch only the turns currently on screen.
export function createMessageAttachmentsStore(directory) {
  const jobs = new Map();
  const key = (value) => {
    if (typeof value !== 'string' || !value || value.length > 200) throw Error('附件记录标识无效');
    return createHash('sha256').update(value).digest('hex');
  };
  const file = (threadId, turnId) => join(directory, key(threadId), key(turnId) + '.json');
  return {
    save(threadId, turnId, attachments) {
      if (!attachments.files.length && !attachments.quotes.length) return Promise.resolve();
      const path = file(threadId, turnId),
        job = (async () => {
          await mkdir(join(directory, key(threadId)), { recursive: true });
          const temporary = path + '.' + randomUUID() + '.tmp';
          await writeFile(temporary, JSON.stringify(attachments), { mode: 0o600 });
          await rename(temporary, path);
        })();
      jobs.set(path, job);
      void job
        .finally(() => {
          if (jobs.get(path) === job) jobs.delete(path);
        })
        .catch(() => {});
      return job;
    },
    async read(threadId, turnIds) {
      if (!Array.isArray(turnIds) || turnIds.length > 100) throw Error('附件记录范围无效');
      const result = {};
      for (let i = 0; i < turnIds.length; i += 10)
        await Promise.all(
          turnIds.slice(i, i + 10).map(async (id) => {
            const path = file(threadId, id);
            await jobs.get(path)?.catch(() => {});
            try {
              result[id] = JSON.parse(await readFile(path, 'utf8'));
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }),
        );
      return result;
    },
  };
}
