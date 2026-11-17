import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
const pptxgen = createRequire(import.meta.url)('pptxgenjs');
import { inspectCompletion } from '../packages/local-runtime/work/completion-inspector.js';
import { decideContinuation } from '../packages/local-runtime/work/completion-policy.js';
import { DesktopStore } from '../packages/local-runtime/store.js';

test('completed revision retains only an unchanged, rechecked artifact after a supplement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-retained-'));
  const store = new DesktopStore(directory);
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true,
    maxRetries: 10, retryDelay: 100 }); });
  store.createWorkspace('retained');
  const binding = (store.open('retained') as any).binding;
  const w = binding.workspaceId;
  const create = (title: string) => store.createObject(w, binding.credential, 'retained', randomUUID(), {
    kind: 'text', title, content: { blocks: [{ id: 'p', text: title }] },
    bounds: { x: 0, y: 0, width: 300, height: 200 },
  }) as any;
  const cmd = (operation: string, taskId?: string, payload: any = {}) => store.workManagement.command(w,
    { operation, taskId, payload, requestId: randomUUID(),
      ...(taskId ? { expectedRevision: (store.workManagement.command(w,
        { operation: 'detail', taskId }, true) as any).revision } : {}) }, true) as any;
  for (const archive of [false, true]) {
    const oldFile = create(`old-${archive}`);
    const task = cmd('intake', undefined, { text: '交付旧成果' }).task;
    const first = cmd('dispatch', task.id, { threadId: randomUUID(), provider: 'codex',
      controlled: true, dispatchKey: randomUUID() }).run;
    cmd('ack', task.id, { runId: first.id, threadId: first.threadId, turnId: randomUUID() });
    const firstDone = cmd('finish', task.id, { runId: first.id, state: 'succeeded',
      artifacts: [{ objectId: oldFile.id, revision: oldFile.revision }],
      completionEvidence: [{ objectId: oldFile.id, revision: oldFile.revision,
        status: 'passed', code: 'structure_valid', detail: 'checked' }] });
    assert.equal(firstDone.management.state, 'completed');
    cmd('revise', task.id, { text: '追加新成果' });
    await delay(2100);
    if (archive) store.manageObject(w, binding.credential, 'retained', {
      operation: 'archive', objectId: oldFile.id, expectedRevision: oldFile.revision,
      requestId: randomUUID(),
    });
    const newFile = create(`new-${archive}`);
    const second = cmd('dispatch', task.id, { threadId: randomUUID(), provider: 'codex',
      controlled: true, dispatchKey: randomUUID() }).run;
    cmd('ack', task.id, { runId: second.id, threadId: second.threadId, turnId: randomUUID() });
    const result = cmd('finish', task.id, { runId: second.id, state: 'succeeded',
      artifacts: [{ objectId: newFile.id, revision: newFile.revision }],
      retainedArtifacts: [{ objectId: oldFile.id, revision: oldFile.revision }],
      completionEvidence: [{ objectId: oldFile.id, revision: oldFile.revision,
        status: 'passed', code: 'structure_valid', detail: 'checked' },
      { objectId: newFile.id, revision: newFile.revision,
        status: 'passed', code: 'structure_valid', detail: 'checked' }] });
    assert.equal(result.management.artifacts.find((a: any) => a.objectId === oldFile.id)?.validity,
      archive ? 'stale' : 'current');
  }
});

test('real asset inspection distinguishes malformed SVG, editable PPT and unavailable evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-assets-'));
  mkdirSync(join(directory, 'assets'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = (name: string, bytes: Buffer | string, editable = false) => {
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(directory, 'assets', hash), bytes);
    return { objectId: name, name, hash, revision: 1, editable };
  };
  const deck = new pptxgen();
  deck.addSlide().addText('Editable', { x: 1, y: 1, w: 3, h: 1 });
  const inputs = [file('bad.svg', '<svg><text>broken</svg>'),
    file('good.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>OK</text></svg>'),
    file('empty.txt', ''), file('deck.pptx', await deck.write({ outputType: 'nodebuffer' }) as Buffer, true),
    { objectId: 'gone', name: 'gone.svg', hash: 'a'.repeat(64), revision: 1, editable: false }];
  const result = await inspectCompletion(directory, inputs);
  assert.deepEqual(result.map(e => e.status), ['failed', 'passed', 'failed', 'passed', 'unknown']);
  assert.equal(result[3]!.facts?.nativeEditableContent, true);
  assert.equal(result[3]!.facts?.slideCount, 1);
  assert.match(result[0]!.text!, /broken/); // malformed sources remain available as evidence, not a pass
  const cached = await inspectCompletion(directory, [{ ...inputs[1]!, objectId: 'copy', revision: 2 }]);
  assert.equal(cached[0]!.objectId, 'copy');
  assert.equal(cached[0]!.revision, 2);
  assert.equal(cached[0]!.status, 'passed');
  rmSync(join(directory, 'assets', inputs[1]!.hash));
  assert.equal((await inspectCompletion(directory, [inputs[1]!]))[0]!.status, 'unknown');
});

