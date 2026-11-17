import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
const root = resolve(process.argv[2] || 'release/marketplace/plugins/ai-desktop');
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const compat = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
if (manifest.version !== compat.version) throw Error('Manifest version mismatch');
const config = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')).mcpServers.ai_desktop;
if (!config.command.startsWith('./') || config.cwd !== './')
  throw Error('Portable MCP must use contained ./ paths');
const command = resolve(root, config.command);
if (dirname(command) !== join(root, 'runtime')) throw Error('Runtime command escapes package');
const dir = await mkdtemp(join(tmpdir(), 'ai-desktop-package-'));
const client = new Client({ name: 'packaged-runtime-smoke', version: '1' });
try {
  await client.connect(
    new StdioClientTransport({
      command,
      args: config.args,
      cwd: resolve(root, config.cwd),
      env: { ...process.env, AI_DESKTOP_DATA_DIR: dir },
      stderr: 'pipe',
    }),
  );
  const { tools } = await client.listTools();
  if (tools.length !== 7) throw Error('Missing tools');
  const result = await client.callTool({
    name: 'desktop_open',
    arguments: {},
    _meta: { 'openai/session': 'package-smoke' },
  });
  if (!result._meta?.desktop?.binding?.workspaceId) throw Error('Open failed');
  const resources = await client.readResource({ uri: 'ui://ai-desktop/workspace' });
  if (resources.contents[0].mimeType !== 'text/html;profile=mcp-app')
    throw Error('UI resource missing');
  console.log(
    JSON.stringify(
      {
        version: manifest.version,
        bundledRuntime: true,
        toolCount: tools.length,
        open: true,
        uiResource: true,
        realDesktopHost: false,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  if (
    dirname(resolve(dir)) !== resolve(tmpdir()) ||
    !basename(dir).startsWith('ai-desktop-package-')
  )
    throw Error('Unexpected cleanup path');
  await rm(dir, { recursive: true, force: true });
}
