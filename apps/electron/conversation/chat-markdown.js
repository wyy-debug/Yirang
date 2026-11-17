import { bindUiLabel } from '../ui/ui-labels.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
const localImages = new Map();
export function localImage(image, path) {
  image.draggable = false;
  let pending = localImages.get(path);
  if (!pending) {
    pending = window.desktop.image(path);
    localImages.set(path, pending);
    setTimeout(() => localImages.delete(path), 30000);
    if (localImages.size > 50) localImages.delete(localImages.keys().next().value);
  }
  pending
    .then((data) => {
      image.src = data;
    })
    .catch((error) => {
      image.alt = uiText('图片暂不可预览');
      image.title = error.message;
    });
}
function inline(parent, text, depth = 0) {
  if (depth > 6) {
    parent.append(document.createTextNode(text));
    return;
  }
  const re =
    /(`+)([^`\n]+)\1|\*\*([^*]+)\*\*|\*([^*\n]+)\*|(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/g;
  let last = 0,
    m;
  while ((m = re.exec(text))) {
    parent.append(document.createTextNode(text.slice(last, m.index)));
    let el;
    const destination = m[7]?.trim().replace(/^<|>$/g, '');
    if (m[2]) {
      el = document.createElement('code');
      el.textContent = m[2];
    } else if (m[3] || m[4]) {
      el = document.createElement(m[3] ? 'strong' : 'em');
      inline(el, m[3] || m[4], depth + 1);
    } else if (m[5] && /^https:\/\//i.test(destination)) {
      el = document.createElement('img');
      el.src = destination;
      el.alt = m[6];
      el.loading = 'lazy';
      el.referrerPolicy = 'no-referrer';
      el.className = 'chat-image';
    } else if (m[5] && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(destination)) {
      el = document.createElement('img');
      el.src = destination;
      el.alt = m[6];
      el.className = 'chat-image';
    } else if (m[5] && /^(?:file:|\/?[a-z]:[\\/])/i.test(destination)) {
      el = document.createElement('img');
      el.alt = m[6];
      el.className = 'chat-image';
      localImage(el, destination);
    } else if (/^(?:javascript|vbscript|data):/i.test(destination || '')) {
      el = document.createElement('span');
      el.textContent = m[6] || destination;
    } else {
      el = document.createElement('button');
      el.className = 'chat-link';
      el.textContent = m[6] || destination;
      el.title = destination;
      el.onclick = () =>
        window.desktop.openLink(destination).catch(() => {
          bindUiLabel(el, 'title', '请在文件卡片中打开此文件');
        });
    }
    if (el.tagName === 'IMG') el.draggable = false;
    parent.append(el);
    last = re.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(last)));
}
const renderedMessages = new WeakMap();
export function renderMessage(node, text) {
  const previous = renderedMessages.get(node);
  if (previous?.text === text && previous.nodes.every(child => child.parentNode === node)) return;
  node.dataset.source = text;
  node.classList.add('markdown-message');
  const lines = text.slice(0, 300000).split(/\r?\n/);
  let i = 0;
  const blocks = [];
  // Keep completed blocks mounted (selection, image loading and copy state).
  // One line of lookahead invalidates a paragraph that becomes a table header.
  if (previous && previous.nodes.every(child => child.parentNode === node)) {
    for (const block of previous.blocks) {
      if (lines.slice(block.start, block.end + 1).join('\n') !== block.source) break;
      blocks.push(block);
      i = block.end;
    }
  }
  const retained = blocks.reduce((count, block) => count + block.count, 0);
  while (node.childNodes.length > retained) node.lastChild.remove();
  while (i < lines.length) {
    const start = i, before = node.childNodes.length;
    try {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3),
        code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const box = document.createElement('div'),
        bar = document.createElement('div'),
        label = document.createElement('span'),
        copy = document.createElement('button'),
        pre = document.createElement('pre'),
        content = document.createElement('code');
      box.className = 'chat-code';
      bar.className = 'chat-code-bar';
      label.textContent = language || uiText('代码');
      bindUiLabel(copy, 'textContent', '复制');
      copy.onclick = () =>
        navigator.clipboard.writeText(code.join('\n')).then(
          () => {
            bindUiLabel(copy, 'textContent', '已复制');
          },
          () => {
            bindUiLabel(copy, 'textContent', '复制失败');
          },
        );
      content.textContent = code.join('\n');
      bar.append(label, copy);
      pre.append(content);
      box.append(bar, pre);
      node.append(box);
      continue;
    }
    if (i + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const table = document.createElement('table'),
        wrap = document.createElement('div');
      wrap.className = 'chat-table';
      const row = (value, heading) => {
        const tr = document.createElement('tr');
        for (const cell of value
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')) {
          const td = document.createElement(heading ? 'th' : 'td');
          inline(td, cell.trim());
          tr.append(td);
        }
        table.append(tr);
      };
      row(line, true);
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) row(lines[i++], false);
      wrap.append(table);
      node.append(wrap);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/),
      list = line.match(/^\s*(?:[-*+] |\d+[.)] )(.*)/),
      quote = line.match(/^>\s?(.*)/);
    if (list) {
      const ordered = /^\s*\d+[.)] /.test(line);
      const group = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered) group.start = Number(line.trim().match(/^\d+/)[0]);
      const pattern = ordered ? /^\s*\d+[.)] (.*)/ : /^\s*[-*+] (.*)/;
      while (i < lines.length) {
        const item = lines[i].match(pattern);
        if (!item) break;
        const li = document.createElement('li');
        inline(li, item[1]); group.append(li); i++;
      }
      node.append(group);
      continue;
    }
    const el = document.createElement(
      heading ? `h${Math.min(heading[1].length + 1, 6)}` : list ? 'li' : quote ? 'blockquote' : 'p',
    );
    let content = heading?.[2] ?? quote?.[1] ?? line;
    if (!heading && !quote) {
      while (i + 1 < lines.length && lines[i + 1].trim() &&
          !/^\s*(?:```|#{1,6}\s|>|[-*+] |\d+[.)] )/.test(lines[i + 1]) &&
          !(lines[i + 1].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 2] || ''))) {
        content += '\n' + lines[++i];
      }
    }
    inline(el, content);
    node.append(el);
    i++;
    } finally {
      blocks.push({ start, end: i, count: node.childNodes.length - before,
        source: lines.slice(start, i + 1).join('\n') });
    }
  }
  renderedMessages.set(node, { text, blocks, nodes: [...node.childNodes] });
}
export function messageImage(parent, item) {
  const url =
    item.url ||
    item.imageUrl ||
    (typeof item.data === 'string' ? `data:${item.mimeType};base64,${item.data}` : null);
  const local = item.type === 'localImage' && typeof item.path === 'string';
  if (
    !local &&
    (typeof url !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,|^https:\/\//i.test(url))
  )
    return;
  const image = document.createElement('img');
  image.draggable = false;
  image.alt =
    item._meta?.['yirang/composer-image']?.name ||
    item._meta?.['openai/title'] ||
    uiText('对话图片');
  image.loading = 'lazy';
  image.referrerPolicy = 'no-referrer';
  image.className = 'chat-image';
  if (local) localImage(image, item.path);
  else image.src = url;
  parent.append(image);
}
