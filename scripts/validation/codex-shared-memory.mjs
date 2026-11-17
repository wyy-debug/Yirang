import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [binaryArg, outputArg] = process.argv.slice(2);
if (!binaryArg || !outputArg)
  throw Error('usage: node codex-shared-memory.mjs <codex.exe> <output-directory>');
const binary = resolve(binaryArg);
const directory = resolve(outputArg);
const home = join(directory, 'codex-home');
const marker = 'SHARED_MEMORY_DIRECTORY_PROBE';
const v2Marker = 'SHARED_MEMORY_V2_DIRECTORY_PROBE';
const report = { binary, directory, startedAt: new Date().toISOString(), checks: [] };
await Promise.all([
  mkdir(join(home, 'memories'), { recursive: true }),
  mkdir(join(directory, 'workspace-a'), { recursive: true }),
  mkdir(join(directory, 'workspace-b'), { recursive: true }),
]);
await writeFile(join(home, 'memories', 'memory_summary.md'), `v1\n${marker}\n`);

async function withServer(run, version = 'v1') {
  const child = spawn(binary, [
    'app-server', '--stdio', '-c', 'features.memories=true',
    '-c', `memories.version="${version}"`,
  ], { cwd: directory, env: { ...process.env, CODEX_HOME: home },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0;
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(Error(message.error.message));
    else request.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`RPC timeout: ${method}; ${stderr.join('').slice(-1000)}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    const initialized = await rpc('initialize', {
      clientInfo: { name: 'yirang_shared_memory_probe', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized"}\n');
    report.userAgent = initialized.userAgent;
    return await run(rpc);
  } finally {
    child.kill();
  }
}

try {
  await withServer(async rpc => {
    for (const name of ['workspace-a', 'workspace-b']) {
      const cwd = join(directory, name);
      const started = await rpc('thread/start', {
        cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      });
      const read = await rpc('thread/memory/read', { threadId: started.thread.id });
      assert.match(read.summary || '', new RegExp(marker));
      report.checks.push({ name: `${name} reads shared memory`, passed: true,
        threadId: started.thread.id, cwd });
    }
  });
  await withServer(async rpc => {
    const started = await rpc('thread/start', {
      cwd: join(directory, 'workspace-b'), ephemeral: true,
      sandbox: 'read-only', approvalPolicy: 'never',
    });
    const read = await rpc('thread/memory/read', { threadId: started.thread.id });
    assert.match(read.summary || '', new RegExp(marker));
    report.checks.push({ name: 'restart keeps shared memory', passed: true,
      threadId: started.thread.id });
  });
  await mkdir(join(home, 'memories_v2'), { recursive: true });
  await writeFile(join(home, 'memories_v2', 'memory_summary.md'), `v2\n${v2Marker}\n`);
  await withServer(async rpc => {
    for (const name of ['workspace-a', 'workspace-b']) {
      const started = await rpc('thread/start', {
        cwd: join(directory, name), ephemeral: true,
        sandbox: 'read-only', approvalPolicy: 'never',
      });
      const read = await rpc('thread/memory/read', { threadId: started.thread.id });
      assert.match(read.summary || '', new RegExp(v2Marker));
      assert.doesNotMatch(read.summary, new RegExp(`${marker}\\n`));
      report.checks.push({ name: `${name} reads shared v2 memory`, passed: true,
        threadId: started.thread.id });
    }
  }, 'v2');
  await withServer(async rpc => {
    const started = await rpc('thread/start', {
      cwd: join(directory, 'workspace-b'), ephemeral: true,
      sandbox: 'read-only', approvalPolicy: 'never',
    });
    const read = await rpc('thread/memory/read', { threadId: started.thread.id });
    assert.match(read.summary || '', new RegExp(v2Marker));
    report.checks.push({ name: 'restart keeps shared v2 memory', passed: true,
      threadId: started.thread.id });
  }, 'v2');
} catch (error) {
  report.checks.push({ name: 'shared memory probe', passed: false, error: error.stack });
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
