import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';

const [binaryArg, directoryArg] = process.argv.slice(2);
if (!binaryArg || !directoryArg)
  throw Error('usage: node codex-memory-lifecycle.mjs <codex.exe> <output-directory> --mock [--elevated]');
const binary = resolve(binaryArg);
const directory = resolve(directoryArg);
const home = join(directory, 'codex-home');
const workspace = join(directory, 'workspace');
const marker = '云杉灯塔';
const useMock = process.argv.includes('--mock');
if (!useMock) throw Error('This isolated fixture requires --mock; live API behavior needs a separate probe.');
const sandboxLevel = process.argv.includes('--elevated') ? 'elevated' : 'unelevated';
await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })]);
if (useMock) {
  await mkdir(join(home, 'memories_v2'), { recursive: true });
  await Promise.all([
    writeFile(join(home, 'memories_v2', 'memory_summary.md'),
      'v1\n## User Profile\n隔离测试用户。\n## User preferences\n暂无。\n## General Tips\n暂无。\n## What\'s in Memory\n暂无。\n'),
    writeFile(join(home, 'memories_v2', 'MEMORY.md'), '# 测试记忆\n'),
  ]);
}
const report = { binary, directory, home, mockModel: useMock,
  sandboxLevel,
  startedAt: new Date().toISOString(), checks: [], mockRequests: [] };
