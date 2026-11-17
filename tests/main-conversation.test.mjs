import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainConversation } from '../apps/electron/work/main-conversation.mjs';

test('recovery serializes overlapping pages and never sends unknown deliveries', async () => {
  const writes = [], reads = [];
  const conversation = createMainConversation({
    orchestration: async (workspace, command) => { writes.push({workspace,...command}); },
    readHistory: async (thread) => {
      reads.push(thread);
      await new Promise(resolve => setTimeout(resolve, 5));
      return {data:[{id:thread, status:'completed',items:[{type:'agentMessage',text:thread}]}]};
    },
  });
  const request = id => ({delivery:{state:'acknowledged',threadId:id,turnId:id}});
  await Promise.all([
    conversation.recover('desk',[request('a')]),
    conversation.recover('desk',[request('b'),{delivery:{state:'unknown',threadId:'c'}}]),
  ]);
  assert.deepEqual(reads,['a','b']);
  assert.deepEqual(writes.map(x=>x.turnId),['a','b']);
  assert.ok(writes.every(x=>x.operation==='consult_result' && x.workspace==='desk'));
});

test('failed recovery does not prevent subsequent recovery and running turns are not completed', async () => {
  const writes=[];
  let fail=true;
  const conversation=createMainConversation({
    orchestration:async (w,c)=>writes.push(c),
    readHistory:async ()=>{if(fail){fail=false;throw Error('disconnected');}return {data:[{id:'a',status:'inProgress'}]};},
  });
  const requests=[{delivery:{state:'acknowledged',threadId:'t',turnId:'a'}}];
  await assert.rejects(conversation.recover('desk',requests),/disconnected/);
  await conversation.recover('desk',requests);
  assert.equal(writes.length,0);
});
