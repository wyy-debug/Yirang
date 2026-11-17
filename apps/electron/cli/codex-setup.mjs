import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const execute = promisify(execFile);
export function validateGateway(value) {
  const url = new URL(String(value.url || ''));
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  )
    throw Error('接口地址须为 HTTPS，或本机 HTTP');
  if (url.username || url.password || url.search || url.hash)
    throw Error('接口地址不能包含账号、查询参数或片段');
  const model = String(value.model || '').trim(),
    key = String(value.key || '').trim();
  if (!model || model.length > 160 || /[\r\n"\\]/.test(model)) throw Error('请输入有效的模型名称');
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw Error('请输入 API Key');
  return { url: url.toString().replace(/\/$/, ''), model, key };
}
export async function discoverGatewayModels(value) {
  const { url, key } = validateGateway({ ...value, model: value.model || 'temporary-model' });
  const response = await fetch(url + '/models', {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error(`获取模型列表失败：HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > 2 * 1024 * 1024)
    throw Error('模型列表响应过大');
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw Error('模型列表响应过大');
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw Error('接口没有返回 JSON 模型列表');
  }
  if (!Array.isArray(data.data)) throw Error('接口未返回标准的 data 模型列表');
  return [
    ...new Set(
      data.data
        .map((item) => item?.id)
        .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 160),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
export async function installCodex(directory) {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64',
    assetName = `codex-${arch}-pc-windows-msvc.exe.zip`;
  const release = await fetch('https://api.github.com/repos/openai/codex/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Yirang' },
    signal: AbortSignal.timeout(15000),
  });
  if (!release.ok) throw Error('无法获取 Codex 官方发布信息：' + release.status);
  const metadata = await release.json(),
    asset = metadata.assets?.find((item) => item.name === assetName);
  if (!asset?.browser_download_url || !/^sha256:[a-f\d]{64}$/i.test(asset.digest || ''))
    throw Error('官方发布包缺少校验信息');
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error('下载 Codex CLI 失败：' + response.status);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > 200 * 1024 * 1024) throw Error('安装包超出大小限制');
  if (createHash('sha256').update(archive).digest('hex') !== asset.digest.slice(7).toLowerCase())
    throw Error('安装包 SHA-256 校验失败');
  const zip = await JSZip.loadAsync(archive),
    entries = Object.values(zip.files).filter(
      (file) => !file.dir && /codex(?:-[\w-]+)?\.exe$/i.test(file.name),
    );
  if (entries.length !== 1) throw Error('官方安装包中未找到唯一的 Codex CLI');
  const bytes = await entries[0].async('nodebuffer');
  if (bytes.length > 300 * 1024 * 1024) throw Error('CLI 文件超出大小限制');
  const version = String(metadata.tag_name || '').replace(/[^\w.-]/g, '');
  if (!version) throw Error('官方版本号无效');
  const target = join(directory, 'codex-cli', version);
  const path = join(target, 'codex.exe');
  await mkdir(target, { recursive: true });
  const pending = join(target, 'codex-pending.exe');
  await writeFile(pending, bytes);
  try {
    await execute(pending, ['--version'], { timeout: 10000, windowsHide: true });
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rename(pending, path);
  } catch (error) {
    await unlink(pending).catch(() => {});
    throw Error('CLI 验证或安装失败：' + error.message);
  }
  if (!(await stat(path)).isFile()) throw Error('CLI 安装后不存在');
  return { path, version: metadata.tag_name };
}
