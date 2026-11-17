import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import electron from 'electron';
import { resolveCodexRuntime } from '../../apps/electron/cli/codex-runtime.mjs';

const args = process.argv.slice(2);
const directory = resolve(args[0] || `test-results/electron-direct-chat-${Date.now()}`);
const binaryIndex = args.indexOf('--electron-binary');
const electronBinary = binaryIndex < 0 ? electron : resolve(args[binaryIndex + 1]);
const profile = join(directory, 'profile');
const home = join(directory, 'yirang-codex-home');
const output = join(directory, 'outputs');
const reportPath = join(directory, 'report.json');
await Promise.all([profile, home, output, join(directory, 'data')]
  .map((path) => mkdir(path, { recursive: true })));
await writeFile(join(output, 'proof.txt'), '初始内容\n');

let requests = 0;
const mock = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
    response.writeHead(404).end();
    return;
  }
  for await (const _chunk of request) { /* Drain the request. */ }
  const id = `direct-chat-${++requests}`;
  const item = { type: 'message', role: 'assistant', id: `message-${requests}`,
    content: [{ type: 'output_text', text: '执行结果已记录。' }] };
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id,
      usage: { input_tokens: 0, input_tokens_details: null,
        output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map((event) =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
});
await new Promise((done) => mock.listen(0, '127.0.0.1', done));
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
await writeFile(join(home, 'config.toml'),
  `model_provider = "direct_e2e"\nmodel = "gpt-6-luna"\n` +
  `[model_providers.direct_e2e]\nname = "Direct chat E2E"\nbase_url = "${mockUrl}"\n` +
  `env_key = "YIRANG_DIRECT_CHAT_E2E_KEY"\nwire_api = "responses"\n` +
  `[windows]\nsandbox = "elevated"\n`);
const binary = await resolveCodexRuntime();
await writeFile(join(profile, 'desktop-preferences.json'), JSON.stringify({
  codexPath: binary.path, model: 'gpt-6-luna', effort: 'low', usageMode: 'daily',
}));
const env = {
  ...process.env,
  AI_DESKTOP_DEV: '1',
  AI_DESKTOP_PROFILE_DIR: profile,
  AI_DESKTOP_CODEX_HOME: home,
  AI_DESKTOP_DATA_DIR: join(directory, 'data'),
  AI_DESKTOP_OUTPUT_DIR: output,
  AI_DESKTOP_NODE_BIN: process.execPath,
  YIRANG_DIRECT_CHAT_E2E_OUTPUT: reportPath,
  YIRANG_DIRECT_CHAT_E2E_KEY: 'local-test-key',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.OPENAI_API_KEY;
const child = spawn(electronBinary, electronBinary === electron ? ['.'] : [], {
  cwd: resolve(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
  logs.push(String(chunk).replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g, '[REDACTED]'));
  if (logs.length > 50) logs.shift();
});
let timeout;
try {
  const exited = new Promise((done, reject) => {
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', reject);
  });
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(Error('Electron direct chat timeout')), 60000);
  });
  const status = await Promise.race([exited, timer]);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(status.code, 0, report.error || logs.join('').slice(-2500));
  assert.equal(report.passed, true, report.error);
  assert.equal(report.turnIds.length, 2);
  assert.equal(report.codexHome.toLowerCase(), home.toLowerCase());
  const sessions = await readdir(join(home, 'sessions'), { recursive: true });
  const file = sessions.find((name) => name.endsWith(`${report.threadId}.jsonl`));
  assert.ok(file, 'direct Codex session was not recorded');
  const records = (await readFile(join(home, 'sessions', file), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line));
  const contexts = records.filter((item) => item.type === 'turn_context');
  assert.equal(contexts.length, 2);
  for (const { payload } of contexts) {
    assert.equal(payload.sandbox_policy?.type, 'workspace-write');
    assert.equal(payload.approval_policy, 'on-request');
    assert.equal(payload.approvals_reviewer, 'auto_review');
  }
  console.log(JSON.stringify({ passed: true, directory, report, requests }));
} catch (error) {
  await writeFile(join(directory, 'debug.json'), JSON.stringify({ logs }, null, 2));
  console.error(JSON.stringify({ passed: false, directory, error: error.message }));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.kill();
  child.stdout.destroy();
  child.stderr.destroy();
  mock.closeAllConnections();
  mock.close();
}
