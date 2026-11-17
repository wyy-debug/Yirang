import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// No live user data, AI requests, Electron profile or external network required.
test('desktop UX walkthrough — production components at PC 2K', { timeout: 120000 }, async (t) => {
  const output = resolve('output/playwright/desktop-ux');
  await mkdir(output, { recursive: true });
  const compiled = await build({
    entryPoints: ['tests/ux/desktop-fixture.tsx'],
    bundle: true,
    write: false,
    outfile: 'fixture.js',
    format: 'iife',
    loader: { '.png': 'dataurl', '.svg': 'dataurl' },
  });
  const js = compiled.outputFiles.find((f) => f.path.endsWith('.js')).text,
    css = compiled.outputFiles.find((f) => f.path.endsWith('.css')).text;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><html lang="zh-CN"><head><style>${css}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`,
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const browser = await chromium.launch({
    channel: process.env.UX_BROWSER || 'msedge',
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 2560, height: 1440 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  t.after(async () => {
    await writeFile(
      resolve(output, 'metrics.json'),
      JSON.stringify(
        {
          errors,
          metrics: await page
            .evaluate(() => ({ commits: window.ux.commits, requests: window.ux.requests.length }))
            .catch(() => null),
        },
        null,
        2,
      ),
    );
    await page.context().tracing.stop({ path: resolve(output, 'trace.zip') });
    await browser.close();
  });
  const load = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(
      () => document.querySelector('.app-notification-bar b')?.textContent === '100',
    );
  };
  const wait = (fn) => page.waitForFunction(fn, {}, { timeout: 2500 });
  await t.test(
    'collapsed notifications allow screenshot button and shortcut; expanded popup still blocks',
    async () => {
      await load();
      const start = page.getByRole('button', { name: '截图问 AI', exact: true });
      const selection = page.locator('.screenshot-ai-select');
      await start.click();
      await selection.waitFor();
      assert.equal(await page.getByLabel('截图提示').textContent(), '');
      await page.keyboard.press('Escape');
      await selection.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '应用通知' }).click();
      await page.keyboard.press('Control+Shift+s');
      assert.equal(await selection.count(), 0);
      assert.match(await page.getByLabel('截图提示').textContent(), /请先关闭弹窗/);
      await page.getByRole('button', { name: '关闭通知' }).click();
      await page.keyboard.press('Control+Shift+s');
      await selection.waitFor();
      await page.keyboard.press('Escape');
      await selection.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '打开测试应用', exact: true }).click();
      await page.getByTitle('测试应用', { exact: true }).waitFor();
      await page.getByRole('button', { name: '返回桌面', exact: true }).click();
      await start.click();
      await selection.waitFor();
      await page.keyboard.press('Escape');
      await selection.waitFor({ state: 'detached' });
    },
  );
  await t.test(
    'preview screenshot spans the viewport and references the previewed material',
    async () => {
      await load();
      const selection = page.locator('.screenshot-ai-select');
      await page.getByRole('button', { name: '截图问 AI', exact: true }).click();
      await selection.waitFor();
      assert.equal((await selection.boundingBox()).x, 155);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '预览测试文件', exact: true }).click();
      const preview = page.locator('.desktop-preview-window');
      await preview.waitFor();
      await page.keyboard.press('Control+Shift+s');
      await selection.waitFor();
      assert.deepEqual(await selection.boundingBox(), { x: 0, y: 0, width: 2560, height: 1440 });
      await page.keyboard.press('Escape');
      await selection.waitFor({ state: 'detached' });
      assert.equal(await preview.isVisible(), true);

      await page.keyboard.press('Control+Shift+s');
      await selection.waitFor();
      await page.mouse.move(2, 2);
      await page.mouse.down();
      await page.mouse.move(2558, 1438);
      await page.mouse.up();
      const composer = page.locator('.screenshot-ai-composer');
      await composer.waitFor();
      assert.deepEqual(await page.evaluate(() => window.ux.capture), {
        x: 2,
        y: 2,
        width: 2556,
        height: 1436,
      });
      assert.match(await composer.locator('.screenshot-ai-sources').innerText(), /报告\.md/);
      await page.keyboard.press('Escape');
      await composer.waitFor({ state: 'detached' });
      assert.equal(await preview.isVisible(), true);
    },
  );
  await t.test(
    'clear all stays accessible after scrolling; failed clear retains notifications and can retry',
    async () => {
      await load();
      await page.getByRole('button', { name: '应用通知' }).click();
      await page
        .locator('.app-notification-list')
        .evaluate((el) => (el.scrollTop = el.scrollHeight));
      const clear = page.getByRole('button', { name: '一键清空' });
      assert.equal(
        await clear.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
        true,
        'clear must not scroll out or be covered',
      );
      await page.evaluate(() => (window.ux.failClear = true));
      await clear.click();
      await page.getByRole('status').filter({ hasText: '通知存储暂时不可用' }).waitFor();
      assert.equal(await page.locator('.app-notification-item').count(), 100);
      await page.evaluate(() => (window.ux.failClear = false));
      await clear.click();
      await page.getByText('暂无通知', { exact: true }).waitFor();
      assert.equal(await page.locator('.app-notification-bar b').count(), 0);
      assert.equal(await clear.isDisabled(), true);
      await page.getByRole('button', { name: '刷新应用', exact: true }).click();
      await page.screenshot({ path: resolve(output, 'notifications-cleared.png') });
      assert.equal(await page.locator('.app-notification-item').count(), 0);
    },
  );
  await t.test(
    'an in-flight old snapshot cannot resurrect cleared notices or drop the next refresh',
    async () => {
      await load();
      await page.evaluate(() => (window.ux.hold = true));
      await page.getByRole('button', { name: '刷新应用', exact: true }).click();
      await wait(() => window.ux.pending.length === 1);
      await page.getByRole('button', { name: '应用通知' }).click();
      await page.getByRole('button', { name: '一键清空' }).click();
      await page.getByText('暂无通知', { exact: true }).waitFor();
      await page.evaluate(() => {
        window.ux.notes = [
          {
            id: 'new',
            workspaceId: 'a',
            title: '新的完成通知',
            createdAt: Date.now(),
            read: false,
          },
        ];
        window.ux.hold = false;
        window.ux.release();
      });
      await page.getByText('新的完成通知', { exact: true }).waitFor({ timeout: 2500 });
      assert.equal(await page.locator('.app-notification-item').count(), 1);
    },
  );
  await t.test('notification popup dismisses with Escape and returns focus', async () => {
    await load();
    const trigger = page.getByRole('button', { name: '应用通知' });
    await trigger.click();
    await page.getByRole('button', { name: '一键清空' }).focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.app-notification-list').count(), 0);
    assert.equal(
      await trigger.evaluate((el) => el === document.activeElement),
      true,
      'keyboard focus must not fall back to body',
    );
  });
  await t.test(
    'switching from an app to desktop retains the same iframe and does not restart its service',
    async () => {
      await load();
      await page.getByRole('button', { name: '打开测试应用', exact: true }).click();
      const app = page.getByTitle('测试应用', { exact: true });
      await app.waitFor();
      await app.evaluate((el) => (el.dataset.identity = 'retained'));
      const open = page.getByRole('button', { name: '打开测试应用', exact: true });
      for (let i = 0; i < 5; i++) {
        await page.getByRole('button', { name: '返回桌面', exact: true }).click();
        await app.waitFor({ state: 'hidden' });
        await open.click();
        await app.waitFor({ timeout: 2500 }).catch(async (error) => {
          const state = await app.evaluate((el) => ({
            slot: el.closest('.light-app-page-slot')?.outerHTML.slice(0, 140),
            viewport: [window.innerWidth, window.innerHeight],
            bounds: el.getBoundingClientRect().toJSON(),
            active: document.querySelector('main')?.dataset.activeApp,
          }));
          throw Error(JSON.stringify(state), { cause: error });
        });
        assert.equal(await app.getAttribute('data-identity'), 'retained');
      }
      assert.equal(
        await page.evaluate(() => window.ux.requests.filter((r) => r.operation === 'open').length),
        1,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.ux.requests.filter((r) => r.operation === 'close_page' || r.operation === 'stop')
              .length,
        ),
        0,
      );
    },
  );
  await t.test(
    'context menu stays inside viewport, skips disabled actions and dismisses without executing',
    async () => {
      await load();
      const target = page.getByRole('button', { name: '所选材料' });
      await target.focus();
      await target.click({ button: 'right' });
      const menu = page.getByRole('menu', { name: '桌面操作' });
      await menu.waitFor();
      const box = await menu.boundingBox();
      assert.ok(
        box.x >= 0 && box.y >= 0 && box.x + box.width <= 2560 && box.y + box.height <= 1440,
      );
      await page.keyboard.press('Home');
      assert.equal(
        await page
          .getByRole('menuitem', { name: '打包导出 ZIP' })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await menu.waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => window.ux.actions), ['delete']);
      await target.click({ button: 'right' });
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => window.ux.actions), ['delete']);
      await target.click({ button: 'right' });
      await page.screenshot({ path: resolve(output, 'context-menu-2k.png') });
      await page.mouse.click(600, 500);
      await menu.waitFor({ state: 'detached' });
    },
  );
  await t.test(
    'refresh storms are coalesced; unchanged catalog does not commit repeated UI renders',
    async () => {
      await load();
      await page.evaluate(() => {
        window.ux.requests = [];
        window.ux.commits = [];
        window.ux.hold = true;
        for (let i = 0; i < 30; i++) window.dispatchEvent(new Event('yirang:apps-changed'));
      });
      await wait(() => window.ux.pending.length === 1);
      assert.equal(await page.evaluate(() => window.ux.requests.length), 1);
      await page.evaluate(() => {
        window.ux.hold = false;
        window.ux.release();
      });
      await page.waitForTimeout(150); // bounded settling window, not a timing assertion
      assert.ok(
        (await page.evaluate(() => window.ux.requests.length)) <= 2,
        'burst should need at most one trailing refresh',
      );
      assert.equal(
        await page.evaluate(() => window.ux.commits.length),
        0,
        'identical data must preserve React state identity',
      );
      for (let i = 0; i < 6; i++)
        await page.getByRole('button', { name: '切换桌面', exact: true }).click();
      await page.waitForTimeout(150);
      const before = await page.evaluate(() => window.ux.requests.length);
      await page.getByRole('button', { name: '刷新应用', exact: true }).click();
      await wait(() => window.ux.requests.length > 0);
      await page.waitForTimeout(100);
      assert.equal(
        (await page.evaluate(() => window.ux.requests.length)) - before,
        1,
        'workspace switches must not leak event listeners',
      );
    },
  );
  assert.deepEqual(errors, [], 'no browser runtime errors');
});
