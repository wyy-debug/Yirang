import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findEdge,
  aiBrowserMcpConfig,
  createTabGuard,
  countTabs,
  createBrowserActionTracker,
  aiBrowserInstructions,
  AI_BROWSER_OBSERVATION_TOOLS,
  // @ts-ignore -- JavaScript module has no declaration file.
} from '../apps/electron/browser/ai-browser.mjs';
// @ts-ignore
import { consultationProfile } from '../apps/electron/orchestration/consultation-profile.mjs';
// @ts-ignore
import { createMicroRunner } from '../apps/electron/micro/micro-runner.mjs';
// @ts-ignore
import * as voiceSession from '../apps/electron/voice/voice-session.mjs';

const config = () =>
  aiBrowserMcpConfig({
    node: 'node.exe',
    proxy: 'C:/app/ai-browser-proxy.mjs',
    cli: 'C:/app/cli.js',
    directory: 'C:/data/ai-browser',
    edge: 'C:/Edge/msedge.exe',
  });
const value = (list: string[], key: string) => {
  const line = list.find((l) => l.startsWith(key + '='));
  return line === undefined ? undefined : JSON.parse(line.slice(key.length + 1));
};

test('only observation tools skip approval; page-changing tools keep the CLI prompt; host-code tool disabled', () => {
  const c: string[] = config(),
    approved = c
      .filter((l) => l.includes('.approval_mode='))
      .map((l) => /tools\.([^.]+)\.approval_mode/.exec(l)![1]);
  assert.deepEqual(approved.sort(), [...AI_BROWSER_OBSERVATION_TOOLS].sort());
  for (const tool of [
    'browser_click',
    'browser_type',
    'browser_fill_form',
    'browser_select_option',
    'browser_file_upload',
    'browser_press_key',
    'browser_drag',
    'browser_handle_dialog',
    'browser_evaluate',
  ])
    assert.ok(!approved.includes(tool), tool + ' must not be auto-approved');
  assert.deepEqual(value(c, 'mcp_servers.yirang_browser.disabled_tools'), [
    'browser_run_code_unsafe',
  ]);
  assert.equal(value(c, 'mcp_servers.yirang_browser.required'), false);
});
test('browser runs the detected Edge with its own profile and closes when idle', () => {
  const args: string[] = value(config(), 'mcp_servers.yirang_browser.args');
  assert.equal(args[args.indexOf('--executable-path') + 1], 'C:/Edge/msedge.exe');
  assert.match(args[args.indexOf('--user-data-dir') + 1], /ai-browser[\\/]profile$/);
  assert.ok(Number(args[args.indexOf('--idle-timeout') + 1]) > 0);
});
test('missing Edge registers no browser server', () => {
  assert.equal(
    findEdge({ platform: 'win32', env: { ProgramFiles: 'C:/PF' }, exists: () => false }),
    null,
  );
  assert.deepEqual(aiBrowserMcpConfig({ node: 'n', cli: 'c', directory: 'd', edge: null }), []);
  const found = findEdge({
    platform: 'win32',
    env: { 'ProgramFiles(x86)': 'C:/X86', ProgramFiles: 'C:/PF' },
    exists: (p: string) => /^C:[\\/]PF/.test(p),
  });
  assert.match(found, /^C:[\\/]PF.*msedge\.exe$/);
});
test('stop notice only when a page-changing browser call was still running', () => {
  const t = createBrowserActionTracker(),
    item = (id: string, tool: string, server = 'yirang_browser') => ({
      type: 'mcpToolCall',
      id,
      server,
      tool,
    });
  t.notification('item/started', {
    threadId: 'a',
    turnId: 'u1',
    item: item('1', 'browser_snapshot'),
  });
  t.notification('item/started', { threadId: 'b', turnId: 'u2', item: item('2', 'browser_click') });
  assert.equal(t.turnCompleted('a', { id: 'u1', status: 'interrupted' }), null);
  t.notification('item/started', { threadId: 'a', turnId: 'u3', item: item('3', 'browser_click') });
  t.notification('item/started', {
    threadId: 'a',
    turnId: 'u3',
    item: item('4', 'other_tool', 'ai_desktop'),
  });
  assert.match(t.turnCompleted('a', { id: 'u3', status: 'interrupted' }), /browser_click/);
  t.notification('item/completed', {
    threadId: 'b',
    turnId: 'u2',
    item: item('2', 'browser_click'),
  });
  assert.equal(t.turnCompleted('b', { id: 'u2', status: 'interrupted' }), null);
  t.notification('item/started', { threadId: 'b', turnId: 'u4', item: item('5', 'browser_type') });
  assert.equal(t.turnCompleted('b', { id: 'u4', status: 'completed' }), null);
});
test('prompt names the browser tool, the tab limit and the check after a stop', () => {
  assert.equal('delegationInstructions' in voiceSession, false,
    'voice must not inject hidden browser workflow instructions');
  assert.match(aiBrowserInstructions, /同时最多保留 4 个标签/);
  assert.match(aiBrowserInstructions, /不要自动重试提交/);
});

