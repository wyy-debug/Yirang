import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BotEventStore } from '../packages/local-runtime/bot/bot-events.js';
import { BotIntakeStore } from '../packages/local-runtime/bot/bot-intake.js';
import { DesktopStore } from '../packages/local-runtime/store.js';

test('claim, ack and interrupted delivery are persisted and token guarded', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let events = new BotEventStore(db);
    const task = { id: 'task-a', title: '报告', management: {
      state: 'review', currentRequirementsRevision: 2, originThreadId: 'main',
      runs: [{ id: 'run-a', requirementsRevision: 2, resultText: '结果' }],
    } } as any;
    db.exec('BEGIN');
    events.publishResult('desk', task, 'run-a');
    db.exec('ROLLBACK');
    assert.equal((events.command('desk', { operation: 'pending' }) as any[]).length, 0,
      'event publication must roll back with task state');
    events.publishResult('desk', task, 'run-a');
    events.publishResult('desk', task, 'run-a');
    assert.equal((events.command('desk', { operation: 'pending' }) as any[]).length, 1);
    const claimed = events.command('desk', { operation: 'claim', id: 'work_result:run-a' }) as any;
    assert.equal(claimed?.delivery.attempt, 1);
    assert.throws(() => events.command('desk', { operation: 'ack', id: claimed!.id,
      token: '00000000-0000-4000-8000-000000000000' }), /回执/);
    events = new BotEventStore(db);
    const uncertain = events.command('desk', { operation: 'status', id: 'work_result:run-a' }) as any;
    assert.equal(uncertain.delivery.state, 'unknown');
    assert.equal((events.command('desk', { operation: 'recent' }) as any[])[0].delivery.state, 'unknown');
    assert.equal((events.command('desk', { operation: 'pending' }) as any[]).length, 0,
      'unknown delivery must not be sent twice automatically');
    assert.throws(() => events.command('desk', { operation: 'ack', id: claimed.id,
      token: claimed.delivery.token }), /回执/, 'stale claim cannot acknowledge an unknown event');
  } finally { db.close(); }
});

test('result event carries host checked artifacts and only the matching run verification', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const events = new BotEventStore(db);
    const task = { id: 'task-a', title: '报告', management: {
      state: 'completed', currentRequirementsRevision: 2, originThreadId: 'main',
      runs: [{ id: 'run-a', requirementsRevision: 2, resultText: '已完成' }],
      artifacts: [{ objectId: 'file-a', revision: 3, title: 'report.txt', validity: 'current' },
        { objectId: 'file-b', revision: 1, title: 'old.txt', validity: 'stale' }],
      continuation: { checkedRunId: 'run-a', revision: 2, next: 'done', missing: [],
        evidence: [{ objectId: 'file-a', revision: 3, status: 'passed',
          code: 'structure_valid', criterion: { id: 'goal:0' } }] },
    } } as any;
    const event = events.publishResult('desk', task, 'run-a')!;
    assert.deepEqual(event.artifacts, [{ objectId: 'file-a', revision: 3, title: 'report.txt' }]);
    assert.equal(event.verification?.state, 'passed');
    assert.equal(event.verification?.evidence[0]?.criterionId, 'goal:0');
    task.management.continuation.checkedRunId = 'other-run';
    task.management.runs[0].id = 'run-b';
    assert.equal(events.publishResult('desk', task, 'run-b')?.verification?.state, 'unknown');
  } finally { db.close(); }
});

