import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('selected work shows its conversation immediately without nested disclosure controls', async () => {
  const {outputFiles} = await build({stdin:{resolveDir:process.cwd(),contents:`
    import {createWorkHistory} from './apps/electron/work/work-history-view.js';
    window.calls=0;
    window.desktop={workManagement:async()=>{calls++;return {data:[{id:'turn',status:'completed',items:[{type:'userMessage',text:'制作可编辑架构图'},{type:'agentMessage',text:'已保存架构图.svg'}]}]};}};
    window.historyView=createWorkHistory({workspaceId:'desk',expanded:true});
    document.body.append(historyView.element);
    historyView.update([{threadId:'thread',state:'succeeded'}]);
  `},bundle:true,write:false,format:'iife'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:2560,height:1440}});
    await page.setContent('<body></body>');
    await page.addScriptTag({content:outputFiles[0].text});
    await page.getByText('已保存架构图.svg',{exact:true}).waitFor();
    assert.equal(await page.getByText('制作可编辑架构图',{exact:true}).isVisible(),true);
    assert.equal(await page.locator('summary').count(),0);
    await page.evaluate(()=>historyView.update([{threadId:'thread',state:'succeeded'}]));
    assert.equal(await page.locator('[data-turn]').count(),1);
    assert.equal(await page.evaluate(()=>calls),1,'reading a completed conversation must not repeatedly fetch it');
    await page.evaluate(()=>historyView.dispose());
  } finally {await browser.close();}
});

test('completed execution history reads once instead of polling', async () => {
 const {outputFiles}=await build({stdin:{contents:`
 import {createWorkExecution} from './apps/electron/work/work-execution-view.js';
 window.calls=0;window.desktop={workManagement:async()=>{calls++;return {data:[]};}};
 window.view=createWorkExecution({workspaceId:'desk',threadId:'done',interval:30,live:false});document.body.append(view.element);
 `,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
 const page=await browser.newPage();await page.setContent('<body></body>');await page.addScriptTag({content:outputFiles[0].text});
 await page.locator('summary').click();await page.waitForFunction(()=>calls===1);
 await page.waitForTimeout(160);assert.equal(await page.evaluate(()=>calls),1);
 await page.evaluate(()=>view.setLive(true));await page.waitForFunction(()=>calls>=2);
 await page.evaluate(()=>view.setLive(false));await page.waitForTimeout(80);
 const count=await page.evaluate(()=>calls);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>calls),count);
 await page.evaluate(()=>view.dispose());
 }finally{await browser.close();}
});

test('inline execution refresh deduplicates and stops on collapse without switching conversations', async () => {
  const {outputFiles}=await build({stdin:{contents:`
    import {createWorkExecution} from './apps/electron/work/work-execution-view.js';
    window.calls=[];
    window.desktop={workManagement:async args=>{calls.push(args);if(args.command.operation==='execution_item')return {stdout:'raw tool output'};return {data:[{id:'turn',status:'running',items:[{type:'agentMessage',text:'正在处理'},{type:'commandExecution',lazy:{turnId:'turn',itemIndex:1,cursor:null}}]}],nextCursor:'older'};},switchThread:()=>{throw Error('must not switch');}};
    window.view=createWorkExecution({workspaceId:'desk',threadId:'run',interval:50});
    document.body.append(view.element);
  `,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<body></body>');
    await page.addScriptTag({content:outputFiles[0].text});
    await page.locator('.work-execution-inline > summary').click();
    await page.waitForFunction(()=>calls.length>=2);
    assert.equal(await page.locator('[data-turn]').count(),1);
    assert.equal(await page.evaluate(()=>calls.some(c=>c.command.operation==='execution_item')),false);
    await page.getByText('运行命令',{exact:true}).click();
    await page.getByText('raw tool output',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.command.operation==='execution_item').length),1);
    await page.getByRole('button',{name:'加载更多'}).click();
    assert.ok(await page.evaluate(()=>calls.some(c=>c.command.payload.cursor==='older')));
    await page.locator('.work-execution-inline > summary').click();
    await page.waitForTimeout(100);
    const count=await page.evaluate(()=>calls.length);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>calls.length),count);
    assert.equal(await page.locator('dialog').count(),0);
    assert.equal(await page.evaluate(()=>calls[0].workspaceId),'desk');
    await page.evaluate(()=>view.dispose());
  } finally {await browser.close();}
});


test('late responses cannot enter another desktop and a failed refresh retains loaded history', async () => {
 const {outputFiles}=await build({stdin:{contents:`
 import {createWorkExecution} from './apps/electron/work/work-execution-view.js';
 window.calls=0;window.fail=false;window.hold=false;
 window.desktop={workManagement:async()=>{calls++;if(hold)await new Promise(r=>window.release=r);if(fail)throw Error('offline');return {data:[{id:'one',items:[{type:'agentMessage',text:'retained'}]}]};}};
 window.view=createWorkExecution({workspaceId:'old',threadId:'old',interval:40});document.body.append(view.element);
 `,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
 const page=await browser.newPage();await page.setContent('<body></body>');await page.addScriptTag({content:outputFiles[0].text});
 await page.locator('summary').first().click();await page.getByText('retained',{exact:true}).waitFor();
 await page.evaluate(()=>fail=true);await page.getByText('offline',{exact:true}).waitFor();
 assert.equal(await page.getByText('retained',{exact:true}).isVisible(),true);
 await page.evaluate(()=>{fail=false;hold=true;});await page.waitForFunction(()=>!!window.release);
 await page.evaluate(()=>{view.dispose();view.element.remove();document.body.innerHTML='<div id="new">new desktop</div>';release();});
 await page.waitForTimeout(120);assert.equal(await page.locator('[data-turn]').count(),0);
 const n=await page.evaluate(()=>calls);await page.waitForTimeout(120);assert.equal(await page.evaluate(()=>calls),n);
 }finally{await browser.close();}
});

