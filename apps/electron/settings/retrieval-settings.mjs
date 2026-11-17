import { safeStorage } from 'electron';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Embeddings are independent of CLI accounts. Secrets never enter renderer or MCP results.
export async function createRetrievalSettings(directory) {
  const path = join(directory, 'retrieval-settings.json');
  let state = {
      endpoint: 'https://api.openai.com/v1/embeddings',
      model: 'text-embedding-3-small',
      enabledWorkspaces: [],
      paused: false,
      encryptedKey: '',
    },
    loadError = '';
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')),
      url = new URL(saved.endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      typeof saved.endpoint !== 'string' ||
      saved.endpoint.length > 2000 ||
      typeof saved.model !== 'string' ||
      !saved.model ||
      saved.model.length > 200 ||
      !Array.isArray(saved.enabledWorkspaces) ||
      saved.enabledWorkspaces.length > 1000 ||
      saved.enabledWorkspaces.some((id) => typeof id !== 'string' || id.length > 200) ||
      typeof saved.encryptedKey !== 'string' ||
      saved.encryptedKey.length > 32000 ||
      (saved.dimensions != null &&
        (!Number.isInteger(saved.dimensions) || saved.dimensions < 1 || saved.dimensions > 8192))
    )
      throw Error('无效的向量配置');
    state = {
      endpoint: saved.endpoint,
      model: saved.model,
      dimensions: saved.dimensions ?? undefined,
      enabledWorkspaces: [...new Set(saved.enabledWorkspaces)],
      paused: saved.paused === true,
      encryptedKey: saved.encryptedKey,
    };
  } catch (e) {
    if (e.code !== 'ENOENT') loadError = '向量配置读取失败，请重新保存配置；关键词检索不受影响';
  }
  function key() {
    if (!state.encryptedKey) return '';
    try {
      return safeStorage.decryptString(Buffer.from(state.encryptedKey, 'base64'));
    } catch {
      loadError = '向量密钥无法解密，请重新填写；关键词检索不受影响';
      return '';
    }
  }
  function publicValue(workspace) {
    return {
      endpoint: state.endpoint,
      model: state.model,
      dimensions: state.dimensions ?? null,
      enabled: state.enabledWorkspaces.includes(workspace),
      paused: state.paused,
      hasKey: !!key(),
      error: loadError,
    };
  }
  function workerValue() {
    return {
      endpoint: state.endpoint,
      model: state.model,
      ...(state.dimensions ? { dimensions: state.dimensions } : {}),
      apiKey: key(),
      enabledWorkspaces: state.enabledWorkspaces,
      paused: state.paused,
    };
  }
  let saving = false;
  return {
    get: publicValue,
    worker: workerValue,
    async save(workspace, input) {
      if (saving) throw Error('正在保存向量配置，请稍候');
      saving = true;
      try {
        const endpoint = String(input.endpoint || '').trim(),
          model = String(input.model || '').trim(),
          secret = String(input.apiKey || '').trim();
        let url;
        try {
          url = new URL(endpoint);
        } catch {
          throw Error('请输入完整的 HTTPS 向量 API 地址');
        }
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          endpoint.length > 2000
        )
          throw Error('向量 API 使用 HTTPS 地址，不在地址中包含密钥或查询参数');
        if (!model || model.length > 200 || secret.length > 8000 || /[\r\n]/.test(secret))
          throw Error('请检查向量模型名称与密钥');
        const dimensions =
          input.dimensions == null || input.dimensions === ''
            ? undefined
            : Number(input.dimensions);
        if (
          dimensions !== undefined &&
          (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192)
        )
          throw Error('向量维度应为 1–8192 的整数，或留空使用模型默认值');
        let encryptedKey = state.encryptedKey;
        if (input.clearKey === true) encryptedKey = '';
        else if (secret) {
          if (!safeStorage.isEncryptionAvailable()) throw Error('系统密钥加密暂不可用，未保存密钥');
          encryptedKey = safeStorage.encryptString(secret).toString('base64');
        } else if (endpoint !== state.endpoint && encryptedKey)
          throw Error('更换 API 地址时请重新填写密钥');
        if (input.enabled === true && !encryptedKey)
          throw Error('请先填写商业模型 API 密钥，或关闭此工作区的语义检索');
        const enabled = new Set(state.enabledWorkspaces);
        input.enabled === true ? enabled.add(workspace) : enabled.delete(workspace);
        const next = {
          endpoint,
          model,
          dimensions,
          encryptedKey,
          enabledWorkspaces: [...enabled],
          paused: input.paused === true,
        };
        await mkdir(directory, { recursive: true });
        const temporary = path + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temporary, path);
        state = next;
        loadError = '';
        return publicValue(workspace);
      } finally {
        saving = false;
      }
    },
  };
}
