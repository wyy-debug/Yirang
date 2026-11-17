import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
test('model picker stays in card and persists supported reasoning levels', async () => {
  const js = (
    await build({
      stdin: {
        contents: `import {createComposerControls} from './apps/electron/composer/composer-controls.js';createComposerControls({state:()=>({running:false})});window.emit({type:'ready'});`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: 'iife',
    })
  ).outputFiles[0].text;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
    await page.setContent(
      '<div style="position:fixed;bottom:20px;right:20px;width:400px"><div class="composer-tools"></div></div>',
    );
    await page.addStyleTag({ content: await readFile('apps/electron/design-tokens.css', 'utf8') });
    for (const path of ['apps/electron/shell.css', 'apps/electron/composer/composer-layout.css'])
      await page.addStyleTag({ content: await readFile(path, 'utf8') });
    await page.evaluate(() => {
      window.saved = { model: 'terra', effort: 'xhigh' };
      window.calls = [];
      window.desktop = {
        onEvent: (f) => (window.emit = f),
        chat: async (method, p) => {
          if (method === 'models')
            return ['terra', 'sol'].map((model) => ({
              model,
              displayName: model === 'terra' ? 'GPT Terra' : 'GPT Sol',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(
                (reasoningEffort) => ({ reasoningEffort }),
              ),
            }));
          if (method === 'preferences') return window.saved;
          if (method === 'runtime') return { config: { model: 'terra', effort: 'high' } };
          if (method === 'configure') {
            window.calls.push(p);
            return (window.saved = p);
          }
          return {};
        },
      };
    });
    await page.addScriptTag({ content: js });
    await page.locator('.composer-model').click();
    const anchor = await page.locator('.composer-model').boundingBox();
    const card = await page.locator('dialog').boundingBox();
    assert.ok(Math.abs(card.x - anchor.x) < 2, 'card aligns with model trigger');
    assert.ok(card.y + card.height <= anchor.y, 'card stays above trigger');
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    const expanded = await page.locator('dialog').boundingBox();
    assert.ok(Math.abs(expanded.x - anchor.x) < 2, 'model list keeps the same anchor');
    assert.ok(expanded.y + expanded.height <= anchor.y, 'model list stays above trigger');
    assert.equal(await page.locator('.model-compact select').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(
      await page.locator('dialog').evaluate((el) => el.open),
      true,
      'Escape in the model list returns to the slider',
    );
    assert.equal(await page.getByRole('slider', { name: '思考强度' }).isVisible(), true);
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    await page.getByRole('button', { name: 'GPT Sol', exact: true }).click();
    await page.waitForFunction(() => window.saved.model === 'sol');
    const slider = () => page.getByRole('slider', { name: '思考强度' });
    assert.equal(await slider().getAttribute('aria-valuetext'), '中');
    await slider().focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.saved.effort === 'high');
    assert.equal(await slider().getAttribute('aria-valuetext'), '高');
    assert.equal(await page.locator('.effort-name').textContent(), '高');
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    await page.getByRole('button', { name: 'CLI 默认模型', exact: true }).click();
    await page.waitForFunction(() => window.saved.model === '');
    assert.equal(await slider().getAttribute('aria-valuetext'), '高');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').evaluate((el) => el.open), false);
  } finally {
    await browser.close();
  }
});
