import { t as uiText } from '../platform/native-ui-language.mjs';
import { app, WebContentsView, session, shell, dialog, Menu } from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBrowserAgent } from './browser-agent.mjs';
import { createBrowserCapture } from './browser-capture.mjs';

const MAX_TABS = 20;
function canvasPlacement(value) {
  if (
    !value ||
    typeof value.workspaceId !== 'string' ||
    !value.workspaceId ||
    value.workspaceId.length > 150 ||
    ![value.x, value.y, value.width, value.height].every(Number.isFinite) ||
    Math.abs(value.x) > 100000 ||
    Math.abs(value.y) > 100000 ||
    value.width < 360 ||
    value.width > 2000 ||
    value.height < 240 ||
    value.height > 1600
  )
    throw Error(uiText('网页窗口位置不正确'));
  return {
    workspaceId: value.workspaceId,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}
function webUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw Error(uiText('请输入有效的网址'));
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw Error(uiText('只支持不含账号密码的 HTTP / HTTPS 网页'));
  return url.href;
}
function allowedNavigation(value) {
  try {
    return value === 'about:blank' || !!webUrl(value);
  } catch {
    return false;
  }
}
/** Remote websites have only a private read-only capture preload, never the app bridge. */
export async function createDesktopBrowser(window, emit, approve, transfers) {
  const capture = createBrowserCapture();
  const browserSession = session.fromPartition('persist:ai-desktop-browser');
  const stateFile = join(app.getPath('userData'), 'browser-tabs.json');
  const tabs = new Map();
  let activeId = '',
    disposed = false,
    layout = { visible: false, x: 0, y: 0, width: 0, height: 0 },
    saveTimer,
    saveQueue = Promise.resolve(),
    persistError = '';
  let canvasLayouts = [],
    publishTimer,
    lastPublished = '';
  const uploadTargets = new Map(),
    activeDownloads = new Set(),
    downloadDeliveries = new Set();
  const ownContents = (contents) =>
    !!contents && [...tabs.values()].some((tab) => tab.view?.webContents === contents);
  const liveContents = (tab) =>
    tab?.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
  const preferences = {
    session: browserSession,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    preload: fileURLToPath(new URL('../../../apps/electron/browser-preload.cjs', import.meta.url)),
  };
  const grantedPermissions = new Set();
  const permissionNames = () => ({
    media: uiText('摄像头或麦克风'),
    geolocation: uiText('位置信息'),
    notifications: uiText('通知'),
    'clipboard-read': uiText('剪贴板'),
  });
  browserSession.setPermissionCheckHandler(
    (contents, permission, origin) =>
      ownContents(contents) &&
      (permission === 'clipboard-sanitized-write' ||
        grantedPermissions.has(`${origin}:${permission}`)),
  );
  browserSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (!ownContents(contents)) return callback(false);
    if (permission === 'clipboard-sanitized-write') return callback(true);
    if (!permissionNames()[permission]) return callback(false);
    let origin;
    try {
      origin = new URL(details.requestingUrl || contents.getURL()).origin;
    } catch {
      return callback(false);
    }
    if (grantedPermissions.has(`${origin}:${permission}`)) return callback(true);
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        message: uiText('{0} 请求使用{1}', { 0: origin, 1: permissionNames()[permission] }),
        buttons: [uiText('不允许'), uiText('本次允许')],
        defaultId: 0,
        cancelId: 0,
      });
      const accepted =
        result.response === 1 &&
        !disposed &&
        !contents.isDestroyed() &&
        new URL(contents.getURL()).origin === origin;
      if (accepted) grantedPermissions.add(`${origin}:${permission}`);
      callback(accepted);
    } catch {
      callback(false);
    }
  });
  const downloading = (_event, item, contents) => {
    if (!ownContents(contents)) {
      item.cancel();
      return;
    }
    // Let Electron own the save dialog; an asynchronous second dialog races its default one.
    item.setSaveDialogOptions({
      title: uiText('保存下载文件'),
      defaultPath: join(
        app.getPath('downloads'),
        item.getFilename().replace(/[\\/:*?"<>|]/g, '_') || uiText('下载文件'),
      ),
    });
    activeDownloads.add(item);
    const context = transfers.context().catch(() => null),
      url = /^https?:\/\//i.test(contents.getURL()) ? contents.getURL() : item.getURL();
    item.once('done', (_event, status) => {
      activeDownloads.delete(item);
      emit(
        'browser-notice',
        status === 'completed'
          ? uiText('已下载：{0}', { 0: item.getFilename() })
          : uiText('下载未完成'),
      );
      if (status === 'completed') {
        const delivery = context.then((value) =>
          transfers.downloaded({ path: item.getSavePath(), url, workspaceId: value?.workspaceId }),
        );
        downloadDeliveries.add(delivery);
        delivery.then(
          () => downloadDeliveries.delete(delivery),
          (error) => {
            downloadDeliveries.delete(delivery);
            emit('browser-notice', uiText('下载已保存，加入桌面未完成：{0}', { 0: error.message }));
          },
        );
      }
    });
  };
  browserSession.on('will-download', downloading);
  function snapshot() {
    return {
      activeId,
      tabs: [...tabs.values()].map((tab) => {
        const wc = liveContents(tab);
        return {
          id: tab.id,
          url: tab.url,
          title: tab.title,
          canvas: tab.canvas,
          loading: tab.loading,
          documentReady: tab.documentReady,
          error: tab.error,
          canGoBack: wc?.navigationHistory.canGoBack() ?? false,
          canGoForward: wc?.navigationHistory.canGoForward() ?? false,
        };
      }),
      persistError,
    };
  }
  function publish() {
    if (disposed || publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      if (disposed) return;
      const value = snapshot(),
        key = JSON.stringify(value);
      if (key === lastPublished) return;
      lastPublished = key;
      emit('browser-state', value);
    }, 50);
  }
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const data = JSON.stringify({
        activeId,
        tabs: [...tabs.values()].map(({ id, url, title, canvas }) => ({ id, url, title, canvas })),
      });
      const temporary = `${stateFile}.${process.pid}.tmp`;
      saveQueue = saveQueue
        .then(async () => {
          if (disposed) return;
          await writeFile(temporary, data);
          if (!disposed) await rename(temporary, stateFile);
        })
        .catch(() => {
          persistError = uiText('标签恢复记录暂未保存');
          publish();
        });
    }, 350);
  }
  function newTab(url = '', id = randomUUID(), title = uiText('新标签页')) {
    if (tabs.size >= MAX_TABS)
      throw Error(uiText('最多打开 {0} 个标签，请先关闭一个', { 0: MAX_TABS }));
    const tab = {
      id,
      url,
      title,
      canvas: null,
      loading: false,
      documentReady: false,
      documentVersion: 0,
      error: '',
      view: null,
    };
    tabs.set(id, tab);
    activeId = id;
    persist();
    return tab;
  }
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    let restoredActive = '';
    for (const entry of (Array.isArray(saved.tabs) ? saved.tabs : []).slice(0, MAX_TABS)) {
      try {
        const tab = newTab(
          entry.url ? webUrl(entry.url) : '',
          typeof entry.id === 'string' &&
            /^[a-zA-Z0-9-]{1,100}$/.test(entry.id) &&
            !tabs.has(entry.id)
            ? entry.id
            : randomUUID(),
          String(entry.title || uiText('新标签页')).slice(0, 300),
        );
        try {
          if (entry.canvas) tab.canvas = canvasPlacement(entry.canvas);
        } catch {}
        if (entry.id === saved.activeId) restoredActive = tab.id;
      } catch {}
    }
    if (restoredActive) activeId = restoredActive;
  } catch {}
  if (!tabs.size) newTab();
  function placeRelated(tab, source) {
    if (layout.visible || !source.canvas) return;
    const same = [...tabs.values()].filter(
        (item) => item.canvas?.workspaceId === source.canvas.workspaceId,
      ),
      base = source.canvas;
    let x = base.x + base.width + 24,
      y = base.y;
    for (
      let step = 0;
      step < 40 &&
      same.some(
        (item) =>
          x < item.canvas.x + item.canvas.width + 16 &&
          x + base.width + 16 > item.canvas.x &&
          y < item.canvas.y + item.canvas.height + 16 &&
          y + base.height + 16 > item.canvas.y,
      );
      step++
    ) {
      y += base.height + 24;
    }
    tab.canvas = { ...base, x: Math.min(100000, x), y: Math.min(100000, y) };
    persist();
  }
  function load(tab, url) {
    const wc = ensureView(tab, false);
    tab.url = url;
    tab.error = '';
    tab.loading = true;
    tab.documentReady = false;
    publish();
    persist();
    void wc.loadURL(url).catch((error) => {
      if (!liveContents(tab) || error.code === 'ERR_ABORTED') return;
      tab.error = error.message;
      tab.loading = false;
      applyLayout();
      publish();
    });
  }
  function remove(tab) {
    if (disposed) return;
    const ids = [...tabs.keys()],
      index = ids.indexOf(tab.id);
    if (tab.view) window.contentView.removeChildView(tab.view);
    tabs.delete(tab.id);
    if (activeId === tab.id) activeId = ids[index + 1] || ids[index - 1] || '';
    if (!tabs.size) newTab();
    applyLayout();
    publish();
    persist();
    focusActive();
  }
  function ensureView(tab, loadInitial = true, popupOptions) {
    if (liveContents(tab)) return tab.view.webContents;
    // Electron already created the popup WebContents. Adopt that exact instance:
    // createWindow must return it, preserving the opener, referrer and POST body.
    const view = new WebContentsView({
      ...(popupOptions?.webContents ? { webContents: popupOptions.webContents } : {}),
      webPreferences: { ...popupOptions?.webPreferences, ...preferences },
    });
    tab.view = view;
    tab.visible = false;
    tab.boundsKey = '';
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    window.contentView.addChildView(view);
    const wc = view.webContents;
    wc.on('focus', () => {
      if (activeId !== tab.id) {
        activeId = tab.id;
        publish();
        persist();
      }
    });
    wc.on('will-navigate', (event, url) => {
      if (!allowedNavigation(url)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => {
      if (!allowedNavigation(url)) event.preventDefault();
    });
    wc.on('will-frame-navigate', (event) => {
      if (!allowedNavigation(event.url)) event.preventDefault();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      tab.error = '';
      publish();
    });
    wc.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        tab.documentReady = false;
        tab.documentVersion++;
        publish();
      }
    });
    wc.on('dom-ready', () => {
      tab.documentReady = /^https?:\/\//i.test(wc.getURL());
      publish();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      publish();
    });
    const navigated = () => {
      const url = wc.getURL();
      if (url && url !== 'about:blank' && allowedNavigation(url)) tab.url = url;
      tab.error = '';
      tab.title = wc.getTitle() || tab.url || uiText('新标签页');
      applyLayout();
      publish();
      persist();
    };
    wc.on('did-navigate', navigated);
    wc.on('did-navigate-in-page', navigated);
    wc.on('page-title-updated', (_event, title) => {
      tab.title = title.slice(0, 300) || tab.url;
      publish();
      persist();
    });
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      tab.loading = false;
      tab.error = uiText('网页未能载入（{0}）', { 0: description });
      applyLayout();
      publish();
    });
    wc.on('render-process-gone', () => {
      tab.loading = false;
      tab.error = uiText('网页进程已退出，请重新载入');
      applyLayout();
      publish();
    });
    wc.on('will-prevent-unload', (event) => {
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question',
        message: uiText('此网页可能还有未保存的内容，是否离开？'),
        buttons: [uiText('留在网页'), uiText('离开')],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice === 1) event.preventDefault();
    });
    wc.on('destroyed', () => remove(tab));
    wc.setWindowOpenHandler(({ url }) => {
      if (disposed || window.isDestroyed() || !allowedNavigation(url) || tabs.size >= MAX_TABS)
        return { action: 'deny' };
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: preferences },
        createWindow: (options) => {
          const popup = newTab(url === 'about:blank' ? '' : webUrl(url));
          placeRelated(popup, tab);
          const contents = ensureView(popup, false, options);
          applyLayout();
          publish();
          return contents;
        },
      };
    });
    wc.on('context-menu', (_event, params) => {
      const entries = [];
      if (tab.documentReady && !tab.error && tab.url && allowedNavigation(tab.url)) {
        const url = wc.getURL();
        entries.push({
          label: uiText('在画布中浏览当前网页'),
          click: () => emit('browser-pin', { id: tab.id }),
        });
        entries.push({
          label: uiText('将当前网页保存为桌面文档'),
          click: () => emit('browser-collect', { mode: 'material', id: tab.id, url }),
        });
        if (params.selectionText && !params.isEditable)
          entries.push({
            label: uiText('将选中文字摘录到桌面'),
            click: () =>
              emit('browser-collect', {
                mode: 'selection',
                id: tab.id,
                url,
                selection: params.selectionText.slice(0, 6000),
              }),
          });
        entries.push({ type: 'separator' });
      }
      if (params.linkURL && allowedNavigation(params.linkURL))
        entries.push({
          label: uiText('在新标签中打开链接'),
          click: () => {
            try {
              const next = newTab(webUrl(params.linkURL));
              placeRelated(next, tab);
              applyLayout();
              publish();
            } catch (error) {
              emit('browser-notice', error.message);
            }
          },
        });
      if (params.isEditable)
        entries.push(
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        );
      else if (params.selectionText) entries.push({ role: 'copy' }, { role: 'selectAll' });
      if (entries.length) Menu.buildFromTemplate(entries).popup({ window });
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
      const key = input.key.toLowerCase();
      if (['l', 't', 'w', 'r', 'f'].includes(key)) {
        event.preventDefault();
        if (key === 'l' || key === 'f') {
          window.webContents.focus();
          emit('browser-focus', key === 'l' ? 'address' : 'find');
        }
        if (key === 't') {
          try {
            const next = newTab();
            placeRelated(next, tab);
            applyLayout();
            publish();
            window.webContents.focus();
            emit('browser-focus', 'address');
          } catch (error) {
            emit('browser-notice', error.message);
          }
        }
        if (key === 'w') wc.close({ waitForBeforeUnload: true });
        if (key === 'r') wc.reload();
      }
    });
    if (loadInitial && tab.url) load(tab, tab.url);
    return wc;
  }
  function applyLayout() {
    if (disposed || window.isDestroyed()) return;
    const [windowWidth, windowHeight] = window.getContentSize(),
      active = tabs.get(activeId);
    const requested = window.isMinimized()
      ? []
      : layout.visible && active ? [{ ...layout, id: active.id }] : canvasLayouts;
    const shown = new Set();
    for (const rect of requested) {
      const tab = tabs.get(rect.id);
      if (!tab?.url || tab.error || !rect.visible) continue;
      if (!layout.visible && (!tab.canvas || tab.canvas.workspaceId !== rect.workspaceId)) continue;
      const x = Math.max(0, Math.min(Math.round(rect.x), windowWidth)),
        y = Math.max(0, Math.min(Math.round(rect.y), windowHeight));
      const bounds = {
        x,
        y,
        width: Math.max(0, Math.min(Math.round(rect.width), windowWidth - x)),
        height: Math.max(0, Math.min(Math.round(rect.height), windowHeight - y)),
      };
      if (bounds.width < 1 || bounds.height < 1) continue;
      if (!tab.view) ensureView(tab);
      if (!tab.view || tab.error) continue;
      const boundsKey = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (tab.boundsKey !== boundsKey) {
        tab.view.setBounds(bounds);
        tab.boundsKey = boundsKey;
      }
      if (!tab.visible) {
        tab.view.setVisible(true);
        tab.visible = true;
      }
      shown.add(tab.id);
    }
    for (const item of tabs.values())
      if (item.view && item.visible && !shown.has(item.id)) {
        item.view.setVisible(false);
        item.visible = false;
      }
  }
  window.on('resize', applyLayout);
  function concealViews() {
    for (const tab of tabs.values()) {
      if (!tab.view || !tab.visible) continue;
      tab.view.setVisible(false);
      tab.visible = false;
    }
  }
  window.on('minimize', concealViews);
  window.on('restore', applyLayout);
  function hide() {
    layout = { ...layout, visible: false };
    applyLayout();
  }
  function focusActive() {
    if (!layout.visible) return;
    const tab = tabs.get(activeId),
      wc = liveContents(tab);
    if (tab?.url && !tab.error && wc) wc.focus();
    else window.webContents.focus();
  }
  async function command(action, payload = {}) {
    if (disposed) throw Error(uiText('浏览器已关闭'));
    if (!payload || typeof payload !== 'object') throw Error(uiText('浏览器操作格式不正确'));
    let tab = tabs.get(payload.id || activeId);
    if (action === 'layout-batch') {
      const next = payload.layout,
        items = payload.items;
      if (
        !next ||
        typeof next.visible !== 'boolean' ||
        (next.visible &&
          ![next.x, next.y, next.width, next.height].every(
            (n) => Number.isFinite(n) && n >= 0 && n <= 50000,
          )) ||
        !Array.isArray(items) ||
        items.length > MAX_TABS
      )
        throw Error(uiText('浏览器区域不正确'));
      const nextCanvas = items.map((rect) => {
        if (
          !rect ||
          typeof rect.id !== 'string' ||
          typeof rect.workspaceId !== 'string' ||
          ![rect.x, rect.y, rect.width, rect.height].every(
            (n) => Number.isFinite(n) && n >= 0 && n <= 50000,
          )
        )
          throw Error(uiText('网页窗口区域不正确'));
        return { ...rect, visible: rect.visible === true };
      });
      layout = next.visible
        ? { visible: true, x: next.x, y: next.y, width: next.width, height: next.height }
        : { visible: false };
      canvasLayouts = nextCanvas;
      applyLayout();
      return true;
    }
    if (action === 'files-open') {
      emit('browser-files-open', {});
      return true;
    }
    if (['transfers', 'retry-download', 'reveal-download', 'upload-list'].includes(action))
      return transfers.command(action, payload);
    if (action === 'upload-targets' || action === 'upload-file') {
      if (action === 'upload-file') tab = tabs.get(payload.tabId);
      const wc = liveContents(tab);
      if (!wc || tab.loading || tab.error) throw Error(uiText('请先打开含上传框的网页'));
      const url = wc.getURL();
      if (wc.debugger.isAttached())
        throw Error(uiText('网页调试器正在使用，请先关闭开发工具再上传'));
      wc.debugger.attach('1.3');
      try {
        if (action === 'upload-targets') {
          uploadTargets.clear();
          const { root } = await wc.debugger.sendCommand('DOM.getDocument', {}),
            { nodeIds } = await wc.debugger.sendCommand('DOM.querySelectorAll', {
              nodeId: root.nodeId,
              selector: 'input[type="file"]',
            }),
            fields = [];
          for (const nodeId of nodeIds.slice(0, 30)) {
            const { node } = await wc.debugger.sendCommand('DOM.describeNode', { nodeId }),
              attributes = node.attributes || [],
              a = Object.fromEntries(
                Array.from({ length: attributes.length / 2 }, (_, i) => [
                  attributes[i * 2],
                  attributes[i * 2 + 1],
                ]),
              ),
              id = randomUUID();
            if ('disabled' in a) continue;
            const label =
              a['aria-label'] || a.name || a.id || uiText('上传框 {0}', { 0: fields.length + 1 });
            uploadTargets.set(id, { tabId: tab.id, url, backendNodeId: node.backendNodeId });
            fields.push({ id, label, accept: a.accept || '' });
          }
          return { tabId: tab.id, url, fields };
        }
        const target = uploadTargets.get(payload.targetId);
        if (!target || target.tabId !== tab.id || target.url !== url || payload.url !== url)
          throw Error(uiText('网页已变化，请重新选择上传框'));
        const path = await transfers.uploadFile(payload, url);
        if (wc.isDestroyed() || wc.getURL() !== url)
          throw Error(uiText('选择期间网页已跳转，请重试'));
        const { node } = await wc.debugger.sendCommand('DOM.describeNode', {
            backendNodeId: target.backendNodeId,
          }),
          attributes = node.attributes || [],
          a = Object.fromEntries(
            Array.from({ length: attributes.length / 2 }, (_, i) => [
              attributes[i * 2],
              attributes[i * 2 + 1],
            ]),
          );
        if (node.nodeName !== 'INPUT' || a.type?.toLowerCase() !== 'file' || 'disabled' in a)
          throw Error(uiText('上传框已失效，请重新选择'));
        await wc.debugger.sendCommand('DOM.setFileInputFiles', {
          backendNodeId: target.backendNodeId,
          files: [path],
        });
        return { uploaded: true };
      } finally {
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
      }
    }
    if (action === 'canvas-layout') {
      if (!Array.isArray(payload.items) || payload.items.length > MAX_TABS)
        throw Error(uiText('网页窗口区域不正确'));
      canvasLayouts = payload.items.map((rect) => {
        if (
          !rect ||
          typeof rect.id !== 'string' ||
          typeof rect.workspaceId !== 'string' ||
          ![rect.x, rect.y, rect.width, rect.height].every(
            (n) => Number.isFinite(n) && n >= 0 && n <= 50000,
          )
        )
          throw Error(uiText('网页窗口区域不正确'));
        return { ...rect, visible: rect.visible === true };
      });
      applyLayout();
      return true;
    }
    if (action === 'pin') {
      if (!tab || (!tab.url && !tab.canvas)) throw Error(uiText('请先打开网页再放到画布'));
      tab.canvas = canvasPlacement(payload.bounds);
      persist();
      publish();
      return snapshot();
    }
    if (action === 'unpin') {
      if (!tab || tab.canvas?.workspaceId !== payload.workspaceId)
        throw Error(uiText('网页窗口不在当前工作区'));
      tab.canvas = null;
      canvasLayouts = canvasLayouts.filter((item) => item.id !== tab.id);
      applyLayout();
      persist();
      publish();
      return snapshot();
    }
    if (action === 'layout') {
      if (payload.visible === false) {
        hide();
        return true;
      }
      if (
        payload.visible !== true ||
        ![payload.x, payload.y, payload.width, payload.height].every(
          (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 50000,
        )
      )
        throw Error(uiText('浏览器区域不正确'));
      layout = {
        visible: true,
        x: payload.x,
        y: payload.y,
        width: payload.width,
        height: payload.height,
      };
      applyLayout();
      return true;
    }
    if (action === 'state') return snapshot();
    if (action === 'new' || action === 'open') {
      const url = payload.url ? webUrl(payload.url) : '';
      const existing =
        action === 'open' && [...tabs.values()].find((entry) => entry.url === url && url);
      tab = existing || newTab(url);
      activeId = tab.id;
      applyLayout();
      persist();
      publish();
      focusActive();
      return snapshot();
    }
    if (!tab) throw Error(uiText('此标签已关闭'));
    if (action === 'switch') {
      activeId = tab.id;
      applyLayout();
      persist();
      focusActive();
    } else if (action === 'close') {
      const wc = liveContents(tab);
      if (wc) wc.close({ waitForBeforeUnload: true });
      else remove(tab);
    } else if (action === 'navigate') {
      load(tab, webUrl(payload.url));
      applyLayout();
      focusActive();
    } else if (action === 'external') return shell.openExternal(webUrl(tab.url));
    else if (action === 'capture') {
      const wc = liveContents(tab);
      if (!wc || !tab.documentReady || tab.error)
        throw Error(uiText('网页正文尚未就绪，请稍后再保存'));
      const url = webUrl(wc.getURL()),
        version = tab.documentVersion;
      const result = await capture.read(wc);
      if (
        wc.isDestroyed() ||
        !tab.documentReady ||
        tab.documentVersion !== version ||
        wc.getURL() !== url ||
        result.url !== url
      )
        throw Error(uiText('网页已跳转，请重新保存当前页面'));
      // Leave room for JSON escaping and multi-byte text in the workspace capture limit.
      while (Buffer.byteLength(JSON.stringify(result)) > 360 * 1024) {
        if (result.links.length) result.links.pop();
        else result.text = result.text.slice(0, Math.floor(result.text.length * 0.8));
      }
      return result;
    } else if (action === 'back' || action === 'forward') {
      const wc = liveContents(tab);
      if (action === 'back' && wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      if (action === 'forward' && wc?.navigationHistory.canGoForward())
        wc.navigationHistory.goForward();
    } else if (action === 'reload') {
      tab.error = '';
      const wc = liveContents(tab);
      if (wc) {
        wc.reload();
        applyLayout();
      } else if (tab.url) load(tab, tab.url);
    } else if (action === 'stop') liveContents(tab)?.stop();
    else if (action === 'find') {
      const text = String(payload.text || '').slice(0, 300);
      const wc = liveContents(tab);
      if (text)
        wc?.findInPage(text, {
          forward: payload.forward !== false,
          findNext: payload.findNext !== false,
        });
      else wc?.stopFindInPage('clearSelection');
    } else throw Error(uiText('不支持此浏览器操作'));
    publish();
    return snapshot();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    capture.close();
    clearTimeout(saveTimer);
    clearTimeout(publishTimer);
    window.removeListener('resize', applyLayout);
    window.removeListener('minimize', concealViews);
    window.removeListener('restore', applyLayout);
    browserSession.removeListener('will-download', downloading);
    const data = JSON.stringify({
      activeId,
      tabs: [...tabs.values()].map(({ id, url, title, canvas }) => ({ id, url, title, canvas })),
    });
    // App shutdown does not wait for queued filesystem promises.
    try {
      const temporary = `${stateFile}.${process.pid}.closing`;
      writeFileSync(temporary, data);
      renameSync(temporary, stateFile);
    } catch {}
    for (const tab of tabs.values()) liveContents(tab)?.close({ waitForBeforeUnload: false });
    tabs.clear();
  }
  const agent = createBrowserAgent({ tabs, contents: liveContents, command, approve });
  return {
    command,
    hide,
    dispose,
    agent: agent.command,
    busy: () => activeDownloads.size > 0 || downloadDeliveries.size > 0,
    stopDownloads: async () => {
      for (const item of activeDownloads) item.cancel();
      await Promise.all([...downloadDeliveries]);
    },
    settle: async () => {
      if (activeDownloads.size) throw Error(uiText('请先等待或取消正在下载的文件'));
      await Promise.all([...downloadDeliveries]);
    },
  };
}
