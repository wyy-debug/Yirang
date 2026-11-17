import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright';
import { BotEventStore } from '../../packages/local-runtime/bot/bot-events.js';

const executable = resolve(process.argv[2] || '');
const directory = resolve(process.argv[3] || `test-results/installed-result-events-${Date.now()}`);
if (!process.argv[2]) throw Error('usage: npx tsx installed-result-events.mjs <Yirang.exe> [output]');
await mkdir(join(directory, 'profile'), { recursive: true });
const original = JSON.parse(await readFile(join(process.env.APPDATA, 'ai-desktop/desktop-preferences.json'), 'utf8'));
await writeFile(join(directory, 'profile/desktop-preferences.json'), JSON.stringify({
  codexPath: original.codexPath, model: original.model, effort: original.effort, usageMode: 'daily',
}));
const env = { ...process.env, AI_DESKTOP_PROFILE_DIR: join(directory, 'profile'),
  AI_DESKTOP_DATA_DIR: join(directory, 'data'), AI_DESKTOP_OUTPUT_DIR: join(directory, 'outputs') };
delete env.ELECTRON_RUN_AS_NODE;
const report = { executable, directory, checks: [] };
let app;
try {
  app = await electron.launch({ executablePath: executable, env, timeout: 45000 });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(2560, 1440));
  await page.waitForFunction(() => !!window.desktop, { timeout: 45000 });
  let snapshot;
  for (let i = 0; i < 120; i++) {
    snapshot = await page.evaluate(() => window.desktop.workManagement({ command: { operation: 'reports' } })).catch(() => null);
    if (snapshot?.workspaceId) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(snapshot?.workspaceId, 'installed Work Host must expose its workspace');
  const db = new DatabaseSync(join(directory, 'data', 'desktop.sqlite'));
  try {
    const events = new BotEventStore(db);
    const runId = randomUUID();
    events.publishResult(snapshot.workspaceId, { id: randomUUID(), title: '未知投递界面验收', management: {
      state: 'attention', currentRequirementsRevision: 1, originThreadId: 'fixture-main',
      runs: [{ id: runId, requirementsRevision: 1, resultText: '结果需核实' }],
      continuation: { checkedRunId: runId, revision: 1, next: 'blocked', missing: ['证据待核实'], evidence: [] },
    } }, runId);
    events.command(snapshot.workspaceId, { operation: 'claim', id: `work_result:${runId}` });
  } finally { db.close(); }
  const resumed = new DatabaseSync(join(directory, 'data', 'desktop.sqlite'));
  try { new BotEventStore(resumed); } finally { resumed.close(); }
  const reopened = new DatabaseSync(join(directory, 'data', 'desktop.sqlite'));
  let resultEvents;
  try {
    resultEvents = new BotEventStore(reopened).command(snapshot.workspaceId, { operation: 'recent' });
  } finally { reopened.close(); }
  assert.equal(resultEvents.length, 1);
  assert.equal(resultEvents[0].delivery.state, 'unknown');
  report.checks.push({ name: 'persisted unknown result survives without replay', passed: true,
    eventId: resultEvents[0].id, delivery: resultEvents[0].delivery.state });
} catch (error) {
  report.checks.push({ name: 'persisted unknown result survives without replay', passed: false,
    error: error.stack || String(error) });
  throw error;
} finally {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await app?.close();
}
