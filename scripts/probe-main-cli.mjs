// Opt-in live protocol probe. Uses an isolated cwd; never opens user materials.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveCodexRuntime } from '../apps/electron/cli/codex-runtime.mjs';

const cwd = resolve('output/main-cli-probe');
await mkdir(cwd, { recursive: true });
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
  const params = { cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true };
  const a = await request('thread/start', params);
  const b = await request('thread/start', params);
  if (!a.thread?.id || a.thread.id === b.thread?.id) throw Error('Independent thread identity missing');
  result.status = 'passed';
  result.independentThreads = true;
} catch (error) { result.status = 'failed'; result.error = error.message; process.exitCode = 1; }
finally {
  child.stdin.end(); child.kill();
  for (const p of pending.values()) clearTimeout(p.timer);
  await writeFile(resolve(cwd, 'result.json'), JSON.stringify({ ...result, events }, null, 2));
  console.log(JSON.stringify(result));
}
