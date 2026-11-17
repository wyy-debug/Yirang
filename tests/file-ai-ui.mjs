// Browser integration with a fake IPC boundary. No real AI requests or user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test(
  'file targeting, configurable shortcut, context continuity and floating layout',
  { timeout: 90000 },
  async () => {
    const output = resolve('test-results/file-ai');
    await mkdir(output, { recursive: true });
    const panel = await build({
      stdin: {
        contents: `
    import React from 'react';import{createRoot}from'react-dom/client';
    import{useFileAiTarget}from'./apps/panel/interaction/use-file-ai-target.ts';
    import{WorkbenchChrome}from'./apps/panel/ui/workbench-chrome.tsx';
    import './apps/electron/design-tokens.css';import './apps/panel/styles.css';import './apps/panel/workbench-theme.css';import './apps/panel/electron-mode.css';
    window.plainClicks=0;window.failAttachment=false;
    window.addEventListener('message',({source,data})=>{
      if(source===parent&&data?.type==='ai-desktop:clear-reference')
        parent.postMessage({type:'ai-desktop:clear-reference-result',id:data.id,ok:true},'*');
    });
    function Fixture(){useFileAiTarget({available:true,workspaceId:'test',selected:()=>[],find:id=>({title:id==='report'?'报告.pdf':'预算.xlsx'}),notice:text=>window.notice=text,
      attach:async id=>{await new Promise(r=>setTimeout(r,180));if(window.failAttachment)return false;
        return new Promise(resolve=>{const request=crypto.randomUUID();const receive=e=>{if(e.data?.id!==request)return;window.removeEventListener('message',receive);resolve(!e.data.error)};window.addEventListener('message',receive);
          parent.postMessage({jsonrpc:'2.0',id:request,method:'ui/update-model-context',params:{content:[{type:'text',text:'fixture material '+id,_meta:{'ai-desktop/selection':{objects:[{id,title:id==='report'?'报告.pdf':'预算.xlsx'}]}}}]}},'*');});}});
      return <div className="desktop-shell sidebar-collapsed"><WorkbenchChrome active="canvas" collapsed={true} ready={true} workspaceName="我的工作桌面" itemCount={2} navigate={id=>{if(id==='tools')parent.postMessage({type:'ai-desktop:open-settings'},'*')}} toggleSidebar={()=>{}} shortcuts={()=>{}} workspaces={()=>{}} search={()=>{}} commands={()=>{}} create={()=>{}} setNewMenu={()=>{}} zoom={100}/><main><h1>工作桌面</h1><p>文件 AI 交互验证</p>{['report','budget'].map((id,i)=><article key={id} className="react-flow__node" data-id={id} style={{left:100+i*270,top:170}}><div className="object-paper" onClick={()=>window.plainClicks++}><div className="file-symbol">{id==='report'?'PDF':'XLS'}</div><h2>{id==='report'?'报告.pdf':'预算.xlsx'}</h2><p>{id==='report'?'项目进展与主要结论':'年度预算与支出明细'}</p></div></article>)}</main></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      loader: { '.png': 'dataurl' },
      outfile: 'panel.js',
      format: 'iife',
    });
    const js = panel.outputFiles.find((f) => f.path.endsWith('.js')).text,
      css = panel.outputFiles.find((f) => f.path.endsWith('.css')).text;
    const panelHtml = `<!doctype html><html class="electron-mode"><head><meta charset="utf-8"><style>body{margin:0;background:#f5f7fa;color:#27364c;font:14px "Segoe UI","Microsoft YaHei UI",sans-serif}main{padding:36px}h1{font-size:20px}main>p{color:#5b687c}.react-flow__node{position:absolute;width:220px}.object-paper{height:200px;background:white;border:1px solid #d9e0ea;border-radius:10px;padding:20px;box-sizing:border-box}.object-paper h2{font-size:15px}.object-paper p{font-size:12px;color:#596779}.file-symbol{border-radius:8px;background:#ebf2fc;color:#315c93;padding:12px;width:32px;font-weight:600}${css}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
    const shell = (await readFile('apps/electron/shell.html', 'utf8')).replace(
      '../../dist/panel-electron.html',
      '/fixture-panel.html',
    );
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/fixture-panel.html') {
          res.setHeader('Content-Type', 'text/html;charset=utf-8');
          res.end(panelHtml);
          return;
        }
        if (url.pathname === '/apps/electron/shell.html') {
          res.setHeader('Content-Type', 'text/html;charset=utf-8');
          res.end(shell);
          return;
        }
        const file = resolve('.' + url.pathname);
        if (!file.startsWith(process.cwd())) throw Error('path');
        res.setHeader(
          'Content-Type',
          { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }[extname(file)] ||
            'text/plain',
        );
        res.end(await readFile(file));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    let browser;
    try {
      browser = await chromium.launch({
        channel: process.env.FILE_AI_BROWSER || 'msedge',
        headless: true,
      });
    } catch (error) {
      server.close();
      throw error;
    }
    try {
      const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } }),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        const listeners = [];
        window.calls = [];
        window.reference = [];
        window.emit = (type, payload) => listeners.forEach((fn) => fn({ type, payload }));
        localStorage.setItem(
          'ai-desktop:conversation-sidebar:v1',
          JSON.stringify({ open: false, width: 390 }),
        );
        const api = {
          onEvent: (fn) => listeners.push(fn),
          startup: async () => ({ milestones: {} }),
          tool: async () => ({}),
          canvasContext: async () => {},
          browser: async () => ({ tabs: [] }),
          conversation: async () => ({ queue: [], paused: false, draft: '' }),
          attach: async (blocks) => {
            window.reference = blocks;
            window.emit('selection', blocks);
          },
          send: async (text) => {
            window.calls.push({
              text,
              thread: 'same-thread',
              reference: structuredClone(window.reference),
            });
            window.emit('selection', []);
            const id = 'turn-' + window.calls.length;
            setTimeout(() => {
              window.emit('started', { turn: { id } });
              window.emit('delta', {
                turnId: id,
                itemId: id + 'answer',
                delta:
                  window.calls.length === 1
                    ? '报告的主要结论：项目按计划推进，下一阶段需要关注预算和交付时间。'
                    : '接着前面的结论：第二点涉及预算分配，可以继续细化。',
              });
              setTimeout(() => window.emit('completed', { turn: { id, status: 'completed' } }), 40);
            }, 20);
            return { turnId: id };
          },
          stop: async () => {},
          closeResult: async () => {},
          settings: async () => ({}),
          projects: async () => ({ projects: [] }),
          outputs: async () => ({ batches: [] }),
        };
        window.desktop = new Proxy(api, {
          get: (target, key) => target[key] || (() => Promise.resolve({})),
        });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/apps/electron/shell.html`);
      await page.waitForFunction(
        () => window.emit && document.querySelector('.conversation-queue'),
      );
      await page.evaluate(() => {
        window.emit('desktop-ready', {});
        window.emit('ready', { threadId: 'same-thread', history: [] });
      });
      const frame = page.frameLocator('#panel'),
        report = frame.locator('[data-id="report"]');
      await report.waitFor();
      await report.click();
      assert.equal(
        await page.locator('#chat').getAttribute('aria-hidden'),
        'true',
        'ordinary clicks must not open AI',
      );
      await page.keyboard.press('Control+Alt+a');
      await frame.locator('.file-ai-target-hint:not([hidden])').waitFor({ timeout: 5000 });
      await page.keyboard.press('Escape');
      assert.equal(await frame.locator('.file-ai-target-hint').isVisible(), false);
      await page.keyboard.press('Control+Alt+a');
      await frame.locator('.file-ai-target-hint:not([hidden])').waitFor();
      await report.click();
      await page.locator('#chat.file-chat:not(.collapsed)').waitFor();
      await page.waitForFunction(
        () => document.querySelector('#chat').getAttribute('aria-busy') === 'false',
      );
      assert.equal(await page.locator('#file-chat-title').getAttribute('title'), '报告.pdf');
      assert.equal(await frame.locator('.file-ai-target-hint').isVisible(), false);
      await page.locator('#input').fill('帮我总结这份报告');
      await page.screenshot({ path: resolve(output, 'composer.png') });
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () =>
          document.querySelector('.app-shell').dataset.chatState === 'ready' &&
          document.querySelector('.message.assistant')?.textContent,
      );
      await page.locator('#input').fill('第二点展开说说');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () =>
          window.calls.length === 2 &&
          document.querySelector('.app-shell').dataset.chatState === 'ready',
      );
      assert.equal(await page.locator('.message.user').count(), 2);
      assert.equal(await page.locator('.message.assistant').count(), 2);
      assert.equal(
        await page.evaluate(
          () => window.calls[0].reference[0]._meta['ai-desktop/selection'].objects[0].id,
        ),
        'report',
      );
      await page.locator('#input').fill('尚未发送的追问');
      await page.keyboard.press('Escape');
      await page.locator('#chat.collapsed').waitFor({ state: 'attached' });
      await page.waitForFunction(() => window.reference.length === 0);
      await page.keyboard.press('Control+Alt+a');
      await frame.locator('.file-ai-target-hint:not([hidden])').waitFor({ timeout: 5000 });
      await report.click();
      await page.waitForFunction(
        () =>
          document.querySelector('#chat').getAttribute('aria-busy') === 'false' &&
          !document.querySelector('#chat').classList.contains('collapsed'),
      );
      assert.equal(await page.locator('#input').inputValue(), '尚未发送的追问');
      await page.locator('#file-chat-history').click();
      assert.equal(await page.locator('.message.user').count(), 2);
      await page.screenshot({ path: resolve(output, 'conversation.png') });
      const rect = await page.locator('#chat').boundingBox();
      assert.ok(
        rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 2561 && rect.y + rect.height <= 1441,
        'floating panel fits the desktop window',
      );
      await page.locator('#chat-close').click();
      await frame.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      const shortcut = settings.getByRole('textbox', { name: '录入文件 AI 快捷键' });
      const fileShortcut = settings.locator('.settings-file-ai').filter({
        has: page.getByRole('textbox', { name: '录入文件 AI 快捷键' }),
      });
      await shortcut.waitFor();
      assert.equal(await shortcut.inputValue(), 'Ctrl+Alt+A');
      assert.equal(
        await frame.getByRole('button', { name: '新建文件' }).count(),
        0,
        'settings hides unrelated toolbar actions',
      );
      await page.screenshot({ path: resolve(output, 'settings.png') });
      await shortcut.click();
      await page.keyboard.press('Control+Alt+a');
      await settings.getByText('已保存。按快捷键，再点击文件即可提问。', { exact: true }).waitFor();
      assert.equal(
        await frame.locator('.file-ai-target-hint').isVisible(),
        false,
        'recording the current shortcut must not activate targeting',
      );
      await shortcut.click();
      await page.keyboard.press('Control+Alt+q');
      await settings.getByText('已保存。按快捷键，再点击文件即可提问。', { exact: true }).waitFor();
      assert.equal(await shortcut.inputValue(), 'Ctrl+Alt+Q');
      await shortcut.click();
      await page.keyboard.press('Control+s');
      await settings.getByText('此组合已用于常见操作，请换一个组合键。', { exact: true }).waitFor();
      assert.equal(
        await shortcut.inputValue(),
        'Ctrl+Alt+Q',
        'reserved editing key must be rejected',
      );
      await page.evaluate(() => {
        window.originalStorageSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'ai-desktop:file-ai-shortcut:v1') throw Error('fixture storage unavailable');
          return window.originalStorageSet.call(this, key, value);
        };
      });
      await shortcut.click();
      await page.keyboard.press('Control+Alt+w');
      await settings.getByText('快捷键未能保存，请重试。', { exact: true }).waitFor();
      await page.evaluate(() => {
        Storage.prototype.setItem = window.originalStorageSet;
      });
      assert.equal(
        await shortcut.inputValue(),
        'Ctrl+Alt+Q',
        'failed persistence keeps the effective shortcut',
      );
      await fileShortcut.getByRole('button', { name: '恢复默认快捷键', exact: true }).click();
      await settings.getByText('已保存。按快捷键，再点击文件即可提问。', { exact: true }).waitFor();
      assert.equal(await shortcut.inputValue(), 'Ctrl+Alt+A');
      await shortcut.click();
      await page.keyboard.press('Control+Alt+q');
      await settings.getByText('已保存。按快捷键，再点击文件即可提问。', { exact: true }).waitFor();
      const settingsBounds = await fileShortcut.boundingBox(),
        keyBounds = await shortcut.boundingBox();
      assert.ok(
        keyBounds.x >= settingsBounds.x &&
          keyBounds.x + keyBounds.width <= settingsBounds.x + settingsBounds.width,
        'shortcut stays inside its settings row',
      );
      await settings.getByRole('button', { name: '关闭', exact: true }).click();
      await report.click();
      await page.keyboard.press('Control+Alt+a');
      assert.equal(await frame.locator('.file-ai-target-hint').isVisible(), false);
      await page.keyboard.press('Control+Alt+q');
      await frame.locator('.file-ai-target-hint:not([hidden])').waitFor();
      await page.keyboard.press('Escape');
      await frame.locator('body').evaluate(() => {
        window.failAttachment = true;
      });
      await page.keyboard.press('Control+Alt+q');
      await report.click();
      await page.locator('.file-chat-failed').waitFor();
      await page.locator('#input').fill('不应发送');
      assert.equal(await page.locator('#send').isDisabled(), true);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.calls.length), 2);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('.conversation-queue'));
      await page.evaluate(() => {
        window.emit('desktop-ready', {});
        window.emit('ready', { threadId: 'same-thread', history: [] });
      });
      await report.waitFor();
      await report.click();
      await page.keyboard.press('Control+Alt+q');
      await frame.locator('.file-ai-target-hint:not([hidden])').waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await report.click();
      await page.waitForFunction(
        () =>
          document.querySelector('#chat').getAttribute('aria-busy') === 'false' &&
          !document.querySelector('#chat').classList.contains('collapsed'),
      );
      assert.equal(
        await page.locator('.file-ai-contact').isVisible(),
        false,
        'reduced motion suppresses contact animation',
      );
      await page.setViewportSize({ width: 360, height: 640 });
      await page.waitForFunction(() => {
        const box = document.querySelector('#chat').getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= 361;
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
    }
  },
);
