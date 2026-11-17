import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

// Legacy releases did not acquire Electron's single-instance lock. Inspect only
// desktop main processes in this Windows session; never kill another instance.
export async function runningInstances() {
  if (process.platform !== 'win32') return [];
  const script = `$ErrorActionPreference='Stop'; $sessionId=[System.Diagnostics.Process]::GetCurrentProcess().SessionId; $rows=@(Get-CimInstance Win32_Process -Filter "Name='Yirang.exe' OR Name='AI Desktop.exe'" | Where-Object { $_.SessionId -eq $sessionId -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ExecutablePath); ConvertTo-Json -InputObject $rows -Compress`;
  const { stdout } = await promisify(execFile)(
    join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 8000, maxBuffer: 65536 },
  );
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
  if (!Array.isArray(result)) throw Error('无法确认已有一壤窗口');
  return result
    .filter((item) => Number.isInteger(item.ProcessId) && item.ProcessId !== process.pid)
    .map((item) => ({ pid: item.ProcessId, path: item.ExecutablePath || '' }));
}
