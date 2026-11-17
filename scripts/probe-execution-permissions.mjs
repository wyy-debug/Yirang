// Opt-in live protocol probe. Uses an isolated cwd; never opens user materials.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveCodexRuntime } from '../apps/electron/cli/codex-runtime.mjs';

const cwd = resolve('output/permission-live-' + Date.now());
await mkdir(cwd, { recursive: true });
const { executionPermissions, executionTurnPermissions } = await import('../apps/electron/conversation/execution-permissions.mjs');
const { path } = await resolveCodexRuntime();
const child = spawn(path, ['app-server', '--listen', 'stdio://'], {
  cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let id = 0;
const pending = new Map(), events = [];
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(Error(`${method} timed out`)); }, 25000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
}
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Error(message.error.message)); else waiter.resolve(message.result);
  } else if (message.method) events.push({ method: message.method });
});
child.stderr.resume();
child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
const result = { scope: 'live CLI initialize and independent threads; no model execution or Yirang end-to-end proof' };
try {
  await request('initialize', { clientInfo: { name: 'yirang_acceptance', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const params = { cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false };
  const baseline = await request('config/read', { cwd, includeLayers: false });
  result.baseline = { sandbox: baseline.config?.sandbox_mode, approval: baseline.config?.approval_policy };
  const a = await request('thread/start', params);
  await request('turn/start', { threadId: a.thread.id, input: [{ type: 'text', text: 'Reply OK only. Do not use tools.' }] });
  const initialDeadline = Date.now() + 90000;
  while (Date.now() < initialDeadline && !events.some(e => e.method === 'turn/completed')) await new Promise(r => setTimeout(r, 250));
  events.length = 0;
  const { config } = await request('config/read', { cwd, includeLayers: false });
  const resumed = await request('thread/resume', { threadId: a.thread.id, cwd, ...executionPermissions(baseline.config, { approvalPolicy: 'on-request', approvalsReviewer: 'user' }), excludeTurns: true });
  result.effectiveSandbox = resumed.sandbox;
  result.effectiveApprovalPolicy = resumed.approvalPolicy;
  await request('turn/start', { threadId: a.thread.id, ...executionTurnPermissions(baseline.config, { approvalPolicy: 'on-request' }, cwd), input: [{ type: 'text', text: 'Write a file named permission-proof.txt in the current working directory containing exactly YIRANG_WRITE_OK. Use a shell or file tool, not just a response. Do not touch other files. Then finish.' }] });
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && !events.some(e => e.method === 'turn/completed')) await new Promise(r => setTimeout(r, 250));
  const proof = await readFile(resolve(cwd, 'permission-proof.txt'), 'utf8');
  if (proof.trim() !== 'YIRANG_WRITE_OK') throw Error('File content mismatch');
  result.status = 'passed'; result.scope = 'real CLI read-only thread resumed as execution; model wrote verified local file';} catch (error) { result.status = 'failed'; result.error = error.message; process.exitCode = 1; }
finally {
  child.stdin.end(); child.kill();
  for (const p of pending.values()) clearTimeout(p.timer);
  await writeFile(resolve(cwd, 'result.json'), JSON.stringify({ ...result, events }, null, 2));
  console.log(JSON.stringify(result));
}






