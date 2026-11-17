import { t as uiText } from './native-ui-language.mjs';
import { randomUUID } from 'node:crypto';

export function createShutdownController({ window, app, emit, state, stop, finish, forceCleanup, lifecycle }) {
  let exiting = false,
    forced = false,
    pending = false;
  const requests = new Map();
  const prepare = () =>
    new Promise((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          requests.delete(id);
          reject(Error(uiText('桌面保存回应超时')));
        }, 2000);
      requests.set(id, { resolve, reject, timer });
      emit('prepare-close', { id });
    });
  async function bounded(work, milliseconds) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        work(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = Error(uiText('退出阶段超时'));
            controller.abort(error);
            reject(error);
          }, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function clearRequests() {
    for (const item of requests.values()) {
      clearTimeout(item.timer);
      item.reject(Error(uiText('退出请求已结束')));
    }
    requests.clear();
  }
  function exitNow() {
    if (forced) return;
    forced = true;
    exiting = true;
    clearRequests();
    lifecycle?.('shutdown-forced');
    try {
      forceCleanup?.();
    } catch (error) {
      console.warn(uiText('退出清理失败'), error);
    } finally {
      app.exit(0);
    }
  }
  async function close({ rendererGone = false } = {}) {
    if (pending || exiting) return;
    pending = true;
    // Closing is the user's decision. Save best-effort without asking them to
    // reopen a broken renderer; even cleanup/quit must have a total deadline.
    const deadline = setTimeout(exitNow, 43000);
    deadline.unref();
    try {
      window()?.hide();
      emit('closing', true);
      lifecycle?.('shutdown-started', { rendererGone });
      if (state().running)
        try {
          await bounded(stop, 8000);
        } catch (error) {
          lifecycle?.('shutdown-stop-failed', { message: error.message });
          console.warn(uiText('停止任务未完成'), error);
        }
      try {
        if (!rendererGone) await prepare();
      } catch (error) {
        lifecycle?.('shutdown-save-failed', { message: error.message });
        console.warn(uiText('桌面保存未确认'), error);
      }
      try {
        await bounded(finish, 30000);
      } catch (error) {
        lifecycle?.('shutdown-sync-failed', { message: error.message });
        console.warn(uiText('退出同步未完成'), error);
        exitNow();
        return;
      }
      exiting = true;
      lifecycle?.('shutdown-ready');
      app.quit();
      // Keep the deadline armed until the process exits, including beforeunload
      // handlers or a stalled Electron shutdown after app.quit().
    } catch (error) {
      lifecycle?.('shutdown-failed', { message: error.message });
      console.warn(uiText('退出失败，结束当前实例'), error);
      exitNow();
    } finally {
      clearRequests();
      if (!exiting) clearTimeout(deadline);
    }
  }
  window().on('close', (event) => {
    if (!exiting) {
      event.preventDefault();
      void close();
    }
  });
  app.on('before-quit', (event) => {
    if (!exiting) {
      event.preventDefault();
      void close();
    }
  });
  return {
    get exiting() {
      return exiting;
    },
    bypass() {
      exiting = true;
    },
    respond(id, error) {
      const item = requests.get(id);
      if (!item) return;
      requests.delete(id);
      clearTimeout(item.timer);
      error ? item.reject(Error(error)) : item.resolve();
    },
    close,
  };
}
