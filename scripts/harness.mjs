// Development-only MCP Apps test host. Never shipped in the plugin.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const nonce = process.env.AI_DESKTOP_PREVIEW_KEY || randomUUID(),
  port = Number(process.env.AI_DESKTOP_PREVIEW_PORT || 43187);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid preview port');
await mkdir('test-results/harness-data', { recursive: true });
const client = new Client({ name: 'component-harness', version: '1' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', resolve('dist/server.mjs')],
    env: {
      ...process.env,
      AI_DESKTOP_DATA_DIR: resolve('test-results/harness-data'),
      AI_DESKTOP_PREVIEW_MODE: '1',
    },
    stderr: 'inherit',
  }),
);
const wrapper = `<!doctype html><html><head><meta charset="utf-8"><title>Yirang · 交互原型</title><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f7f8f5}
iframe{display:block;width:100%;height:100%;border:0;background:white}
</style></head><body><iframe id="panel" title="工作桌面预览" src="/panel.html?key=${nonce}"></iframe><script>
const frame=document.getElementById("panel"), messages=[];
window.__harnessMessages=messages;
async function tool(name,args){return fetch("/api/tool?key=${nonce}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,arguments:args})}).then(r=>r.json());}
window.__harnessTool=tool;
window.addEventListener("message",async e=>{
if(e.source!==frame.contentWindow||e.origin!==location.origin)return;
const m=e.data;if(!m||m.jsonrpc!=="2.0")return;
const post=x=>frame.contentWindow.postMessage({jsonrpc:"2.0",...x},location.origin);
try{
if(m.method==="ui/initialize"){post({id:m.id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"Component Test Harness",version:"1"},
hostCapabilities:{serverTools:{}},hostContext:{theme:"light",displayMode:"fullscreen",availableDisplayModes:["inline","fullscreen"],platform:"desktop",containerDimensions:{width:frame.clientWidth,height:frame.clientHeight}}}});}
else if(m.method==="ui/notifications/initialized"){post({method:"ui/notifications/tool-result",params:await tool("desktop_open",{})});}
else if(m.method==="tools/call"){post({id:m.id,result:await tool(m.params.name,m.params.arguments)});}
else if(m.method==="ui/message"){post({id:m.id,error:{code:-32601,message:"本地预览未连接 Codex，请使用原生工作桌面。"}});}
else if(m.method==="ui/update-model-context"){post({id:m.id,error:{code:-32601,message:"本地预览没有对话材料通道，请使用原生工作桌面。"}});}
else if(m.id!==undefined){post({id:m.id,result:{}});}
}catch(error){post({id:m.id,error:{code:-32603,message:String(error)}});}
});
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.searchParams.get('key') !== nonce) {
    res.writeHead(403);
    res.end();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.end(wrapper);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/panel.html') {
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "frame-src blob:; object-src 'none'; base-uri 'none'",
      );
      res.end(await readFile('dist/panel.html'));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/tool') {
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`)
        throw Error('Origin denied');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) throw Error('Too large');
      }
      const input = JSON.parse(body);
      const result = await client.callTool({
        ...input,
        _meta: { 'openai/session': 'component-harness-A' },
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(e) }));
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`COMPONENT TEST ONLY http://127.0.0.1:${port}/?key=${nonce}`),
);
process.on('SIGINT', async () => {
  server.close();
  await client.close();
  process.exit(0);
});
