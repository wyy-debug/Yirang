import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test(
  'real canvas supports multiselect, export, clipboard import and desktop deletion',
  { timeout: 90000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'yirang-ux-'));
    const output = resolve('output/playwright/canvas-journey');
    await mkdir(output, { recursive: true });
    const client = new Client({ name: 'ux-walkthrough', version: '1' });
    let browser, server;
    t.after(async () => {
      await browser?.close();
      server?.close();
      await client.close();
      await rm(directory, { recursive: true, force: true });
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', resolve('dist/server.mjs')],
        env: { ...process.env, AI_DESKTOP_DATA_DIR: directory, AI_DESKTOP_PREVIEW_MODE: '1' },
        stderr: 'pipe',
      }),
    );
    const tool = (name, args = {}) =>
      client.callTool({ name, arguments: args, _meta: { 'openai/session': 'ux-isolated' } });
    const opened = (await tool('desktop_open'))._meta.desktop,
      scope = { workspaceId: opened.binding.workspaceId, credential: opened.binding.credential };
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const result = await tool('desktop_panel_action', {
        ...scope,
        action: 'create',
        payload: {
          requestId: crypto.randomUUID(),
          object: {
            kind: 'text',
            title: '走查材料' + i,
            content: { blocks: [{ id: 'b', text: '用于验证选区打包与删除的独立测试内容 ' + i }] },
            bounds: { x: 100 + i * 450, y: 140, width: 340, height: 240 },
          },
        },
      });
      assert.ok(!result.isError, JSON.stringify(result));
      ids.push(result._meta.desktop.id);
    }
    const html = await readFile('dist/panel.html', 'utf8');
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.end(
        req.url === '/panel'
          ? html
          : `<html><body style="margin:0"><iframe id="panel" src="/panel" style="width:100vw;height:100vh;border:0"></iframe><script>
    const frame=document.getElementById('panel');
    window.addEventListener('message',async e=>{if(e.source!==frame.contentWindow)return;const m=e.data;if(m?.jsonrpc!=='2.0')return;
      const post=x=>frame.contentWindow.postMessage({jsonrpc:'2.0',...x},location.origin);
      try{if(m.method==='ui/initialize')post({id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'UX harness',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{theme:'light',displayMode:'fullscreen',availableDisplayModes:['fullscreen'],platform:'desktop'}}});
      else if(m.method==='ui/notifications/initialized')post({method:'ui/notifications/tool-result',params:await window.callTool('desktop_open',{})});
      else if(m.method==='tools/call')post({id:m.id,result:await window.callTool(m.params.name,m.params.arguments)});
      else if(m.id!==undefined)post({id:m.id,result:{}});
      }catch(e){post({id:m.id,error:{code:-32603,message:String(e)}});}});
    </script></body></html>`,
      );
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({
      channel: process.env.UX_BROWSER || 'msedge',
      headless: true,
    });
    const page = await browser.newPage({
        viewport: { width: 2560, height: 1440 },
        permissions: ['clipboard-read', 'clipboard-write'],
      }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('callTool', tool);
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const panel = page.frameLocator('#panel');
      for (const id of ids) await panel.locator(`.react-flow__node[data-id="${id}"]`).waitFor();
      // Shift-click is a separate user path from marquee selection.
      await panel
        .locator(`.react-flow__node[data-id="${ids[0]}"]`)
        .click({ position: { x: 4, y: 4 } });
      await panel.locator('.react-flow__node.selected').waitFor();
      await page.keyboard.down('Shift');
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      await panel
        .locator(`.react-flow__node[data-id="${ids[1]}"]`)
        .click({ position: { x: 4, y: 4 } });
      await page.keyboard.up('Shift');
      await panel.locator('.react-flow__node.selected').nth(1).waitFor({ timeout: 2500 });
      await page.keyboard.press('Escape');
      const boxes = await Promise.all(
        ids.map((id) => panel.locator(`.react-flow__node[data-id="${id}"]`).boundingBox()),
      );
      const left = Math.min(...boxes.map((b) => b.x)) - 20,
        top = Math.min(...boxes.map((b) => b.y)) - 20;
      const right = Math.max(...boxes.map((b) => b.x + b.width)) + 20,
        bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 20;
      await page.mouse.move(left, top);
      await page.mouse.down();
      await page.mouse.move(right, bottom, { steps: 15 });
      await page.mouse.up();
      await panel.locator('.react-flow__node.selected').nth(1).waitFor();
      assert.equal(
        await panel.locator('.react-flow__node.selected').count(),
        2,
        'both cards must remain selected',
      );
      const selection = panel.locator('.react-flow__nodesselection-rect');
      await selection.waitFor();
      await selection.click({ button: 'right', position: { x: 380, y: 100 } });
      await panel.getByRole('menu', { name: '桌面操作' }).waitFor();
      assert.equal(
        await panel.locator('.react-flow__node.selected').count(),
        2,
        'right click must preserve multiselection',
      );
      await page.screenshot({ path: resolve(output, 'multi-selection-menu.png') });
      await panel.getByRole('menuitem', { name: '打包导出 ZIP' }).click();
      const path = panel.getByRole('textbox', { name: '压缩包路径' });
      await path.waitFor();
      await panel.getByRole('button', { name: '复制路径', exact: true }).click();
      await page.waitForFunction(async expected =>
        (await navigator.clipboard.readText()) === expected, await path.inputValue());
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        await path.inputValue(),
      );
      const zip = await JSZip.loadAsync(await readFile(await path.inputValue()));
      assert.deepEqual(Object.keys(zip.files).sort(), ['走查材料0.txt', '走查材料1.txt']);
      assert.match(await zip.file('走查材料1.txt').async('string'), /独立测试内容 1/);
      await page.keyboard.press('Escape');
      await panel.getByRole('dialog', { name: '打包完成' }).waitFor({ state: 'detached' });
      await selection.click({ button: 'right', position: { x: 380, y: 100 } });
      await panel.getByRole('menuitem', { name: '移到回收站' }).click();
      for (const id of ids)
        await panel.locator(`.react-flow__node[data-id="${id}"]`).waitFor({ state: 'detached' });
      await page.reload();
      await panel.locator('.react-flow').waitFor();
      for (const id of ids)
        assert.equal(
          await panel.locator(`.react-flow__node[data-id="${id}"]`).count(),
          0,
          'deleted cards must stay removed after reload',
        );
      const canvas = panel.locator('.canvas');
      await page.evaluate(() => navigator.clipboard.writeText('粘贴文字测试\n保留第二行'));
      await canvas.click({ position: { x: 220, y: 200 } });
      await page.keyboard.press('Control+v');
      await panel.getByText('已粘贴为文字笔记。', { exact: true }).waitFor();
      const pastedNote = panel.locator('.react-flow__node').filter({ hasText: '粘贴文字测试' });
      await pastedNote.waitFor();
      assert.equal(await pastedNote.count(), 1);

      await canvas.evaluate((element) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['# 外部文件'], '外部剪贴板.md', { type: 'text/markdown' }));
        transfer.setData('text/plain', '此备用文字不应变成笔记');
        element.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true, cancelable: true, clipboardData: transfer,
        }));
      });
      await panel.locator('.react-flow__node').filter({ hasText: '外部剪贴板.md' }).waitFor();
      assert.equal(await panel.getByText('此备用文字不应变成笔记', { exact: true }).count(), 0);

      await page.evaluate(async () => {
        const picture = document.createElement('canvas');
        picture.width = picture.height = 32;
        const context = picture.getContext('2d');
        context.fillStyle = '#1263b5';
        context.fillRect(0, 0, picture.width, picture.height);
        const image = await new Promise((resolve) => picture.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
      });
      await canvas.focus();
      await page.keyboard.press('Control+v');
      await panel.locator('.react-flow__node').nth(2).waitFor();

      await canvas.evaluate((element) => {
        const input = document.createElement('textarea');
        input.setAttribute('aria-label', '粘贴测试输入框');
        element.append(input);
        input.focus();
      });
      await page.evaluate(() => navigator.clipboard.writeText('只粘贴到输入框'));
      await page.keyboard.press('Control+v');
      assert.equal(await panel.getByRole('textbox', { name: '粘贴测试输入框' }).inputValue(), '只粘贴到输入框');
      assert.equal(await panel.locator('.react-flow__node').count(), 3);
      await panel.getByRole('textbox', { name: '粘贴测试输入框' }).evaluate((element) => element.remove());
      await canvas.focus();
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Control+g');
      const regionName = panel.getByRole('textbox', { name: '区域名称', exact: true });
      await regionName.fill('走查区域');
      await regionName.press('Enter');
      await panel.getByText('走查区域', { exact: true }).waitFor();
      await canvas.focus();
      await page.keyboard.press('Escape');
      await panel.getByRole('button', { name: '定位区域', exact: true }).click();
      await panel.getByRole('button', { name: '走查区域 3', exact: true }).click();
      await panel.locator('.react-flow__node.selected').nth(2).waitFor();
      await canvas.focus();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+g');
      const placement = panel.locator('.canvas-region-placement');
      await placement.waitFor();
      await page.keyboard.press('Escape');
      await placement.waitFor({ state: 'detached' });
      const options = panel.getByRole('button', { name: '桌面选项', exact: true });
      await options.click();
      assert.equal(await panel.getByRole('button', { name: '删除桌面', exact: true }).isDisabled(), true);
      await options.click();
      const tabs = panel.getByRole('navigation', { name: '页面切换' });
      await tabs.getByRole('button', { name: '新建桌面', exact: true }).click();
      await panel.getByRole('textbox', { name: '桌面名称' }).fill('删除走查桌面');
      await panel.locator('.desktop-tab-editor').getByRole('button', { name: '保存', exact: true }).click();
      const second = tabs.getByRole('button', { name: '删除走查桌面', exact: true });
      await second.waitFor();
      await second.click({ button: 'right' });
      await panel.getByRole('button', { name: '删除桌面', exact: true }).click();
      const confirm = panel.getByRole('dialog', { name: '删除「删除走查桌面」？' });
      await confirm.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await second.count(), 1);
      await options.click();
      await panel.getByRole('button', { name: '删除桌面', exact: true }).click();
      await confirm.getByRole('button', { name: '删除桌面', exact: true }).click();
      await second.waitFor({ state: 'detached' });
      await options.click();
      await panel.getByRole('button', { name: '恢复已删除的桌面：删除走查桌面' }).click();
      await second.waitFor();
      await second.click({ button: 'right' });
      await panel.getByRole('button', { name: '删除桌面', exact: true }).click();
      await confirm.getByRole('button', { name: '删除桌面', exact: true }).click();
      await second.waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
    } finally {
      await page.screenshot({ path: resolve(output, 'last-state.png') });
      await page.context().tracing.stop({ path: resolve(output, 'trace.zip') });
    }
  },
);