test('same failure stops; unknown, cancellation and exhausted activity never auto-repair', () => {
  const run: any = { id: 'r1', activeMs: 0, controlled: true, state: 'succeeded', createdAt: '2026-11-05T00:00:00Z', endedAt: '2026-11-05T00:00:00Z' };
  const m: any = { currentRequirementsRevision: 1, state: 'review' };
  const bad: any = [{ objectId: 'svg', revision: 1, hash: 'h', status: 'failed', code: 'invalid', detail: 'XML' }];
  const first = decideContinuation(m, run, [], bad);
  assert.equal(first.next, 'repair');
  assert.equal(first.conditions?.[0]?.id, 'structure:svg');
  m.continuation = JSON.parse(JSON.stringify(first)); // persisted/reloaded budget
  assert.equal(decideContinuation(m, { ...run, id: 'r2' }, [], bad).next, 'blocked');
  assert.equal(decideContinuation({ ...m, state: 'cancelled' }, run, ['ppt'], []).next, 'blocked');
  assert.equal(decideContinuation({ ...m, continuation: undefined }, run, [], [{ ...bad[0], status: 'unknown' }]).next, 'blocked');
  assert.equal(decideContinuation(m, { ...run, activeMs: 660000 }, ['ppt'], []).next, 'blocked');
  assert.equal(decideContinuation(m, { ...run, activeMs: 1000, endedAt: '2026-11-06T00:00:00Z' }, ['ppt'], []).spentMs, 1000);
  assert.equal(decideContinuation(m, run, [], []).next, 'done');
  const unavailable: any = { objectId: 'ppt', revision: 1, status: 'unknown', code: 'review_timeout', detail: 'timeout' };
  assert.equal(decideContinuation({ ...m, continuation: undefined }, run, ['svg'], [unavailable]).next, 'repair');
  assert.equal(decideContinuation({ ...m, continuation: undefined }, run, [], [unavailable]).next, 'blocked');
  assert.equal(decideContinuation({ ...m, continuation: undefined }, run, ['svg'], [{ ...unavailable, code: 'object_changed' }]).next, 'blocked');
  const extended: any = { ...m, continuation: { ...first, attempts: 2, spentMs: 600000,
    fingerprint: '', repeats: 0, grants: [{ at: '2026-11-05T00:00:00Z', attempts: 2, activeMs: 600000 }] } };
  assert.equal(decideContinuation(extended, run, ['ppt'], bad).next, 'repair');
  extended.continuation.attempts = 4;
  assert.equal(decideContinuation(extended, run, ['ppt'], bad).next, 'blocked');
});

test('V6 work without any verifiable evidence cannot be reported as checked completion', () => {
  const management: any = { currentRequirementsRevision: 1, responsibilityVersion: 6,
    state: 'review', requirements: [{ goal: '整理结论' }], artifacts: [] };
  const run: any = { id: 'no-evidence', controlled: true, state: 'succeeded', activeMs: 0,
    resultText: '已经完成' };
  const result = decideContinuation(management, run, [], []);
  assert.equal(result.next, 'blocked');
  assert.deepEqual(result.missing, ['缺少可核验成果证据']);
  assert.equal(result.attempts, 0);
});

