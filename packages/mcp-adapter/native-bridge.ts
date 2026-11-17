import { DesktopError } from '../contracts/index.js';
export async function nativeBridge(operation: string, payload: unknown) {
  const endpoint = process.env.AI_DESKTOP_BRIDGE_URL,
    token = process.env.AI_DESKTOP_BRIDGE_TOKEN;
  if (!endpoint || !token)
    throw new DesktopError('ELECTRON_REQUIRED', '此工具需要在独立工作桌面的对话中使用');
  const url = new URL(endpoint);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/desktop')
    throw new DesktopError('BRIDGE_INVALID', '桌面连接信息无效');
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation, payload }),
    signal: AbortSignal.timeout(150000),
  });
  const result = (await response.json()) as { error?: string; result: unknown };
  if (!response.ok || result.error)
    throw new DesktopError('DESKTOP_OPERATION', result.error || '桌面操作失败');
  return result.result as any;
}
