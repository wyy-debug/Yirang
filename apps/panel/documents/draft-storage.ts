// Coalesce synchronous Web Storage writes; keep only the latest draft per key.
type PendingWrite = {
  read: () => string | null;
  done: (error?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, PendingWrite>();
function cancel(key: string) {
  const value = pending.get(key);
  if (value) clearTimeout(value.timer);
  pending.delete(key);
}
export function writeDraftNow(key: string, value: string | null) {
  cancel(key);
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}
export function flushDraftStorage(key?: string) {
  for (const name of key ? [key] : [...pending.keys()]) {
    const job = pending.get(name);
    if (!job) continue;
    try {
      writeDraftNow(name, job.read());
      job.done();
    } catch (error) {
      job.done(error);
    }
  }
}
export function scheduleDraftWrite(
  key: string,
  read: () => string | null,
  done: (error?: unknown) => void,
  delay = 800,
) {
  cancel(key);
  pending.set(key, { read, done, timer: setTimeout(() => flushDraftStorage(key), delay) });
}
// A hidden/closing panel still gets its newest in-memory draft written locally.
window.addEventListener('pagehide', () => flushDraftStorage());
window.addEventListener('beforeunload', () => flushDraftStorage());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushDraftStorage();
});
