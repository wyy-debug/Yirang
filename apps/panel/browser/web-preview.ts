import { t as uiText } from '../../../packages/components/ui-language.js';
import type { WebSourceRole } from '../../../packages/contracts/web-projects.js';

export type WebSources = Record<WebSourceRole, string>;
export type WebPreviewMessage = {
  channel: 'ai-desktop-web-preview';
  token: string;
  kind: 'ready' | 'console' | 'error' | 'policy';
  level: string;
  message: string;
};
export const WEB_PREVIEW_CHANNEL = 'ai-desktop-web-preview';
const safeJSON = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// CSP is emitted before any user markup. No user markup is parsed in the host DOM.
// The parent must also restrict frame-src to blob: so a script cannot navigate its own frame to a remote page.
export function webPreviewDocument(
  source: WebSources,
  options: { run: boolean; token: string; bridge?: boolean },
) {
  const csp = [
    "default-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'img-src data:',
    'media-src data:',
    'font-src data:',
    "style-src 'unsafe-inline'",
    `script-src ${options.run ? "'unsafe-inline'" : "'none'"}`,
  ].join('; ');
  const bridge =
    options.run && options.bridge !== false
      ? `<script>(()=>{
    const token=${safeJSON(options.token)},channel=${safeJSON(WEB_PREVIEW_CHANNEL)},send=parent.postMessage.bind(parent);let sent=0;
    const text=value=>{try{return (typeof value==='string'?value:typeof value==='bigint'?String(value):value instanceof Error?value.name+': '+value.message:JSON.stringify(value)??String(value)).slice(0,1800);}catch{return ${JSON.stringify(uiText('[无法序列化的值]'))};}};
    const emit=(kind,level,message)=>{if(sent++>=160)return;try{send({channel,token,kind,level,message:String(message).slice(0,2400)},'*');}catch{}};
    for(const level of ['log','info','warn','error','debug']){const original=console[level]?.bind(console);console[level]=(...args)=>{emit('console',level,args.slice(0,12).map(text).join(' '));try{original?.(...args);}catch{}};}
    addEventListener('error',e=>emit('error','error',(e.message||${JSON.stringify(uiText('资源或脚本加载失败'))})+(e.lineno?' · '+e.lineno+':'+e.colno:'')));
    addEventListener('unhandledrejection',e=>emit('error','error',${JSON.stringify(uiText('未处理的 Promise：'))}+text(e.reason)));
    addEventListener('securitypolicyviolation',e=>emit('policy','warn',${JSON.stringify(uiText('预览已阻止 '))}+e.violatedDirective+' · '+e.blockedURI));
    addEventListener('submit',e=>e.preventDefault(),true);
    addEventListener('click',e=>{const link=e.target?.closest?.('a[href]');if(link&&!link.getAttribute('href')?.startsWith('#')){e.preventDefault();emit('policy','info',${JSON.stringify(uiText('预览内不跳转外部链接。'))});}},true);
    emit('ready','info',${JSON.stringify(uiText('脚本预览容器已启动。'))});
  })();<\/script>`
      : '';
  // script.textContent avoids turning a source-string </script> into host document markup.
  const script = options.run
    ? `<script>(()=>{const code=${safeJSON(source.js)},script=document.createElement('script');script.textContent=code+'\\n//# sourceURL=desktop-project.js';document.body.appendChild(script);})();<\/script>`
    : '';
  const css = source.css.replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">${bridge}</head><body>${source.html}\n<style>${css}</style>\n${script}</body></html>`;
}
export function standaloneWebDocument(source: WebSources) {
  return webPreviewDocument(source, { run: true, token: '', bridge: false });
}
export function acceptedWebPreviewMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
  token: string,
): WebPreviewMessage | null {
  if (!frame || event.source !== frame.contentWindow || event.origin !== 'null' || !token)
    return null;
  const value = event.data;
  if (
    !value ||
    typeof value !== 'object' ||
    value.channel !== WEB_PREVIEW_CHANNEL ||
    value.token !== token ||
    !['ready', 'console', 'error', 'policy'].includes(value.kind) ||
    typeof value.message !== 'string' ||
    value.message.length > 2400 ||
    typeof value.level !== 'string' ||
    value.level.length > 20
  )
    return null;
  return {
    channel: WEB_PREVIEW_CHANNEL,
    token,
    kind: value.kind,
    level: value.level,
    message: value.message,
  };
}
export function utf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
