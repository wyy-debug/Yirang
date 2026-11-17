import { t as uiText } from '../../../packages/components/ui-language.js';
import { TEXT_FILE_LIMIT } from '../../../packages/contracts/native-text.js';

/** Parse in an inert template; render only inside an opaque, scriptless iframe. */
export function htmlPageDocument(source: string) {
  if (source.length > TEXT_FILE_LIMIT)
    return uiText('<!doctype html><p>文件较大，请打开原文件查看完整页面。</p>');
  const template = document.createElement('template');
  template.innerHTML = source;
  template.content
    .querySelectorAll(
      'script,base,meta,link,title,iframe,frame,frameset,object,embed,applet,portal,template,animate,animateMotion,animateTransform,set',
    )
    .forEach((node) => node.remove());
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase(),
        value = attribute.value.trim();
      if (
        name.startsWith('on') ||
        ['srcdoc', 'action', 'formaction', 'target', 'ping', 'autofocus', 'autoplay'].includes(name)
      )
        element.removeAttribute(attribute.name);
      else if (
        ['href', 'xlink:href', 'src', 'poster', 'srcset'].includes(name) &&
        !value.startsWith('#') &&
        !/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i.test(value)
      )
        element.removeAttribute(attribute.name);
    }
  }
  const csp =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}</style></head><body>${template.innerHTML || uiText('<p style="padding:24px;color:#86868b">空白网页</p>')}</body></html>`;
}
