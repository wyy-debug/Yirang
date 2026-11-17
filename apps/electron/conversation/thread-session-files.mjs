import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const THREAD_ID = /^[0-9a-f-]{36}$/i;
const SESSION_REF = /^(codex|electron):[0-9a-f-]{36}$/i;

export function createThreadSessionFiles(directory, threadDirectory = directory) {
  const threadPath = join(threadDirectory, 'codex-thread.json');
  const workspacePath = join(directory, 'workspace-session.json');

  async function loadThreadId() {
    try {
      const id = JSON.parse(await readFile(threadPath, 'utf8')).threadId;
      return typeof id === 'string' && THREAD_ID.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  return {
    loadThreadId,
    saveThreadId: (threadId) => writeFile(threadPath, JSON.stringify({ threadId })),
    async loadWorkspaceSession() {
      try {
        const saved = JSON.parse(await readFile(workspacePath, 'utf8')).sessionRef;
        if (typeof saved === 'string' && SESSION_REF.test(saved)) return saved;
      } catch {}
      const prior = await loadThreadId();
      const sessionRef = prior ? `codex:${prior}` : `electron:${randomUUID()}`;
      await writeFile(workspacePath, JSON.stringify({ sessionRef }));
      return sessionRef;
    },
  };
}
