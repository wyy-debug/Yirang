import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installPackage } from './install-core.mjs';
import { runningInstances } from './platform/running-instances.mjs';
const here = dirname(fileURLToPath(import.meta.url)),
  source = resolve(here, '../../../..'),
  destination = join(process.env.LOCALAPPDATA, 'Programs', 'AI Desktop');
console.log('Installing Yirang. Your workspace and previous versions will be kept.');
const result = await installPackage(source, destination, (item) => {
  if (item.done % 150 === 1) console.log(`${item.done}/${item.total}`);
});
await new Promise((resolve, reject) => {
  const child = spawn(
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(here, 'install-shortcuts.ps1'),
      '-InstallRoot',
      destination,
    ],
    { windowsHide: true, stdio: 'inherit' },
  );
  child.on('error', reject);
  child.on('exit', (code) =>
    code === 0 ? resolve() : reject(Error(`Shortcut setup failed: ${code}`)),
  );
});
console.log(`Installed ${result.version}`);
let canLaunch = false;
try {
  const existing = await runningInstances();
  canLaunch = existing.length === 0;
  if (existing.length)
    console.log(
      `Launch deferred: ${existing.length} desktop instance(s) still running. Save and exit them, then open Yirang from the shortcut.`,
    );
} catch (error) {
  console.log(
    `Launch deferred: could not check existing instances (${error.message}). Open Yirang after saving and exiting old windows.`,
  );
}
if (canLaunch) {
  const child = spawn(result.executable, [], {
    cwd: result.path,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}
