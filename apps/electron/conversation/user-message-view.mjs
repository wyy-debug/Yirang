// Presentation only: transport text, durable requests and attachment metadata remain intact.
const screenshotContext = '\n\n这是用户截取的一壤画布局部截图，并附带原材料引用。';
export function visibleUserText(item) {
  const parts = item.content || [{ type: 'text', text: item.text || '' }];
  return parts.filter(part => {
    if (part.type !== 'text') return false;
    try { return !['yirang.turn-context', 'yirang.turn_context'].includes(JSON.parse(part.text).type); }
    catch { return true; }
  }).map(part => userMessageText(part.text)).join('\n');
}
export function userMessageText(value) {
  const text = String(value || '');
  const at = text.indexOf(screenshotContext);
  if (at < 0) return text;
  const suffix = text.slice(at);
  const match = suffix.match(/\n工作区：([^\n]+)\n关联原材料：([\s\S]+)$/);
  if (!match) return text;
  try {
    const sources = JSON.parse(match[2]);
    if (!Array.isArray(sources) || !sources.every(source => source && typeof source.id === 'string' && typeof source.title === 'string')) return text;
    return text.slice(0, at);
  } catch { return text; }
}