test('Work Host keeps a prose-only run unverified in the persisted Bot result event', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-no-proof-host-'));
  const store = new DesktopStore(directory);
  const previousHost = process.env.AI_DESKTOP_WORK_HOST;
  const previousSession = process.env.AI_DESKTOP_SESSION_REF;
  process.env.AI_DESKTOP_WORK_HOST = '1';
  process.env.AI_DESKTOP_SESSION_REF = 'no-proof';
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousHost === undefined) delete process.env.AI_DESKTOP_WORK_HOST;
    else process.env.AI_DESKTOP_WORK_HOST = previousHost;
    if (previousSession === undefined) delete process.env.AI_DESKTOP_SESSION_REF;
    else process.env.AI_DESKTOP_SESSION_REF = previousSession;
  });
  store.createWorkspace('no-proof');
  const workspace = (store.open('no-proof') as any).binding.workspaceId;
  let sequence = 0;
  const command = (operation: string, taskId?: string, payload: any = {}) =>
    store.workManagement.command(workspace, { operation, taskId, payload,
      requestId: `no-proof-${sequence++}` }, true) as any;
  const task = command('intake', undefined, { text: '整理结论' }).task;
  const run = command('dispatch', task.id, { threadId: 'worker', provider: 'codex',
    controlled: true, dispatchKey: 'no-proof-run' }).run;
  command('ack', task.id, { runId: run.id, threadId: 'worker', turnId: 'turn' });
  const result = await store.workHost('no-proof', workspace, { operation: 'finish',
    taskId: task.id, requestId: `no-proof-${sequence++}`,
    payload: { runId: run.id, state: 'succeeded', resultText: '已经完成' } }) as any;
  assert.equal(result.management.state, 'attention');
  assert.equal(result.management.continuation.next, 'blocked');
  const events = store.workManagement.command(workspace,
    { operation: 'bot_events', payload: { operation: 'pending' } }, true) as any[];
  assert.equal(events.length, 1);
  assert.equal(events[0].verification.state, 'blocked');
  assert.deepEqual(events[0].verification.missing, ['缺少可核验成果证据']);
});

test('missing files dispatch the next round in the same work and cancellation wins', t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-work-'));
  const store = new DesktopStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createWorkspace('v6');
  const w = (store.open('v6') as any).binding.workspaceId;
  let sequence = 0;
  const cmd = (operation: string, taskId?: string, payload: any = {}) => store.workManagement.command(w,
    { operation, taskId, payload, requestId: 'v6-' + sequence++,
      ...(taskId ? { expectedRevision: (store.workManagement.command(w, { operation: 'detail', taskId }, true) as any).revision } : {}) }, true) as any;
  const task = cmd('intake', undefined, { text: '生成 SVG 和 PPT' }).task;
  const start = () => cmd('dispatch', task.id, { threadId: 'worker', provider: 'codex', controlled: true, dispatchKey: 'key-' + sequence }).run;
  const r = start();
  cmd('ack', task.id, { runId: r.id, threadId: 'worker', turnId: 't1' });
  assert.throws(() => store.workManagement.guardTool('worker', 'desktop_prepare_file', {
    workspaceId: 'mistyped-desktop', credential: 'not-a-real-credential', intent: 'edit',
  }), (error: any) => error.code === 'RUN_WORKSPACE_MISMATCH' && error.message.includes(w));
  // Correcting the workspace does not authenticate or widen the credential.
  assert.throws(() => store.auth(w, 'not-a-real-credential', null),
    (error: any) => error.code === 'PERMISSION_DENIED');
  const repaired = cmd('finish', task.id, { runId: r.id, state: 'succeeded', resultText: '完成', completionEvidence: [] });
  assert.equal(repaired.management.state, 'queued');
  assert.equal(repaired.management.continuation.attempts, 1);
  const context = cmd('prepare', task.id).context;
  assert.match(context.continuationInstructions, /不重复通知/);
  assert.deepEqual(context.completionCheck.missing, ['svg', 'ppt']);
  const next = start();
  assert.notEqual(next.id, r.id);
  assert.equal(cmd('list').tasks.length, 1);
  cmd('control', task.id, { action: 'cancel' });
  const cancelled = cmd('finish', task.id, { runId: next.id, state: 'succeeded', resultText: '旧结果', completionEvidence: [] });
  assert.equal(cancelled.management.state, 'cancelled');
  const ledger = store.workManagement.repairBudget.read(w, task.id, 1);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0]!.settled, true);
  assert.ok(ledger.entries[0]!.spentMs < ledger.entries[0]!.allowanceMs);
});

