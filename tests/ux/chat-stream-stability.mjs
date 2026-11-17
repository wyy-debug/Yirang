import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('streaming preserves completed blocks and selection, reparses evolving tables and code', async () => {
  const bundle = await build({ stdin: { contents: `
    import {renderMessage} from './apps/electron/conversation/chat-markdown.js';
    window.render = text => renderMessage(document.querySelector('main'), text);
  `, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main></main>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    assert.deepEqual(await page.evaluate(() => {
      window.render('已完成的段落\n\n正在');
      const first = document.querySelector('p');
      const range = document.createRange(); range.selectNodeContents(first);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      for (let i = 0; i < 50; i++) window.render('已完成的段落\n\n正在处理' + i);
      return [first === document.querySelector('p'), getSelection().toString()];
    }), [true, '已完成的段落']);
    await page.evaluate(() => {
      window.render('列 A | 列 B');
      window.render('列 A | 列 B\n--- | ---\n一 | 二');
    });
    assert.equal(await page.locator('table td').count(), 2);
    await page.evaluate(() => { window.render('```js\na'); window.render('```js\nabc\n```'); });
    assert.equal(await page.locator('pre').innerText(), 'abc');
    await page.evaluate(() => window.render('更短的内容'));
    assert.equal(await page.locator('main').innerText(), '更短的内容');
    await page.evaluate(() => window.render('1. 第一项\n2. 第二项\n\n[危险链接](javascript:alert(1))'));
    assert.equal(await page.locator('ol > li').count(), 2);
    assert.equal(await page.locator('.chat-link').count(), 0);
    const measurements = await page.evaluate(() => {
      const base = Array.from({length:200}, (_,i) => `段落 ${i}\n\n`).join('');
      window.render(base + '开始');
      const samples = [];
      for (let i=0;i<50;i++) {
        const start = performance.now(); window.render(base + '流式更新 ' + i);
        samples.push(performance.now()-start);
      }
      return {p95:samples.sort((a,b)=>a-b)[47],blocks:document.querySelector('main').children.length};
    });
    assert.equal(measurements.blocks, 201, 'updates must not duplicate prior blocks');
    assert.ok(measurements.p95 < 100, JSON.stringify(measurements));
  } finally { await browser.close(); }
});
