import test from 'node:test';
import assert from 'node:assert/strict';
import { consultationProfile } from '../apps/electron/orchestration/consultation-profile.mjs';
test('consultation disables unrelated MCPs per thread without round-tripping secrets or nullable fields', async () => {
  const config = {
      mcp_servers: {
        ai_desktop: { command: 'node', tool_timeout_sec: null },
        other: { command: 'external', env: { TOKEN: 'private' } },
      },
    },
    before = structuredClone(config),
    calls = [];
  const profile = await consultationProfile(async (method, args) => {
    calls.push({ method, args });
    return { config };
  }, 'C:/workspace');
  assert.deepEqual(calls, [
    { method: 'config/read', args: { includeLayers: false, cwd: 'C:/workspace' } },
  ]);
  assert.equal(profile['mcp_servers.other.enabled'], false);
  assert.equal(profile['mcp_servers.ai_desktop.enabled'], true);
  assert.equal(profile['features.apps'], false);
  assert.ok(!JSON.stringify(profile).includes('private'));
  assert.deepEqual(config, before);
});
test('consultation refuses a configuration missing the desktop tool server', async () => {
  await assert.rejects(
    consultationProfile(async () => ({ config: { mcp_servers: { other: {} } } }), 'C:/workspace'),
    /桌面工具/,
  );
});