test('exit intent survives interruption, resumes the same work and respects cancellation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-exit-'));
  const store = new DesktopStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createWorkspace('exit');
  const w = (store.open('exit') as any).binding.workspaceId;
  let sequence = 0;
  const cmd = (operation: string, taskId?: string, payload: any = {}) => store.workManagement.command(w,
    { operation, taskId, payload, requestId: 'exit-' + sequence++,
      ...(taskId ? { expectedRevision: (store.workManagement.command(w, { operation: 'detail', taskId }, true) as any).revision } : {}) }, true) as any;
  for (const cancel of [false, true]) {
    const task = cmd('intake', undefined, { text: '创建文件 proof.txt' }).task;
    const run = cmd('dispatch', task.id, { threadId: `exit-${cancel}`, provider: 'codex', controlled: true, dispatchKey: 'key-' + sequence }).run;
    cmd('ack', task.id, { runId: run.id, threadId: `exit-${cancel}`, turnId: 'turn' });
    cmd('suspend_for_exit', task.id, { runId: run.id });
    if (cancel) cmd('control', task.id, { action: 'cancel' });
    const stopped = cmd('finish', task.id, { runId: run.id, state: 'interrupted' });
    assert.equal(stopped.management.runs.at(-1).state, cancel ? 'interrupted' : 'unknown');
    const restored = cmd('reconcile', task.id, { runId: run.id, state: 'interrupted', restartSafe: true });
    assert.equal(restored.management.state, cancel ? 'cancelled' : 'queued');
    assert.equal(restored.id, task.id);
    if (!cancel) {
      assert.equal(restored.management.continuation.next, 'repair');
      assert.ok(restored.management.continuation.reservation.allowanceMs > 0);
      assert.equal(restored.management.continuation.reservation.key, `restart:${run.id}`);
    }
    assert.equal(cmd('reconcile', task.id, { runId: run.id, state: 'interrupted', restartSafe: true }).management.state, restored.management.state);
  }
});

test('recovery restores only the original live identity and persists submission uncertainty', t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-reconnect-'));
  const store = new DesktopStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createWorkspace('recover');
  const w = (store.open('recover') as any).binding.workspaceId;
  let n = 0;
  const cmd = (operation: string, taskId?: string, payload: any = {}) => store.workManagement.command(w,
    { operation, taskId, payload, requestId: 'recover-' + n++ }, true) as any;
  const task = cmd('intake', undefined, { text: '生成 test.txt' }).task;
  const r = cmd('dispatch', task.id, { threadId: 'worker', provider: 'codex', controlled: true, dispatchKey: 'start' }).run;
  cmd('ack', task.id, { runId: r.id, threadId: 'worker', submitting: true });
  assert.equal(cmd('detail', task.id).management.runs[0].submission.state, 'possibly_sent');
  cmd('ack', task.id, { runId: r.id, threadId: 'worker', turnId: 'turn' });
  const revision = cmd('detail', task.id).revision;
  const segment = '2c755530-3094-4f71-a2fe-423b39ac6b33';
  cmd('execution_activity', task.id, { runId: r.id, segment, elapsedMs: 1200 });
  cmd('execution_activity', task.id, { runId: r.id, segment, elapsedMs: 800 });
  cmd('execution_activity', task.id, { runId: r.id, segment, elapsedMs: 1200 });
  assert.equal(cmd('detail', task.id).management.runs[0].activeMs, 1200);
  assert.equal(cmd('detail', task.id).revision, revision, 'accounting must not invalidate UI revisions');
  assert.throws(() => store.workManagement.command(w, { operation: 'execution_activity', taskId: task.id,
    requestId: 'untrusted-clock', payload: { runId: r.id, segment, elapsedMs: 90000 } }, false));
  cmd('recover');
  assert.equal(cmd('detail', task.id).management.runs[0].state, 'unknown');
  const allowance = cmd('recovery_budget', task.id, { action: 'reserve', runId: r.id, key: 'observation' });
  assert.equal(allowance.allowanceMs, 90000);
  assert.throws(() => store.workManagement.command(w, { operation: 'recovery_budget', taskId: task.id,
    requestId: 'untrusted', payload: { action: 'reserve', runId: r.id, key: 'not-host' } }, false));
  cmd('recovery_budget', task.id, { action: 'settle', runId: r.id, key: 'observation', elapsedMs: 800 });
  assert.equal(store.workManagement.repairBudget.read(w, task.id, 1).entries[0]!.spentMs, 800);
  assert.throws(() => cmd('ack', task.id, { runId: r.id, threadId: 'other', turnId: 'turn', reconnect: true }));
  const restored = cmd('ack', task.id, { runId: r.id, threadId: 'worker', turnId: 'turn', reconnect: true });
  assert.equal(restored.management.state, 'running');
  assert.equal(restored.management.runs.length, 1);
  assert.equal(restored.management.runs[0].submission.turnId, 'turn');
  cmd('execution_activity', task.id, { runId: r.id, segment: 'cddce2d8-901c-4208-8be6-752f50a49c72', elapsedMs: 300 });
  assert.equal(cmd('detail', task.id).management.runs[0].activeMs, 1500);
  assert.equal(restored.management.runs[0].activityUnobserved, true);
});
