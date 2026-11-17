import { bindUiLabel } from '../ui/ui-labels.js';

const labels = new Map([
  ['commandExecution', ['正在运行命令', '运行了命令', '命令执行失败']],
  ['fileChange', ['正在修改文件', '修改了文件', '文件修改失败']],
  ['mcpToolCall', ['正在调用工具', '调用了工具', '工具调用失败']],
  ['dynamicToolCall', ['正在调用工具', '调用了工具', '工具调用失败']],
]);

function activityLabel(item, live) {
  const [running, done, failed] = labels.get(item.type);
  if (
    ['failed', 'error'].includes(item.status) ||
    (item.type === 'commandExecution' && Number.isInteger(item.exitCode) && item.exitCode !== 0) ||
    (item.type === 'mcpToolCall' && item.result?.isError === true) ||
    (item.type === 'dynamicToolCall' && item.success === false)
  )
    return failed;
  if (item.status === 'completed') return done;
  if (item.status === 'declined') return '操作已拒绝';
  if (['interrupted', 'cancelled', 'canceled'].includes(item.status)) return '操作已中断';
  return live ? running : '操作状态未确认';
}

export function createTurnActivity(messages) {
  const doc = messages.ownerDocument;
  const turns = new Map();
  function row() {
    const node = doc.createElement('div');
    node.className = 'message activity';
    const icon = doc.createElement('span');
    icon.className = 'activity-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '›_';
    const caption = doc.createElement('span');
    caption.setAttribute('role', 'status');
    node.append(icon, caption);
    return { node, caption };
  }

  const pending = row();
  pending.node.dataset.running = 'true';
  bindUiLabel(pending.caption, 'textContent', 'Codex 正在处理…');

  function append(node) {
    messages.insertBefore(node, pending.node.parentNode === messages ? pending.node : null);
  }

  function record(turnId, item, live = false) {
    if (!turnId || !item?.id || !labels.has(item.type)) return false;
    const label = activityLabel(item, live);
    const running = live && label === labels.get(item.type)[0];
    let items = turns.get(turnId);
    if (!items) turns.set(turnId, (items = new Map()));
    let entry = items.get(item.id);
    if (entry?.label === label || (entry && !entry.running && running)) return false;
    if (!entry) {
      entry = row();
      entry.node.dataset.turnId = turnId;
      items.set(item.id, entry);
      append(entry.node);
    }
    entry.running = running;
    entry.label = label;
    entry.node.dataset.running = String(running);
    bindUiLabel(entry.caption, 'textContent', label);
    return true;
  }

  return {
    append,
    record,
    finish(turnId, finalItems = []) {
      const items = turns.get(turnId);
      if (!items) return false;
      const results = new Map((finalItems ?? []).map((item) => [item.id, item]));
      let changed = false;
      for (const [id, entry] of items) {
        if (!entry.running) continue;
        const item = results.get(id);
        if (item && record(turnId, item)) changed = true;
        else {
          entry.running = false;
          entry.label = '操作状态未确认';
          entry.node.dataset.running = 'false';
          bindUiLabel(entry.caption, 'textContent', entry.label);
          changed = true;
        }
      }
      return changed;
    },
    showPending(visible, turnId) {
      const hasRunning = Array.from(turns.get(turnId)?.values() ?? []).some((entry) => entry.running);
      if (visible && !hasRunning) {
        if (messages.lastElementChild === pending.node) return false;
        messages.append(pending.node);
        return true;
      }
      if (!pending.node.parentNode) return false;
      pending.node.remove();
      return true;
    },
    reset() {
      turns.clear();
      pending.node.remove();
    },
  };
}