test('host report uses the persisted result event and rejects a forged queue identity', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const events = new BotEventStore(db);
    const task = { id: 'task-a', title: '报告', management: {
      state: 'completed', currentRequirementsRevision: 2, originThreadId: 'main',
      runs: [{ id: 'run-a', requirementsRevision: 2, resultText: 'Worker says done' }],
      artifacts: [{ objectId: 'file-a', revision: 3, title: 'report.txt', validity: 'current' }],
      continuation: { checkedRunId: 'run-a', revision: 2, next: 'done', missing: [], evidence: [] },
    } } as any;
    const intake = new BotIntakeStore(db, () => task);
    events.publishResult('desk', task, 'run-a');
    events.command('desk', { operation: 'claim', id: 'work_result:run-a' });
    intake.command('desk', { operation: 'receive', request: { id: 'followup-run-a',
      text: '工作「报告」结果已更新', mode: 'daily',
      capture: { route: 'consult', consultTaskId: 'task-a' } } });
    const response = intake.command('desk', { operation: 'work_event_report',
      id: 'followup-run-a', runId: 'run-a' }) as any;
    assert.match(response.text, /已完成并通过宿主核验/);
    assert.match(response.text, /taskId: task-a.*runId: run-a/);
    assert.match(response.text, /report\.txt（file-a@3）/);
    assert.deepEqual(intake.command('desk', { operation: 'work_event_report',
      id: 'followup-run-a', runId: 'run-a' }), response);
    intake.command('desk', { operation: 'receive', request: { id: 'followup-run-b',
      text: '工作「报告」结果已更新', mode: 'daily',
      capture: { route: 'consult', consultTaskId: 'task-a' } } });
    assert.throws(() => intake.command('desk', { operation: 'work_event_report',
      id: 'followup-run-b', runId: 'run-b' }), /不存在/);
    task.management.state = 'attention';
    task.management.runs[0].id = 'run-c';
    task.management.continuation.checkedRunId = 'run-c';
    task.management.continuation.next = 'blocked';
    events.publishResult('desk', task, 'run-c');
    events.command('desk', { operation: 'claim', id: 'work_result:run-c' });
    intake.command('desk', { operation: 'receive', request: { id: 'followup-run-c',
      text: '工作「报告」结果已更新', mode: 'daily',
      capture: { route: 'consult', consultTaskId: 'task-a' } } });
    const blocked = intake.command('desk', { operation: 'work_event_report',
      id: 'followup-run-c', runId: 'run-c' }) as any;
    assert.match(blocked.text, /尚未确认完成/);
    assert.doesNotMatch(blocked.text, /已完成并通过宿主核验/);
  } finally { db.close(); }
});

test('a queued prior result cannot report a newer requirement as completed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const task = { id: 'task-a', title: '报告', management: {
      state: 'completed', currentRequirementsRevision: 2, originThreadId: 'main',
      runs: [{ id: 'run-old', requirementsRevision: 2, resultText: '旧版完成' }],
      continuation: { checkedRunId: 'run-old', revision: 2, next: 'done',
        missing: [], evidence: [] },
    } } as any;
    const events = new BotEventStore(db);
    const intake = new BotIntakeStore(db, () => task);
    events.publishResult('desk', task, 'run-old');
    events.command('desk', { operation: 'claim', id: 'work_result:run-old' });
    intake.command('desk', { operation: 'receive', request: { id: 'followup-run-old',
      text: '工作「报告」结果已更新', mode: 'daily',
      capture: { route: 'consult', consultTaskId: 'task-a' } } });
    task.management.currentRequirementsRevision = 3;
    task.management.state = 'queued';
    const response = intake.command('desk', { operation: 'work_event_report',
      id: 'followup-run-old', runId: 'run-old' }) as any;
    assert.match(response.text, /当前任务或要求版本已变化/);
    assert.doesNotMatch(response.text, /已完成并通过宿主核验/);
  } finally { db.close(); }
});

test('finishing a current top-level run publishes one result in the Work Host transaction', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-event-work-'));
  const store = new DesktopStore(directory);
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  const workspace = store.createWorkspace(null, 'events');
  let sequence = 0;
  const command = (operation: string, taskId?: string, payload: any = {}) =>
    store.workManagement.command(workspace, { operation, taskId, payload,
      requestId: `bot-event-test-${sequence++}` }, true) as any;
  const task = command('intake', undefined, { text: '写一份报告' }).task;
  const run = command('dispatch', task.id, { threadId: 'worker', provider: 'codex',
    controlled: true, dispatchKey: 'bot-event-run' }).run;
  command('ack', task.id, { runId: run.id, threadId: 'worker', turnId: 'turn' });
  const finished = command('finish', task.id, { runId: run.id, state: 'failed',
    resultText: '执行失败', reason: '测试失败' });
  assert.equal(finished.management.state, 'attention');
  const pending = store.workManagement.command(workspace,
    { operation: 'bot_events', payload: { operation: 'pending' } }, true) as any[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].runId, run.id);
  assert.equal(pending[0].taskId, task.id);
  assert.equal(pending[0].state, 'attention');
  command('finish', task.id, { runId: run.id, state: 'failed', resultText: '执行失败' });
  assert.equal((store.workManagement.command(workspace,
    { operation: 'bot_events', payload: { operation: 'pending' } }, true) as any[]).length, 1);
});
