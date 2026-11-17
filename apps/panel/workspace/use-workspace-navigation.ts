import { useEffect, useRef } from 'react';
import { isIntegratedDesktop } from './workspace-mode.js';

type Options = {
  workspaceId?: string;
  navigate: () => Promise<boolean>;
  change: (value: { operation: 'switch'; targetId: string; requestId: string }) => Promise<void>;
  notice: (value: string) => void;
};
export function useWorkspaceNavigation(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const working = useRef(false);
  useEffect(() => {
    if (!isIntegratedDesktop) return;
    async function receive(event: MessageEvent) {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (data?.type === 'yirang:workspaces-changed') {
        window.dispatchEvent(new Event('yirang:workspaces-changed'));
        return;
      }
      if (
        data?.type !== 'yirang:workspace-open' ||
        typeof data.workspaceId !== 'string' ||
        typeof data.targetId !== 'string' ||
        typeof data.requestId !== 'string'
      )
        return;
      const answer = (error?: string) =>
        window.parent.postMessage(
          {
            type: 'yirang:workspace-open-result',
            requestId: data.requestId,
            targetId: data.targetId,
            error,
          },
          '*',
        );
      if (working.current) {
        answer('正在切换桌面，请稍后重试');
        return;
      }
      working.current = true;
      try {
        if (latest.current.workspaceId === data.targetId) {
          answer();
          return;
        }
        if (latest.current.workspaceId !== data.workspaceId)
          throw Error('当前桌面已变化，新桌面仍保留在桌面列表');
        if (!(await latest.current.navigate()))
          throw Error('当前编辑尚未保存，已保留当前桌面；保存后可从桌面列表打开新桌面');
        if (latest.current.workspaceId !== data.workspaceId)
          throw Error('当前桌面已变化，请重新选择目标桌面');
        await latest.current.change({
          operation: 'switch',
          targetId: data.targetId,
          requestId: data.requestId,
        });
        answer();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        latest.current.notice(message);
        answer(message);
      } finally {
        working.current = false;
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
}
