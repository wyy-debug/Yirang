// Served by the host so existing apps receive compatible fixes without copying SDK files.
export const sdkSource = String.raw`(()=>{
  if(window.yirang?.apiVersion>=2)return;
  const script=document.currentScript,base=new URL('.',script?.src||location.href),endpoint=new URL('api',base);
  async function request(body){const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok||v.error)throw Error(v.error||'请求失败');return v;}
  // Opaque-origin frames cannot access Chromium storage. Hydrate synchronously
  // before application scripts, then persist ordered key operations per instance.
  let storageWrites=Promise.resolve();
  function storage(seed,persist){
    let values=new Map(Object.entries(seed||{}));
    const methods={getItem:key=>values.get(String(key))??null,key:index=>Array.from(values.keys())[Number(index)>>>0]??null,
      setItem(key,value){key=String(key);value=String(value);const next=new Map(values);next.set(key,value);if(JSON.stringify(Object.fromEntries(next)).length>48000)throw new DOMException('应用存储超过 48 KiB','QuotaExceededError');values=next;persist?.({action:'set',key,value});},
      removeItem(key){key=String(key);values.delete(key);persist?.({action:'remove',key});},clear(){values.clear();persist?.({action:'clear'});}};
    return new Proxy(Object.create(null),{get:(_,key)=>key==='length'?values.size:Object.hasOwn(methods,key)?methods[key]:typeof key==='string'?values.get(key):undefined,
      set:(_,key,value)=>{methods.setItem(key,value);return true;},deleteProperty:(_,key)=>{methods.removeItem(key);return true;},ownKeys:()=>Array.from(values.keys()),
      getOwnPropertyDescriptor:(_,key)=>values.has(key)?{configurable:true,enumerable:true,writable:true,value:values.get(key)}:undefined});
  }
  const local=storage(/*YIRANG_STORAGE_SEED*/{},change=>{storageWrites=storageWrites.then(async()=>{const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({operation:'storage_mutate',...change}),keepalive:true});const v=await r.json();if(!r.ok||v.error)throw Error(v.error||'存储失败');}).catch(error=>parent.postMessage({type:'yirang:page-error',message:'页面存储未保存：'+error.message},'*'));});
  Object.defineProperty(window,'localStorage',{configurable:true,value:local});
  Object.defineProperty(window,'sessionStorage',{configurable:true,value:storage({})});
  const pending=new Map();
  addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='yirang:sdk-result')return;const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);clearTimeout(p.timer);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.result);});
  function host(operation,payload={}){return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('宿主操作超时'));},120000);pending.set(id,{resolve,reject,timer});parent.postMessage({type:'yirang:sdk',id,operation,payload},'*');});}
  async function run(id){return (await request({operation:'runs_get',runId:id}))[0];}
  function subscribe(id,listener,{interval=1200}={}){let live=true,timer;async function poll(){try{const value=await run(id);if(!live)return;listener(value);if(value&&['completed','failed','cancelled','interrupted'].includes(value.state))return;}catch(error){if(live)listener({state:'unavailable',error:error.message});}if(live)timer=setTimeout(poll,Math.max(1000,interval));}void poll();return()=>{live=false;clearTimeout(timer);};}
  const remote=/*YIRANG_REMOTE*/false,widgetParams=new URLSearchParams(location.search);
  const widget={id:widgetParams.get('widget'),size:Number(widgetParams.get('size'))||1,
    watchState(listener,{interval=remote?5000:15000}={}){let live=true,timer,last='';async function poll(){if(document.hidden){if(live)timer=setTimeout(poll,Math.max(5000,interval));return;}try{const value=await request({operation:'state_get'}),connection=remote?await request({operation:'connection_status'}):{remote:false,online:true},serialized=JSON.stringify([value,connection.online]);if(live&&serialized!==last){last=serialized;listener(value,connection);}}catch(error){if(live)parent.postMessage({type:'yirang:page-error',message:String(error.message)},'*');}if(live)timer=setTimeout(poll,Math.max(remote?5000:10000,interval));}void poll();return()=>{live=false;clearTimeout(timer);};}};
  window.yirang={widget,apiVersion:3,
    ai:{run:(name,input={},options={})=>host('ai_run',{capability:name,input,materials:(Array.isArray(options.materials)?options.materials:options.materials?.objects||[]).map(m=>typeof m==='string'?m:m.id),requestId:options.requestId||crypto.randomUUID()})},
    feedback:(runId,value={})=>request({operation:'feedback',runId,verdict:value.verdict,note:value.note}),
    results:{edit:(runId,output)=>request({operation:'result_edit',runId,output})},
    examples:{propose:(runId,output)=>host('examples_propose',{runId,output})},connection:{get:()=>remote?request({operation:'connection_status'}):Promise.resolve({remote:false,online:true})},call:(action,input={},options={})=>request({operation:'action_call',action,input,requestId:options.requestId||crypto.randomUUID()}),runs:()=>request({operation:'runs_get'}),run,subscribe,
    wait:async(id,{signal,timeout=600000}={})=>{const end=Date.now()+timeout;while(Date.now()<end){if(signal?.aborted)throw Error('已停止等待，后台任务继续运行');const v=await run(id);if(v&&['completed','failed','cancelled','interrupted'].includes(v.state))return v;await new Promise(r=>setTimeout(r,1200));}throw Error('等待超时，后台任务继续运行');},
    cancel:runId=>request({operation:'cancel',runId}),outputs:()=>request({operation:'outputs_list'}),
    state:{get:()=>request({operation:'state_get'}),set:value=>request({operation:'state_set',value})},
    files:{pick:()=>host('files_pick')},materials:{pick:()=>host('materials_pick')},
    outputsImport:(runId,path)=>host('outputs_import',{runId,path}),openOutput:(runId,path)=>host('output_open',{runId,path}),
    focusedRun:()=>new URLSearchParams(location.hash.slice(1)).get('run')||null,onFocusRun:listener=>{const f=()=>{const id=new URLSearchParams(location.hash.slice(1)).get('run');if(id)listener(id);};f();addEventListener('hashchange',f);return()=>removeEventListener('hashchange',f);},
    askAI:task=>host('ask_ai',{task}),reportError:message=>host('report_error',{message:String(message).slice(0,4000)})};
  addEventListener('error',e=>{parent.postMessage({type:'yirang:page-error',message:String(e.message).slice(0,4000)},'*');});
  addEventListener('unhandledrejection',e=>{parent.postMessage({type:'yirang:page-error',message:String(e.reason?.message||e.reason).slice(0,4000)},'*');});
})();`;
