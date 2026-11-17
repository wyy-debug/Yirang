import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('history exposes earlier executions without dispatching or losing the selected run on refresh', async () => {
  const { outputFiles } = await build({ stdin: { contents: `
    import {createWorkHistory} from './apps/electron/work/work-history-view.js';
    window.calls=[];
    window.desktop={workManagement:async args=>{
      calls.push(args);
      if(args.command.operation!=='execution_history')throw Error('unexpected mutation');
      return {data:[{id:args.command.payload.threadId,items:[{type:'agentMessage',text:'history '+args.command.payload.threadId}]}]};
    }};
    window.runs=[{threadId:'old',state:'failed'},{threadId:'pending',state:'starting'},{threadId:'current',state:'succeeded'}];
    window.view=createWorkHistory({workspaceId:'desk'});
    document.body.append(view.element);view.update(runs);
  `, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
    await page.setContent('<body></body>');
    await page.addScriptTag({ content: outputFiles[0].text });
    assert.equal(await page.locator('select option').count(), 2);
    assert.equal(await page.locator('select').inputValue(), 'current');
    await page.locator('select').selectOption('old');
    await page.locator('.work-execution-inline > summary').click();
    await page.getByText('history old', { exact: true }).waitFor();
    await page.evaluate(() => view.update([...runs, {threadId:'current',state:'succeeded'}]));
    assert.equal(await page.locator('select').inputValue(), 'old');
    assert.equal(await page.locator('select option').count(), 2);
    assert.equal(await page.getByText('history old', { exact: true }).isVisible(), true);
    assert.ok(await page.evaluate(() => calls.every(c => c.workspaceId === 'desk' && c.command.operation === 'execution_history')));
    await page.evaluate(() => { view.update([]); view.dispose(); });
    assert.equal(await page.locator('.work-history').isVisible(), false);
  } finally { await browser.close(); }
});
