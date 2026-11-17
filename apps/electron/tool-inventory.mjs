import { t as uiText } from './platform/native-ui-language.mjs';
export function createToolInventory({ request, state }) {
  let cached = null,
    loading = null;
  async function refresh() {
    if (!state().ready) throw Error(uiText('Codex CLI 未连接，无法读取实际工具目录'));
    const identity = state().threadId,
      servers = [],
      seen = new Set();
    let cursor;
    do {
      const result = await request('mcpServerStatus/list', {
        limit: 100,
        ...(identity && !identity.startsWith('local-draft-') ? { threadId: identity } : {}),
        ...(cursor ? { cursor } : {}),
      });
      servers.push(...result.data);
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw Error(uiText('工具目录分页重复，请重连后刷新'));
      seen.add(cursor);
      if (servers.length > 2000) throw Error(uiText('工具目录超过读取上限'));
    } while (cursor);
    const skillsResult = await request('skills/list', {
      cwds: [state().cwd],
      forceReload: true,
    }).catch((error) => ({ data: [], error: error.message }));
    if (identity !== state().threadId) throw Error(uiText('对话已切换，请重新刷新工具目录'));
    const tools = servers.flatMap((server) =>
      Object.entries(server.tools || {}).map(([name, tool]) => ({
        name,
        description: tool.description || tool.title || name,
        server: server.name,
        inputSchema: tool.inputSchema || {},
        available: server.authStatus !== 'notLoggedIn',
        authStatus: server.authStatus,
      })),
    );
    const skills = (skillsResult.data || []).flatMap((entry) =>
      (entry.skills || [])
        .filter((skill) => skill.enabled !== false)
        .map((skill) => ({
          id: skill.path,
          name: skill.name,
          description: skill.description,
          path: skill.path,
        })),
    );
    return (cached = {
      threadId: identity,
      tools,
      skills,
      servers: servers.map((server) => ({
        name: server.name,
        authStatus: server.authStatus,
        tools: Object.keys(server.tools || {}).length,
      })),
      capturedAt: new Date().toISOString(),
      source: uiText('当前 Codex CLI 连接的 MCP 工具与可用 Skill'),
      issues: skillsResult.error
        ? [skillsResult.error]
        : (skillsResult.data || []).flatMap((entry) => entry.errors || []),
    });
  }
  return {
    invalidate() {
      cached = null;
    },
    async get(force = false) {
      if (
        !force &&
        cached &&
        cached.threadId === state().threadId &&
        Date.now() - Date.parse(cached.capturedAt) < 15000
      )
        return cached;
      if (loading) return loading;
      loading = refresh();
      try {
        return await loading;
      } finally {
        loading = null;
      }
    },
  };
}
