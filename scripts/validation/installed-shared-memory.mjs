import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? null : args[index + 1];
};
if (!option('exe')) throw Error('--exe is required');
const executable = resolve(option('exe'));
const directory = resolve(option('output') || `test-results/installed-shared-memory-${Date.now()}`);
const home = join(directory, 'codex-home');
const profile = join(directory, 'profile');
const marker = '桔梗河共享记忆';
const roots = [join(directory, 'project-alpha'), join(directory, 'project-beta')];
await Promise.all([home, profile, ...roots, join(home, 'memories_v2')]
  .map(path => mkdir(path, { recursive: true })));
await writeFile(join(home, 'memories_v2', 'memory_summary.md'),
  `v1\n## User Profile\n${marker}。\n## User preferences\n暂无。\n## General Tips\n暂无。\n## What's in Memory\n暂无。\n`);
await writeFile(join(home, 'memories_v2', 'MEMORY.md'), '# 共享目录验证\n');

const requests = [];
const mock = createServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const serialized = JSON.stringify(body);
  requests.push({
    markerFound: serialized.includes(marker),
    alphaQuery: serialized.includes('ALPHA_QUERY'),
    betaQuery: serialized.includes('BETA_QUERY'),
    alphaRoot: serialized.includes(roots[0].replaceAll('\\', '\\\\')) || serialized.includes(roots[0]),
    betaRoot: serialized.includes(roots[1].replaceAll('\\', '\\\\')) || serialized.includes(roots[1]),
    model: body.model,
  });
  const id = `mock-response-${requests.length}`;
  const item = { type: 'message', role: 'assistant', id: `message-${requests.length}`,
    content: [{ type: 'output_text', text: '收到。' }] };
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
await new Promise(done => mock.listen(0, '127.0.0.1', done));
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
await writeFile(join(home, 'config.toml'),
  `model_provider = "shared_probe"\nmodel = "gpt-6-luna"\n` +
  `[model_providers.shared_probe]\nname = "Shared memory probe"\nbase_url = "${mockUrl}"\n` +
  `env_key = "YIRANG_SHARED_PROBE_KEY"\nwire_api = "responses"\n` +
  `[memories]\nversion = "v2"\n[windows]\nsandbox = "elevated"\n`);
const preferences = JSON.parse(await readFile(
  join(process.env.APPDATA, 'ai-desktop', 'desktop-preferences.json'), 'utf8'));
await writeFile(join(profile, 'desktop-preferences.json'), JSON.stringify({
  codexPath: preferences.codexPath,
  model: 'gpt-6-luna',
  effort: 'low',
  usageMode: 'daily',
}));
const env = { ...process.env, AI_DESKTOP_CODEX_HOME: home,
  YIRANG_SHARED_PROBE_KEY: 'local-test-key',
  AI_DESKTOP_PROFILE_DIR: profile,
  AI_DESKTOP_DATA_DIR: join(directory, 'data'),
  AI_DESKTOP_OUTPUT_DIR: join(directory, 'outputs') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { executable, directory, home, mockModel: true,
  startedAt: new Date().toISOString(), checks: [], requests };
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
let application;
async function until(fn, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise(done => setTimeout(done, 500));
  }
  throw Error(`Timed out: ${lastError?.message || 'condition remained false'}`);
}
async function close() {
  if (!application) return;
  const current = application;
  application = null;
  const exited = new Promise(done => current.process().once('exit', done));
  await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await Promise.race([exited, new Promise((_, reject) =>
    setTimeout(() => reject(Error('installed app did not close')), 15000))]);
}
try {
  application = await electron.launch({ executablePath: executable, env, timeout: 45000 });
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(2560, 1440));
  await page.waitForFunction(() => !!window.desktop, { timeout: 45000 });
  await until(() => page.evaluate(async () =>
    (await window.desktop.workManagement({ command: { operation: 'reports' } })).workspaceId));
  for (let index = 0; index < roots.length; index++) {
    const label = index === 0 ? 'ALPHA_QUERY' : 'BETA_QUERY';
    const created = await page.evaluate(payload => window.desktop.projects('create', payload), {
      name: `Shared memory ${index + 1}`, path: roots[index], requestId: randomUUID(),
    });
    await until(() => page.evaluate(projectId =>
      window.desktop.projects('select', { projectId }), created.project.id), 120000);
    await until(async () => {
      const current = await page.evaluate(() => window.desktop.projects('current', { observed: true }));
      return current.projectId === created.project.id && current;
    });
    await page.evaluate(text => window.desktop.send(text), `请只回答 ${label}。`);
    await until(() => requests.some(item => item[index === 0 ? 'alphaQuery' : 'betaQuery']), 90000);
    const matched = requests.filter(item => item[index === 0 ? 'alphaQuery' : 'betaQuery']);
    assert.ok(matched.some(item => item.markerFound), `${label} model input lacked shared memory`);
    assert.ok(matched.some(item => item[index === 0 ? 'alphaRoot' : 'betaRoot']),
      `${label} model input lacked its project root`);
    report.checks.push({ name: `${label} used same Codex memory`, passed: true,
      projectId: created.project.id, root: roots[index], matchingRequests: matched.length });
    await save();
    await until(async () => {
      const state = await page.evaluate(() => window.desktop.projects('current', { observed: true }));
      return state.projectId === created.project.id && state.threadId;
    });
  }
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  try {
    const all = db.prepare('SELECT cwd, source, memory_mode FROM threads').all();
    const rows = roots.map(root => all.find(row => row.cwd.endsWith(root)));
    assert.ok(rows.every(Boolean), 'both project roots should have a native thread');
    assert.ok(rows.every(row => row.source === 'vscode' && row.memory_mode === 'enabled'));
    report.checks.push({ name: 'both installed project threads use one CODEX_HOME',
      passed: true, rows });
  } finally { db.close(); }
  await page.screenshot({ path: join(directory, 'shared-memory-2k.png') });
} catch (error) {
  report.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  await close().catch(error => { report.closeError = error.message; });
  mock.close();
  report.finishedAt = new Date().toISOString();
  await save();
}
