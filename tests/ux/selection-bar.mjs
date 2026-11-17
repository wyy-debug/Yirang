import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import ts from 'typescript';

test('selection bar keeps frequent actions direct for single and multiple selections', async () => {
  const source = await readFile('apps/panel/index.tsx', 'utf8');
  const syntax = ts.createSourceFile(
    'index.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let selectionMarkup;
  function findSelection(node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(syntax) === 'className' &&
          attribute.initializer &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === 'material-dock',
      )
    ) {
      selectionMarkup = node.getText(syntax);
    }
    ts.forEachChild(node, findSelection);
  }
  findSelection(syntax);
  assert.ok(selectionMarkup, 'production material dock must exist');
  const entry = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {IntentWorkbench,IntentSelection} from './apps/panel/interaction/intent-workbench.tsx';import {ActionPopover} from './apps/panel/ui/workbench-chrome.tsx';import {DesktopArrangeMenu} from './apps/panel/canvas/desktop-arrange.tsx';import {Icon,FileBadge} from './apps/panel/ui/icons.tsx';import {t as uiText,setUiLanguage} from './packages/components/ui-language.ts';window.language=setUiLanguage;
 const busy=false,isIntegratedDesktop=true,attached=null,ranges={},binding={messageRouteAvailable:true},bridge={connectionMessage:()=>'',supportsAttachments:()=>true},connection='ready',hostReady=true,arrangementBusy=false,deletion={busy:false,pendingCount:0},duplication={busy:false},canvasHistory={canUndo:false,canRedo:false};
 const workspace={objects:[{id:'file',title:'季度项目计划.md',kind:'file',content:{fileName:'季度项目计划.md'},revision:1}],groups:{items:[]}};const noop=()=>{},regions={create:()=>window.regionCreated=true},setCommentsTarget=noop,beginRename=()=>window.renamed=true,connectSelected=noop,setFilesOpen=noop,canArrange=()=>true,arrangeSelection=mode=>window.arranged=mode,undoArrangement=noop,flush=async()=>{},setContextPreview=noop,report=noop,setProtectionObject=noop,localCodeRuntime=()=>false,openLocalRuns=noop,openPreview=()=>window.previewed=true,deleteMaterials=noop,attachMaterials=noop,removeAttached=noop,setRanges=noop,setNodes=noop;
 function App(){const [selected,setSelected]=useState(['file']),[selectionTools,setSelectionTools]=useState(false),[selectionList,setSelectionList]=useState(false),[selectionArrange,setSelectionArrange]=useState(false);window.selectFiles=setSelected;const selectObjects=setSelected;return <div className="desktop-shell"><IntentWorkbench workspaceId="desk" visible inspect={noop}/><IntentSelection integrated>{${selectionMarkup}}</IntentSelection></div>;}createRoot(document.getElementById('root')).render(<App/>);`;
  const js = (
    await build({
      stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() },
      bundle: true,
      write: false,
      outfile: 'fixture.js',
      format: 'iife',
      loader: { '.png': 'dataurl' },
    })
  ).outputFiles.find((f) => !f.path.endsWith('.css')).text;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://127.0.0.1/selection', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html class="electron-mode"><body><div id="root"></div></body></html>',
      }),
    );
    await page.goto('http://127.0.0.1/selection');
    await page.addStyleTag({ content: await readFile('apps/electron/design-tokens.css', 'utf8') });
    for (const path of [
      'styles.css',
      'workbench-theme.css',
      'workbench-interactions.css',
      'interaction/intent-workbench.css',
      'canvas/desktop-arrange.css',
      'electron-mode.css',
    ])
      await page.addStyleTag({
        content: (await readFile('apps/panel/' + path, 'utf8')).replace(/@import[^;]*;/g, ''),
      });
    await page.addStyleTag({
      content: 'body{background:#f5f7fa}.electron-mode{--workspace-nav-width:0px}',
    });
    await page.addScriptTag({ content: js });
    await page.locator('.material-dock').waitFor();
    const bar = page.locator('.intent-work-bar'),
      dock = page.locator('.material-dock');
    for (const name of ['问 AI', '预览', '改名', '删除所选材料'])
      assert.equal(await bar.getByRole('button', { name, exact: true }).isVisible(), true);
    assert.equal(await bar.locator('.intent-work-entry').count(), 0);
    await bar.getByRole('button', { name: '改名', exact: true }).click();
    assert.equal(await page.evaluate(() => window.renamed), true);
    await bar.getByRole('button', { name: '预览', exact: true }).click();
    assert.equal(await page.evaluate(() => window.previewed), true);
    assert.equal(await dock.getByRole('button', { name: '排列', exact: true }).count(), 0);
    await mkdir('test-results/selection-bar', { recursive: true });
    await bar.screenshot({ path: 'test-results/selection-bar/single.png' });
    await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '评论', exact: true }).isVisible(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '查看执行记录', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: '执行记录' }).isVisible(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.selectFiles(['file', 'second', 'third']));
    await dock.getByRole('button', { name: '排列', exact: true }).waitFor();
    await dock.getByRole('button', { name: '创建区域', exact: true }).click();
    assert.equal(await page.evaluate(() => window.regionCreated), true);
    await dock.getByRole('button', { name: '排列', exact: true }).click();
    await page.getByRole('button', { name: '整理成网格', exact: true }).click();
    assert.equal(await page.evaluate(() => window.arranged), 'grid');
    assert.equal(await page.getByRole('group', { name: '排列', exact: true }).count(), 0);
    await bar.screenshot({ path: 'test-results/selection-bar/multiple.png' });
    for (const ids of [['file'], ['file', 'second', 'third']]) {
      await page.evaluate((ids) => window.selectFiles(ids), ids);
      for (const [width, nav] of [
        [800, 220],
        [650, 180],
        [480, 64],
      ]) {
        await page.evaluate(
          (nav) => document.documentElement.style.setProperty('--workspace-nav-width', nav + 'px'),
          nav,
        );
        await page.setViewportSize({ width, height: 800 });
        const rect = await bar.boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
        for (const button of await bar.locator('button:visible').all()) {
          const r = await button.boundingBox();
          assert.ok(r.x >= 0 && r.x + r.width <= width, 'visible action outside viewport');
        }
        await page.getByRole('button', { name: '更多文件操作', exact: true }).click();
        const menu = await page.getByRole('group', { name: '更多文件操作' }).boundingBox();
        assert.ok(menu.x >= 0 && menu.x + menu.width <= width);
        await page.keyboard.press('Escape');
      }
    }
    await page.evaluate(() => window.language('en'));
    for (const ids of [['file'], ['file', 'second', 'third']]) {
      await page.evaluate((ids) => window.selectFiles(ids), ids);
      for (const width of [650, 480]) {
        await page.setViewportSize({ width, height: 800 });
        for (const control of [
          'selection-preview',
          ids.length === 1 ? 'selection-rename' : 'selection-group',
        ])
          assert.equal(
            await dock
              .locator(':scope > .' + control + '>span')
              .evaluate((node) => getComputedStyle(node).display),
            'none',
          );
        for (const button of await bar.locator('button:visible').all()) {
          const r = await button.boundingBox();
          assert.ok(r.x >= 0 && r.x + r.width <= width, 'English action outside viewport');
        }
      }
    }
    await bar.screenshot({ path: 'test-results/selection-bar/narrow.png' });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
