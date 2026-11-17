import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';
import { resolveCodexRuntime } from '../../apps/electron/cli/codex-runtime.mjs';

const root = resolve();
const directory = resolve(process.argv[2] || 'test-results/live-multi-desktop');
const profile = join(directory, 'profile');
const output = join(directory, 'outputs');
const data = join(directory, 'data');
const sourceHome = join(process.env.APPDATA || '', 'ai-desktop', 'codex-cli-home');
const home = await mkdtemp(join(tmpdir(), 'yirang-live-e2e-'));
const report = { startedAt: new Date().toISOString(), mode: 'real-model', passed: false };
let app;
let page;
try {
  await Promise.all([profile, output, data].map((path) => mkdir(path, { recursive: true })));
  await copyFile(join(sourceHome, 'auth.json'), join(home, 'auth.json'));
  const binary = (await resolveCodexRuntime()).path;
  await writeFile(join(profile, 'desktop-preferences.json'), JSON.stringify({
    codexPath: binary, model: 'gpt-6-luna', effort: 'low', usageMode: 'daily',
  }));
  const env = {
    ...process.env,
    AI_DESKTOP_DEV: '1',
    AI_DESKTOP_PROFILE_DIR: profile,
    AI_DESKTOP_CODEX_HOME: home,
    AI_DESKTOP_DATA_DIR: data,
    AI_DESKTOP_OUTPUT_DIR: output,
    AI_DESKTOP_NODE_BIN: process.execPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  app = await _electron.launch({ executablePath: electron, args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.locator('#input').waitFor();
  const call = (name, args = {}) => page.evaluate(async ({ name, args }) => {
    const value = await window.desktop.tool(name, args);
    if (value.isError) throw Error(value.structuredContent?.error?.message ||
      value.content?.[0]?.text || name + ' failed');
    return value._meta?.desktop ?? value.structuredContent;
  }, { name, args });
  const account = await page.evaluate(() => window.desktop.chat('account'));
  assert.ok(account?.account, 'isolated app did not accept the existing Codex login');
  await page.evaluate(() => window.desktop.switchThread('new'));
  const firstWorkspace = (await call('desktop_workspace_overview')).workspaceId;
  report.workspaceA = firstWorkspace;
  const firstPrompt = '验收测试：这是同一用户回合的两件独立任务。请分别使用原生执行对话，在当前 AI 桌面创建 A-验收.txt（内容仅为 LIVE_A_OK）和 B-验收.txt（内容仅为 LIVE_B_OK）。两件任务都完成后核实两个真实文件，并简短汇报。';
  await page.evaluate((text) => window.desktop.send(text), firstPrompt);
  const waitForRecords = async (workspaceId, count, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await page.evaluate((id) => window.desktop.nativeWork(id), workspaceId);
      if (value.records?.length >= count && value.records.slice(0, count)
        .every((item) => ['completed', 'failed', 'interrupted', 'unknown'].includes(item.state)))
        return value;
      await new Promise((done) => setTimeout(done, 2000));
    }
    throw Error(`等待桌面 ${workspaceId} 的 ${count} 项原生执行超时`);
  };
  const first = await waitForRecords(firstWorkspace, 2, 180000);
  report.firstRecords = first.records.map(({ threadId, state, title }) => ({ threadId, state, title }));
  assert.equal(first.records.filter((item) => item.state === 'completed').length, 2,
    'first desktop did not complete two tasks');
  assert.equal(new Set(first.records.map((item) => item.threadId)).size, 2,
    'two tasks reused one native thread');
  report.childMessages = [];
  for (const record of first.records) {
    await page.evaluate((id) => window.desktop.switchThread(id), record.threadId);
    const history = await page.evaluate((id) => window.desktop.chat('history', { threadId: id }),
      record.threadId);
    report.childMessages.push({ threadId: record.threadId,
      status: history.data?.[0]?.status,
      messages: (history.data || []).flatMap((turn) => (turn.items || [])
        .filter((item) => item.type === 'agentMessage')
        .map((item) => String(item.text || '').slice(0, 3000))) });
  }
  await page.evaluate((id) => window.desktop.switchThread(id), first.records[0].parentId);
  const firstFiles = first.batches.flatMap((batch) => batch.files || []);
  report.firstFiles = firstFiles.map((file) => file.path);
  assert.ok(firstFiles.some((file) => file.path?.endsWith('A-验收.txt')),
    'A file was not collected');
  assert.ok(firstFiles.some((file) => file.path?.endsWith('B-验收.txt')),
    'B file was not collected');
  report.firstFileContents = {};
  for (const [name, expected] of [['A-验收.txt', 'LIVE_A_OK'], ['B-验收.txt', 'LIVE_B_OK']]) {
    const batch = first.batches.find((item) => item.files?.some((file) => file.path === name));
    assert.equal(batch.workspaceId, firstWorkspace, `${name} belongs to another desktop`);
    const actual = await readFile(join(batch.directory, name), 'utf8');
    assert.equal(actual, expected, `${name} content mismatch`);
    report.firstFileContents[name] = actual;
  }
  const created = await call('desktop_workspace_create', {
    workspaceId: firstWorkspace, requestId: randomUUID(), name: '真实验收桌面 B', open: true,
  });
  report.workspaceB = created.workspaceId;
  const switchDeadline = Date.now() + 60000;
  while ((await call('desktop_workspaces_list')).workspaceId !== report.workspaceB) {
    if (Date.now() > switchDeadline) throw Error('real desktop switch did not finish');
    await new Promise((done) => setTimeout(done, 1000));
  }
  await page.evaluate((text) => window.desktop.send(text),
    '验收测试：在当前桌面创建 C-验收.txt，内容仅为 LIVE_C_OK。核实真实文件后汇报。');
  const second = await waitForRecords(report.workspaceB, 1, 180000);
  report.secondRecords = second.records.map(({ threadId, state, title }) => ({ threadId, state, title }));
  report.secondFiles = second.batches.flatMap((batch) => batch.files || []).map((file) => file.path);
  assert.equal(second.records[0].state, 'completed');
  assert.ok(report.secondFiles.some((path) => path?.endsWith('C-验收.txt')),
    'C file was not collected');
  const secondBatch = second.batches.find((item) => item.files?.some((file) => file.path === 'C-验收.txt'));
  assert.equal(secondBatch.workspaceId, report.workspaceB, 'C file belongs to another desktop');
  report.secondFileContent = await readFile(join(secondBatch.directory, 'C-验收.txt'), 'utf8');
  assert.equal(report.secondFileContent, 'LIVE_C_OK', 'C file content mismatch');
  assert.ok(!second.records.some((item) => first.records.some((prior) => prior.threadId === item.threadId)),
    'desktop B reused desktop A task thread');
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  if (page) {
    report.visibleConversation = await page.locator('#messages').innerText().catch(() => '');
    if (report.workspaceA)
      report.firstSnapshot = await page.evaluate((id) => window.desktop.nativeWork(id),
        report.workspaceA).catch(() => null);
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await app?.close().catch(() => {});
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  const target = resolve(home), base = resolve(tmpdir());
  if (!target.startsWith(base + sep) || !target.split(sep).at(-1)?.startsWith('yirang-live-e2e-'))
    throw Error('refusing to remove unexpected auth staging directory');
  await rm(target, { recursive: true, force: true });
  console.log(JSON.stringify({ report: join(directory, 'report.json'), ...report }));
}
