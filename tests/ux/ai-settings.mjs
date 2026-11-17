import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('AI settings unify tools and model services with local reconnect and retry', async () => {
  const { outputFiles } = await build({ stdin: { contents: `
    import {createSettingsLayout} from './apps/electron/settings/settings-layout.js';
    import {registerAiTools} from './apps/electron/settings/ai-tools-ui.js';
    const {sections}=createSettingsLayout(document.querySelector('main'),'ai',()=>{});
    registerAiTools();
    const button=(text,run)=>{const b=document.createElement('button');b.textContent=text;b.onclick=run;return b};
    window.dispatchEvent(new CustomEvent('desktop-settings-open',{detail:{sections,button,signal:new AbortController().signal}}));
  `, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<main></main><div class="chat-heading"><strong></strong></div><small id="connection-label"></small><div class="composer-tools"></div>');
    await page.evaluate(() => {
      window.calls = []; window.failInstall = true;
      window.desktop = {
        onEvent: fn => { window.providerEvent = fn; },
        reconnect: async () => { window.calls.push(['reconnect']); },
        aiTools: async (action, data) => {
          window.calls.push([action, data]);
          if (action === 'list') return [
            { id:'codex', name:'Codex CLI', supported:true, installed:false, path:'', args:[], status:'未安装' },
            { id:'claude', name:'Claude Code', supported:false, installed:true, path:'', args:[] },
          ];
          if (action === 'codex-version') throw Error('未安装');
          if (action === 'codex-gateway-read') return { enabled:false, url:'', model:'', hasKey:false };
          if (action === 'codex-gateway-models') return ['model-a'];
          if (action === 'codex-install') { if (window.failInstall) { window.failInstall=false; throw Error('下载失败'); } return {version:'1.0'}; }
          return true;
        },
      };
    });
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.getByRole('button', {name:'本机 AI 工具',exact:true}).click();
    await page.getByRole('button', {name:'安装 Codex CLI',exact:true}).waitFor();
    assert.equal(await page.locator('.settings-nav button[data-category=ai]').count(), 0);
    assert.equal(await page.locator('.settings-nav button[data-category=tools]').innerText(), 'AI');
    assert.equal(await page.getByText('Claude Code', {exact:true}).count(), 0);
    assert.equal(await page.locator('.ai-model-service').isVisible(), false);
    assert.equal(await page.locator('.ai-model-service').evaluate(e => !!e.closest('details')), false);
    const install = page.getByRole('button',{name:'安装 Codex CLI',exact:true});
    await install.click();
    await page.getByText('安装失败：下载失败', {exact:true}).waitFor();
    assert.equal(await install.isEnabled(), true);
    await install.click();
    await page.getByText('已安装 1.0。点击「重新连接」后生效。', {exact:true}).waitFor();
    await page.getByRole('button',{name:'重新连接',exact:true}).click();
    await page.getByRole('button',{name:'模型服务',exact:true}).click();
    await page.getByLabel('接口地址').fill('https://example.com/v1');
    await page.getByLabel('API Key',{exact:true}).fill('test-only');
    await page.getByRole('button',{name:'获取模型列表',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="模型名称"]').value==='model-a');
    await page.locator('.ai-model-service input[type=checkbox]').check();
    await page.getByRole('button',{name:'保存接口配置',exact:true}).click();
    await page.getByText('已保存。点击「重新连接并应用」后生效。',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'');
    await page.getByRole('button',{name:'重新连接并应用',exact:true}).click();
    const calls = await page.evaluate(()=>window.calls);
    assert.equal(calls.filter(c=>c[0]==='reconnect').length,2);
    assert.equal(calls.find(c=>c[0]==='codex-gateway-save')[1].model,'model-a');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('settings forms fit the dialog and preserve file actions at desktop 2K', async () => {
  const { outputFiles } = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { createSettingsLayout } from './apps/electron/settings/settings-layout.js';
      import { registerAppSettings } from './apps/electron/settings/app-settings.js';
      import { ConnectedDirectories } from './apps/panel/workspace/connected-directories.tsx';
      import { ExternalResources } from './apps/panel/workspace/external-resources.tsx';
      import { Storage } from './apps/panel/workspace/storage.tsx';
      const dialog = document.querySelector('dialog');
      const { sections, row } = createSettingsLayout(dialog, 'general', () => {});
      const button = (text, run) => Object.assign(document.createElement('button'), {
        type: 'button', textContent: text, onclick: run,
      });
      window.calls = [];
      window.desktop = {
        onEvent() {},
        app: async (action) => action === 'check'
          ? { name: '0.66.41', downloadable: true } : { version: '0.66.40' },
      };
      registerAppSettings({ frame: null, status: document.createElement('span') });
      window.dispatchEvent(new CustomEvent('desktop-settings-open', { detail: { sections, row, button } }));
      const action = async (_, { operation, command }) => {
        window.calls.push([operation, command]);
        if (operation === 'storage') return { bytes: 2048, revisions: 2 };
        if (command.operation === 'scan') return { files: [], issues: [], missing: [], totalScanned: 0 };
        if (command.operation === 'list') return [];
        return { id: 'new' };
      };
      for (const [id, View] of Object.entries({ folders: ConnectedDirectories, resources: ExternalResources, storage: Storage })) {
        const mount = Object.assign(document.createElement('div'), { className: 'workspace-settings-body' });
        sections[id].append(mount);
        createRoot(mount).render(React.createElement(View, { action }));
      }
      dialog.showModal();
    `, resolveDir: process.cwd() },
    outfile: 'settings-test.js', bundle: true, write: false, format: 'iife',
  });
  const css = await Promise.all(['design-tokens.css', 'shell.css'].map(file => readFile(`apps/electron/${file}`, 'utf8')));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://settings.test/**', async route => {
      if (route.request().url().endsWith('/apps/panel/assets/yirang.png')) {
        await route.fulfill({ path: 'apps/panel/assets/yirang.png' });
      } else {
        await route.fulfill({
          contentType: 'text/html',
          body: '<meta charset="utf-8"><dialog class="desktop-settings organized-settings"><header><h2>设置</h2></header></dialog>',
        });
      }
    });
    await page.goto('http://settings.test/apps/electron/settings-test.html');
    await page.addStyleTag({ content: outputFiles.find(file => file.path.endsWith('.css')).text });
    for (const content of css) await page.addStyleTag({ content });
    await page.addScriptTag({ content: outputFiles.find(file => file.path.endsWith('.js')).text });
    await page.getByRole('button', { name: '文件管理', exact: true }).click();
    await page.getByRole('button', { name: '网络文件', exact: true }).click();
    const name = page.getByLabel('名称', { exact: true }), link = page.getByLabel('文件链接');
    const submit = page.getByRole('button', { name: '添加链接', exact: true });
    await name.fill('测试文件');
    await link.fill('https://example.com/report.pdf');
    const [nameBox, linkBox, formBox] = await Promise.all([
      name.boundingBox(), link.boundingBox(), page.locator('#settings-resources form').boundingBox(),
    ]);
    await mkdir('test-results/settings-layout', { recursive: true });
    await page.locator('dialog').screenshot({ path: 'test-results/settings-layout/files.png' });
    assert.equal(nameBox.y, linkBox.y);
    assert.ok(linkBox.width > nameBox.width && formBox.height < 180,
      JSON.stringify({ nameBox, linkBox, formBox }));
    await submit.click();
    await page.getByRole('status').filter({ hasText: '链接已添加' }).waitFor();

    await page.getByRole('button', { name: '本机文件夹', exact: true }).click();
    await page.getByLabel('文件夹完整路径', { exact: true }).fill('F:/Documents/Project');
    await page.getByRole('button', { name: '连接文件夹', exact: true }).click();
    await page.waitForFunction(() => window.calls.some(([operation, command]) =>
      operation === 'directories' && command.operation === 'connect' && command.access === 'read',
    ));

    await page.getByRole('button', { name: '存储与历史', exact: true }).click();
    await page.getByText('2.0 KB', { exact: true }).waitFor();
    const keep = await page.getByRole('spinbutton').boundingBox();
    assert.ok(keep.width < 100);

    await page.getByRole('button', { name: '关于', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.settings-brand img').naturalWidth > 0);
    const download = page.getByRole('button', { name: '下载安装包', exact: true });
    assert.equal(await download.isVisible(), false);
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await download.waitFor();
    await page.locator('dialog').screenshot({ path: 'test-results/settings-layout/about.png' });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
