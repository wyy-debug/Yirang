import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isLoginPortDenied, startCodexLogin } from '../apps/electron/conversation/codex-login.mjs';
import { hasDesktopCodexAuth, importDesktopCodexAuth } from '../apps/electron/cli/codex-auth-import.mjs';

test('a blocked browser callback never starts device code login', async () => {
  const calls = [];
  await assert.rejects(startCodexLogin(async (method, args) => {
    calls.push([method, args.type]);
    throw Error('failed to start login server: 以一种访问权限不允许的方式做了一个访问套接字的尝试。(os error 10013)');
  }, async () => {}), /10013/);
  assert.deepEqual(calls, [['account/login/start', 'chatgpt']]);
  assert.equal(isLoginPortDenied(Error('failed to start login server: os error 10013')), true);
  assert.equal(isLoginPortDenied(Error('401 Unauthorized')), false);
});

test('browser sign-in still opens the Codex authorization URL', async () => {
  const opened = [];
  const result = await startCodexLogin(async () => ({
    loginId: 'browser-1', authUrl: 'https://auth.openai.com/authorize',
  }), async (url) => opened.push(url));
  assert.deepEqual(result, { loginId: 'browser-1', method: 'browser' });
  assert.deepEqual(opened, ['https://auth.openai.com/authorize']);
});

test('explicit import copies only a validated ChatGPT login into a separate home', async () => {
  const base = await mkdtemp(join(tmpdir(), 'yirang-auth-import-'));
  assert.ok(resolve(base).startsWith(resolve(tmpdir())));
  const sourceHome = join(base, 'source');
  const targetHome = join(base, 'target');
  const source = join(sourceHome, '.codex', 'auth.json');
  try {
    await mkdir(join(sourceHome, '.codex'), { recursive: true });
    const fixture = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: 'fake-access', refresh_token: 'fake-refresh',
    } });
    await writeFile(source, fixture);
    assert.equal(await hasDesktopCodexAuth(sourceHome), true);
    assert.equal(await importDesktopCodexAuth(targetHome, sourceHome), true);
    assert.equal(await readFile(join(targetHome, 'auth.json'), 'utf8'), fixture);
    await assert.rejects(importDesktopCodexAuth(targetHome, sourceHome), /已有独立登录文件/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
