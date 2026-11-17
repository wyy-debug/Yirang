import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf('--' + name);
  return at < 0 ? null : args[at + 1];
};
if (!value('exe')) throw Error('--exe is required');
const executable = resolve(value('exe'));
const directory = resolve(value('output') || `test-results/primary-identity-${Date.now()}`);
const profile = join(directory, 'profile');
await mkdir(profile, { recursive: true });
const preferences = JSON.parse(
  await readFile(join(process.env.APPDATA, 'ai-desktop', 'desktop-preferences.json'), 'utf8'),
);
await writeFile(join(profile, 'desktop-preferences.json'), JSON.stringify({
  codexPath: preferences.codexPath,
  model: preferences.model,
  effort: preferences.effort,
  usageMode: 'daily',
}));
const env = {
  ...process.env,
  AI_DESKTOP_PROFILE_DIR: profile,
  AI_DESKTOP_DATA_DIR: join(directory, 'data'),
  AI_DESKTOP_OUTPUT_DIR: join(directory, 'outputs'),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = { executable, directory, checks: [], startedAt: new Date().toISOString() };
let application;
async function launch() {
  application = await electron.launch({ executablePath: executable, env, timeout: 45000 });
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(2560, 1440));
  await page.waitForFunction(() => !!window.desktop, { timeout: 45000 });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const workspaceId = await page.evaluate(async () =>
      (await window.desktop.workManagement({ command: { operation: 'reports' } })).workspaceId).catch(() => null);
    if (workspaceId) return { page, workspaceId };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('Desktop did not become ready');
}
async function close() {
  if (!application) return;
  const current = application;
  application = null;
  const exited = new Promise((r) => current.process().once('exit', r));
  await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(Error('Desktop close timed out')), 15000)),
  ]);
}
const primaries = async () =>
  JSON.parse(await readFile(join(profile, 'conversation-state.json'), 'utf8')).primaryThreads || {};
try {
  const first = await launch();
  const original = (await primaries())[first.workspaceId];
  assert.ok(original, 'startup should persist a workspace primary');
  report.checks.push({ name: 'first startup binds primary', passed: true });
  await first.page.evaluate(() => window.desktop.switchThread('new'));
  assert.equal((await primaries())[first.workspaceId], original);
  report.checks.push({ name: 'browsing a draft does not rebind primary', passed: true });
  await close();

  const second = await launch();
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal((await primaries())[second.workspaceId], original);
  report.checks.push({ name: 'restart preserves logical Bot primary', passed: true });
  await second.page.screenshot({ path: join(directory, 'restarted-desktop.png') });
  await close();

  const statePath = join(profile, 'conversation-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const missing = '00000000-0000-4000-8000-000000000001';
  state.primaryThreads[second.workspaceId] = missing;
  await writeFile(statePath, JSON.stringify(state));
  const missingSession = await launch();
  await missingSession.page.waitForFunction(() =>
    document.body.innerText.includes('主 Bot 对话无法恢复'), null, { timeout: 60000 });
  assert.equal((await primaries())[missingSession.workspaceId], missing);
  report.checks.push({ name: 'missing primary reports failure without rebinding', passed: true });
  await missingSession.page.screenshot({ path: join(directory, 'missing-primary.png') });
  console.log('PASS installed primary conversation ownership across browse and restart');
} catch (error) {
  report.error = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(join(directory, 'primary-identity-report.json'), JSON.stringify({
    ...report, finishedAt: new Date().toISOString(),
  }, null, 2));
  await close().catch(() => {});
}
