import { messageImage } from './chat-markdown.js';
import { describeAttachments, historicalAttachments } from './message-attachment-model.mjs';

export function renderAttachments(node, attachments, { locate } = {}) {
  node.querySelector('.message-attachments')?.remove();
  if (!attachments?.files?.length && !attachments?.quotes?.length) return;
  const list = document.createElement('div');
  list.className = 'message-attachments';
  list.setAttribute('aria-label', '本条消息的附件');
  for (const file of attachments.files || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-attachment';
    const icon = document.createElement('span');
    icon.className = 'message-attachment-icon';
    icon.textContent =
      file.title
        .match(/\.([a-z0-9]{1,8})$/i)?.[1]
        .slice(0, 4)
        .toUpperCase() || '文件';
    const caption = document.createElement('span'),
      title = document.createElement('strong'),
      detail = document.createElement('small');
    caption.className = 'message-attachment-caption';
    title.textContent = file.title;
    detail.textContent = '引用材料' + (file.revision ? ' · v' + file.revision : '');
    caption.append(title, detail);
    button.append(icon, caption);
    button.title = '定位桌面：' + file.title;
    button.disabled = !locate;
    button.onclick = () => locate?.(file);
    list.append(button);
  }
  for (const quote of attachments.quotes || []) {
    const card = document.createElement('div');
    card.className = 'message-attachment message-attachment-quote';
    const title = document.createElement('strong'),
      detail = document.createElement('small');
    title.textContent = quote.title;
    detail.textContent = quote.kind === 'widget' ? '小组件 · 状态快照' : '选中文字';
    card.title = quote.preview;
    card.append(title, detail);
    list.append(card);
  }
  node.prepend(list);
}

export function renderUserAttachments(node, blocks, options, history = false) {
  renderAttachments(
    node,
    history ? historicalAttachments(blocks) : describeAttachments(blocks),
    options,
  );
  // Desktop images, screenshots and uploaded images use the same render path.
  const seen = new Set();
  for (const block of blocks || [])
    if (['image', 'localImage'].includes(block?.type)) {
      const key = block.url || block.imageUrl || block.data || block.path;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      messageImage(node, block);
    }
}
