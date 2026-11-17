export function createHostRecovery({
  isReady,
  executionCapacity,
  readTurn,
  microRunner,
  agentPool,
  maintainApps,
  intervalMs = 15000,
}) {
  let recovering = false;
  let agentPoolStarted = false;

  async function recover() {
    if (recovering || !isReady()) return;
    recovering = true;
    try {
      await executionCapacity.reconcile(async (entry) => {
        if (!entry.turnId) return null;
        let cursor = null;
        for (let page = 0; page < 10; page += 1) {
          const history = await readTurn(entry.threadId, cursor);
          const found = history.data.find((turn) => turn.id === entry.turnId);
          if (found) return found;
          if (!history.nextCursor) break;
          cursor = history.nextCursor;
        }
        return null;
      });
      await microRunner.verify().catch(() => {});
      if (agentPool && !agentPoolStarted) {
        agentPoolStarted = true;
        void agentPool.start().catch(() => {
          agentPoolStarted = false;
        });
      }
      void maintainApps().catch(() => {});
    } catch {
      // Recovery is best-effort; the next interval retries.
    } finally {
      recovering = false;
    }
  }

  function start() {
    const timer = setInterval(() => void recover(), intervalMs);
    timer.unref();
    return timer;
  }

  return { recover, start };
}
