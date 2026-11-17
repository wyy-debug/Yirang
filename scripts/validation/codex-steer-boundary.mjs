import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [binary, output] = process.argv.slice(2);
if (!binary || !output) throw Error('usage: node codex-steer-boundary.mjs <codex.exe> <report.json>');
const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stderr.resume();
const pending = new Map();
const terminals = new Map();
const waiting = new Map();
let sequence = 0;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(Error(`RPC timeout: ${method}`));
  }, 45000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined) {
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.error) job.reject(Object.assign(Error(message.error.message), {
      code: message.error.code, data: message.error.data,
    }));
    else job.resolve(message.result);
    return;
  }
  if (message.method === 'turn/completed') {
    const turn = message.params?.turn;
    if (!turn?.id) return;
    terminals.set(turn.id, turn);
    waiting.get(turn.id)?.(turn);
    waiting.delete(turn.id);
  }
});
const terminal = id => terminals.get(id) || new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('turn completion timeout')), 45000);
  waiting.set(id, turn => { clearTimeout(timer); resolve(turn); });
});
const report = { startedAt: new Date().toISOString(), binary, checks: [] };
try {
  const initialized = await rpc('initialize', {
    clientInfo: { name: 'yirang_steer_boundary', title: 'Yirang steer boundary', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  report.userAgent = initialized.userAgent;
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const created = await rpc('thread/start', {
    model: 'gpt-6-luna', cwd: process.cwd(), ephemeral: true,
    sandbox: 'read-only', approvalPolicy: 'never',
    config: { 'features.apps': false, 'features.multi_agent': false,
      'features.shell_tool': false, 'features.plugins': false, web_search: 'disabled' },
  });
  const threadId = created.thread.id;
  const started = await rpc('turn/start', {
    threadId, input: [{ type: 'text', text: '只回答 OK。' }],
    sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never',
  });
  const turnId = started.turn.id;
  const done = await terminal(turnId);
  assert.equal(done.status, 'completed');
  let steerError;
  try {
    await rpc('turn/steer', {
      threadId, expectedTurnId: turnId,
      input: [{ type: 'text', text: '这是回合结束后的边界探针。' }],
    });
  } catch (error) {
    steerError = { code: error.code, message: error.message, data: error.data };
  }
  assert.ok(steerError, 'steering a completed turn must fail');
  report.checks.push({ name: 'completed turn steer rejected', passed: true,
    threadId, turnId, steerError });
} catch (error) {
  report.checks.push({ name: 'completed turn steer rejected', passed: false,
    error: error.stack });
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  child.kill();
}
console.log(JSON.stringify(report.checks[0]));
