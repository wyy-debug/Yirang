// Recover only configuration-load failures, before a thread can execute a turn.
// Do not replay turn/start or any tool/action request.
export async function requestWithConfigRecovery(request, method, params = {}) {
  try {
    return await request(method, params);
  } catch (error) {
    if (!['thread/start', 'thread/resume', 'thread/fork'].includes(method)) throw error;
    const match = String(error?.message || '').match(
      /failed to load configuration: invalid type: string "", expected f64 in `mcp_servers\.([\w-]+)\.tool_timeout_sec`/,
    );
    if (!match) throw error;
    const key = `mcp_servers.${match[1]}.tool_timeout_sec`;
    // Never replace an explicit caller choice; retry at most once.
    if (Object.hasOwn(params.config || {}, key)) throw error;
    return request(method, { ...params, config: { ...params.config, [key]: 60 } });
  }
}
