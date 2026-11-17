import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import { fail, FileContent } from '../../contracts/index.js';
import type { WorkbenchAPI } from '../work/workbench.js';

type NetworkResource = {
  id: string;
  name: string;
  url: string;
  privateNetworkAuthorized: boolean;
  createdAt: string;
  expiresAt: string | null;
  objectId?: string;
  desktopHash?: string;
  sourceHash?: string;
  lastReadAt?: string;
};
const READ_LIMIT = 20 * 1024 * 1024;
const publicAddress = (address: string) => {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const [first, second] = address.split(':').map((p) => parseInt(p || '0', 16));
    return (
      first >= 0x2000 &&
      first < 0x3fff &&
      first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
  }
  return false;
};
function parseUrl(value: unknown) {
  const url = new URL(z.string().min(1).max(2048).parse(value));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    fail('NETWORK_URL', '请使用不含账号、密码及片段的完整 HTTP(S) 资源地址。');
  return url;
}
async function resolveAddresses(hostname: string) {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('NETWORK_DNS_TIMEOUT: 域名解析超过 10 秒。')),
          10000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function download(resource: NetworkResource) {
  const url = parseUrl(resource.url),
    hostname = url.hostname.replace(/^\[|\]$/g, ''),
    addresses = await resolveAddresses(hostname);
  if (!addresses.length) fail('NETWORK_DNS', '没有可访问的地址。');
  if (!resource.privateNetworkAuthorized && addresses.some((a) => !publicAddress(a.address)))
    fail('NETWORK_PRIVATE', '此地址指向本机或私有网络，请在连接时明确授权该精确地址。');
  const chosen = addresses[0];
  if (url.protocol === 'http:' && addresses.some((a) => publicAddress(a.address)))
    fail('NETWORK_HTTP', '公开网络只接受 HTTPS，请改用 HTTPS 地址。');
  // DNS is resolved once and pinned to this socket; redirects never widen the exact URL grant.
  return new Promise<{ bytes: Buffer; mime: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        agent: false,
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          'User-Agent': 'AI-Desktop-Resource/1',
        },
        lookup: ((_host: any, options: any, callback: any) => {
          if (options?.all) callback(null, [chosen]);
          else callback(null, chosen.address, chosen.family);
        }) as any,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new Error('NETWORK_REDIRECT: 资源返回重定向；请确认目标地址并单独建立连接。'));
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(new Error(`NETWORK_HTTP: 读取失败（HTTP ${status}）。`));
          return;
        }
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          response.destroy();
          reject(new Error('NETWORK_ENCODING: 服务器未返回原始未压缩字节。'));
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > READ_LIMIT) {
          response.destroy();
          reject(new Error('NETWORK_LIMIT: 网络导入最多 20 MiB。'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk) => {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > READ_LIMIT) {
            response.destroy(new Error('NETWORK_LIMIT: 网络导入最多 20 MiB。'));
            return;
          }
          chunks.push(bytes);
        });
        response.on('end', () =>
          resolve({
            bytes: Buffer.concat(chunks),
            mime: String(response.headers['content-type'] ?? '').split(';')[0],
          }),
        );
        response.on('error', reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error('NETWORK_TIMEOUT: 读取超过 20 秒，请稍后重试。')),
      20000,
    );
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}
export class ExternalResources {
  constructor(private api: WorkbenchAPI) {}
  private resources(): NetworkResource[] {
    return this.api.get('network-resources') ?? [];
  }
  private current(id: string) {
    const resource = this.resources().find((r) => r.id === id);
    if (!resource) fail('NETWORK_REVOKED', '此网络连接已经撤销。');
    if (resource.expiresAt && Date.parse(resource.expiresAt) <= Date.now())
      fail('NETWORK_EXPIRED', '此网络连接已到期，请重新授权。');
    return resource;
  }
  async action(input: any) {
    const p = z
      .object({ operation: z.enum(['list', 'connect', 'revoke', 'pull', 'application_reference']) })
      .passthrough()
      .parse(input);
    if (p.operation === 'list')
      return this.resources().map((r) => {
        let currentDesktopHash: string | undefined;
        try {
          if (r.objectId)
            currentDesktopHash = FileContent.parse(this.api.object(r.objectId).content).assetHash;
        } catch {}
        return {
          ...r,
          expired: !!r.expiresAt && Date.parse(r.expiresAt) <= Date.now(),
          currentDesktopHash,
          desktopChanged: !!currentDesktopHash && currentDesktopHash !== r.desktopHash,
        };
      });
    if (p.operation === 'application_reference') {
      const application = z.string().trim().min(1).max(120).parse(p.application),
        target = z
          .string()
          .trim()
          .max(2000)
          .parse(p.target ?? ''),
        operation = z.string().trim().min(1).max(4000).parse(p.instruction),
        text = `# 软件操作请求\n\n软件：${application}\n目标：${target || '由用户在原对话中选择'}\n\n## 希望完成的操作\n${operation}\n\n## 执行位置\n此文件只记录用户请求，没有启动软件或执行任何命令。请在 Codex 原对话中确认实际可用的应用/工具，沿用当前会话的权限执行；如需打开外部软件，使用宿主支持的打开入口。没有可用适配器时说明限制。产出文件需收回原桌面对象或导入桌面。\n`;
      return this.api.create(
        z.string().min(1).parse(p.requestId),
        `${application.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}-操作请求.md`,
        Buffer.from(text),
        { x: 120, y: 120, width: 360, height: 300 },
      );
    }
    if (p.operation === 'connect') {
      const url = parseUrl(p.url),
        name = z.string().trim().min(1).max(120).parse(p.name),
        authorized = z.boolean().default(false).parse(p.privateNetworkAuthorized),
        duration = z.enum(['hour', 'persistent']).default('hour').parse(p.duration),
        all = this.resources();
      if (url.protocol === 'http:' && !authorized)
        fail('NETWORK_HTTP', 'HTTP 地址仅用于你明确授权的本机或私有网络；公开资源请使用 HTTPS。');
      const same = all.find((r) => r.url === url.href);
      if (all.length >= 30 && !same) fail('NETWORK_LIMIT', '最多连接 30 个网络资源。');
      const resource: NetworkResource = {
        ...same,
        id: same?.id ?? randomUUID(),
        name,
        url: url.href,
        privateNetworkAuthorized: authorized,
        createdAt: new Date().toISOString(),
        expiresAt: duration === 'hour' ? new Date(Date.now() + 3600000).toISOString() : null,
      };
      this.api.put('network-resources', [...all.filter((r) => r.id !== resource.id), resource]);
      return resource;
    }
    const id = z.string().parse(p.resourceId);
    if (p.operation === 'revoke') {
      this.api.put(
        'network-resources',
        this.resources().filter((r) => r.id !== id),
      );
      return { revoked: true };
    }
    const resource = this.current(id),
      downloaded = await download(resource),
      current = this.current(id);
    if (current.createdAt !== resource.createdAt)
      fail('NETWORK_CHANGED', '读取期间授权发生变化，请重新读取。');
    const digest = createHash('sha256').update(downloaded.bytes).digest('hex'),
      requestId = z.string().min(1).max(150).parse(p.requestId);
    let object;
    if (resource.objectId) {
      const previous = this.api.object(resource.objectId),
        content = FileContent.parse(previous.content);
      if (content.assetHash !== resource.desktopHash && p.expectedDesktopHash !== content.assetHash)
        fail('NETWORK_CONFLICT', '桌面文件已有修改，请先保存或保留其副本，再明确采用网络版本。');
      object =
        content.assetHash === digest
          ? previous
          : this.api.save(
              requestId,
              previous.id,
              previous.revision,
              downloaded.bytes,
              '从已授权网络资源更新',
              { type: 'object', source: resource.url },
            );
    } else {
      const extension: Record<string, string> = {
        'text/html': 'html',
        'text/plain': 'txt',
        'text/markdown': 'md',
        'application/json': 'json',
        'application/pdf': 'pdf',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/svg+xml': 'svg',
      };
      let fileName =
        basename(decodeURIComponent(new URL(resource.url).pathname))
          .replace(/[\\/:*?"<>|]/g, '_')
          .slice(0, 160) || resource.name;
      if (!/\.[a-z0-9]{1,10}$/i.test(fileName))
        fileName += `.${extension[downloaded.mime] ?? 'bin'}`;
      object = this.api.create(requestId, fileName, downloaded.bytes, {
        x: 100,
        y: 100,
        width: 350,
        height: 300,
      });
    }
    this.api.put(
      'network-resources',
      this.resources().map((r) =>
        r.id === id
          ? {
              ...r,
              objectId: object.id,
              desktopHash: FileContent.parse(object.content).assetHash,
              sourceHash: digest,
              lastReadAt: new Date().toISOString(),
            }
          : r,
      ),
    );
    return object;
  }
}
