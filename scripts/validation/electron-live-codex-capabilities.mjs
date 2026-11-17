import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { _electron } from 'playwright';
import electron from 'electron';
import { resolveCodexRuntime } from '../../apps/electron/cli/codex-runtime.mjs';

const root = resolve();
const directory = resolve(process.argv[2] || 'test-results/live-codex-capabilities');
const profile = join(directory, 'profile');
const home = await mkdtemp(join(tmpdir(), 'yirang-codex-capability-'));
const report = { startedAt: new Date().toISOString(), mode: 'real-codex-cli', passed: false };
let app;
try {
  await Promise.all([profile, join(directory, 'data'), join(directory, 'outputs')]
    .map((path) => mkdir(path, { recursive: true })));
  await copyFile(join(process.env.APPDATA || '', 'ai-desktop', 'codex-cli-home', 'auth.json'),
    join(home, 'auth.json'));
  const binary = (await resolveCodexRuntime()).path;
  await writeFile(join(profile, 'desktop-preferences.json'), JSON.stringify({
    codexPath: binary, model: 'gpt-6-luna', effort: 'low', usageMode: 'daily',
  }));
  const env = { ...process.env, AI_DESKTOP_DEV: '1',
    AI_DESKTOP_PROFILE_DIR: profile, AI_DESKTOP_CODEX_HOME: home,
    AI_DESKTOP_DATA_DIR: join(directory, 'data'),
    AI_DESKTOP_OUTPUT_DIR: join(directory, 'outputs'),
    AI_DESKTOP_NODE_BIN: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  app = await _electron.launch({ executablePath: electron, args: ['.'], cwd: root, env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.locator('#input').waitFor();
  await page.evaluate(() => {
    window.__codexCheck = { events: [], threadId: null };
    window.desktop.onEvent((event) => {
      window.__codexCheck.events.push(event);
      if (event.type === 'thread-switched' || event.type === 'thread-created')
        window.__codexCheck.threadId = event.payload.threadId;
    });
  });
  const account = await page.evaluate(() => window.desktop.chat('account'));
  assert.ok(account?.account, 'Codex login not available in isolated app');
  report.account = 'signed-in';
  const models = await page.evaluate(() => window.desktop.chat('models'));
  assert.ok(Array.isArray(models) && models.length > 0, 'model catalog empty');
  report.modelCount = models.length;
  const selected = models.find((item) => item.model === 'gpt-6-luna') || models[0];
  const effort = selected.supportedReasoningEfforts?.[0]?.reasoningEffort;
  const configured = await page.evaluate((patch) => window.desktop.chat('configure', patch),
    { model: selected.model, effort });
  assert.equal(configured.model, selected.model, 'selected Codex model was not saved');
  assert.equal((await page.evaluate(() => window.desktop.chat('preferences'))).model,
    selected.model, 'saved model was not returned');
  report.modelConfigured = selected.model;
  const runtime = await page.evaluate(() => window.desktop.chat('runtime'));
  assert.ok(runtime && typeof runtime === 'object', 'runtime information unavailable');
  report.runtimeRead = true;
  const permissions = await page.evaluate(() => window.desktop.permissions('read'));
  assert.ok(permissions?.supported, 'Codex permission read unavailable');
  report.permissions = permissions.effective;
  await page.evaluate(() => window.desktop.switchThread('new'));
  const draftId = await page.evaluate(() => window.__codexCheck.threadId);
  assert.ok(draftId, 'new chat did not select a thread');
  await page.evaluate((threadId) => window.desktop.conversation('draft', {
    threadId, text: '未发送草稿保留测试',
  }), draftId);
  const draft = await page.evaluate((threadId) => window.desktop.conversation('get', {
    threadId,
  }), draftId);
  assert.equal(draft.draft, '未发送草稿保留测试');
  await page.evaluate((threadId) => window.desktop.conversation('draft', {
    threadId, text: '',
  }), draftId);
  report.draftPersisted = true;
  await page.evaluate(() => window.desktop.conversation('pause', { paused: true }));
  await page.evaluate(() => window.desktop.conversation('enqueue', { text: '第一条待发消息' }));
  await page.evaluate(() => window.desktop.conversation('enqueue', { text: '第二条待发消息' }));
  let queue = (await page.evaluate(() => window.desktop.conversation('get'))).queue;
  assert.equal(queue.length, 2, 'paused chat did not retain both queued messages');
  await page.evaluate((id) => window.desktop.conversation('edit', {
    id, text: '第一条已编辑',
  }), queue[0].id);
  await page.evaluate((id) => window.desktop.conversation('move', {
    id, delta: -1,
  }), queue[1].id);
  queue = (await page.evaluate(() => window.desktop.conversation('get'))).queue;
  assert.deepEqual(queue.map((item) => item.text), ['第二条待发消息', '第一条已编辑']);
  for (const item of queue)
    await page.evaluate((id) => window.desktop.conversation('remove', { id }), item.id);
  assert.equal((await page.evaluate(() => window.desktop.conversation('get'))).queue.length, 0);
  await page.evaluate(() => window.desktop.conversation('pause', { paused: false }));
  report.queueEditReorderRemove = true;
  await page.evaluate(() => window.desktop.send('验收普通对话：请只回复 CODEX_CHAT_OK。'));
  await page.waitForFunction(() => window.__codexCheck.events.some((event) =>
    event.type === 'completed' && event.payload?.turn?.status === 'completed'),
    null, { timeout: 120000 });
  const threadId = await page.evaluate(() => window.__codexCheck.threadId);
  assert.ok(threadId && !threadId.startsWith('local-draft-'), 'chat was not materialized');
  report.threadId = threadId;
  const history = await page.evaluate((id) => window.desktop.chat('history', { threadId: id }),
    threadId);
  const agentText = (history.data || []).flatMap((turn) => (turn.items || [])
    .filter((item) => item.type === 'agentMessage')
    .map((item) => String(item.text || ''))).join('\n');
  assert.match(agentText, /CODEX_CHAT_OK/, 'real model reply missing from history');
  report.historyTurns = history.data.length;
  await page.evaluate((id) => window.desktop.chat('rename', {
    threadId: id, name: 'Codex 功能验收会话',
  }), threadId);
  const threads = await page.evaluate(() => window.desktop.chat('threads'));
  assert.ok(threads.data.some((item) => item.id === threadId &&
    item.name === 'Codex 功能验收会话'), 'renamed chat not found');
  await page.evaluate(() => window.desktop.switchThread('new'));
  await page.evaluate((id) => window.desktop.switchThread(id), threadId);
  const restored = await page.evaluate((id) => window.desktop.chat('history', {
    threadId: id,
  }), threadId);
  assert.ok(restored.data.some((turn) => turn.id === history.data[0].id),
    'history lost after switching chats');
  report.switchRestoredHistory = true;
  const idleSteer = await page.evaluate(async (id) => {
    try { await window.desktop.steer(id, '已结束回合不应接受补充'); return null; }
    catch (error) { return String(error.message); }
  }, threadId);
  report.idleSteer = idleSteer;
  assert.match(idleSteer || '', /活动|运行|结束|active|no active/i,
    'completed chat unexpectedly accepted a steer');
  report.completedTurnSteerRejected = true;
  const imageId = 'codex-capability-image';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
  await page.evaluate(({ id, data, threadId }) => window.desktop.composerImages('add', {
    threadId, blocks: [{ type: 'image', mimeType: 'image/png', data,
      _meta: { 'yirang/composer-image': { id, name: 'test.png' } } }],
  }), { id: imageId, data: png, threadId });
  const added = await page.evaluate(() => window.__codexCheck.events
    .filter((event) => event.type === 'selection').at(-1)?.payload || []);
  assert.ok(added.some((item) => item._meta?.['yirang/composer-image']?.id === imageId),
    'image was not attached to current chat');
  await page.evaluate(({ threadId, id }) => window.desktop.composerImages('remove', {
    threadId, id,
  }), { threadId, id: imageId });
  const removed = await page.evaluate(() => window.__codexCheck.events
    .filter((event) => event.type === 'selection').at(-1)?.payload || []);
  assert.ok(!removed.some((item) => item._meta?.['yirang/composer-image']?.id === imageId),
    'image removal did not clear the current chat');
  report.imageAddRemove = true;
  await page.evaluate(({ id, data, threadId }) => window.desktop.composerImages('add', {
    threadId, blocks: [{ type: 'image', mimeType: 'image/png', data,
      _meta: { 'yirang/composer-image': { id, name: 'test.png' } } }],
  }), { id: imageId, data: png, threadId });
  const completions = await page.evaluate(() => window.__codexCheck.events
    .filter((event) => event.type === 'completed').length);
  await page.evaluate(() => window.desktop.send('请确认你收到了一张图片，只回复 IMAGE_OK。'));
  await page.waitForFunction((count) => window.__codexCheck.events
    .filter((event) => event.type === 'completed').length > count,
  completions, { timeout: 120000 });
  const imageHistory = await page.evaluate((id) => window.desktop.chat('history', {
    threadId: id,
  }), threadId);
  const imageTypes = (imageHistory.data || []).flatMap((turn) => (turn.items || [])
    .filter((item) => item.type === 'userMessage')
    .flatMap((item) => (item.content || []).map((part) => part.type)));
  assert.ok(imageTypes.some((type) => /image/i.test(type)),
    `CLI history does not contain the image input: ${imageTypes.join(',')}`);
  report.imageSentToCli = true;
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  const target = resolve(home), base = resolve(tmpdir());
  if (!target.startsWith(base + sep) ||
      !target.split(sep).at(-1)?.startsWith('yirang-codex-capability-'))
    throw Error('unexpected auth staging directory');
  await rm(target, { recursive: true, force: true });
  console.log(JSON.stringify({ report: join(directory, 'report.json'), ...report }));
}
