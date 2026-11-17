import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';

test('reports live beside notifications, focus work, locate files and isolate desktops', async () => {
  const bundle = await build({stdin:{contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {WorkReportNotifications} from './apps/panel/work/work-report-notifications.tsx';
    const root=createRoot(document.getElementById('root'));
    window.calls=[];window.addEventListener('message',e=>window.calls.push(e.data));
    window.render=(workspaceId='desk')=>root.render(React.createElement(WorkReportNotifications,{workspaceId}));
    window.render();
    window.publish=(workspaceId='desk')=>window.postMessage({type:'yirang:work-reports',workspaceId,reports:[
      {taskId:'a',title:'制作可编辑架构图',label:'已完成',tone:'done',reason:'文件已保存到桌面',at:'2026-11-05T08:00:00Z',artifacts:[{objectId:'svg',title:'架构图.svg',revision:2}]},
      {taskId:'b',title:'整理报告',label:'需要你',tone:'blocked',reason:'缺少数据',artifacts:[]}
    ]},'*');
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',loader:{'.css':'empty'}});
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:2560,height:1440}});
    await page.clock.install();
    await page.setContent('<div class="desktop-tabs-bar" style="margin-top:60px"><div class="desktop-tabs" style="width:100%;justify-content:flex-end"><div id="root"></div><button id="outside">应用通知</button></div></div><main id="messages"></main>');
    for (const file of ['apps/electron/design-tokens.css','apps/panel/styles.css','apps/panel/workspace/desktop-tabs.css','apps/panel/light-apps/light-apps.css','apps/panel/work/work-report-notifications.css'])
      await page.addStyleTag({content:await readFile(file,'utf8')});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const trigger=page.getByRole('button',{name:/工作汇报/});
    await trigger.waitFor();
    await trigger.click();
    await page.clock.fastForward(10001);
    await page.getByRole('button',{name:'加载失败，点击重试'}).click();
    await page.getByText('正在加载…').waitFor();
    await page.evaluate(()=>window.publish());
    await page.getByText('缺少数据',{exact:true}).waitFor();
    assert.equal(await page.locator('#messages').innerText(),'');
    assert.equal(await page.locator('.work-report-notice').count(),2);
    await mkdir('output/work-report-ui',{recursive:true});
    await page.screenshot({path:'output/work-report-ui/notifications-2k.png'});
    await page.getByRole('button',{name:'架构图.svg',exact:true}).click();
    await page.waitForFunction(()=>window.calls.some(x=>x.type==='ai-desktop:locate-outputs'));
    assert.deepEqual(await page.evaluate(()=>window.calls.find(x=>x.type==='ai-desktop:locate-outputs')),
      {type:'ai-desktop:locate-outputs',workspaceId:'desk',objectIds:['svg']});
    assert.equal(await page.locator('.work-report-list').count(),0);
    await trigger.click();
    await page.getByRole('button',{name:/整理报告/}).click();
    await page.waitForFunction(()=>window.calls.some(x=>x.type==='yirang:focus-work'));
    assert.deepEqual(await page.evaluate(()=>window.calls.find(x=>x.type==='yirang:focus-work')),
      {type:'yirang:focus-work',workspaceId:'desk',taskId:'b'});
    await trigger.click();
    await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
    await trigger.click();
    await page.locator('#outside').click();
    assert.equal(await page.locator('.work-report-list').count(),0);
    await page.evaluate(()=>window.render('other'));
    await page.waitForFunction(()=>window.calls.filter(x=>x.type==='yirang:work-stream-request').length===3);
    await page.evaluate(()=>window.publish('desk'));
    await trigger.click();
    assert.equal(await page.locator('.work-report-notice').count(),0);
    await page.evaluate(()=>window.postMessage({type:'yirang:work-reports',workspaceId:'other',reports:[]},'*'));
    await page.getByText('暂无工作汇报').waitFor();
  } finally { await browser.close(); }
});
