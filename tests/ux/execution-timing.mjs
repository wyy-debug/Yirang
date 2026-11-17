import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';

const run = (id, taskId, start, end, spans, model = 'GPT-6-Luna') => ({
  id,
  turnId: id,
  threadId: id,
  taskId,
  model,
  effort: 'medium',
  startedAt: start,
  endedAt: end,
  observedAt: end,
  status: 'completed',
  spans: spans.map(([kind, start, end]) => ({ kind, start, end })),
  tools: id === 'integrate' ? [{ id: 'save', label: '修改文件', start: 37000, end: 43000 }] : [],
});
const data = {
  observedAt: 43000,
  tasks: [
    { id: 'root', title: '整理季度报告', state: 'review' },
    { id: 'check', title: '核对资料', parentTaskId: 'root', state: 'review' },
    { id: 'draft', title: '起草报告', parentTaskId: 'root', state: 'review' },
  ],
  runs: [
    run('plan', 'root', 1000, 5000, [['model', 1000, 5000]]),
    run('check', 'check', 5000, 17000, [
      ['model', 5000, 13000],
      ['tool', 13000, 17000],
    ]),
    run('draft', 'draft', 5000, 25000, [
      ['model', 5000, 19000],
      ['tool', 19000, 25000],
    ]),
    run('integrate', 'root', 25000, 43000, [
      ['model', 25000, 37000],
      ['tool', 37000, 43000],
    ]),
  ],
};

test('the unified composer exposes model controls; timing stays readable, keyboard accessible and localized', async () => {
  const js = (
    await build({
      stdin: {
        contents: `import {createComposerControls} from './apps/electron/composer/composer-controls.js';import {createTimingCard} from './apps/electron/timing/execution-timing-ui.js';import {setUiLanguage} from './packages/components/ui-language.js';window.language=setUiLanguage;window.makeTimingCard=createTimingCard;window.controls=createComposerControls({state:()=>({running:true,threadId:'same-thread'})});window.card=createTimingCard({load:async()=>window.fixture});document.querySelector('.wm-timing').append(window.card.element);window.card.refresh();window.emit({type:'ready'});`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: 'iife',
    })
  ).outputFiles[0].text;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(
      '<main class="timing-fixture"><section class="wm-panel"><header><strong>整理季度报告</strong><small>耗时明细</small></header><div class="wm-timing"></div></section><aside><header>AI 助手</header><p>报告已整理，关键结论和建议已汇总。</p><div class="compose"><div class="composer"><textarea placeholder="继续提问或交办下一件事…"></textarea><div class="composer-tools"><button class="send-button" aria-label="发送"><svg viewBox="0 0 24 24"><path d="M12 19V5m-5 5 5-5 5 5"/></svg></button></div></div></div><div id="status"></div></aside></main>',
    );
    await page.addStyleTag({ content: await readFile('apps/electron/design-tokens.css', 'utf8') });
    for (const path of [
      'apps/electron/shell.css',
      'apps/electron/timing/execution-timing.css',
      'apps/electron/composer/composer-layout.css',
    ])
      await page.addStyleTag({ content: await readFile(path, 'utf8') });
    await page.addStyleTag({
      content:
        'body{height:auto;overflow:auto;background:#f4f6f9;margin:0;padding:24px;font:14px "Segoe UI","Microsoft YaHei",sans-serif}.timing-fixture{display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:24px;max-width:1200px;margin:0 auto}.wm-panel,aside{min-width:0;background:white;border:1px solid #dde5ee;border-radius:12px;padding:20px}header{display:flex;justify-content:space-between;font-size:16px;color:#26394f;margin-bottom:20px}header small{font-size:12px;color:#53657d}aside p{color:#405670;font-size:13px;line-height:1.8;margin:100px 0 80px}.compose{padding:0}.composer textarea{min-height:86px}.composer-tools button{font:inherit;color:#2464b4;background:#edf3ff;border:0;border-radius:6px;padding:6px 12px}.wm-panel .execution-timing{max-height:none}@media(max-width:800px){body{padding:12px}.timing-fixture{grid-template-columns:1fr}.wm-panel,aside{padding:12px}aside p{margin:20px 0}}',
    });
    await page.evaluate((fixture) => {
      window.fixture = fixture;
      window.saved = { model: 'alpha', effort: 'high', childModel: null, childEffort: null };
      window.events = [];
      window.emit = (value) => window.events.forEach((fn) => fn(value));
      window.desktop = {
        onEvent: (fn) => window.events.push(fn),
        usageMode: async (value) => value || 'daily',
        chat: async (method, patch) => {
          if (method === 'preferences') return window.saved;
          if (method === 'models')
            return ['alpha', 'beta'].map((model) => ({
              model,
              displayName: model === 'alpha' ? 'GPT-6-Luna' : 'GPT-6.1',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
                reasoningEffort,
              })),
            }));
          if (method === 'runtime') return { config: { model: 'alpha', effort: 'high' } };
          if (method === 'configure') {
            window.saved = { ...window.saved, ...patch };
            return window.saved;
          }
          return {};
        },
      };
    }, data);
    await page.addScriptTag({ content: js });
    assert.equal(await page.locator('.composer-model').isVisible(), true);
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
    await page.locator('#fake-settings .child-model-select').selectOption('beta');
    await page.waitForFunction(() => window.saved.childModel === 'beta');
    assert.equal(await page.evaluate(() => window.saved.model), 'alpha');
    await page.evaluate(() => window.closeFakeSettings());
    await page.locator('.composer-model').click();
    await page.getByRole('slider', { name: '思考强度' }).focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => window.saved.effort === 'medium');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.execution-timing').evaluate((el) => el.open), false);
    await page.locator('.execution-timing>summary').click();
    // <details> dispatches toggle asynchronously; wait for its content paint, not just click.
    await page.waitForFunction(() =>
      document.querySelector('.timing-overview')?.textContent?.includes('16 秒'),
    );
    assert.match(await page.locator('.timing-overview').innerText(), /16 秒/);
    assert.match(await page.locator('.timing-clock').innerText(), /42 秒/);
    await page.locator('.timing-timeline>summary').click();
    await page.waitForFunction(() => document.querySelectorAll('.timing-track-row').length === 3);
    assert.equal(await page.locator('.timing-track-row').count(), 3);
    assert.match(await page.locator('.timing-overview').innerText(), /20 秒/);
    await mkdir('test-results/timings', { recursive: true });
    await page.screenshot({ path: 'test-results/timings/daily.png', fullPage: true });
    assert.equal(await page.locator('.usage-mode-switch').count(), 0);
    for (const width of [760, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(await page.locator('.composer-model').isVisible(), true);
    }
    await page.evaluate(() => window.language('en', false));
    await page.waitForFunction(() =>
      document
        .querySelector('.composer-model')
        .getAttribute('aria-label')
        .startsWith('Model and reasoning'),
    );
    await page.screenshot({ path: 'test-results/timings/narrow-english.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