test('tab guard refuses a fifth tab and passes everything else through', () => {
  const child: string[] = [],
    client: string[] = [];
  const g = createTabGuard({
    limit: 4,
    toChild: (l: string) => child.push(l),
    toClient: (l: string) => client.push(l),
  });
  const tabs = (n: number, heading = 'Result') =>
    '### ' +
    heading +
    '\n' +
    Array.from({ length: n }, (_, i) => `- ${i}: [](about:blank)`).join('\n');
  const reply = (id: any, text: string) =>
    JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  g.fromClient(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} },
    }),
  );
  assert.equal(JSON.parse(child.at(-1)!).id, 1);
  const ask = (id: number) => {
    g.fromClient(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'browser_tabs', arguments: { action: 'new' } },
      }),
    );
    return JSON.parse(child.at(-1)!);
  };
  let check = ask(2);
  assert.equal(check.params.arguments.action, 'list');
  g.fromChild(reply(check.id, tabs(3)));
  assert.equal(JSON.parse(child.at(-1)!).id, 2);
  assert.equal(client.length, 0);
  check = ask(3);
  g.fromChild(reply(check.id, tabs(4)));
  const refused = JSON.parse(client.at(-1)!);
  assert.equal(refused.id, 3);
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /上限 4/);
  g.fromChild(reply(10, tabs(2, 'Open tabs')));
  assert.equal(JSON.parse(client.at(-1)!).result.content.length, 1);
  assert.equal(countTabs('### Page\n- 0: x', 'Open tabs'), null);
});
const six =
  '### Ran Playwright code\n### Open tabs\n- 0: [a](https://a.test/)\n- 1: [b](https://b.test/)\n- 2: [c](https://c.test/)\n- 3: [d](https://d.test/)\n- 4: (current) [Pop](https://pop.test/x)\n- 5: [Pop2](https://pop2.test/)\n### Page\n- Page URL: x';
