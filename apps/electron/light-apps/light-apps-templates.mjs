import { widgetContract } from './light-app-widgets-contract.mjs';
import { sdkSource } from './light-apps-sdk.mjs';
export function scaffoldFiles(id, name, runtime) {
  if (!['python', 'node', 'static'].includes(runtime)) throw Error('只支持 python、node、static');
  const manifest = {
    schemaVersion: 1,
    minHostApi: 2,
    id,
    name,
    version: '0.1.0',
    runtime: {
      kind: runtime,
      ...(runtime === 'static'
        ? {}
        : { entry: runtime === 'python' ? 'backend/main.py' : 'backend/main.mjs' }),
    },
    ui: { entry: 'ui/index.html' },
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    actions:
      runtime === 'static'
        ? []
        : [
            {
              name: 'echo',
              title: '回显输入',
              effect: 'read',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string', maxLength: 4000 } },
                required: ['text'],
                additionalProperties: false,
              },
              outputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
              timeoutMs: 30000,
            },
          ],
  };
  const files = {
    'yirang.app.json': JSON.stringify(manifest, null, 2) + '\n',
    'ui/index.html': `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>轻应用</title><style>body{font:15px system-ui;color:#202735;max-width:720px;margin:60px auto;padding:24px}input,button,pre{padding:12px;border:1px solid #e5e7eb;border-radius:12px}button{background:#2878ff;color:white}pre{white-space:pre-wrap}</style><h1>你的轻应用</h1><p>页面和 MCP 使用同一套动作与运行记录。</p><input id="text" placeholder="输入内容"><button id="run">运行 echo</button><pre id="result">准备就绪</pre><script src="./yirang.js"></script><script>document.querySelector('#run').onclick=async()=>{const box=document.querySelector('#result');try{const run=await yirang.call('echo',{text:document.querySelector('#text').value});box.textContent=JSON.stringify(await yirang.wait(run.id),null,2)}catch(e){box.textContent=e.message}}</script></html>`,
    'ui/yirang.js': `(()=>{const endpoint=new URL('api',location.href);async function request(body){const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok||v.error)throw Error(v.error||'请求失败');return v}window.yirang={call:(action,input)=>request({operation:'action_call',action,input,requestId:crypto.randomUUID()}),runs:()=>request({operation:'runs_get'}),wait:async(id)=>{for(let n=0;n<600;n++){const runs=await request({operation:'runs_get',runId:id}),run=runs.find(r=>r.id===id);if(run&&['completed','failed','cancelled','interrupted'].includes(run.state))return run;await new Promise(r=>setTimeout(r,1000))}throw Error('等待超时；后台运行状态可在轻应用面板查看')}}})();`,
    'README.md':
      '# ' +
      name +
      '\n\n这是通用轻应用模板，不包含业务服务。修改 yirang.app.json 声明动作，页面调用 window.yirang.call。后端 stdout 每行输出一个 JSON 事件，日志写 stderr。宿主发送 {id, action, input, context}，不含 operation。每个动作必须返回 {id: request.id, result} 或 {id: request.id, error}；不要用 requestId 作为响应关联字段。前端 yirang.call 返回任务记录，必须 await yirang.wait(run.id)，并检查 state 为 completed 后再使用 result。实例配置来自 context.config，凭据来自 context.secrets。只读状态动作不得启动查询、通知或重置定时器。后台进程可以常驻，但每个动作必须及时返回。实例数据和产出目录来自每次请求的 context。依赖安装由开发者显式完成，运行器不会自动安装依赖。源码改变后需要重新授权。\n',
  };
  files['ui/yirang.js'] = sdkSource;
  if (runtime === 'python') {
    files['requirements.txt'] = '# Add pinned application dependencies here.\n';
    files['backend/main.py'] = `import sys, json, traceback

def dispatch(action, data, context):
    if action == 'echo':
        return {'text': data['text']}
    raise ValueError('Unknown action: ' + action)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        result = dispatch(request['action'], request['input'], request['context'])
        print(json.dumps({'id': request['id'], 'result': result}, ensure_ascii=False), flush=True)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'id': request.get('id'), 'error': str(error)}), flush=True)
`;
  }
  if (runtime === 'node') {
    files['package.json'] =
      JSON.stringify(
        { name: id, version: '0.1.0', private: true, type: 'module', dependencies: {} },
        null,
        2,
      ) + '\n';
    files['package-lock.json'] =
      JSON.stringify(
        {
          name: id,
          version: '0.1.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: id, version: '0.1.0' } },
        },
        null,
        2,
      ) + '\n';
    files['backend/main.mjs'] = `import {createInterface} from 'node:readline';
async function dispatch(action,input,context){
  if(action==='echo')return {text:input.text};
  throw Error('Unknown action: '+action);
}
for await(const line of createInterface({input:process.stdin})){
  let request={};
  try{request=JSON.parse(line);const result=await dispatch(request.action,request.input,request.context);process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');}
  catch(error){console.error(error);process.stdout.write(JSON.stringify({id:request.id,error:error.message})+'\\n');}
}
`;
  }
  files['WIDGETS.md'] = '# 桌面小组件开发规范\n\n' + JSON.stringify(widgetContract, null, 2) + '\n';
  if (runtime === 'static')
    files['ui/index.html'] =
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>轻应用</title><style>body{font:15px system-ui;color:#202735;max-width:720px;margin:60px auto;padding:24px;line-height:1.8}</style><h1>你的轻应用</h1><p>这是独立的静态页面。直接编辑 ui/index.html 添加界面。</p><p>需要后端动作时，在 yirang.app.json 中声明 Python 或 Node 入口与动作契约，再接入页面 SDK。</p></html>';
  return files;
}
