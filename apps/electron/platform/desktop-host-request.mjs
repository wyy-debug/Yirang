// Used only by the authenticated main-frame/host path. Agent tool calls retain
// their real thread_id and continue through the read-only/task guards.
export function desktopHostRequest(name, args, visibleThread, source = 'host') {
  return {
    name,
    arguments: args,
    _meta: { 'yirang/source': source, 'yirang/visible-thread': visibleThread || '' },
  };
}
