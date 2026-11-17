import { t as uiText } from '../platform/native-ui-language.mjs';
import { ipcMain, dialog, shell } from 'electron';
import { readModelCatalog, readCliConfiguration } from '../cli/codex-runtime.mjs';
import { validateModelSettings } from '../cli/model-settings.mjs';
import { isLoginPortDenied, startCodexLogin } from './codex-login.mjs';
import { hasDesktopCodexAuth, importDesktopCodexAuth } from '../cli/codex-auth-import.mjs';

export async function readChatHistory(request, threadId, limit = 40, cursor = null) {
  if (!cursor?.startsWith('local:'))
    try {
      return await request('thread/turns/list', {
        threadId,
        limit,
        sortDirection: 'desc',
        itemsView: 'full',
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (cursor) throw error;
    }
  // Older installed CLIs expose thread/read instead of paginated turns.
  const result = await request('thread/read', { threadId, includeTurns: true }),
    turns = [...(result.thread.turns || [])].reverse(),
    anchor = cursor?.slice(6),
    index = anchor ? turns.findIndex((turn) => turn.id === anchor) : -1;
  if (anchor && index < 0) throw Error(uiText('历史记录已变化，请重新打开这段对话'));
  const start = index + 1,
    data = turns.slice(start, start + limit);
  return {
    data,
    nextCursor:
      start + data.length < turns.length && data.length ? `local:${data.at(-1).id}` : null,
  };
}

export function registerChatManager({
  request,
  timings,
  runtime,
  state,
  preferences,
  codexHome,
  requireMainFrame,
  window,
  emit,
  visibleThread = () => true,
  history = (id, limit, cursor) => readChatHistory(request, id, limit, cursor),
}) {
  let catalog = [];
  const threadId = (value) => {
    if (typeof value !== 'string' || !/^[-a-zA-Z0-9_]{1,160}$/.test(value))
      throw Error(uiText('对话标识无效'));
    return value;
  };
  ipcMain.handle('desktop:chat', async (event, action, payload = {}) => {
    requireMainFrame(event);
    if (action === 'preferences') return preferences.get();
    if (action === 'timings') return timings(payload);
    if (action === 'models') {
      catalog = await readModelCatalog(request);
      return catalog;
    }
    if (action === 'runtime') {
      let config = null,
        configError = null;
      try {
        config = await readCliConfiguration(request);
      } catch (error) {
        configError = error.message;
      }
      return { ...runtime(), config, configError };
    }
    if (action === 'auto-cli') {
      if (state().running) throw Error(uiText('请先完成当前回合'));
      await preferences.set({ codexPath: null });
      return true;
    }
    if (action === 'configure') {
      const saved = await preferences.set(
        await validateModelSettings(request, preferences.get(), payload),
      );
      emit('preferences', saved);
      return saved;
    }
    if (action === 'threads') {
      const page = await request('thread/list', {
        limit: 40,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        ...(payload.cursor ? { cursor: String(payload.cursor) } : {}),
        ...(payload.search ? { searchTerm: String(payload.search).slice(0, 200) } : {}),
      });
      return { ...page, data: page.data.filter((thread) => visibleThread(thread.id)) };
    }
    if (action === 'rename') {
      const name = String(payload.name || '')
        .trim()
        .slice(0, 120);
      if (!name) throw Error(uiText('请输入对话名称'));
      return request('thread/name/set', { threadId: threadId(payload.threadId), name });
    }
    if (action === 'history') {
      const id = threadId(payload.threadId);
      if (id !== state().threadId) throw Error(uiText('请先切换到这段对话'));
      return history(id, 40, payload.cursor ? String(payload.cursor) : null);
    }
    if (action === 'account') return request('account/read', {});
    if (action === 'login') {
      try {
        return await startCodexLogin(request, (url) => shell.openExternal(url));
      } catch (error) {
        if (!isLoginPortDenied(error)) throw error;
        return { method: 'port-blocked', canImport: await hasDesktopCodexAuth() };
      }
    }
    if (action === 'import-login') {
      if (state().running) throw Error(uiText('请先完成当前回合'));
      return importDesktopCodexAuth(codexHome);
    }
    if (action === 'rates') return request('account/rateLimits/read', {});
    if (action === 'choose-cli') {
      if (state().running) throw Error(uiText('请先完成当前回合'));
      const result = await dialog.showOpenDialog(window(), {
        title: uiText('选择 Codex CLI'),
        properties: ['openFile'],
        filters: [{ name: 'Codex CLI', extensions: ['exe'] }],
      });
      if (!result.canceled) {
        await preferences.set({ codexPath: result.filePaths[0] });
        return result.filePaths[0];
      }
      return null;
    }
    throw Error(uiText('不支持的对话操作'));
  });
}
