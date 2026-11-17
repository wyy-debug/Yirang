import { createHash } from 'node:crypto';
const hash = (v: unknown) =>
  typeof v === 'string' && v ? createHash('sha256').update(v).digest('hex').slice(0, 16) : null;
const symbol = (v: unknown) =>
  typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(v) ? v : null;
export function diagnosticDetails(
  args: any,
  meta: Record<string, unknown>,
  host: boolean,
  mode: string,
  durationMs: number,
) {
  return {
    source: host
      ? meta['yirang/source'] === 'desktop-ui'
        ? 'desktop-ui'
        : 'desktop-host'
      : 'agent-mcp',
    action: symbol(args?.action),
    operation: symbol(args?.operation ?? args?.command?.operation ?? args?.payload?.operation),
    requestHash: hash(args?.requestId ?? args?.command?.requestId ?? args?.payload?.requestId),
    threadHash: hash(meta.thread_id ?? meta.threadId),
    visibleThreadHash: host ? hash(meta['yirang/visible-thread']) : null,
    workspaceHash: hash(args?.workspaceId),
    threadMode: mode,
    durationMs: Math.max(0, Math.round(durationMs)),
    pid: process.pid,
  };
}
