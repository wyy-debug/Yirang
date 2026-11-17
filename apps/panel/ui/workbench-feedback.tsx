import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';

export function WorkbenchFeedback({ children }: { children: React.ReactNode }) {
  const items = React.Children.toArray(children).filter(React.isValidElement);
  if (!items.length) return null;
  return (
    <section className="workbench-feedback" aria-label="桌面通知">
      {items[0]}
      {items.length > 1 && (
        <details className="feedback-more">
          <summary>还有 {items.length - 1} 条提示</summary>
          {items.slice(1)}
        </details>
      )}
    </section>
  );
}
export function TransientNotice({ message, dismiss }: { message: string; dismiss: () => void }) {
  const close = useRef(dismiss);
  close.current = dismiss;
  const [paused, setPaused] = useState(false);
  const success =
    /(成功|已保存|已复制|已添加|已删除|已恢复)/.test(message) &&
    !/(失败|错误|冲突|未完成|请|需要)/.test(message);
  useEffect(() => {
    if (!success || paused) return;
    const timer = setTimeout(() => close.current(), 6000);
    return () => clearTimeout(timer);
  }, [message, success, paused]);
  return (
    <div
      className={'banner notice ' + (success ? 'notice-success' : '')}
      role="status"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <span>{message}</span>
      <button onClick={dismiss} aria-label="关闭提示">
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
