import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

test('Codex question choices preserve descriptions, drafts and identity through retry', async () => {
  const bundle = await build({stdin:{contents:`
    import {createApprovalCard} from './apps/electron/conversation/approval-card.js';
    window.calls=[];window.fail=true;
    document.body.append(createApprovalCard({id:'request-a',method:'item/tool/requestUserInput',params:{questions:[
      {id:'direction',question:'你真正想实现的是哪一种？',options:[{label:'A. 本地运行',description:'保留原有操作方式'},{label:'B. 协同运行',description:'让两个设备共同处理'}]},
      {id:'details',question:'还有什么要求？'}
    ]}}, {respond:async(id,response)=>{window.calls.push({id,response});if(window.fail)throw Error('连接失败，请重试');},onSettled:()=>window.settled=true,onError:()=>{}}));
  `,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:2560,height:1440}});
    await page.setContent('<body style="width:390px;margin:30px"></body>');
    for (const file of ['apps/electron/design-tokens.css','apps/electron/shell.css','apps/electron/conversation/question-card.css'])
      await page.addStyleTag({content:await readFile(file,'utf8')});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const submit = page.getByRole('button',{name:'确认并继续'});
    assert.equal(await page.locator('select').count(),0);
    assert.equal(await page.getByText('让两个设备共同处理').isVisible(),true);
    assert.equal(await submit.isDisabled(),true);
    await page.getByRole('radio',{name:/B. 协同运行/}).check();
    await page.getByText('补充说明',{exact:true}).click();
    await page.getByRole('textbox',{name:'补充说明'}).fill('先做原型');
    await page.getByRole('textbox',{name:'还有什么要求？'}).fill('保持简洁');
    await submit.click();
    await page.getByRole('alert').getByText('连接失败，请重试').waitFor();
    assert.equal(await page.getByRole('textbox',{name:'补充说明'}).inputValue(),'先做原型');
    await page.evaluate(()=>window.fail=false);
    await submit.click();
    await page.waitForFunction(()=>window.settled);
    const calls = await page.evaluate(()=>window.calls);
    assert.equal(calls.length,2);
    assert.deepEqual(calls[0],calls[1]);
    assert.deepEqual(calls[1],{id:'request-a',response:{answers:{direction:['B. 协同运行','先做原型'],details:['保持简洁']}}});
    assert.equal(await page.locator('.approval').count(),0);
  } finally { await browser.close(); }
});
