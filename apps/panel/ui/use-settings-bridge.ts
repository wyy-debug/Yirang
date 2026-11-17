import { useEffect, useRef } from 'react';
export function useSettingsBridge(
  workspaceId: string | undefined,
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>,
) {
  const current = useRef({ workspaceId, action });
  current.current = { workspaceId, action };
  useEffect(() => {
    const receive = async (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== 'yirang:settings-request') return;
      const m = event.data,
        scope = current.current;
      if (typeof m.id !== 'string') return;
      try {
        if (!scope.workspaceId) throw Error('请先打开工作区');
        let result;
        if (m.operation === 'scope') result = { workspaceId: scope.workspaceId };
        else {
          if (m.workspaceId !== scope.workspaceId) throw Error('工作区已切换，请重新打开设置');
          const allowed = [
            'directories',
            'directories_diff',
            'directories_push',
            'external_resources',
            'storage',
            'maintenance',
          ];
          if (m.operation !== 'native_workbench' || !allowed.includes(m.payload?.operation))
            throw Error('不支持的设置操作');
          result = await scope.action('native_workbench', m.payload);
        }
        window.parent.postMessage({ type: 'yirang:settings-response', id: m.id, result }, '*');
      } catch (error) {
        window.parent.postMessage(
          { type: 'yirang:settings-response', id: m.id, error: String(error) },
          '*',
        );
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
}
