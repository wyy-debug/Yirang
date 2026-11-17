import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('long conversation preserves reading and input through streaming, narrow layout and Escape', async () => {
  const bundle=await build({stdin:{contents:`
    import {createChatSurface} from './apps/electron/conversation/chat-surface.js';
    import {renderMessage} from './apps/electron/conversation/chat-markdown.js';
    window.surface=createChatSurface({frame:document.querySelector('#panel'),onLayoutStart(){},onLayoutEnd(){}});
    window.render=renderMessage;
  `,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:2560,height:1440}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const html=(await readFile('apps/electron/shell.html','utf8')).replace(/<link[^>]+>/g,'')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace('src="../../dist/panel-electron.html"','src="about:blank"');
    await page.route('http://127.0.0.1/reading',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://127.0.0.1/reading');
    for(const path of ['design-tokens.css','shell.css','composer/composer-layout.css'])
      await page.addStyleTag({content:await readFile('apps/electron/'+path,'utf8')});
    await page.evaluate(()=>document.documentElement.classList.add('managed-work-ui'));
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.evaluate(()=>{
      window.surface.setOpen(true,{animate:false});
      const messages=document.querySelector('#messages');messages.replaceChildren();
      for(let i=0;i<120;i++){
        const el=document.createElement('div');el.className='assistant';
        window.render(el,`历史消息 ${i}\n\n这是已读的内容。`);messages.append(el);
      }
      window.surface.contentChanged({force:true});
    });
    await page.locator('#input').fill('尚未发送的补充');
    await page.waitForTimeout(50);
    await page.evaluate(()=>{const messages=document.querySelector('#messages');messages.scrollTop=300;messages.dispatchEvent(new Event('scroll'));});
    const before=await page.locator('#messages').evaluate(el=>el.scrollTop);
    for(let i=0;i<30;i++) await page.evaluate(i=>{
      window.render(document.querySelector('#messages').lastElementChild,'追加内容 '+i+'\n\n'+('文本 '.repeat(i)));
      window.surface.contentChanged();window.surface.update({ready:true,running:true});
    },i);
    assert.ok(Math.abs(await page.locator('#messages').evaluate(el=>el.scrollTop)-before)<2);
    assert.equal(await page.locator('#input').inputValue(),'尚未发送的补充');
    assert.equal(await page.locator('#input').evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('#latest-message').isVisible(),true);
    await page.locator('#latest-message').click();
    assert.ok(await page.locator('#messages').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<48));
    await page.locator('#chat-resize').focus();await page.keyboard.press('Home');
    await page.evaluate(()=>{
      window.render(document.querySelector('#messages').lastElementChild,'列 A | 列 B\n--- | ---\n'+('长内容'.repeat(50))+' | 二\n\n```js\n'+('long_identifier_'.repeat(50))+'\n```');
      window.surface.contentChanged();
    });
    assert.ok(await page.locator('#chat').evaluate(el=>el.scrollWidth<=el.clientWidth+2),'320px sidebar must contain table/code overflow');
    await page.locator('#input').focus();await page.keyboard.press('Escape');
    assert.equal(await page.locator('#chat-toggle').evaluate(el=>el===document.activeElement),true);
    await page.locator('#chat-toggle').click();
    assert.equal(await page.locator('#input').inputValue(),'尚未发送的补充');
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
