import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnInput } from '../apps/electron/conversation/turn-prompt.mjs';

const fixture = {text:'生成文件',attached:[],extra:[],batch:{id:'batch',directory:'F:/out'},
  projectCwd:'F:/project',outputRoot:'F:/out'};
test('managed execution carries automatic file collection contract and its actual cwd', () => {
  const blocks = buildTurnInput({...fixture,work:{task:{id:'task'},run:{id:'run'}}});
  const context = JSON.parse(blocks[1].text);
  assert.equal(context.output.cwd,'F:/out');
  assert.match(context.output.instructions,/output.directory/);
  assert.match(context.output.instructions,/desktop_file_result/);
  assert.equal(blocks[0].text,fixture.text);
});
test('read-only answers do not advertise file output or lose the user request', () => {
  const blocks = buildTurnInput({...fixture,consult:{}});
  assert.equal(JSON.parse(blocks[1].text).output,null);
  assert.equal(blocks[0].text,fixture.text);
});

test('ordinary Codex chat receives the user request and writable output contract', () => {
  const blocks = buildTurnInput(fixture);
  const context = JSON.parse(blocks[1].text);
  assert.equal(context.output.directory,'F:/out');
  assert.doesNotMatch(context.interaction,/desktop_codex_conversations/);
  assert.equal(blocks[0].text,fixture.text);
});

test('explicit file references stay attached to the current Codex turn', () => {
  const selected = { type: 'text', text: '引用文件：proof.svg',
    _meta: { 'ai-desktop/selection': { objects: [{ id: 'svg-1' }] } } };
  const blocks = buildTurnInput({...fixture,attached:[selected]});
  const context = JSON.parse(blocks[1].text);
  assert.equal(context.materials[0].metadata['ai-desktop/selection'].objects[0].id,'svg-1');
  assert.doesNotMatch(context.interaction,/原生对话索引/);
  assert.equal(context.output.directory,'F:/out');
});
