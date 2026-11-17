import test from 'node:test';
import assert from 'node:assert/strict';
import { attachConversationReports } from '../apps/electron/work/conversation-reports.mjs';

test('durable reports attach to the current originating request without crossing workspaces', () => {
  const page = {workspaceId:'desk', requests:[{id:'old'}, {id:'latest',workRequestIds:['bot:effect-current']}]};
  const task = {id:'a',title:'修复图',revision:2,management:{state:'running',generation:2,
    currentRequirementsRevision:2,requirements:[{revision:1,sourceRequestId:'old'},{revision:2,sourceRequestId:'bot:effect-current'}],
    runs:[],artifacts:[{objectId:'deleted',validity:'deleted'},{objectId:'live',title:'图.svg',validity:'current'}]}};
  const snapshot = {workspaceId:'desk',tasks:[task,{...task,id:'archived',archived:true},
    {...task,id:'child',management:{...task.management,parentTaskId:'a'}}]};
  const result = attachConversationReports(page,snapshot);
  assert.equal(result.requests[0].reports.length,0);
  assert.equal(result.requests[1].reports.length,1);
  assert.deepEqual(result.requests[1].reports[0].artifacts.map(a=>a.objectId),['live']);
  assert.deepEqual(attachConversationReports(result,snapshot),result);
  assert.equal(attachConversationReports(page,{...snapshot,workspaceId:'other'}),page);
  assert.equal(page.requests[1].reports,undefined);
});
