import { browserCommand } from '../browser/electron-browser-bridge.js';

// Serialize page ownership across quick tabs and the manager. A stale cleanup
// must not close a newer view's HTTP server while its iframe is loading.
const sessions = new Map<string, { tail: Promise<unknown>; users: number; url: string }>();
window.addEventListener('yirang:app-version-changed', (event: Event) => {
  const d = (event as CustomEvent).detail;
  if (d?.workspaceId && d?.instanceId) {
    const current = sessions.get(JSON.stringify([d.workspaceId, d.instanceId]));
    if (current) current.url = '';
  }
});
export function openLightAppPage(workspaceId: string, instanceId: string) {
  const key = JSON.stringify([workspaceId, instanceId]);
  let session = sessions.get(key);
  if (!session) {
    session = { tail: Promise.resolve(), users: 0, url: '' };
    sessions.set(key, session);
  }
  const state = session;
  const call = (operation: string) =>
    browserCommand<any>('light-apps', { workspaceId, operation, payload: { instanceId } }, 120000);
  const enqueue = <T>(fn: () => Promise<T>) => {
    const result = state.tail.then(fn, fn);
    state.tail = result.catch(() => {});
    return result;
  };
  let owned = false,
    closed = false;
  const ready = enqueue(async () => {
    if (!state.users || !state.url) {
      const result = await call('open');
      state.url = result.url;
    }
    state.users++;
    owned = true;
    return state.url;
  });
  return {
    ready,
    close() {
      if (closed) return;
      closed = true;
      void enqueue(async () => {
        if (!owned) return;
        owned = false;
        state.users--;
        if (!state.users) {
          state.url = '';
          await call('close_page');
        }
      }).catch(() => {});
    },
  };
}
