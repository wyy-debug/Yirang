import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { PNG } from 'pngjs';

test('real stdio process: discovery, private UI hydration, selected model write and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-desktop-mcp-'));
  const start = async () => {
    const client = new Client({ name: 'g0-test-host', version: '1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', resolve('dist/server.mjs')],
      env: {
        ...(process.env as Record<string, string>),
        AI_DESKTOP_DATA_DIR: dir,
        AI_DESKTOP_PREVIEW_MODE: '0',
      },
      stderr: 'pipe',
    });
    await client.connect(transport);
    return client;
  };
  let client = await start();
  const call = async (name: string, args: any = {}, session = 'host-A'): Promise<any> =>
    client.callTool({ name, arguments: args, _meta: { 'openai/session': session } });
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of [
      'desktop_open',
      'desktop_panel_action',
      'desktop_prepare_context',
      'desktop_read_objects',
      'desktop_commit_changes',
    ])
      assert.ok(names.includes(name), name);
    assert.equal(names.includes('desktop_work_host'), false);
    const entry = tools.tools.find((t) => t.name === 'desktop_open')!;
    assert.deepEqual(entry._meta?.['openai/ui'], { entrypoints: [{ type: 'thread' }] });
    const resource = await client.readResource({ uri: 'ui://ai-desktop/workspace' });
    assert.ok(
      'text' in resource.contents[0] && resource.contents[0].text.includes('<div id="root"></div>'),
    );
    const opened = await call('desktop_open'),
      b = opened._meta.desktop.binding;
    assert.ok(b.workspaceId);
    assert.equal(b.messageRouteAvailable, true);
    assert.ok(!JSON.stringify(opened.content).includes(b.credential));
    const scoped = { workspaceId: b.workspaceId, credential: b.credential };
    const created = await call('desktop_panel_action', {
      ...scoped,
      action: 'create',
      payload: {
        requestId: 'create',
        object: {
          kind: 'text',
          title: '需求',
          content: { blocks: [{ id: 'b1', text: '原文' }] },
          bounds: { x: 0, y: 0, width: 350, height: 300 },
        },
      },
    });
    const object = created._meta.desktop;
    const image = new PNG({ width: 20, height: 20 });
    image.data.fill(255);
    const imageCreated = await call('desktop_panel_action', {
      ...scoped,
      action: 'create',
      payload: {
        requestId: 'image',
        object: {
          kind: 'image',
          title: '视觉材料',
          data: PNG.sync.write(image).toString('base64'),
          bounds: { x: 400, y: 0, width: 350, height: 300 },
        },
      },
    });
    const imageId = imageCreated._meta.desktop.id;
    const prepared = await call('desktop_prepare_context', {
      ...scoped,
      requestId: 'selection',
      objectIds: [object.id, imageId],
      expectedRevisions: { [object.id]: 1, [imageId]: 1 },
      instruction: '修改原文',
    });
    const p = prepared._meta.desktop;
    assert.equal(p.content[1].type, 'image');
    const exec = p.content[0].text.match(/credential=(execution_[\w-]+)/)[1];
    const read = await call('desktop_read_objects', {
      workspaceId: b.workspaceId,
      credential: exec,
      objectIds: [object.id],
    });
    assert.equal(read.structuredContent.objects[0].content.blocks[0].text, '原文');
    const changed = await call('desktop_commit_changes', {
      workspaceId: b.workspaceId,
      credential: exec,
      requestId: 'write',
      expectedRevisions: { [object.id]: 1 },
      operations: [
        {
          type: 'replace_text',
          objectId: object.id,
          content: { blocks: [{ id: 'b1', text: '通过真实 stdio 工具修改' }] },
        },
      ],
    });
    assert.equal(changed.structuredContent.changed[0].revision, 2);
    const denied = await call('desktop_get_workspace', scoped, 'host-B');
    assert.equal(denied.isError, true);
    await client.close();
    client = await start();
    const reopened = await call('desktop_open');
    assert.equal(reopened._meta.desktop.binding.workspaceId, b.workspaceId);
    assert.equal(
      reopened._meta.desktop.workspace.objects[0].content.blocks[0].text,
      '通过真实 stdio 工具修改',
    );
    const logs = readFileSync(join(dir, 'diagnostics.jsonl'), 'utf8');
    assert.ok(!logs.includes('原文'));
    assert.ok(!logs.includes(exec));
    assert.ok(!logs.includes('host-A'));
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two stdio processes serialize competing writes, and acknowledged data survives forced termination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-desktop-mcp-race-'));
  const start = async () => {
    const c = new Client({ name: 'race-harness', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', resolve('dist/server.mjs')],
      env: {
        ...(process.env as Record<string, string>),
        AI_DESKTOP_DATA_DIR: dir,
        AI_DESKTOP_PREVIEW_MODE: '0',
      },
      stderr: 'pipe',
    });
    await c.connect(transport);
    return { c, transport };
  };
  const first = await start(),
    second = await start();
  const call = (c: Client, name: string, args: any = {}): Promise<any> =>
    c.callTool({ name, arguments: args, _meta: { 'openai/session': 'race-A' } });
  try {
    const opened = (await call(first.c, 'desktop_open'))._meta.desktop,
      b = opened.binding;
    const created = (
      await call(first.c, 'desktop_panel_action', {
        workspaceId: b.workspaceId,
        credential: b.credential,
        action: 'create',
        payload: {
          requestId: 'create',
          object: {
            kind: 'text',
            title: '并发测试',
            content: { blocks: [{ id: 'b', text: 'zero' }] },
            bounds: { x: 0, y: 0, width: 350, height: 300 },
          },
        },
      })
    )._meta.desktop;
    const commit = (c: Client, label: string) =>
      call(c, 'desktop_commit_changes', {
        workspaceId: b.workspaceId,
        credential: b.credential,
        requestId: label,
        expectedRevisions: { [created.id]: 1 },
        operations: [
          {
            type: 'replace_text',
            objectId: created.id,
            content: { blocks: [{ id: 'b', text: label }] },
          },
        ],
      });
    const outcomes = await Promise.all([commit(first.c, 'first'), commit(second.c, 'second')]);
    assert.equal(outcomes.filter((r) => !r.isError).length, 1);
    assert.equal(
      outcomes.filter((r) => r.structuredContent?.error?.code === 'REVISION_CONFLICT').length,
      1,
    );
    const winner = outcomes[0].isError ? 'second' : 'first';
    // Only terminate the exact process created by this test, after its response acknowledged commit.
    const pid = first.transport.pid;
    assert.ok(pid && pid > 0 && pid !== process.pid);
    process.kill(pid!, 'SIGKILL');
    await first.c.close();
    await second.c.close();
    const third = await start();
    try {
      const recovered = (await call(third.c, 'desktop_open'))._meta.desktop;
      assert.equal(recovered.workspace.objects[0].revision, 2);
      assert.equal(recovered.workspace.objects[0].content.blocks[0].text, winner);
    } finally {
      await third.c.close();
    }
  } finally {
    await first.c.close();
    await second.c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
