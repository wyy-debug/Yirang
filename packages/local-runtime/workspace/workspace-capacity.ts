import type { DatabaseSync } from 'node:sqlite';
import { fail } from '../../contracts/index.js';

export function requireWorkspaceSlot(db: DatabaseSync) {
  const { count } = db.prepare(
    "SELECT COUNT(*) AS count FROM workspaces WHERE id NOT IN (SELECT workspace FROM settings WHERE key='workspace-trashed')",
  ).get() as { count: number };
  if (count >= 100) fail('WORKSPACE_LIMIT', '最多保留 100 个可用桌面。');
}
