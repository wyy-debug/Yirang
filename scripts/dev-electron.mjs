// Development loop: rebuilds on save and restarts Electron from the source tree, without packaging.
// Electron loads dist/electron/main.mjs (package.json "main"); the repo root is resolved from there.
import { context } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import electron from 'electron';
import { buildSteps } from './build.mjs';

let child = null,
  timer = null,
  ready = false,
  stopping = false,
  initialWatchBuilds = 0;
function stop() {
  if (!child) return;
  // Electron starts Node and Codex children; kill the whole tree so none is left holding the profile.
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  child = null;
}
function start() {
  child = spawn(electron, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, AI_DESKTOP_DEV: '1' },
  });
  const self = child;
  self.on('exit', (code) => {
    if (child !== self) return;
    child = null;
    if (!stopping) {
      console.log(`[dev] Electron 已退出（${code}），保存文件后会重新启动；Ctrl+C 结束。`);
    }
  });
}
function restart(reason) {
  if (!ready) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[dev] ${reason}，重启 Electron…`);
    stop();
    start();
  }, 300);
}
const notify = {
  name: 'dev-restart',
  setup(b) {
    b.onEnd((result) => {
      if (initialWatchBuilds > 0 && !result.errors.length) {
        initialWatchBuilds--;
        return;
      }
      if (result.errors.length) console.log('[dev] 构建失败，保持当前窗口，修复后自动重试。');
      else restart('代码已重新构建');
    });
  },
};

const contexts = await Promise.all(
  (await buildSteps()).map((step) =>
    context({ ...step, plugins: [...(step.plugins || []), notify] }),
  ),
);
await Promise.all(contexts.map((c) => c.rebuild()));
// watch() repeats the build once on start; those results are not edits and must not restart the window.
initialWatchBuilds = contexts.length;
await Promise.all(contexts.map((c) => c.watch()));
// Stylesheets, HTML and PowerShell helpers under apps/electron are loaded from source, not through esbuild.
watch('apps/electron', { recursive: true }, (event, file) => {
  if (file && /\.(?:css|html|ps1)$/.test(file)) restart(`${file} 已修改`);
});
ready = true;
start();
console.log('[dev] 已启动。修改代码后会自动重建并重启 Electron；Ctrl+C 结束。');
const quit = async () => {
  stopping = true;
  stop();
  await Promise.all(contexts.map((c) => c.dispose()));
  process.exit(0);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
