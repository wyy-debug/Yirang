import { t as uiText } from '../platform/native-ui-language.mjs';
import { randomUUID } from 'node:crypto';

// Only this fixed function runs in the page. No script or selector supplied by the model is evaluated.
function pageOperation(operation, payload) {
  if (operation === 'snapshot') {
    const nodes = new Map(),
      elements = [],
      snapshotId = crypto.randomUUID();
    const visit = (root) => {
      for (const el of root.querySelectorAll(
        'a,button,input,textarea,select,[role=button],[contenteditable=true]',
      )) {
        if (elements.length >= 250) break;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(el).visibility === 'hidden') continue;
        const id = String(elements.length + 1);
        nodes.set(id, el);
        elements.push({
          id,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          label: (
            el.getAttribute('aria-label') ||
            el.labels?.[0]?.textContent ||
            el.innerText ||
            el.placeholder ||
            el.name ||
            ''
          )
            .trim()
            .slice(0, 180),
          type: el.type || null,
          disabled: !!el.disabled,
          href: el.tagName === 'A' ? el.href : undefined,
        });
      }
    };
    visit(document);
    for (const el of document.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    globalThis.__desktopAgentSnapshot = { snapshotId, url: location.href, nodes };
    return {
      snapshotId,
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 60000),
      elements,
      frames: Array.from(document.querySelectorAll('iframe'))
        .map((frame) => ({ title: frame.title, src: frame.src }))
        .slice(0, 20),
    };
  }
  const snapshot = globalThis.__desktopAgentSnapshot;
  if (!snapshot || snapshot.snapshotId !== payload.snapshotId || snapshot.url !== location.href)
    throw Error(uiText('页面已变化，请重新读取页面'));
  if (operation === 'scroll') {
    window.scrollBy({ top: payload.dy, behavior: 'instant' });
    return { url: location.href };
  }
  const el = snapshot.nodes.get(String(payload.elementId));
  if (!el?.isConnected || el.disabled) throw Error(uiText('元素不可用，请重新读取页面'));
  if (operation === 'describe')
    return {
      label: (
        el.getAttribute('aria-label') ||
        el.labels?.[0]?.textContent ||
        el.innerText ||
        el.placeholder ||
        el.name ||
        el.tagName
      ).slice(0, 200),
      type: el.type || null,
      tag: el.tagName,
    };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (operation === 'click') {
    el.click();
    return { performed: true };
  }
  if (operation === 'fill') {
    if (['password', 'file', 'hidden'].includes(el.type) || el.readOnly)
      throw Error(uiText('请由用户填写密码、上传文件或处理只读字段'));
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const prototype =
        el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, payload.text);
    } else if (el instanceof HTMLSelectElement) {
      if (!Array.from(el.options).some((option) => option.value === payload.text))
        throw Error(uiText('选项不存在'));
      el.value = payload.text;
    } else if (el.isContentEditable) el.textContent = payload.text;
    else throw Error(uiText('该元素不能填写'));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { performed: true };
  }
  throw Error(uiText('不支持的页面操作'));
}
export function createBrowserAgent({ tabs, contents, command, approve }) {
  const run = (wc, action, payload) =>
    wc.executeJavaScriptInIsolatedWorld(
      1002,
      [
        {
          code: `(${pageOperation.toString()})(${JSON.stringify(action)},${JSON.stringify(payload)})`,
        },
      ],
      true,
    );
  let serial = Promise.resolve();
  return {
    command(action, payload = {}) {
      const job = serial
        .catch(() => {})
        .then(async () => {
          if (action === 'tabs') return command('state');
          if (action === 'open') {
            const url = new URL(payload.url);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
              throw Error(uiText('只支持 HTTP / HTTPS 网页'));
            await approve({ operation: uiText('打开网页'), url: url.href });
            return command('open', { url: url.href });
          }
          const tab = tabs.get(payload.tabId);
          const wc = contents(tab);
          if (!wc || tab.loading || tab.error)
            throw Error(uiText('标签未就绪，请先打开并等待页面载入'));
          const url = wc.getURL();
          if (!/^https?:\/\//i.test(url)) throw Error(uiText('当前标签不是网页'));
          if (action === 'snapshot' || action === 'screenshot') {
            await approve({
              operation: action === 'snapshot' ? uiText('读取网页内容') : uiText('查看网页截图'),
              url,
            });
            if (wc.isDestroyed() || wc.getURL() !== url) throw Error(uiText('网页已跳转，请重试'));
            if (action === 'snapshot') return { tabId: tab.id, ...(await run(wc, 'snapshot', {})) };
            const screenshot = await wc.capturePage(),
              size = screenshot.getSize(),
              image = size.width > 1600 ? screenshot.resize({ width: 1600 }) : screenshot;
            return {
              tabId: tab.id,
              url,
              image: { mimeType: 'image/png', data: image.toPNG().toString('base64') },
            };
          }
          if (!['click', 'fill', 'scroll'].includes(action))
            throw Error(uiText('不支持的浏览器操作'));
          if (typeof payload.snapshotId !== 'string')
            throw Error(uiText('先读取网页，使用真实快照中的元素编号'));
          if (
            action === 'fill' &&
            (typeof payload.text !== 'string' || payload.text.length > 12000)
          )
            throw Error(uiText('填写内容过长'));
          if (action === 'scroll' && (!Number.isFinite(payload.dy) || Math.abs(payload.dy) > 4000))
            throw Error(uiText('单次滚动范围为 -4000 到 4000'));
          const target = action === 'scroll' ? {} : await run(wc, 'describe', payload);
          if (action === 'fill' && ['password', 'file', 'hidden'].includes(target.type))
            throw Error(uiText('此字段需要用户自行填写'));
          await approve({
            operation:
              action === 'click'
                ? uiText('点击网页元素')
                : action === 'fill'
                  ? uiText('填写网页字段')
                  : uiText('滚动网页'),
            url,
            target: target.label,
            text: action === 'fill' ? payload.text : undefined,
          });
          if (wc.isDestroyed() || wc.getURL() !== url)
            throw Error(uiText('授权期间网页已跳转，请重新读取'));
          return { tabId: tab.id, url, ...(await run(wc, action, payload)) };
        });
      serial = job;
      return job;
    },
  };
}
