import { _electron } from 'playwright';
import electron from 'electron';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve();
const directory = resolve(process.argv[2] || 'test-results/native-entry-ui');
await mkdir(directory, { recursive: true });
const codexHome = existsSync(join(directory, 'yirang-codex-home'))
  ? join(directory, 'yirang-codex-home') : join(directory, 'codex-home');
const app = await _electron.launch({
  executablePath: electron,
  args: ['.'], cwd: root,
  env: {
    ...process.env,
    AI_DESKTOP_DEV: '1',
    AI_DESKTOP_PROFILE_DIR: join(directory, 'profile'),
    AI_DESKTOP_DATA_DIR: join(directory, 'data'),
    AI_DESKTOP_CODEX_HOME: codexHome,
    AI_DESKTOP_OUTPUT_DIR: join(directory, 'outputs'),
    AI_DESKTOP_NODE_BIN: process.execPath,
  },
});
try {
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1600, height: 1000 });
  const panel = window.frameLocator('#panel');
  await panel.getByRole('button', { name: '查看执行记录' }).waitFor({ timeout: 30000 });
  await panel.getByRole('button', { name: '查看执行记录' }).click();
  await panel.getByRole('region', { name: '执行记录' }).waitFor();
  if (process.argv.includes('--expect-auth'))
    await window.getByRole('alert').filter({ hasText: 'Codex 需要登录' }).
      getByRole('button', { name: '登录 Codex' }).waitFor({ timeout: 15000 });
  const screenshot = join(directory, 'native-entry.png');
  await window.screenshot({ path: screenshot });
  console.log(JSON.stringify({ passed: true, screenshot }));
} finally {
  await app.close();
}
