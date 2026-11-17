import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DesktopStore} from '../packages/local-runtime/store.js';

test('deleted source cannot be prepared; deleted delivery is stale and excluded from continuation',t=>{
  const directory=mkdtempSync(join(tmpdir(),'work-deleted-'));
  const store=new DesktopStore(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.createWorkspace('deleted-check');
  const b=(store.open('deleted-check') as any).binding;
  const create=(title:string)=>store.createObject(b.workspaceId,b.credential,'deleted-check',randomUUID(),{
    kind:'text',title,content:{blocks:[{id:'p',text:'不应重新引用的材料'}]},bounds:{x:0,y:0,width:300,height:200},
  }) as any;
  const command=(operation:string,taskId?:string,payload:any={})=>store.workManagement.command(b.workspaceId,{
    operation,taskId,payload,requestId:randomUUID(),...(taskId?{expectedRevision:(store.workManagement.command(b.workspaceId,{operation:'detail',taskId},true) as any).revision}:{}),
  },true) as any;
  const archive=(o:any)=>store.manageObject(b.workspaceId,b.credential,'deleted-check',{
    operation:'archive',objectId:o.id,expectedRevision:o.revision,requestId:randomUUID(),
  });
  const source=create('原材料');
  const work=command('intake',undefined,{text:'读取材料',sources:[{objectId:source.id,revision:source.revision}]}).task;
  assert.equal(command('prepare',work.id).context.sources.length,1);
  archive(source);
  assert.throws(()=>command('prepare',work.id),/材料已删除|禁止引用/);
  const result=create('已有成果');
  const next=command('intake',undefined,{text:'生成成果'}).task;
  const run=command('dispatch',next.id,{threadId:'worker',provider:'codex',controlled:true,dispatchKey:'deleted-result'}).run;
  command('ack',next.id,{runId:run.id,threadId:'worker',turnId:'turn'});
  command('finish',next.id,{runId:run.id,state:'succeeded',resultText:'已保存',artifacts:[{objectId:result.id,revision:result.revision}]});
  archive(result);
  assert.equal(command('detail',next.id).management.artifacts[0].validity,'stale');
  command('revise',next.id,{text:'继续处理，已删除成果不再引用',continueRun:true});
  assert.deepEqual(command('prepare',next.id).context.existingArtifacts,[]);
});
