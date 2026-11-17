import { readFile } from 'node:fs/promises';

// Nothing updates these receipts any more, so unfinished ones can no longer report a result.
const unfinished = new Set([
  'prepared',
  'thread_starting',
  'thread_resuming',
  'thread_created',
  'turn_starting',
  'running',
]);

// Keep old execution cards visible after the direct-chat migration.
export async function readLegacyNativeReceipts(path, workspaceId) {
  let saved;
  try {
    saved = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (saved.version !== 1 || !Array.isArray(saved.records))
    throw Error('原生对话回执格式不受支持');
  return saved.records
    .filter((item) => item.workspaceId === workspaceId)
    .slice(-40)
    .reverse()
    .map((item) => (unfinished.has(item.state) ? { ...item, state: 'unknown' } : item));
}
