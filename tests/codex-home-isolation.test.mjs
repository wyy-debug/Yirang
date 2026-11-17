import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveYirangCodexHome, removeInheritedCodexSession } from '../apps/electron/cli/codex-home.mjs';
import { createThreadSessionFiles } from '../apps/electron/conversation/thread-session-files.mjs';

test('Yirang Codex CLI ignores the parent Codex desktop home', () => {
  const profile = resolve('test-output', 'yirang-profile');
  const desktopHome = resolve('test-output', 'desktop-codex-home');
  const home = resolveYirangCodexHome(profile, { CODEX_HOME: desktopHome });
  assert.equal(home, resolve(profile, 'codex-cli-home'));
  assert.notEqual(home, desktopHome);
});

test('an explicit isolated home can be used for validation', () => {
  const profile = resolve('test-output', 'yirang-profile');
  const testHome = resolve('test-output', 'isolated-probe');
  assert.equal(resolveYirangCodexHome(profile, {
    CODEX_HOME: resolve('test-output', 'desktop-codex-home'),
    AI_DESKTOP_CODEX_HOME: testHome,
  }), testHome);
});

test('inherited desktop Codex tool and thread bindings are removed', () => {
  const env = { CODEX_APP_TOOLS_PIPE_PATH: 'desktop-pipe', CODEX_THREAD_ID: 'desktop-thread',
    CODEX_HOME: 'desktop-home', OPENAI_API_KEY: 'unrelated-credential', AI_DESKTOP_PROFILE_DIR: 'profile' };
  removeInheritedCodexSession(env);
  assert.deepEqual(env, { OPENAI_API_KEY: 'unrelated-credential', AI_DESKTOP_PROFILE_DIR: 'profile' });
});

test('Yirang keeps the workspace session but stores its CLI thread ID separately', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'yirang-profile-'));
  const home = resolve(profile, 'codex-cli-home');
  try {
    await mkdir(home);
    await writeFile(resolve(profile, 'workspace-session.json'),
      JSON.stringify({ sessionRef: 'electron:00000000-0000-0000-0000-000000000001' }));
    await writeFile(resolve(profile, 'codex-thread.json'),
      JSON.stringify({ threadId: '00000000-0000-0000-0000-000000000002' }));
    const files = createThreadSessionFiles(profile, home);
    assert.equal(await files.loadWorkspaceSession(),
      'electron:00000000-0000-0000-0000-000000000001');
    assert.equal(await files.loadThreadId(), null);
    await files.saveThreadId('00000000-0000-0000-0000-000000000003');
    assert.equal(JSON.parse(await readFile(resolve(profile, 'codex-thread.json'))).threadId,
      '00000000-0000-0000-0000-000000000002');
    assert.equal(await files.loadThreadId(), '00000000-0000-0000-0000-000000000003');
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
