import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedVoice } from '../apps/electron/voice/managed-voice.mjs';

for (const local of [true, false])
  test(`voice ${local ? 'start' : 'fork'} inherits MCP configuration without serializing nullable fields`, async () => {
    const servers = {
      ai_desktop: { command: 'node', tool_timeout_sec: 180 },
      node_repl: { tool_timeout_sec: null },
      'deepseek-harness': {
        tool_timeout_sec: null,
        startup_timeout_sec: null,
        env: { TOKEN: 'private' },
      },
    };
    const original = structuredClone(servers),
      calls = [];
    const voice = createManagedVoice({
      state: () => ({
        threadId: 'origin',
        ready: true,
        provider: 'codex',
        selection: [],
        outputRoot: 'workspace',
        local,
      }),
      call: async () => ({ workspaceId: 'workspace', availableIds: [] }),
      work: {},
      activate: async () => {},
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'config/read') return { config: { mcp_servers: servers } };
        if (method === 'thread/start' || method === 'thread/fork')
          return { thread: { id: 'voice' } };
        return {};
      },
    });
    await voice.prepare();
    const profile = calls.find((c) => c.method === (local ? 'thread/start' : 'thread/fork')).params;
    assert.deepEqual(profile.config, {
      'mcp_servers.ai_desktop.tools.desktop_voice_work.approval_mode': 'approve',
      'features.multi_agent': false,
      'features.apps': false,
      'mcp_servers.ai_desktop.enabled': true,
      'mcp_servers.node_repl.enabled': false,
      'mcp_servers.deepseek-harness.enabled': false,
    });
    assert.equal(profile.sandbox, 'read-only');
    assert.equal(profile.approvalPolicy, 'never');
    assert.deepEqual(servers, original);
    assert.ok(!JSON.stringify(profile).includes('private'));
  });