const persist = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
const redact = value => String(value).replace(/sk-[A-Za-z0-9*]+/g, '[REDACTED_API_KEY]');
let mockServer, mockUrl, mockSequence = 0, phaseOneReplies = 0;
if (useMock) {
  mockServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const serialized = JSON.stringify(body);
    const inputText = JSON.stringify(body.input || []);
    const phaseOne = JSON.stringify(body.text || {}).includes('rollout_summary');
    const phaseTwo = serialized.includes('Memory Writing Agent') ||
      serialized.includes('phase2_workspace_diff.md');
    const toolReply = Array.isArray(body.input) && body.input.some(item =>
      item.type === 'custom_tool_call_output' || item.type === 'function_call_output');
    const kind = phaseOne ? 'phase1' : phaseTwo ? 'phase2' : toolReply ? 'tool-reply' : 'user-turn';
    report.mockRequests.push({ kind, model: body.model,
      format: body.text?.format?.type || null, bytes: Buffer.byteLength(serialized),
      containsMarker: serialized.includes(marker),
      hasStageOneSchema: serialized.includes('rollout_summary'),
      tools: Array.isArray(body.tools) ? body.tools.map(tool => tool.name || tool.type).slice(0, 20) : [],
      inputTypes: Array.isArray(body.input) ? body.input.slice(-3).map(item => item.type) : [],
      inputTail: Array.isArray(body.input) ? body.input.slice(-2)
        .map(item => JSON.stringify(item).slice(-350)) : [],
      toolOutput: toolReply ? (body.input || [])
        .filter(item => String(item.type).endsWith('_output'))
        .map(item => String(item.output || '').slice(0, 400)) : undefined });
    const id = `mock-response-${++mockSequence}`;
    let item;
    if (phaseOne) {
      phaseOneReplies++;
      item = { type: 'message', role: 'assistant', id: `message-${mockSequence}`,
        content: [{ type: 'output_text', text: JSON.stringify({
          rollout_summary: `隔离测试工作区的稳定名称为${marker}。`,
          rollout_slug: 'isolated-memory-probe',
        }) }] };
    } else if (phaseTwo && !toolReply) {
      const summaryPath = join(home, 'memories_v2', 'memory_summary.md');
      const memoryPath = join(home, 'memories_v2', 'MEMORY.md');
      const patchSummaryPath = summaryPath.replaceAll('\\', '/');
      const patchMemoryPath = memoryPath.replaceAll('\\', '/');
      const existing = await readFile(summaryPath, 'utf8').catch(() => null);
      const content = phaseOneReplies ? `v1\n${marker}是隔离测试工作区的名称。\n` : 'v1\n';
      const patch = existing === null
        ? `*** Begin Patch\n*** Add File: ${patchSummaryPath}\n+${content.trimEnd().split('\n').join('\n+')}\n*** Add File: ${patchMemoryPath}\n+# 测试记忆\n*** End Patch`
        : `*** Begin Patch\n*** Update File: ${patchSummaryPath}\n@@\n-v1\n+${content.trimEnd().split('\n').join('\n+')}\n*** End Patch`;
      item = { type: 'custom_tool_call', name: 'apply_patch',
        call_id: `patch-${mockSequence}`, input: patch };
    } else {
      item = { type: 'message', role: 'assistant', id: `message-${mockSequence}`,
        content: [{ type: 'output_text', text: 'OK' }] };
    }
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id,
        usage: { input_tokens: 0, input_tokens_details: null,
          output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise(resolvePromise => mockServer.listen(0, '127.0.0.1', resolvePromise));
  mockUrl = `http://127.0.0.1:${mockServer.address().port}/v1`;
}
const child = spawn(binary, [
  'app-server', '--stdio',
  '-c', 'model_provider="memory_probe"',
  '-c', `model_providers.memory_probe={name="Memory probe",base_url="${mockUrl || 'https://api.openai.com/v1'}",env_key="${useMock ? 'YIRANG_MEMORY_PROBE_KEY' : 'OPENAI_API_KEY'}",wire_api="responses"}`,
  '-c', 'features.memories=true',
  '-c', `windows.sandbox="${sandboxLevel}"`,
  '-c', 'memories.version="v2"',
  '-c', 'memories.min_rollout_idle_hours=0',
  '-c', 'memories.max_rollouts_per_startup=2',
  '-c', 'memories.extract_model="gpt-6-luna"',
  '-c', 'memories.consolidation_model="gpt-6-luna"',
  '-c', 'web_search="disabled"',
], {
  cwd: workspace,
  env: { ...process.env, CODEX_HOME: home,
    ...(useMock ? { YIRANG_MEMORY_PROBE_KEY: 'local-test-key' } : {}) },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
const completed = new Map();
const waiters = new Map();
const stderr = [];
let serial = 0;
child.on('exit', code => {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(Error(`Codex exited ${code}: ${redact(stderr.join('').slice(-800))}`));
  }
  pending.clear();
});
child.stderr.on('data', chunk => {
  stderr.push(String(chunk));
  if (stderr.length > 200) stderr.shift();
});
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined) {
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.error) job.reject(Error(message.error.message));
    else job.resolve(message.result);
  }
  if (message.method === 'turn/completed') {
    const turn = message.params?.turn;
    if (!turn?.id) return;
    completed.set(turn.id, turn);
    waiters.get(turn.id)?.(turn);
    waiters.delete(turn.id);
  }
});
const rpc = (method, params) => new Promise((resolvePromise, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(Error(`RPC timeout: ${method}`));
  }, 120000);
  pending.set(id, { resolve: resolvePromise, reject, timer });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const waitForTurn = id => completed.get(id) || new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => {
    waiters.delete(id);
    reject(Error(`Turn completion timeout: ${id}`));
  }, 120000);
  waiters.set(id, turn => { clearTimeout(timer); resolvePromise(turn); });
});
async function runTurn(text) {
  const started = await rpc('thread/start', {
    model: 'gpt-6-luna', cwd: workspace, sandbox: 'read-only',
    approvalPolicy: 'never', ephemeral: false,
  });
  const threadId = started.thread.id;
  const turn = await rpc('turn/start', {
    threadId, input: [{ type: 'text', text }],
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'never',
  });
  const result = await waitForTurn(turn.turn.id);
  assert.equal(result.status, 'completed');
  return { threadId, turnId: result.id, status: result.status };
}
async function memorySummary() {
  return readFile(join(home, 'memories_v2', 'memory_summary.md'), 'utf8').catch(() => '');
}
try {
  const initialized = await rpc('initialize', {
    clientInfo: { name: 'yirang_memory_lifecycle_probe', version: '1' },
    capabilities: { experimentalApi: true },
  });
  report.userAgent = initialized.userAgent;
  child.stdin.write('{"method":"initialized"}\n');
  const config = await rpc('config/read', { includeLayers: false, cwd: workspace });
  report.memoryConfig = config.config?.memories;
  await persist();
  const first = await runTurn(`隔离测试的稳定约定：这个测试工作区名叫${marker}。以后提到该工作区时使用此名称。只回复“已记下”。`);
  report.checks.push({ name: 'source turn completed', passed: true, ...first });
  await persist();
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  try {
    const source = db.prepare('SELECT source, memory_mode FROM threads WHERE id = ?').get(first.threadId);
    assert.equal(source?.source, 'vscode');
    assert.equal(source?.memory_mode, 'enabled');
    report.checks.push({ name: 'source is eligible for memory extraction', passed: true, source });
  } finally { db.close(); }
  await persist();
  if (useMock) {
    const initialPhaseTwoDeadline = Date.now() + 150000;
    let initialPhaseTwo;
    while (Date.now() < initialPhaseTwoDeadline) {
      const phaseTwoDb = new DatabaseSync(join(home, 'memories_v2_1.sqlite'), { readOnly: true });
      try {
        initialPhaseTwo = phaseTwoDb.prepare(
          "SELECT status,last_error FROM jobs WHERE kind = 'memory_consolidate_global'",
        ).get();
      } finally { phaseTwoDb.close(); }
      if (initialPhaseTwo && ['done', 'error'].includes(initialPhaseTwo.status)) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
    }
    assert.equal(initialPhaseTwo?.status, 'done',
      `initial phase 2 did not settle successfully: ${JSON.stringify(initialPhaseTwo)}`);
    report.checks.push({ name: 'initial empty phase 2 settled', passed: true });
    await persist();
    // Codex clamps min_rollout_idle_hours to at least one hour. Age only this
    // isolated fixture row so the startup extractor can be exercised now.
    const fixture = new DatabaseSync(join(home, 'state_5.sqlite'));
    const agedAt = Date.now() - 2 * 60 * 60 * 1000;
    try {
      fixture.prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?')
        .run(agedAt, first.threadId);
    } finally { fixture.close(); }
    report.checks.push({ name: 'isolated source aged past native idle gate',
      passed: true, agedAt });
    await persist();
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1200));
  const second = await runTurn('继续这个隔离测试；只回答“继续”。');
  report.checks.push({ name: 'next root turn triggered memory startup', passed: true, ...second });
  await persist();
  if (useMock) {
    const stageOneDeadline = Date.now() + 30000;
    let extracted = null;
    while (Date.now() < stageOneDeadline && !extracted) {
      const memoryDb = new DatabaseSync(join(home, 'memories_v2_1.sqlite'), { readOnly: true });
      try {
        extracted = memoryDb.prepare('SELECT rollout_summary FROM stage1_outputs WHERE thread_id = ?')
          .get(first.threadId)?.rollout_summary;
      } finally { memoryDb.close(); }
      if (!extracted) await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    assert.match(extracted || '', new RegExp(marker));
    report.checks.push({ name: 'Codex phase 1 extracted source into memory DB', passed: true });
    await persist();
    const phaseTwoFixture = new DatabaseSync(join(home, 'memories_v2_1.sqlite'));
    const cooldownAgedAt = Math.floor(Date.now() / 1000) - 7 * 60 * 60;
    try {
      const updated = phaseTwoFixture.prepare(
        "UPDATE jobs SET finished_at = ? WHERE kind = 'memory_consolidate_global' AND status = 'pending'",
      ).run(cooldownAgedAt);
      assert.equal(updated.changes, 1);
    } finally { phaseTwoFixture.close(); }
    report.checks.push({ name: 'isolated phase 2 aged past native cooldown',
      passed: true, cooldownAgedAt });
    await persist();
    const thirdTrigger = await runTurn('再继续这个隔离测试；只回答“继续”。');
    report.checks.push({ name: 'new root turn triggered phase 2 retry', passed: true, ...thirdTrigger });
    await persist();
  }
  const deadline = Date.now() + (useMock ? 60000 : 180000);
  let summary = '';
  while (Date.now() < deadline) {
    summary = await memorySummary();
    if (summary.includes(marker)) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2000));
  }
  report.memory = { directory: join(home, 'memories_v2'),
    summaryExists: !!summary, markerFound: summary.includes(marker), summaryBytes: Buffer.byteLength(summary) };
  assert.ok(report.memory.markerFound,
    `Automatic memory did not include the test marker; stderr: ${redact(stderr.join('').slice(-1500))}`);
  const third = await rpc('thread/start', {
    model: 'gpt-6-luna', cwd: workspace, sandbox: 'read-only',
    approvalPolicy: 'never', ephemeral: true,
  });
  const read = await rpc('thread/memory/read', { threadId: third.thread.id });
  assert.match(read.summary || '', new RegExp(marker));
  report.checks.push({ name: 'generated memory is readable by a new thread', passed: true,
    threadId: third.thread.id });
  const freshTurn = await rpc('turn/start', {
    threadId: third.thread.id,
    input: [{ type: 'text', text: '请只回答“收到”。' }],
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'never',
  });
  assert.equal((await waitForTurn(freshTurn.turn.id)).status, 'completed');
  assert.ok(report.mockRequests.some(request =>
    request.kind === 'user-turn' && request.containsMarker &&
    request.inputTail.some(text => text.includes('收到'))),
  'native context should include generated memory on a fresh turn');
  report.checks.push({ name: 'generated memory enters a fresh model turn', passed: true });
} catch (error) {
  report.checks.push({ name: 'native memory lifecycle', passed: false, error: redact(error.stack) });
  report.stderrTail = redact(stderr.join('').slice(-4000));
  process.exitCode = 1;
} finally {
  child.kill();
  mockServer?.close();
  report.finishedAt = new Date().toISOString();
  await persist();
}
