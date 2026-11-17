import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopStore } from '../packages/local-runtime/store.ts';
import { createWorkManager } from '../apps/electron/work/work-manager.mjs';

test('exit during pending dispatch never starts a CLI and preserves retryable work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-exit-dispatch-'));
  const store = new DesktopStore(directory), workspaceId = store.createWorkspace(null, 'exit');
  const task = store.workManagement.command(workspaceId, { operation: 'intake',
    requestId: 'intake', payload: { text: '创建 proof.txt' } }, true).task;
  let release, dispatchEntered, finishSeen;
  const entered = new Promise(resolve => { dispatchEntered = resolve; });
  const finished = new Promise(resolve => { finishSeen = resolve; });
  const manager = createWorkManager({ ready: () => true, controlled: () => true, emit() {},
    run: async () => assert.fail('exit must prevent an unsent CLI request'),
    call: async ({ workspaceId: w, command }) => {
      if (command.payload?.operation === 'host_workspaces') return { workspaces: [{ id: workspaceId }] };
      const result = store.workManagement.command(w, command, true);
      if (command.operation === 'dispatch') {
        await new Promise(resolve => { release = resolve; dispatchEntered(); });
      }
      if (command.operation === 'finish') finishSeen(result);
      return result;
    },
  });
  t.after(async () => { manager.dispose(); await store.close(); rmSync(directory, { recursive: true, force: true }); });
  await manager.command({ workspaceId, command: { operation: 'configure', requestId: 'configure', payload: { maxConcurrent: 2 } } });
  await entered;
  await manager.suspendForExit();
  release();
  const result = await finished;
  assert.equal(result.id, task.id);
  assert.equal(result.management.state, 'queued');
  assert.equal(result.management.runs[0].submission.state, 'not_received');
});

test('late old-turn events and duplicate current completion cannot finish another run', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v6-finish-'));
  const store = new DesktopStore(directory), workspaceId = store.createWorkspace(null, 'race');
  const command = (operation, payload = {}, taskId) => store.workManagement.command(workspaceId,
    { operation, payload, taskId, requestId: crypto.randomUUID() }, true);
  const task = command('intake', { text: '说明检查结果' }).task;
  let manager, bound, runId, finished = 0;
  const started = new Promise(resolve => { bound = resolve; });
  manager = createWorkManager({ ready: () => true, controlled: () => true, emit() {},
    interrupt: async () => {}, readRun: async () => ({ id: 'current', status: 'completed', items: [
      { type: 'commandExecution', id: 'command', command: 'Start-Sleep -Seconds 45', status: 'completed', exitCode: 0, durationMs: 45010 },
      { type: 'agentMessage', text: '检查完成' },
    ] }),
    call: async ({ workspaceId: w, command: c }) => {
      if (c.payload?.operation === 'host_workspaces') return { workspaces: [{ id: workspaceId }] };
      if (c.operation === 'finish') {
        assert.equal(c.payload.executionEvidence.commands[0].durationMs, 45010,
          'a nonempty completion event must not hide canonical tool receipts');
        finished++; await new Promise(resolve => setTimeout(resolve, 10));
      }
      return store.workManagement.command(w, c, true);
    },
    run: async (task, run) => { runId = run.id; await manager.bindThread(task.id, 'thread'); bound(); },
  });
  t.after(async () => { manager.dispose(); await store.close(); rmSync(directory, { recursive: true, force: true }); });
  await manager.command({ workspaceId, command: { operation: 'configure', requestId: crypto.randomUUID(), payload: { maxConcurrent: 2 } } });
  await started;
  const turn = { id: 'current', status: 'completed', items: [{ type: 'agentMessage', text: '检查完成' }] };
  await manager.finished('thread', turn); // notification may arrive before turn/start response
  assert.equal(finished, 0);
  await manager.ack(task.id, 'thread', 'current');
  assert.equal(finished, 1);
  assert.equal(command('detail', {}, task.id).management.runs.find(r => r.id === runId).state, 'succeeded');
  await Promise.all([manager.finished('thread', turn), manager.finished('thread', { ...turn, id: 'old' })]);
  assert.equal(finished, 1);
});
