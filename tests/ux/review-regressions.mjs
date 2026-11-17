import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

async function fixture({ html = '<div id="root"></div>', entry = '', styles = [] }, check) {
  const bundle = entry
    ? await build({
        stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() },
        bundle: true,
        write: false,
        outfile: 'fixture.js',
        format: 'iife',
        loader: { '.png': 'dataurl' },
      })
    : null;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://127.0.0.1/review', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto('http://127.0.0.1/review');
    for (const path of ['apps/electron/design-tokens.css', ...styles])
      await page.addStyleTag({
        content: (await readFile(path, 'utf8')).replace(/@import[^;]*;/g, ''),
      });
    for (const f of bundle?.outputFiles.filter((f) => f.path.endsWith('.css')) || [])
      await page.addStyleTag({ content: f.text });
    await page.clock.install();
    if (bundle)
      await page.addScriptTag({
        content: bundle.outputFiles.find((f) => f.path.endsWith('.js')).text,
      });
    await check(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

test('permissions stay Codex-only and inherited worker effort matches the selected main model', async () => {
  await fixture(
    {
      html: '<div class="composer-tools"><button id="stop">Stop</button></div>',
      entry: `
 import {createComposerControls} from './apps/electron/composer/composer-controls.js';
 import {createPermissionControls} from './apps/electron/composer/permission-controls.js';
 const events=[];window.emit=e=>events.forEach(fn=>fn(e));window.reads=0;window.saved={model:'selected',effort:null,childModel:null,childEffort:'low'};
 const state=()=>({threadId:'current',ready:true});
 window.desktop={onEvent:fn=>events.push(fn),permissions:async()=>{window.reads++;return {threadId:'current',mode:'user',supported:true,effective:{approvalsReviewer:'user'}};},chat:async(method)=>method==='preferences'?window.saved:method==='runtime'?{config:{model:'cli',effort:'low'}}:method==='models'?[{model:'selected',defaultReasoningEffort:'high',supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort}))}]:{}};
 createComposerControls({state});createPermissionControls({state});window.emit({type:'ready',payload:{}});
 `,
    },
    async (page) => {
      await page.locator('.composer-permission').click();
      assert.equal(await page.locator('.permission-popover').isVisible(), true);
      for (const id of ['claude', 'acp']) {
        await page.evaluate((id) => window.emit({ type: 'provider', payload: { id } }), id);
        await page.waitForFunction(() => document.querySelector('.composer-permission').hidden);
        assert.equal(await page.locator('.permission-popover').isVisible(), false);
        const before = await page.evaluate(() => window.reads);
        await page.evaluate(() => window.dispatchEvent(new Event('desktop-show-permissions')));
        assert.equal(await page.locator('.permission-popover').isVisible(), false);
        assert.equal(await page.evaluate(() => window.reads), before);
      }
      await page.evaluate(() => window.emit({ type: 'provider', payload: { id: 'codex' } }));
      await page.waitForFunction(() => !document.querySelector('.composer-permission').hidden);
      await page.locator('.composer-permission').click();
      assert.equal(await page.locator('.permission-popover').isVisible(), true);
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const box = document.createElement('div');
        box.id = 'fake-settings';
        (document.querySelector('.chat-body') || document.body).append(box);
        const controller = new AbortController();
        window.closeFakeSettings = () => {
          controller.abort();
          box.remove();
        };
        window.dispatchEvent(
          new CustomEvent('desktop-settings-open', {
            detail: {
              modal: { close() {}, append() {} },
              sections: {},
              signal: controller.signal,
              button: (label, action) => {
                const b = document.createElement('button');
                b.textContent = label;
                b.onclick = action;
                return b;
              },
              row: (category, title, description, actions = []) => {
                const section = document.createElement('section');
                section.dataset.title = title;
                section.append(...actions);
                box.append(section);
                return section;
              },
            },
          }),
        );
      });
      await page.waitForFunction(
        () =>
          document.querySelector('.child-effort-select option:checked')?.textContent ===
          '跟随主任务 · 高',
      );
      assert.equal(
        await page.locator('.child-effort-select').isDisabled(),
        true,
        'inherited worker effort is not separately adjustable',
      );
    },
  );
});

test('records stay scoped and Escape returns to the mounted records trigger', async () => {
  await fixture(
    {
      entry: `
 import React from 'react';import {createRoot} from 'react-dom/client';import {IntentWorkbench} from './apps/panel/interaction/intent-workbench.tsx';
 createRoot(document.getElementById('root')).render(<IntentWorkbench workspaceId="desk" visible/>);
 `,
    },
    async (page) => {
      await page.locator('.intent-ask').waitFor();
      await page.evaluate(() => {
        window.postMessage(
          { type: 'yirang:native-work-stream', workspaceId: 'other',
            records: [{ requestId: 'other', title: '其他桌面', state: 'failed' }], batches: [] },
          '*',
        );
        window.postMessage(
          { type: 'yirang:native-work-stream', workspaceId: 'desk',
            records: [{ requestId: 'local', title: '等待确认', state: 'unknown' }], batches: [] },
          '*',
        );
      });
      const opener = page.getByRole('button', { name: /查看执行记录/ });
      await opener.click();
      await page.locator('.intent-work-list').waitFor();
      assert.equal(await page.locator('.intent-work-list article').count(), 1);
      assert.equal(await page.locator('.intent-work-list article').innerText().then((s) => s.includes('等待确认')), true);
      assert.equal(await page.locator('.desk-popover-panel').count(), 0);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.intent-work-list'));
      assert.equal(await opener.evaluate((node) => node === document.activeElement), true);
    },
  );
});

test('Office document colors survive dark mode and SVG zoom controls retain contrast', async () => {
  await fixture(
    {
      html: `<div class="desktop-preview-backdrop"><div class="desktop-preview-window"><article class="desktop-preview-word"><p style="color:black">Black document text</p><p style="color:red">Red document text</p></article><div class="desktop-preview-ppt" style="background:white"><p>Default slide text</p></div><div class="desktop-preview-slide-text">Slide notes</div><div class="native-svg-editor"><div class="native-svg-toolbar"><div class="native-svg-zoom"><button>+</button></div></div></div></div></div>`,
      styles: [
        'apps/panel/documents/desktop-preview.css',
        'apps/panel/documents/native/native-svg-editor.css',
      ],
    },
    async (page) => {
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        const colors = await page.evaluate(() => {
          const read = (selector, key) => getComputedStyle(document.querySelector(selector))[key];
          return {
            paper: read('.desktop-preview-word', 'backgroundColor'),
            black: read('.desktop-preview-word p', 'color'),
            red: read('.desktop-preview-word p+p', 'color'),
            slide: read('.desktop-preview-ppt p', 'color'),
            notes: read('.desktop-preview-slide-text', 'color'),
            toolbar: read('.native-svg-toolbar', 'backgroundColor'),
            zoom: read('.native-svg-zoom button', 'color'),
          };
        });
        assert.equal(colors.paper, 'rgb(255, 255, 255)');
        assert.equal(colors.black, 'rgb(0, 0, 0)');
        assert.equal(colors.red, 'rgb(255, 0, 0)');
        assert.equal(colors.slide, 'rgb(17, 17, 17)');
        assert.equal(colors.notes, 'rgb(17, 17, 17)');
        const luminance = (value) =>
          value
            .match(/\d+/g)
            .slice(0, 3)
            .map((x) => Number(x) / 255)
            .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
            .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
        const a = luminance(colors.toolbar),
          b = luminance(colors.zoom);
        assert.ok(
          (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
          theme + ' SVG toolbar contrast',
        );
      }
    },
  );
});