const flush = () => new Promise((r) => setImmediate(r));
test('page-opened tabs past the limit are closed one by one, re-listed, and only then reported', async () => {
  const child: string[] = [],
    client: string[] = [];
  const g = createTabGuard({
    limit: 4,
    toChild: (l: string) => child.push(l),
    toClient: (l: string) => client.push(l),
  });
  const reply = (id: any, text: string, isError = false) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] },
    });
  const last = () => JSON.parse(child.at(-1)!);
  g.fromChild(reply(9, six));
  assert.equal(client.length, 0, 'held until the closes are confirmed');
  assert.deepEqual(last().params.arguments, { action: 'close', index: 5 });
  g.fromChild(reply(last().id, '### Result\n- 0: a'));
  await flush();
  assert.deepEqual(last().params.arguments, { action: 'close', index: 4 });
  g.fromChild(reply(last().id, '### Result\n- 0: a'));
  await flush();
  assert.deepEqual(last().params.arguments, { action: 'list' });
  g.fromChild(
    reply(
      last().id,
      '### Result\n- 0: [a](https://a.test/)\n- 1: [b](x)\n- 2: [c](x)\n- 3: [d](x)',
    ),
  );
  await flush();
  const note = JSON.parse(client.at(-1)!);
  assert.equal(note.id, 9);
  const text = note.result.content.at(-1).text;
  assert.match(text, /已关闭最新的 2 个/);
  assert.match(text, /pop\.test\/x/);
  assert.match(text, /现在有 4 个标签/);
});
test('a failed close is reported with its reason and the real remaining count', async () => {
  const child: string[] = [],
    client: string[] = [];
  const g = createTabGuard({
    limit: 4,
    toChild: (l: string) => child.push(l),
    toClient: (l: string) => client.push(l),
  });
  const last = () => JSON.parse(child.at(-1)!);
  g.fromChild(
    JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: six }] } }),
  );
  g.fromChild(
    JSON.stringify({
      jsonrpc: '2.0',
      id: last().id,
      result: { isError: true, content: [{ type: 'text', text: '### Error\nTab is busy' }] },
    }),
  );
  await flush();
  g.fromChild(
    JSON.stringify({
      jsonrpc: '2.0',
      id: last().id,
      error: { code: -32000, message: 'browser closed' },
    }),
  );
  await flush();
  g.fromChild(
    JSON.stringify({
      jsonrpc: '2.0',
      id: last().id,
      result: {
        content: [
          {
            type: 'text',
            text: '### Result\n' + [0, 1, 2, 3, 4, 5].map((i) => `- ${i}: [t](x)`).join('\n'),
          },
        ],
      },
    }),
  );
  await flush();
  const text = JSON.parse(client.at(-1)!).result.content.at(-1).text;
  assert.doesNotMatch(text, /已关闭/);
  assert.match(text, /有 2 个没有关掉/);
  assert.match(text, /Tab is busy/);
  assert.match(text, /browser closed/);
  assert.match(text, /仍有 6 个标签，超过上限/);
});
test('an unanswered close times out instead of hanging the response', {timeout: 2000}, async () => {
  const child: string[] = [],
    client: string[] = [];
  let received!: () => void;
  const response = new Promise<void>(resolve => { received = resolve; });
  const g = createTabGuard({
    limit: 4,
    timeoutMs: 20,
    toChild: (l: string) => child.push(l),
    toClient: (l: string) => { client.push(l); received(); },
  });
  g.fromChild(
    JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: six }] } }),
  );
  await response;
  const text = JSON.parse(client.at(-1)!).result.content.at(-1).text;
  assert.match(text, /没有在规定时间内收到结果/);
  assert.match(text, /无法核对现在的标签数/);
});
test('a reply that arrives after its close timed out is swallowed, not forwarded', async () => {
  const child: string[] = [],
    client: string[] = [];
  const g = createTabGuard({
    limit: 4,
    timeoutMs: 20,
    toChild: (l: string) => child.push(l),
    toClient: (l: string) => client.push(l),
  });
  const last = () => JSON.parse(child.at(-1)!);
  g.fromChild(
    JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: six }] } }),
  );
  const firstClose = last().id;
  await new Promise((r) => setTimeout(r, 40));
  const secondClose = last().id;
  g.fromChild(
    JSON.stringify({
      jsonrpc: '2.0',
      id: secondClose,
      result: { content: [{ type: 'text', text: '### Result\n- 0: a' }] },
    }),
  );
  await flush();
  g.fromChild(
    JSON.stringify({
      jsonrpc: '2.0',
      id: last().id,
      result: {
        content: [
          {
            type: 'text',
            text: '### Result\n' + [0, 1, 2, 3].map((i) => `- ${i}: [t](x)`).join('\n'),
          },
        ],
      },
    }),
  );
  await flush();
  assert.equal(client.length, 1);
  const text = JSON.parse(client[0]).result.content.at(-1).text;
  assert.match(text, /现在有 4 个标签/);
  assert.match(text, /超时，可能稍后才生效/);
  const before = child.length;
  g.fromChild(
    JSON.stringify({
      jsonrpc: '2.0',
      id: firstClose,
      result: { content: [{ type: 'text', text: six }] },
    }),
  );
  await flush();
  assert.equal(client.length, 1, 'late reply is not forwarded');
  assert.equal(child.length, before, 'late reply does not start another trim');
});
test('browser server starts behind the tab-guard proxy', () => {
  const c = aiBrowserMcpConfig({
    node: 'node.exe',
    proxy: 'C:/app/ai-browser-proxy.mjs',
    cli: 'C:/app/cli.js',
    directory: 'C:/d',
    edge: 'C:/e.exe',
  });
  assert.deepEqual(value(c, 'mcp_servers.yirang_browser.args').slice(0, 2), [
    'C:/app/ai-browser-proxy.mjs',
    'C:/app/cli.js',
  ]);
});
const servers = {
  ai_desktop: { command: 'node' },
  yirang_browser: { command: 'node', args: ['cli.js'] },
};
test('read-only consultation and controlled managed work turn the AI browser off', async () => {
  const profile = await consultationProfile(
    async () => ({ config: { mcp_servers: servers } }),
    'C:/w',
  );
  assert.equal(profile['mcp_servers.yirang_browser.enabled'], false);
  assert.equal(profile['mcp_servers.ai_desktop.enabled'], true);
});
test('micro app and analysis threads start with the AI browser off', async () => {
  let started: any;
  const request = async (method: string, params: any) => {
    if (method === 'config/read') return { config: { mcp_servers: servers } };
    if (method === 'thread/start') {
      started = params;
      return { thread: { id: 't' } };
    }
    if (method === 'turn/start') return { turn: { id: 'u' } };
    return {};
  };
  const runner = createMicroRunner({
    workspaces: async () => [],
    send: async () => null,
    request,
    capacity: { role() {} },
    cwd: '.',
    readTurn: async () => null,
  });
  const pending = runner
    .ask({ w: 'w', prompt: 'p', wire: { type: 'object' }, timeoutMs: 50 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  runner.notification('turn/completed', {
    threadId: 't',
    turn: { id: 'u', status: 'completed', items: [] },
  });
  await pending;
  assert.equal(started.config['mcp_servers.yirang_browser.enabled'], false);
  assert.equal(started.config['mcp_servers.ai_desktop.enabled'], false);
});

// Real CLI check (former output-config-probe.mjs): the -c browser server is visible to config/read,
// and per-thread enabled=false overrides are accepted. Set YIRANG_LIVE_CLI=1 to run.
test(
  'live CLI accepts the browser server and per-thread disable overrides',
  { skip: process.env.YIRANG_LIVE_CLI !== '1' },
  async () => {
    // @ts-ignore
    const { resolveCodexRuntime } = await import('../apps/electron/cli/codex-runtime.mjs');
    const runtime = await resolveCodexRuntime(),
      dir = mkdtempSync(join(tmpdir(), 'ai-browser-')),
      edge = findEdge() || 'msedge';
    const overrides = aiBrowserMcpConfig({
      node: process.execPath,
      proxy: join(process.cwd(), 'apps', 'electron', 'browser', 'ai-browser-proxy.mjs'),
      cli: join(process.cwd(), 'node_modules', '@playwright', 'mcp', 'cli.js'),
      directory: dir,
      edge,
    });
    const child = spawn(
      runtime.path,
      ['app-server', '--stdio', ...overrides.flatMap((v: string) => ['-c', v])],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let serial = 0;
    const pending = new Map<number, (m: any) => void>();
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        const m = JSON.parse(line);
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      } catch {}
    });
    const rpc = (method: string, params: any) =>
      new Promise<any>((resolve) => {
        const id = ++serial;
        pending.set(id, resolve);
        child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
      });
    try {
      await rpc('initialize', {
        clientInfo: { name: 'yirang_browser_config_test', version: '1' },
        capabilities: { experimentalApi: true },
      });
      child.stdin!.write('{"method":"initialized"}\n');
      const read = await rpc('config/read', { includeLayers: false, cwd: dir }),
        mcp = read.result.config.mcp_servers;
      assert.ok(mcp.yirang_browser, 'browser server visible to config/read');
      const fixed = Object.fromEntries(
        Object.keys(mcp).map((name) => [`mcp_servers.${name}.enabled`, false]),
      );
      const started = await rpc('thread/start', {
        cwd: dir,
        ephemeral: true,
        config: fixed,
        sandbox: 'read-only',
        approvalPolicy: 'never',
      });
      assert.ok(started.result?.thread?.id, started.error?.message || 'thread rejected');
    } finally {
      child.kill();
    }
  },
);

