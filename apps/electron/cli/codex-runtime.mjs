import { t as uiText } from '../platform/native-ui-language.mjs';
import { stat, readFile, readdir } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { execFile } from 'node:child_process';

const isFile = async (path) => !!path && (await stat(path).catch(() => null))?.isFile();
async function npmBinary(prefix) {
  const root = join(prefix, 'node_modules', '@openai', 'codex');
  try {
    if (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name !== '@openai/codex')
      return null;
  } catch {
    return null;
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64',
    triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  for (const vendor of [
    join(root, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor'),
    join(prefix, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor'),
    join(root, 'vendor'),
  ]) {
    for (const directory of ['bin', 'codex']) {
      const path = join(vendor, triple, directory, 'codex.exe');
      if (await isFile(path)) return path;
    }
  }
  return null;
}
export async function resolveCodexRuntime(preferences = {}) {
  for (const [path, source] of [
    [preferences.codexPath, uiText('手动选择')],
    [process.env.AI_DESKTOP_CODEX_BIN, uiText('环境变量')],
  ]) {
    if (!path) continue;
    if (await isFile(path)) return { path, source };
    throw Error(uiText('指定的 Codex CLI 不存在：{0}。请重新选择或恢复自动识别。', { 0: path }));
  }
  // Collect every installed CLI (PATH order first, npm shims resolved to their native binary),
  // then use the newest: the Codex desktop app often puts an older bundled codex.exe first on PATH,
  // and an older CLI lists an older model catalog than the one the user configured.
  const candidates = [],
    add = (path, source) => {
      if (path && !candidates.some((c) => c.path.toLowerCase() === path.toLowerCase()))
        candidates.push({ path, source });
    };
  for (const entry of (process.env.PATH || '').split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '').trim();
    if (!directory) continue;
    const native = join(directory, 'codex.exe');
    if (await isFile(native)) add(native, uiText('命令行 PATH'));
    if (
      (await isFile(join(directory, 'codex.cmd'))) ||
      (await isFile(join(directory, 'codex.ps1')))
    )
      add(await npmBinary(directory), uiText('命令行 npm'));
  }
  if (process.env.APPDATA)
    add(await npmBinary(join(process.env.APPDATA, 'npm')), uiText('npm 安装'));
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const stable = join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (await isFile(stable)) add(stable, uiText('Codex 桌面版附带'));
    const base = join(local, 'OpenAI', 'Codex', 'bin'),
      found = [];
    for (const name of await readdir(base).catch(() => [])) {
      const path = join(base, name, 'codex.exe'),
        info = await stat(path).catch(() => null);
      if (info?.isFile()) found.push({ path, modified: info.mtimeMs });
    }
    found.sort((a, b) => b.modified - a.modified);
    if (found.length) add(found[0].path, uiText('Codex 桌面版附带'));
  }
  if (!candidates.length)
    throw Error(uiText('找不到 Codex CLI。请安装 Codex CLI，或在设置中选择 codex.exe。'));
  if (candidates.length === 1) return candidates[0];
  const versions = await Promise.all(candidates.map((c) => cliVersion(c.path)));
  let best = 0;
  for (let i = 1; i < candidates.length; i++)
    if (compareVersions(versions[i], versions[best]) > 0) best = i;
  return { ...candidates[best], ...(versions[best] ? { version: versions[best].join('.') } : {}) };
}
function cliVersion(path) {
  return new Promise((resolve) =>
    execFile(path, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      const m = !error && /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout));
      resolve(m ? m.slice(1).map(Number) : null);
    }),
  );
}
// Unknown versions rank below any known one, so a broken binary never wins.
function compareVersions(a, b) {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export async function readModelCatalog(request) {
  const models = new Map(),
    seen = new Set();
  let cursor = null;
  // Hidden models are kept (flagged) so a model configured in config.toml still resolves its efforts; pickers list them only when selected.
  do {
    const page = await request('model/list', {
      limit: 100,
      includeHidden: true,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.data || [])
      if (typeof item.model === 'string')
        models.set(item.model, { ...item, hidden: !!item.hidden });
    cursor = page.nextCursor || null;
    if (cursor && seen.has(cursor)) throw Error(uiText('模型目录分页未能完成，请刷新后重试'));
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...models.values()];
}
export async function readCliConfiguration(request) {
  const { config } = await request('config/read', { includeLayers: false });
  // Never expose provider secrets or the complete config to the renderer.
  return {
    model: config?.model || null,
    effort: config?.model_reasoning_effort || null,
    provider: config?.model_provider || null,
  };
}
export async function resolveModelSelection(request, saved) {
  if (saved.model && saved.effort) return { model: saved.model, effort: saved.effort };
  const config = saved.model ? null : await readCliConfiguration(request);
  let model = saved.model || config?.model,
    effort = saved.model ? saved.effort : config?.effort;
  if (!model || !effort) {
    const catalog = await readModelCatalog(request),
      item = model
        ? catalog.find((item) => item.model === model)
        : catalog.find((item) => item.isDefault);
    model ||= item?.model;
    effort ||= item?.defaultReasoningEffort;
  }
  if (!model) throw Error(uiText('CLI 未提供默认模型，请在模型列表中选择。'));
  return { model, effort: effort || null };
}
