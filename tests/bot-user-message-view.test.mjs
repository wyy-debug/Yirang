import test from 'node:test';
import assert from 'node:assert/strict';
import {userMessageText, visibleUserText} from '../apps/electron/conversation/user-message-view.mjs';
import {expectedDeliveryFormats, missingDeliveries} from '../packages/components/work-delivery.mjs';
import {projectWorkReport} from '../apps/electron/work/work-report-journal.mjs';

const suffix = '\n\n这是用户截取的一壤画布局部截图，并附带原材料引用。截图只展示局部，不能代表完整文件。\n工作区：desk\n关联原材料：';
test('execution history keeps user text but excludes separate internal context blocks', () => {
  const content = [{type:'text',text:'修复原图'}, {type:'text',text:JSON.stringify({type:'yirang.turn-context',taskId:'private'})}];
  assert.equal(visibleUserText({content}), '修复原图');
  assert.equal(content.length, 2);
  assert.equal(visibleUserText({text:'{"type":"user.example"}'}), '{"type":"user.example"}');
});
test('live and saved screenshot text keeps original question without changing transport or references', () => {
  const sources = [{id:'svg',title:'架构.svg',revision:1}];
  const transport = '修复这个' + suffix + JSON.stringify(sources);
  assert.equal(userMessageText(transport),'修复这个');
  assert.ok(transport.endsWith(JSON.stringify(sources)));
  assert.equal(userMessageText('请解释工作区：desk'), '请解释工作区：desk');
  assert.equal(userMessageText('问题' + suffix + '不是 JSON'), '问题' + suffix + '不是 JSON');
  assert.equal(userMessageText('问题' + suffix + '["用户原文"]'), '问题' + suffix + '["用户原文"]');
});
const requirement = {goal:'修复这个', sources:[{objectId:'svg',title:'架构.svg',revision:1}]};
test('selected native-file repair needs updated original evidence; text and copied files cannot complete it', () => {
  assert.deepEqual(expectedDeliveryFormats(requirement),['svg']);
  const management = {state:'completed',requirements:[requirement],runs:[],artifacts:[]};
  assert.ok(missingDeliveries(management,[]).length);
  assert.ok(missingDeliveries(management,[{objectId:'copy',title:'架构.svg',revision:2,validity:'current'}]).includes('架构.svg'));
  assert.ok(missingDeliveries(management,[{objectId:'svg',title:'架构.svg',revision:1,validity:'current'}]).length);
  assert.deepEqual(missingDeliveries(management,[{objectId:'svg',title:'架构.svg',revision:2,validity:'current'}]),[]);
  assert.equal(projectWorkReport({id:'a',management},{workspaceId:'desk'}).state,'attention');
  assert.deepEqual(missingDeliveries({requirements:[{...requirement,goal:'只解释原因，不要修改'}]},[]),[]);
  assert.deepEqual(missingDeliveries({requirements:[{goal:'3乘7是多少'}]},[]),[]);
});
