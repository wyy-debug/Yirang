import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkManagementStore } from '../packages/local-runtime/work/work-management.js';
import { diagnosticDetails } from '../packages/mcp-adapter/diagnostic-record.js';
// @ts-ignore Electron host modules are native ESM.
import { desktopHostRequest } from '../apps/electron/platform/desktop-host-request.mjs';

test('human operations stay independent of persisted read-only threads after restart', () => {
  const db = new DatabaseSync(':memory:');
  const before = process.env.AI_DESKTOP_WORK_HOST;
  try {
    const store = new WorkManagementStore(db, {} as any);
    db.prepare('INSERT INTO work_voice_coordinators VALUES(?,?)').run('desk', 'voice');
    db.prepare('INSERT INTO work_consultations VALUES(?,?,?)').run('desk', 'consult', 'request');
    process.env.AI_DESKTOP_WORK_HOST = '1';
    for (const thread of ['voice', 'consult']) {
      const human = desktopHostRequest(
        'desktop_panel_action',
        { action: 'save' },
        thread,
        'desktop-ui',
      );
      assert.equal(human._meta.thread_id, undefined);
      assert.doesNotThrow(() =>
        store.guardTool(human._meta.thread_id, human.name, human.arguments),
      );
      assert.throws(() => store.guardTool(thread, human.name, human.arguments), /只读咨询/);
    }
  } finally {
    db.close();
    if (before === undefined) delete process.env.AI_DESKTOP_WORK_HOST;
    else process.env.AI_DESKTOP_WORK_HOST = before;
  }
});
test('diagnostics correlate sources and suboperations without recording content or credentials', () => {
  const args = {
    action: 'comments',
    payload: {
      operation: 'save',
      requestId: 'private-request',
      body: 'private-content',
      credential: 'secret',
    },
  };
  const meta = {
    'yirang/source': 'desktop-ui',
    'yirang/visible-thread': 'visible-private',
    thread_id: 'thread-private',
  };
  const record = diagnosticDetails(args, meta, true, 'voice-coordinator', 12.4);
  assert.equal(record.source, 'desktop-ui');
  assert.equal(record.operation, 'save');
  assert.equal(record.action, 'comments');
  assert.equal(record.durationMs, 12);
  assert.equal(record.threadHash?.length, 16);
  assert.equal(record.visibleThreadHash?.length, 16);
  assert.ok(!/private|secret/.test(JSON.stringify(record)));
  const forged = diagnosticDetails(args, meta, false, 'consultation', 0);
  assert.equal(forged.source, 'agent-mcp');
  assert.equal(forged.visibleThreadHash, null);
  assert.equal(
    diagnosticDetails({ action: 'user content with spaces' }, {}, true, 'none', 0).action,
    null,
  );
});
