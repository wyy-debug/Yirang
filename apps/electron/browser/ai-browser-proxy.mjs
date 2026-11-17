import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createTabGuard } from './ai-browser.mjs';

// Usage: node ai-browser-proxy.mjs <playwright-mcp cli.js> [cli args...]
const [cli, ...args] = process.argv.slice(2);
const child = spawn(process.execPath, [cli, ...args], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});
const guard = createTabGuard({
  toChild: (line) => child.stdin.write(line + '\n'),
  toClient: (line) => process.stdout.write(line + '\n'),
});
createInterface({ input: process.stdin })
  .on('line', (line) => guard.fromClient(line))
  .on('close', () => child.stdin.end());
createInterface({ input: child.stdout }).on('line', (line) => guard.fromChild(line));
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
