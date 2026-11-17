import { t as uiText } from '../../../packages/components/ui-language.js';
export type BrowserPlacement = {
  workspaceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type BrowserTab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  documentReady: boolean;
  error: string;
  canGoBack: boolean;
  canGoForward: boolean;
  canvas?: BrowserPlacement | null;
};
export type BrowserState = { activeId: string; tabs: BrowserTab[]; persistError?: string };
export type BrowserCapture = {
  url: string;
  title: string;
  text: string;
  links: { url: string; text: string }[];
  fields: never[];
  selection: string;
};
type BrowserCollectRequest = {
  mode: 'material' | 'selection';
  id: string;
  url: string;
  selection?: string;
};
let pendingCollect: BrowserCollectRequest | null = null;
export function queueBrowserCollect(value: BrowserCollectRequest) {
  pendingCollect = value;
}
export function takeBrowserCollect() {
  const value = pendingCollect;
  pendingCollect = null;
  return value;
}
type Waiter = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, Waiter>(),
  listeners = new Set<(type: string, payload: any) => void>();
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const value = event.data;
  if (value?.type === 'ai-desktop:browser-result') {
    const item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id);
    clearTimeout(item.timer);
    if (value.error)
      item.reject(
        Error(
          String(value.error).replace(
            /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
            '',
          ),
        ),
      );
    else item.resolve(value.result);
  } else if (typeof value?.type === 'string' && value.type.startsWith('ai-desktop:browser-')) {
    for (const listener of listeners)
      listener(value.type.slice('ai-desktop:'.length), value.payload);
  }
});
export function browserCommand<T = BrowserState>(
  action: string,
  payload: Record<string, unknown> = {},
  timeout = 30000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(uiText('桌面服务暂未响应，请重试')));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ type: 'ai-desktop:browser-request', id, action, payload }, '*');
  });
}
export function onBrowserEvent(callback: (type: string, payload: any) => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