// Real model turn: observation tools run unprompted, browser_click asks first. YIRANG_LIVE_CLI=1 to run.
test(
  'live turn: navigate runs without approval, click asks and is declined',
  { skip: process.env.YIRANG_LIVE_CLI !== '1', timeout: 240000 },
  async () => {
    // @ts-ignore
    const { resolveCodexRuntime } = await import('../apps/electron/cli/codex-runtime.mjs');
    const runtime = await resolveCodexRuntime(),
      dir = mkdtempSync(join(tmpdir(), 'ai-browser-'));
    const overrides = aiBrowserMcpConfig({
      node: process.execPath,
      proxy: join(process.cwd(), 'apps', 'electron', 'browser', 'ai-browser-proxy.mjs'),
      cli: join(process.cwd(), 'node_modules', '@playwright', 'mcp', 'cli.js'),
      directory: dir,
      edge: findEdge() || 'msedge',
    }).map((v: string) => (v.includes('.args=') ? v.replace(/\]$/, ',"--headless"]') : v));
    const child = spawn(
      runtime.path,
      ['app-server', '--stdio', ...overrides.flatMap((v: string) => ['-c', v])],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let serial = 0,
      finish: (s: string) => void = () => {};
    const pending = new Map<number, (m: any) => void>(),
      asked: string[] = [],
      ran: string[] = [],
      messages: string[] = [],
      finished = new Promise<string>((r) => (finish = r));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id !== undefined && m.method) {
        if (m.method === 'mcpServer/elicitation/request')
          asked.push(m.params?._meta?.tool_description || '');
        child.stdin!.write(
          JSON.stringify({
            id: m.id,
            result:
              m.method === 'mcpServer/elicitation/request'
                ? { action: 'decline', content: null, _meta: null }
                : { decision: 'decline' },
          }) + '\n',
        );
        return;
      }
      if (m.id !== undefined) {
        pending.get(m.id)?.(m);
        pending.delete(m.id);
        return;
      }
      if (m.method === 'item/completed' && m.params.item?.type === 'mcpToolCall')
        ran.push(m.params.item.tool + ':' + m.params.item.status);
      if (m.method === 'item/completed' && m.params.item?.type === 'agentMessage')
        messages.push(String(m.params.item.text || ''));
      if (m.method === 'turn/completed') finish(m.params.turn.status);
    });
    const rpc = (method: string, params: any) =>
      new Promise<any>((resolve) => {
        const id = ++serial;
        pending.set(id, resolve);
        child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
      });
    try {
      await rpc('initialize', {
        clientInfo: { name: 'yirang_browser_approval_test', version: '1' },
        capabilities: { experimentalApi: true },
      });
      child.stdin!.write('{"method":"initialized"}\n');
      const t = await rpc('thread/start', { cwd: dir, ephemeral: true });
      const url = 'data:text/html,<button onclick="document.title=\'clicked\'">Go</button>';
      await rpc('turn/start', {
        threadId: t.result.thread.id,
        input: [
          {
            type: 'text',
            text: `Use the yirang_browser tools only. 1) browser_navigate to ${url} 2) browser_snapshot 3) browser_click the Go button. Then reply with the page title. Do nothing else.`,
          },
        ],
      });
      const status = await finished;
      assert.ok(ran.includes('browser_navigate:completed'),
        JSON.stringify({ status, ran, asked, messages }));
      assert.equal(asked.length >= 1, true, 'click must ask for approval');
      assert.ok(ran.includes('browser_click:failed'), ran.join());
    } finally {
      child.kill();
    }
  },
);
