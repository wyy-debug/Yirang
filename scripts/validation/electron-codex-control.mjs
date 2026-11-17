import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';
import { resolveCodexRuntime } from '../../apps/electron/cli/codex-runtime.mjs';

const root = resolve();
const directory = resolve(process.argv[2] || 'test-results/codex-control');
const profile = join(directory, 'profile');
const home = join(directory, 'codex-home');
const report = { startedAt: new Date().toISOString(), mode: 'electron-real-cli-mock-model', passed: false };
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
    response.writeHead(404).end();
    return;
  }
  for await (const _ of request) {}
  report.modelRequests = (report.modelRequests || 0) + 1;
  const id = `control-${report.modelRequests}`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id } })}\n\n`);
  const timer = setTimeout(() => {
    if (response.destroyed) return;
    const item = { type: 'message', role: 'assistant', id: `message-${id}`,
      content: [{ type: 'output_text', text: 'MOCK_DONE' }] };
    const done = { type: 'response.completed', response: { id,
      usage: { input_tokens: 0, input_tokens_details: null,
        output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } };
    response.end(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify(done)}\n\n`);
  }, 20000);
  response.once('close', () => clearTimeout(timer));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let app;
try {
  await Promise.all([profile, home, join(directory, 'data'), join(directory, 'outputs')]
    .map((path) => mkdir(path, { recursive: true })));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(join(home, 'config.toml'),
    `model_provider = "control_probe"\nmodel = "gpt-6-luna"\n` +
    `[model_providers.control_probe]\nname = "Control probe"\nbase_url = "${baseUrl}"\n` +
    `env_key = "YIRANG_CONTROL_PROBE_KEY"\nwire_api = "responses"\n` +
    `[windows]\nsandbox = "elevated"\n`);
  await writeFile(join(profile, 'desktop-preferences.json'), JSON.stringify({
    codexPath: (await resolveCodexRuntime()).path,
    model: 'gpt-6-luna', effort: 'low', usageMode: 'daily',
  }));
  const env = { ...process.env, AI_DESKTOP_DEV: '1',
    AI_DESKTOP_PROFILE_DIR: profile, AI_DESKTOP_CODEX_HOME: home,
    AI_DESKTOP_DATA_DIR: join(directory, 'data'),
    AI_DESKTOP_OUTPUT_DIR: join(directory, 'outputs'),
    AI_DESKTOP_NODE_BIN: process.execPath, YIRANG_CONTROL_PROBE_KEY: 'local-test-key' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  app = await _electron.launch({ executablePath: electron, args: ['.'], cwd: root, env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.locator('#input').waitFor();
  await page.evaluate(() => {
    window.__controlEvents = [];
    window.desktop.onEvent((event) => window.__controlEvents.push(event));
  });
  await page.waitForFunction(() => window.__controlEvents.some((event) =>
    event.type === 'ready'), null, { timeout: 45000 });
  await page.evaluate(() => window.desktop.switchThread('new'));
  await page.evaluate(() => window.desktop.send('请等待并回复 MOCK_DONE。'));
  await page.waitForFunction(() => window.__controlEvents.some((event) => event.type === 'started'),
    null, { timeout: 30000 });
  const started = await page.evaluate(() => window.__controlEvents.find((event) =>
    event.type === 'started'));
  report.threadId = started.payload.threadId;
  report.turnId = started.payload.turn.id;
  const steered = await page.evaluate(async (id) => {
    try { return { ok: true, value: await window.desktop.steer(id, '补充：仍只回复 MOCK_DONE。') }; }
    catch (error) { return { ok: false, error: String(error.message) }; }
  }, report.threadId);
  report.steer = steered;
  assert.equal(steered.ok, true, `active steer rejected: ${steered.error}`);
  await page.evaluate((id) => window.desktop.stop(id), report.threadId);
  await page.waitForFunction((id) => window.__controlEvents.some((event) =>
    event.type === 'completed' && event.payload.threadId === id),
  report.threadId, { timeout: 30000 });
  report.finalStatus = await page.evaluate((id) => window.__controlEvents.find((event) =>
    event.type === 'completed' && event.payload.threadId === id)?.payload.turn.status,
  report.threadId);
  assert.equal(report.finalStatus, 'interrupted');
  assert.ok(report.modelRequests >= 1);
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: join(directory, 'report.json'), ...report }));
}
