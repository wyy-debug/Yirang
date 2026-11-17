import { t as uiText } from '../../../packages/components/ui-language.js';
import { TEXT_FILE_LIMIT } from '../../../packages/contracts/native-text.js';

/** Executable local page. The owning iframe must keep an opaque sandbox origin. */
export function htmlBrowserDocument(source: string, channel: string) {
  if (source.length > TEXT_FILE_LIMIT)
    return uiText('<!doctype html><p>网页超过小窗读取范围，请打开原文件。</p>');
  const doc = new DOMParser().parseFromString(source, 'text/html');
  doc.querySelectorAll('base,meta[http-equiv]').forEach((node) => node.remove());
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  // No application origin, local files, insecure resources, nested frames, or
  // form submission. HTTPS libraries can render charts in generated reports.
  policy.content =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:; media-src data: blob: https:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const referrer = doc.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  if (!doc.querySelector('meta[name="viewport"]')) {
    const viewport = doc.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width,initial-scale=1';
    doc.head.prepend(viewport);
  }
  const events = doc.createElement('script');
  events.textContent = `(()=>{const send=(kind,message)=>parent.postMessage({type:'desktop-html-browser',channel:${JSON.stringify(channel)},kind,message:String(message||'').slice(0,400)},'*');addEventListener('error',event=>{if(event.message)send('error',event.message);else if(event.target?.src||event.target?.href)send('resource',${JSON.stringify(uiText('有网页资源未能加载'))});},true);addEventListener('unhandledrejection',()=>send('error',${JSON.stringify(uiText('网页脚本执行未完成'))}));addEventListener('DOMContentLoaded',()=>send('title',document.title));addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.isComposing)send('escape','');});})()`;
  doc.head.prepend(charset, policy, referrer, events);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
