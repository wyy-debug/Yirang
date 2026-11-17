import { createHash } from 'node:crypto';

export const remoteProtocol = 1;
export const remoteReadOperations = new Set([
  'state_snapshot',
  'runs_get',
  'runs_poll',
  'logs_read',
  'outputs_list',
  'output_read',
  'schedules_list',
]);
export const remoteControlOperations = new Set([
  'start',
  'stop',
  'action_call',
  'cancel',
  'schedules_update',
  'notifications_update',
]);
export const remoteContract = {
  protocol: remoteProtocol,
  runtime: 'Remote service; desktop is a client',
  transport: 'HTTPS commands and one SSE snapshot stream per connection',
  state:
    'Use yirang.widget.watchState or yirang.state.get. These read shared cached state and never create tasks.',
  widgets:
    'Declare manifest.widgets with separate HTML entry and sizes [1,2,4,8]. Widgets can be placed on canvas or dashboard.',
  lifecycle:
    'Closing the UI or disconnecting never stops server tasks. Only explicit stop/cancel does.',
  configuration:
    'Business credentials, source files and schedules live on the service host. Client stores only an encrypted connection token.',
  ai: 'AI can read public state and task results. Remote action execution requires both server control access and per-instance AI authorization in Yirang.',
  outputs: 'Only registered, hash-checked outputs can be downloaded into desktop files.',
  deployment: 'Run yirang-service.mjs with Node.js 24 on the service host. No Electron required.',
};
export function mappedInstanceId(connectionId, id) {
  const h = createHash('sha256')
    .update(connectionId + ':' + id)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function serviceEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw Error('服务地址不能包含用户名、密码或查询参数');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw Error('远程连接需要 HTTPS；HTTP 仅允许本机或 SSH 隧道的回环地址');
  return url.href.replace(/\/+$/, '');
}
export function assetPath(path) {
  return (
    typeof path === 'string' &&
    path.length < 1024 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((p) => !p || p === '..' || p === '.') &&
    !/[\0?#:]/.test(path)
  );
}
