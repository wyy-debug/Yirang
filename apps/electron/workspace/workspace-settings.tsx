import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectedDirectories } from '../../panel/workspace/connected-directories.js';
import { ExternalResources } from '../../panel/workspace/external-resources.js';
import { Storage } from '../../panel/workspace/storage.js';

export function registerWorkspaceSettings(frame: HTMLIFrameElement) {
  window.addEventListener('desktop-settings-open', ((event: CustomEvent) => {
    const { sections, signal } = event.detail;
    const pending = new Map<
      string,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    function request(operation: string, payload?: object, workspaceId?: string): Promise<any> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(Error('设置已关闭'));
          return;
        }
        const id = crypto.randomUUID(),
          timer = setTimeout(() => {
            pending.delete(id);
            reject(Error('设置操作超时，请重新打开设置查看实际状态'));
          }, 120000);
        pending.set(id, { resolve, reject, timer });
        frame.contentWindow?.postMessage(
          { type: 'yirang:settings-request', id, operation, payload, workspaceId },
          '*',
        );
      });
    }
    const receive = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.data?.type !== 'yirang:settings-response') return;
      const p = pending.get(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(e.data.id);
      e.data.error ? p.reject(Error(e.data.error)) : p.resolve(e.data.result);
    };
    window.addEventListener('message', receive, { signal });
    let scope: Promise<any> | undefined;
    const action = async (name: string, payload?: Record<string, unknown>) => {
      scope ??= request('scope');
      const { workspaceId } = await scope;
      return request(name, payload, workspaceId);
    };
    const views = { folders: ConnectedDirectories, resources: ExternalResources, storage: Storage };
    const roots = new Map<string, ReturnType<typeof createRoot>>();
    const render = () => {
      for (const [id, View] of Object.entries(views)) {
        const panel = sections[id];
        if (!panel) continue;
        if (panel.hidden) {
          roots.get(id)?.unmount();
          roots.delete(id);
          panel.querySelector('.workspace-settings-body')?.remove();
          continue;
        }
        if (roots.has(id)) continue;
        const container = document.createElement('div');
        container.className = 'workspace-settings-body';
        panel.append(container);
        const root = createRoot(container);
        roots.set(id, root);
        root.render(<View action={action} />);
      }
    };
    const observer = new MutationObserver(render);
    for (const id of Object.keys(views))
      if (sections[id])
        observer.observe(sections[id], { attributes: true, attributeFilter: ['hidden'] });
    render();
    signal.addEventListener(
      'abort',
      () => {
        observer.disconnect();
        for (const root of roots.values()) root.unmount();
        for (const p of pending.values()) {
          clearTimeout(p.timer);
          p.reject(Error('设置已关闭'));
        }
        pending.clear();
      },
      { once: true },
    );
  }) as EventListener);
}
