// Settings-backed workflow run records: get/put helpers, run lookup with
// schema refresh, the run binding record type, and the time/sha/terminal
// primitives shared by the workflow modules.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fail } from '../../contracts/index.js';
import { WorkflowDocumentSchema, type WorkflowRun } from '../../contracts/workflows.js';

export const time = () => new Date().toISOString(),
  sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const terminal = (state: string) => ['succeeded', 'failed', 'skipped'].includes(state);

export type Binding = {
  runId: string;
  owner: string;
  session: string;
  attachedAt: string;
  previousOwners?: string[];
};

/** The Workflows surface the record cluster relies on. */
export type WorkflowRecordsHost = { db: DatabaseSync };

export interface WorkflowRecordsMethods {
  get<T>(w: string, key: string): T | undefined;
  put(w: string, key: string, value: unknown): void;
  run(w: string, id: string): WorkflowRun;
}

export const workflowRecords: WorkflowRecordsMethods &
  ThisType<WorkflowRecordsHost & WorkflowRecordsMethods> = {
  get<T>(w: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(w, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  },
  put(w: string, key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(w, key, JSON.stringify(value));
  },
  run(w: string, id: string) {
    const run = this.get<WorkflowRun>(w, `workflow-run:${id}`);
    if (!run) fail('NOT_FOUND', '工作流记录不存在。');
    run.document = WorkflowDocumentSchema.parse(run.document);
    return run;
  }
};
