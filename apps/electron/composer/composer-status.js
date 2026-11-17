import { t } from '../../../packages/components/ui-language.js';

// Only acknowledgements expire. Failures, prompts and active work remain visible.
export function registerComposerStatus(status) {
  const acknowledgements = [
    '已完成',
    '已移除材料引用',
    '要求已保存',
    '账号状态已更新，可继续发送消息',
    '已补充到当前任务',
    '已定位到画布',
    '已返回桌面',
  ];
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    const message = status.textContent.trim();
    if (!acknowledgements.some((text) => t(text) === message)) return;
    timer = setTimeout(() => {
      if (status.textContent.trim() === message) status.textContent = '';
    }, 4500);
  };
  const observer = new MutationObserver(refresh);
  observer.observe(status, { childList: true, subtree: true, characterData: true });
  refresh();
  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
}
