import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf('--' + name);
  return at < 0 ? null : args[at + 1];
};
if (!option('exe')) throw Error('--exe is required');
const executable = resolve(option('exe'));
const directory = resolve(option('output') || `test-results/installed-bot-events-${Date.now()}`);
const profile = join(directory, 'profile');
const data = join(directory, 'data');
await mkdir(profile, { recursive: true });
const preferences = JSON.parse(await readFile(
  join(process.env.APPDATA, 'ai-desktop', 'desktop-preferences.json'), 'utf8'));
await writeFile(join(profile, 'desktop-preferences.json'), JSON.stringify({
  codexPath: preferences.codexPath, model: preferences.model,
  effort: preferences.effort, usageMode: 'daily',
}));
const env = { ...process.env, AI_DESKTOP_PROFILE_DIR: profile,
  AI_DESKTOP_DATA_DIR: data, AI_DESKTOP_OUTPUT_DIR: join(directory, 'outputs') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { executable, directory, checks: [], startedAt: new Date().toISOString() };
let app;
async function launch() {
  app = await electron.launch({ executablePath: executable, env, timeout: 45000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.desktop, null, { timeout: 45000 });
  return page;
}
async function close() {
  if (!app) return;
  const current = app;
  app = null;
  const exited = new Promise((done) => current.process().once('exit', done));
  await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await Promise.race([exited, new Promise((_, reject) =>
    setTimeout(() => reject(Error('Desktop close timed out')), 15000))]);
}
const statePath = join(profile, 'conversation-state.json');
const dbPath = join(data, 'desktop.sqlite');
try {
  const page = await launch();
  const workspaceId = await page.evaluate(async () =>
    (await window.desktop.workManagement({ command: { operation: 'reports' } })).workspaceId);
  let state, primary;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    state = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}'));
    primary = state.primaryThreads?.[workspaceId];
    if (primary) break;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.ok(primary, 'startup must persist primary identity');
  if (args.includes('--real-run')) {
    const received = await page.evaluate((requestId) => window.desktop.workManagement({
      command: { operation: 'intake', requestId,
        payload: { text: '请简短说明：一个工作结果事件已产生。无需创建文件。' } },
    }), randomUUID());
    const taskId = received.task.id;
    const until = Date.now() + 180000;
    let delivery;
    while (Date.now() < until) {
      const opened = new DatabaseSync(dbPath, { readOnly: true });
      try {
        delivery = opened.prepare("SELECT state,body FROM bot_events WHERE workspace=? AND json_extract(body,'$.taskId')=? ORDER BY rowid DESC LIMIT 1")
          .get(workspaceId, taskId);
      } finally { opened.close(); }
      if (delivery?.state === 'acknowledged') break;
      await new Promise((done) => setTimeout(done, 500));
    }
    assert.equal(delivery?.state, 'acknowledged', 'real CLI run must produce an acknowledged event');
    report.checks.push({ name: 'real CLI work result receives durable Bot acknowledgement',
      passed: true, taskId, eventId: JSON.parse(delivery.body).id });
    console.log('PASS real CLI work result received durable Bot acknowledgement');
  } else {
  await close();

  state.threads[primary] ||= { draft: '', queue: [], paused: false };
  state.threads[primary].paused = true;
  state.threads[primary].queue.push({ id: randomUUID(), requestId: 'fixture-user-queued',
    text: '用户排队消息，不应在重启后自动执行', blocks: [], workspaceId,
    state: 'queued', createdAt: new Date().toISOString() });
  await writeFile(statePath, JSON.stringify(state));
  const runId = '00000000-0000-4000-8000-000000000002';
  const id = `work_result:${runId}`;
  const event = { id, workspaceId, kind: 'work_result', taskId: 'fixture-task', runId,
    requirementsRevision: 1, originThreadId: primary, threadId: primary,
    title: '隔离投递夹具', state: 'attention', resultText: 'fixture result',
    delivery: { state: 'pending', attempt: 0, updatedAt: Date.now() } };
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO bot_events(workspace,id,state,body) VALUES(?,?,?,?)')
      .run(workspaceId, id, 'pending', JSON.stringify(event));
  } finally { db.close(); }

  const resumedPage = await launch();
  const until = Date.now() + 60000;
  let delivery;
  while (Date.now() < until) {
    const opened = new DatabaseSync(dbPath, { readOnly: true });
    try {
      delivery = opened.prepare('SELECT state,body FROM bot_events WHERE workspace=? AND id=?')
        .get(workspaceId, id);
    } finally { opened.close(); }
    if (delivery?.state === 'acknowledged') break;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.equal(delivery?.state, 'acknowledged', 'installed host must claim and acknowledge event');
  let reported;
  const reportDeadline = Date.now() + 60000;
  while (Date.now() < reportDeadline) {
    reported = await resumedPage.evaluate(async (id) => (await window.desktop.workManagement({
      command: { operation: 'conversation' } })).requests.find((request) => request.id === id),
    `followup-${runId}`).catch(() => null);
    if (reported?.state === 'committed' && reported.response?.text) break;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.match(reported?.response?.text || '', /尚未确认完成/);
  const queueState = JSON.parse(await readFile(statePath, 'utf8')).threads[primary];
  const queued = queueState.queue.filter((item) => item.requestId === `followup-${runId}`);
  assert.equal(queued.length, 1, 'conversation enqueue must persist before event acknowledgement');
  assert.equal(queued[0].state, 'sent', 'system result must finish despite the paused queue');
  assert.equal(queueState.paused, true, 'ordinary queued work must remain paused');
  assert.equal(queueState.queue.find((item) => item.requestId === 'fixture-user-queued')?.state,
    'queued', 'ordinary queued work must not auto-run');
  report.checks.push({ name: 'installed restart drains durable Work Host event once', passed: true,
    workspaceId, eventId: id, state: delivery.state, queued: queued.length,
    reported: reported.id, ordinaryQueuePaused: queueState.paused });
  console.log('PASS installed durable Bot event recovery and acknowledgement');
  }
} catch (error) {
  report.error = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(join(directory, 'bot-events-report.json'), JSON.stringify({
    ...report, finishedAt: new Date().toISOString(),
  }, null, 2));
  await close().catch(() => {});
}
