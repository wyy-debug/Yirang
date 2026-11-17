const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const allowed = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'div',
  'span',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'ul',
  'ol',
  'li',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'blockquote',
  'pre',
  'code',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'br',
  'hr',
]);
/** A deliberately restricted HTML subset: no user attributes, CSS, links, images or active elements are emitted. */
export function staticHtml(source: string) {
  const input = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  let cursor = 0,
    body = '';
  for (const match of input.matchAll(/<[^>]*>/g)) {
    body += escape(input.slice(cursor, match.index));
    const tag = /^<\s*(\/?)\s*([a-z][a-z0-9]*)\b[^>]*>$/i.exec(match[0]);
    if (tag && allowed.has(tag[2].toLowerCase()))
      body += `<${tag[1] ? '/' : ''}${tag[2].toLowerCase()}>`;
    cursor = match.index! + match[0].length;
  }
  body += escape(input.slice(cursor));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:15px/1.8 'Segoe UI','Microsoft YaHei',sans-serif;color:#35422f;background:#fff;padding:28px;overflow-wrap:anywhere}h1,h2,h3{line-height:1.4;font-weight:550}table{border-collapse:collapse;width:100%}td,th{border:1px solid #dfe6d6;padding:9px;text-align:left}pre{background:#f4f7ef;padding:15px;white-space:pre-wrap}blockquote{border-left:3px solid #afc195;margin-left:0;padding:0 16px;color:#7e8c72}hr{border:0;border-top:1px solid #dfe6d6}</style></head><body>${body}</body></html>`;
}
