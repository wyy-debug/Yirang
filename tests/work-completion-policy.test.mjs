import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationPolicy, requiresDeliveryConfirmation } from '../packages/components/work-confirmation.mjs';
import { missingDeliveries, reviseDeliveryFormats } from '../packages/components/work-delivery.mjs';

test('review survives unrelated revisions; explicit cancellation does not become permission', () => {
  const first = confirmationPolicy('先给我看，确认后再发布', undefined, 'r1');
  const second = confirmationPolicy('颜色改为蓝色', first, 'r2');
  assert.deepEqual(second, first);
  const third = confirmationPolicy('不用再确认', second, 'r3');
  assert.equal(third.required, false);
  assert.equal(third.sourceRequestId, 'r3');
  assert.equal('permissions' in third, false);
  assert.equal(confirmationPolicy('不用确认，发布前需要我审核', third).required, true);
});

test('legacy revisions replay actual amendments without reintroducing cancelled review', () => {
  const requirements = [
    {goal:'先给我看，确认后再发布'},
    {goal:'先给我看，确认后再发布\n不用确认',reason:'不用确认'},
    {goal:'旧目标仍含确认后再发布',reason:'颜色改蓝'},
  ];
  assert.equal(requiresDeliveryConfirmation({requirements}),false);
});

test('successful prose and partial artifacts cannot satisfy two requested formats', () => {
  const m = {requirements:[{goal:'生成 SVG 和 PPT'}]};
  assert.deepEqual(missingDeliveries(m,[]),['svg','ppt']);
  assert.deepEqual(missingDeliveries(m,[{title:'架构.svg',validity:'current'}]),['ppt']);
  assert.deepEqual(missingDeliveries(m,[{title:'架构.svg',validity:'current'},{title:'汇报.pptx',validity:'current'}]),[]);
  assert.deepEqual(missingDeliveries(m,[{title:'架构.svg',validity:'stale'},{title:'汇报.pptx',validity:'current'}]),['svg']);
  assert.deepEqual(missingDeliveries({requirements:[{goal:'解释 SVG 为什么损坏'}]},[]),[]);
  assert.deepEqual(missingDeliveries({requirements:[{goal:'根据 SVG 生成 PPT，不用生成 PDF'}]},[]),['ppt']);
});

test('output contract survives wording changes but explicit removal changes the contract', () => {
  const previous = {goal:'生成 SVG 和 PPT',delivery:{formats:['svg','ppt']}};
  assert.deepEqual(reviseDeliveryFormats(previous,'颜色改蓝'),['svg','ppt']);
  assert.deepEqual(reviseDeliveryFormats(previous,'不用 PPT，保留 SVG'),['svg']);
  assert.deepEqual(reviseDeliveryFormats(previous,'另外生成 PDF'),['svg','ppt','pdf']);
});

test('multiple outputs of one format require multiple distinct current objects', () => {
  const m={requirements:[{goal:'创建 alpha.txt 和 beta.txt'}]};
  const file={objectId:'one',title:'改过的标题',fileName:'alpha.txt',validity:'current'};
  assert.deepEqual(missingDeliveries(m,[file,file]),['beta.txt']);
  assert.deepEqual(missingDeliveries(m,[file,{...file,objectId:'two',fileName:'wrong.txt'}]),['beta.txt']);
  assert.deepEqual(missingDeliveries(m,[file,{...file,objectId:'two',fileName:'beta.txt'}]),[]);
  assert.deepEqual(missingDeliveries({requirements:[{goal:'生成两份 PPT'}]},[]),['ppt（缺 2 份）']);
});
