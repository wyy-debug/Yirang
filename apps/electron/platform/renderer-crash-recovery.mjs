import { t } from './native-ui-language.mjs';

export function registerRendererCrashRecovery({ window, dialog, app, lifecycle, closing, close }) {
  let promptOpen = false;
  window.webContents.on('render-process-gone', (_event, details) => {
    lifecycle('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
    if (details.reason === 'clean-exit' || closing() || window.isDestroyed() || promptOpen) return;
    promptOpen = true;
    void (async () => {
      try {
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '一壤 · Yirang',
          message: t('一壤窗口意外停止显示'),
          detail: t('重新打开后会载入已保存的桌面。尚未保存的编辑可能需要重新输入。'),
          buttons: [t('重新打开'), t('关闭一壤')],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (closing() || window.isDestroyed()) return;
        lifecycle('renderer-crash-recovery', { action: response === 0 ? 'reopen' : 'close' });
        if (response === 0) app.relaunch();
        await close();
      } catch (error) {
        lifecycle('renderer-crash-recovery-failed', { message: error.message });
      } finally {
        promptOpen = false;
      }
    })();
  });
}
