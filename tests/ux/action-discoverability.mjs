import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('primary actions stay accessible across work, preview, navigation and settings', async () => {
  const panelSource = await readFile('apps/panel/index.tsx', 'utf8'),
    headerStart = panelSource.indexOf('<header>', panelSource.indexOf('className="full-view"')),
    headerEnd = panelSource.indexOf('</header>', headerStart) + 9;
  const entry = `
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {DesktopPreview} from './apps/panel/documents/desktop-preview.tsx';import {useFileAiTarget} from './apps/panel/interaction/use-file-ai-target.ts';import {WorkbenchChrome,ActionPopover} from './apps/panel/ui/workbench-chrome.tsx';import {Icon} from './apps/panel/ui/icons.tsx';import {t as uiText} from './packages/components/ui-language.ts';import {createSettingsLayout} from './apps/electron/settings/settings-layout.js';
 const noop=()=>{};window.commands=[];window.inspected=[];window.previewed=[];
 const source='相同文字\\n\\n相同文字';
 const object={id:'file',kind:'text',title:'报告.md',revision:2,content:{blocks:[{id:'b',text:source}]}};
 const task={id:'work',title:'整理季度报告',goal:'整理报告',revision:1,updatedAt:'2026-11-01T04:00:00Z',sources:[{objectId:'source',title:'原始报告',kind:'text',revision:1}],management:{state:'review',reason:'已完成，等待验收',currentRequirementsRevision:1,requirements:[{revision:1,goal:'整理季度报告，保留原始数据',deliverables:'一份报告',acceptanceCriteria:'内容完整'}],runs:[{id:'run',threadId:'thread',state:'succeeded',requirementsRevision:1,appliedRequirementsRevision:1,resultHash:'result',resultText:'已整理报告，并核对了原始数据。'}],artifacts:[{runId:'run',objectId:'file',title:'季度报告.md',revision:2,validity:'current'}],requestIds:['request'],schedule:{priority:1,timezone:'Asia/Hong_Kong'},dependencies:[],acceptances:[],delegation:{children:['child']}}};
 const child={...task,id:'child',title:'核对数据',management:{...task.management,parentTaskId:'work',state:'attention',reason:'需要确认口径'}};
 const snapshot={workspaceId:'desk',tasks:[task,child],goals:[],notices:[],capabilities:{maxConcurrent:6},hostCondition:'一壤正在运行'};
 window.addEventListener('message',e=>{const d=e.data;if(d?.type==='ai-desktop:file-ai-toggle')window.postMessage({type:'ai-desktop:file-ai-mode',active:true},'*');if(d?.type==='ai-desktop:file-ai-target')window.postMessage({type:'ai-desktop:file-ai-prepare',id:d.id},'*');if(!['yirang:work-command','yirang:work-timings'].includes(d?.type))return;const c=d.args.command;window.commands.push(c);const value=c.operation==='list'?snapshot:c.operation==='detail'?task:c.operation==='review'?{criteria:['内容完整'],files:[]}:c.operation==='timings'?{runs:[]}:{receipt:'已保存'};window.postMessage({type:'yirang:work-response',requestId:d.requestId,value},'*');});
 function Preview(){useFileAiTarget({available:true,workspaceId:'desk',selected:()=>[],find:id=>id==='file'?object:undefined,attach:async(id,cancelled,quote)=>{window.attached={id,quote};return true;},attachMany:async()=>true,attachWidget:async()=>true,notice:message=>window.notice=message});return <DesktopPreview object={object} action={async()=>{}} close={()=>window.closed=true} edit={()=>window.edited=true} ask={()=>window.postMessage({type:'ai-desktop:file-ai-toggle'},'*')}/>;}
 const navProps={workspaceName:'我的工作桌面',workspaceId:'desk',itemCount:3,active:'canvas',collapsed:false,desktopActions:true,ready:true,directoryOpen:false,newMenu:false,zoom:100,navigate:id=>window.destination=id};for(const key of ['applications','createRegion','toggleSidebar','search','workspaces','commands','shortcuts','save','importFiles','layouts','annotations','setNewMenu','create','changeZoom','fit','directory'])navProps[key]=noop;
 function Editor(){const [kind,setKind]=useState('file'),[fileActionsOpen,setFileActionsOpen]=useState(false);window.editorKind=setKind;const expanded={id:'document',title:'报告',kind,revision:1},busy=false,imageDirty=false,fileDirty=false,workflowReturn=null,deletion={busy:false,pendingCount:0},setFull=noop,workflowDirtyChanged=noop,flush=async()=>{},setCommentsTarget=noop,setRevisionTarget=noop,setRevisionObject=noop,setProtectionObject=noop,exportObject=async(...args)=>window.exported=args,generateArtifact=async(...args)=>window.generated=args,deleteMaterials=noop,action=async()=>{},reload=noop,report=noop,uid=()=>'';return <section className="full-view">${panelSource.slice(headerStart, headerEnd)}</section>;}
 function App(){const [view,setView]=useState('preview');window.show=setView;return <div className="desktop-shell">{view==='preview'?<Preview/>:view==='navigation'?<WorkbenchChrome {...navProps}/>:view==='editor'?<Editor/>:null}</div>;}createRoot(document.getElementById('root')).render(<App/>);
 window.showSettings=()=>{const dialog=document.createElement('dialog');dialog.className='desktop-settings organized-settings';dialog.innerHTML='<header><h2>设置</h2></header>';document.body.append(dialog);const layout=createSettingsLayout(dialog,'general',noop);layout.row('general','文件 AI 快捷键','',[document.createElement('input')]);layout.row('ai','连接','',[Object.assign(document.createElement('button'),{textContent:'重新连接',onclick:()=>window.reconnected=true})]);dialog.showModal();};
 `;
  const bundle = await build({
    stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true,
    write: false,
    outfile: 'fixture.js',
    loader: { '.png': 'dataurl' },
    format: 'iife',
  });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://127.0.0.1/action-ui', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html class="electron-mode" data-usage-mode="daily"><body><div id="root"></div></body></html>',
      }),
    );
    await page.goto('http://127.0.0.1/action-ui');
    await page.addStyleTag({ content: await readFile('apps/electron/design-tokens.css', 'utf8') });
    for (const name of [
      'styles.css',
      'workbench-theme.css',
      'workbench-interactions.css',
      'electron-mode.css',
    ])
      await page.addStyleTag({
        content: (await readFile('apps/panel/' + name, 'utf8')).replace(/@import[^;]*;/g, ''),
      });
    for (const f of bundle.outputFiles.filter((f) => f.path.endsWith('.css')))
      await page.addStyleTag({ content: f.text });
    await page.addScriptTag({
      content: bundle.outputFiles.find((f) => f.path.endsWith('.js')).text,
    });
    await mkdir('test-results/action-discoverability', { recursive: true });
    await page.evaluate(() => window.show('preview'));
    await page.locator('.desktop-preview-ask').waitFor();
    await page.evaluate(() => {
      const spans = [
        ...document.querySelectorAll('.desktop-preview-document [data-source-start]'),
      ].filter((n) => n.textContent === '相同文字');
      const n = spans.at(-1);
      if (!n) throw Error('Missing rendered source span');
      const r = document.createRange();
      r.selectNodeContents(n);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
      window.expectedStart = Number(n.dataset.sourceStart);
    });
    await page.locator('.desktop-preview-ask').click();
    await page.waitForFunction(() => window.attached);
    const quote = await page.evaluate(() => window.attached.quote);
    assert.equal(quote.text, '相同文字');
    assert.ok(quote.spans.some((s) => s.start === 6));
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '相同文字');
    await page
      .locator('.desktop-preview-window')
      .screenshot({ path: 'test-results/action-discoverability/preview.png' });
    await page.evaluate(() => window.show('navigation'));
    await page.getByRole('button', { name: '最近使用', exact: true }).click();
    assert.equal(await page.evaluate(() => window.destination), 'recent');
    assert.equal(await page.getByRole('button', { name: '收藏', exact: true }).isVisible(), true);
    await page.locator('.sidebar-more-tools>summary').click();
    assert.equal(await page.getByRole('button', { name: '回收站', exact: true }).isVisible(), true);
    await page.evaluate(() => window.show('editor'));
    await page.getByRole('button', { name: '导出', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.exported), ['document']);
    await page.evaluate(() => window.editorKind('deck'));
    await page.getByRole('button', { name: '导出', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.generated), ['document', 'pptx']);
    await page.evaluate(() => window.show('none'));
    await page.addStyleTag({ content: await readFile('apps/electron/shell.css', 'utf8') });
    await page.evaluate(() => window.showSettings());
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    assert.equal(await page.evaluate(() => window.reconnected), true);
    assert.equal(
      await page.getByRole('button', { name: '故障排查', exact: true }).isVisible(),
      true,
    );
    await page
      .locator('dialog')
      .screenshot({ path: 'test-results/action-discoverability/settings.png' });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
