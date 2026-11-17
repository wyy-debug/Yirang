import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntentWorkbench } from './apps/panel/interaction/intent-workbench.tsx';
import { setUiLanguage } from './packages/components/ui-language.ts';
const root = createRoot(document.getElementById('root'));
let mounts = 0;
window.language = setUiLanguage;
window.calls = [];
window.addEventListener('message', (event) => window.calls.push(event.data));
window.mount = () => root.render(<IntentWorkbench key={++mounts} workspaceId="desk" visible />);
window.stream = (records, batches) =>
  window.postMessage({ type: 'yirang:native-work-stream', workspaceId: 'desk', records, batches }, '*');
window.mount();
`;

test('task records pin running work, announce results and clear only finished entries', async () => {
  const bundle = await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true,
    write: false,
    outfile: 'fixture.js',
    format: 'iife',
  });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 800 },
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://127.0.0.1/records', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html class="electron-mode"><body><div id="root"></div></body></html>',
      }),
    );
    await page.goto('http://127.0.0.1/records');
    await page.addStyleTag({ content: await readFile('apps/electron/design-tokens.css', 'utf8') });
    for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
      await page.addStyleTag({ content: file.text });
    await page.addStyleTag({ content: await readFile('apps/panel/electron-mode.css', 'utf8') });
    await page.addStyleTag({
      content: 'body{background:#f5f7fa}.electron-mode{--workspace-nav-width:0px}',
    });
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
    });
    const requests = () =>
      page.evaluate(
        () => window.calls.filter((call) => call.type === 'yirang:native-work-request').length,
      );
    const mounted = async (count) =>
      page.waitForFunction(
        (count) =>
          window.calls.filter((call) => call.type === 'yirang:native-work-request').length > count,
        count,
      );
    const stream = (records) =>
      page.evaluate(([records, batches]) => window.stream(records, batches), [records, batches]);
    const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
    const records = [
      {
        requestId: 'svg',
        threadId: 'thread-svg',
        title: 'repair-svg-display-object_1d2355b9',
        state: 'completed',
        updatedAt: at(5),
      },
      {
        requestId: 'sheet',
        threadId: 'thread-sheet',
        title: '整理销售表格',
        state: 'failed',
        updatedAt: at(30),
      },
      {
        requestId: 'deck',
        threadId: 'thread-deck',
        title: '做一个PPT出来',
        state: 'running',
        updatedAt: at(90),
      },
    ];
    const batches = [
      {
        id: 'svg',
        threadId: 'thread-svg',
        state: 'ready',
        issues: 0,
        files: [{ objectId: 'svg-file', title: '架构图.svg', result: 'updated' }],
      },
      {
        id: 'svg-older',
        threadId: 'thread-svg',
        state: 'ready',
        issues: 0,
        files: [{ objectId: 'draft-file', title: '旧草稿.svg', result: 'created' }],
      },
    ];
    await mounted(0);
    await stream(records);
    const badges = page.locator('.intent-record-badge');
    await badges.first().waitFor();
    assert.deepEqual(await badges.allTextContents(), ['1 进行中', '1 需处理']);
    const trigger = page.getByRole('button', { name: '查看执行记录', exact: true });
    assert.equal(
      await trigger.evaluate(
        (node) => document.getElementById(node.getAttribute('aria-describedby')).textContent,
      ),
      '1 进行中1 需处理',
    );

    await trigger.click();
    const list = page.getByRole('region', { name: '执行记录' });
    const articles = list.locator('article');
    assert.equal(await articles.count(), 3);
    assert.deepEqual(await list.locator('.intent-work-group').allTextContents(), [
      '进行中1',
      '已结束2',
    ]);
    assert.equal(
      await articles.nth(0).evaluate((node) => node.classList.contains('tone-running')),
      true,
    );
    assert.match(await articles.nth(0).textContent(), /做一个PPT出来进行中正在处理/);
    assert.equal(
      await articles.nth(1).locator('strong').textContent(),
      'Repair svg display object',
    );
    assert.deepEqual(await articles.nth(1).locator('.intent-result span').allTextContents(), [
      '架构图.svg',
    ]);
    assert.match(await articles.nth(2).textContent(), /未能完成这次没有完成/);
    assert.doesNotMatch(await list.textContent(), /thread-|回合|执行详情/);
    await mkdir('test-results/work-records', { recursive: true });
    await page.screenshot({ path: 'test-results/work-records/list.png' });

    await list.getByRole('button', { name: '一键清空', exact: true }).click();
    assert.equal(await articles.count(), 1);
    assert.match(await list.locator('.intent-cleared').textContent(), /已清空 2 条记录/);
    await page.waitForFunction(() => document.activeElement?.textContent === '撤销');
    assert.deepEqual(
      await page.evaluate(() =>
        Object.keys(JSON.parse(localStorage.getItem('yirang:work-records-cleared:desk'))).sort(),
      ),
      ['sheet', 'svg'],
    );
    await page.screenshot({ path: 'test-results/work-records/cleared.png' });
    await list.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await articles.count(), 3);
    await list.getByRole('button', { name: '一键清空', exact: true }).click();
    assert.equal(await articles.count(), 1);
    await page.keyboard.press('Escape');

    const before = await requests();
    await page.evaluate(() => window.mount());
    await mounted(before);
    await stream(records);
    await badges.first().waitFor();
    assert.deepEqual(await badges.allTextContents(), ['1 进行中']);

    const finished = records.map((record) =>
      record.requestId === 'deck' ? { ...record, state: 'completed', updatedAt: at(0) } : record,
    );
    await stream(finished);
    const notice = page.locator('.intent-work-notice');
    await notice.waitFor();
    assert.match(await notice.textContent(), /做一个PPT出来已完成/);
    assert.equal(await page.locator('.intent-live').textContent(), '做一个PPT出来 已完成');
    assert.deepEqual(await badges.allTextContents(), ['1 刚完成']);
    await page.screenshot({ path: 'test-results/work-records/notice.png' });
    await notice.getByRole('button', { name: '查看', exact: true }).click();
    assert.equal(await notice.count(), 0);
    assert.equal(await list.locator('article.fresh').count(), 1);
    assert.match(await list.locator('article.fresh').textContent(), /刚完成/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.intent-record-badge'));

    await stream(
      finished.map((record) =>
        record.requestId === 'sheet' ? { ...record, updatedAt: at(0) } : record,
      ),
    );
    await page.waitForFunction(
      () => document.querySelector('.intent-record-badge')?.textContent === '1 需处理',
    );
    await page.evaluate(() => window.language('en'));
    await page.getByRole('button', { name: 'View AI tasks', exact: true }).waitFor();
    assert.deepEqual(await badges.allTextContents(), ['1 to check']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
