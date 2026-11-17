import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCodexRuntime } from './codex-runtime.mjs';
const execute = promisify(execFile);
let latest = null,
  pending = null;
export async function codexVersion(preferences, check = false) {
  const runtime = await resolveCodexRuntime(preferences);
  const { stdout } = await execute(runtime.path, ['--version'], {
    timeout: 6000,
    windowsHide: true,
    maxBuffer: 65536,
  });
  const version = stdout.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
  if (!version) throw Error('CLI 未返回可识别版本');
  if (check) {
    pending ||= (async () => {
      const response = await fetch('https://registry.npmjs.org/@openai%2fcodex/latest', {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw Error('更新服务返回 ' + response.status);
      const data = await response.json();
      if (!/^\d+\.\d+\.\d+$/.test(data.version)) throw Error('更新服务版本格式不正确');
      return (latest = { version: data.version, checkedAt: new Date().toISOString() });
    })();
    try {
      await pending;
    } finally {
      pending = null;
    }
  }
  const parts = (v) => v.split('-')[0].split('.').map(Number),
    a = parts(version),
    b = latest ? parts(latest.version) : null;
  const newer = b ? b.some((n, i) => n > a[i] && b.slice(0, i).every((v, j) => v === a[j])) : false;
  return {
    ...runtime,
    version,
    latest: latest?.version || null,
    checkedAt: latest?.checkedAt || null,
    updateAvailable: newer,
    command: 'npm install -g @openai/codex@latest',
    bundled: runtime.source.includes('桌面版'),
  };
}
