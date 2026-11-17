// Read-only diagnostics through the installed app-server's generated public schema.
// Does not start a model turn, create a chat, or change the running desktop.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/diagnose-host.mjs <desktop-codex.exe>');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const evidence = 'test-results/host-load-diagnostic.json';
const child = spawn(executable, ['app-server', '--stdio'], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let sequence = 0;
const warnings = [];
createInterface({ input: child.stderr }).on('line', (line) => {
  // Retain only this plugin's diagnostics; other plugin/account logs are excluded.
  if (/ai-desktop|ai_desktop/.test(line)) warnings.push(line);
});
createInterface({ input: child.stdout }).on('line', (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  const job = pending.get(value.id);
  if (!job) return;
  pending.delete(value.id);
  clearTimeout(job.timer);
  value.error ? job.reject(new Error(JSON.stringify(value.error))) : job.resolve(value.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 45000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const report = {
  timestamp: new Date().toISOString(),
  executable,
  mode: 'fresh-app-server-read-only',
};
try {
  report.initialize = await request('initialize', {
    clientInfo: { name: 'ai_desktop_diagnostics', version },
    capabilities: { experimentalApi: true, explicitGatewayOauth: true },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
  report.plugin = await request('plugin/read', {
    marketplacePath: resolve('release/marketplace/.agents/plugins/marketplace.json'),
    pluginName: 'ai-desktop',
  });
  console.log('Plugin metadata read.');
  report.mcp = await request('mcpServerStatus/list', { serverName: 'ai_desktop', detail: 'full' });
  report.warnings = warnings;
  const server = report.mcp.data.find((item) => item.name === 'ai_desktop');
  const opener = server?.tools?.desktop_open;
  report.checks = {
    installedVersion: report.plugin.plugin.summary.localVersion === version,
    mcpRegistered: report.plugin.plugin.mcpServers.includes('ai_desktop'),
    toolCount: Object.keys(server?.tools ?? {}).length === 7,
    serverVersion: server?.serverInfo?.version === version,
    threadEntrypoint:
      opener?._meta?.['openai/ui']?.entrypoints?.some((entry) => entry.type === 'thread') === true,
    uiResource:
      server?.resources?.some(
        (resource) =>
          resource.uri === 'ui://ai-desktop/workspace' &&
          resource.mimeType === 'text/html;profile=mcp-app',
      ) === true,
    noLoadingWarnings: warnings.length === 0 && !server?.toolsError,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile(evidence, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        version,
        checks: report.checks,
        warningCount: warnings.length,
        evidence,
        realPanelRendered: false,
      },
      null,
      2,
    ),
  );
  if (Object.values(report.checks).some((value) => value !== true))
    throw new Error('Desktop loader validation failed; see evidence.');
} finally {
  for (const job of pending.values()) clearTimeout(job.timer);
  child.stdin.end();
  // Only the diagnostic process created by this script is stopped.
  const timer = setTimeout(() => child.kill(), 2000);
  child.once('exit', () => clearTimeout(timer));
}
