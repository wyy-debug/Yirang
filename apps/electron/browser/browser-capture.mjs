import { t as uiText } from '../platform/native-ui-language.mjs';
import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';

export function createBrowserCapture() {
  const pending = new Map();
  const receive = (event, id, result, error) => {
    const item = pending.get(id);
    if (!item || event.sender !== item.contents || event.senderFrame !== item.frame) return;
    if (error) return item.finish(Error(uiText('网页正文暂时无法读取，请稍后重试')));
    if (
      !result ||
      typeof result.url !== 'string' ||
      typeof result.title !== 'string' ||
      typeof result.text !== 'string' ||
      typeof result.selection !== 'string' ||
      !Array.isArray(result.links)
    )
      return item.finish(Error(uiText('网页内容读取失败，请重试')));
    const links = result.links
      .slice(0, 100)
      .filter((link) => typeof link?.url === 'string' && typeof link?.text === 'string')
      .map((link) => ({ url: link.url.slice(0, 4096), text: link.text.slice(0, 500) }));
    item.finish(null, {
      url: result.url.slice(0, 4096),
      title: result.title.slice(0, 300),
      text: result.text.slice(0, 60000),
      selection: result.selection.slice(0, 6000),
      links,
      fields: [],
    });
  };
  ipcMain.on('yirang:browser-captured', receive);
  return {
    read(contents) {
      return new Promise((resolve, reject) => {
        const id = randomUUID(),
          frame = contents.mainFrame;
        const navigated = (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) finish(Error(uiText('网页已跳转，请重新保存当前页面')));
        };
        const closed = () => finish(Error(uiText('网页已关闭，请重新打开后再保存')));
        const timer = setTimeout(() => finish(Error(uiText('读取网页超时，请稍后重试'))), 8000);
        function finish(error, result) {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          contents.removeListener('did-start-navigation', navigated);
          contents.removeListener('destroyed', closed);
          contents.removeListener('render-process-gone', closed);
          if (error) reject(error);
          else resolve(result);
        }
        pending.set(id, { contents, frame, finish });
        contents.on('did-start-navigation', navigated);
        contents.on('destroyed', closed);
        contents.on('render-process-gone', closed);
        try {
          frame.send('yirang:browser-capture', id);
        } catch {
          finish(Error(uiText('网页暂时无法读取，请稍后重试')));
        }
      });
    },
    close() {
      ipcMain.removeListener('yirang:browser-captured', receive);
      for (const item of pending.values()) item.finish(Error(uiText('浏览器已关闭')));
    },
  };
}
