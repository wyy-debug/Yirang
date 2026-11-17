// Scope tools to this Bot; never rewrite the user's global CLI/MCP settings.
export async function consultationProfile(request, cwd) {
  const { config } = await request('config/read', { includeLayers: false, cwd });
  if (!config?.mcp_servers?.ai_desktop) throw Error('桌面工具尚未就绪，请重新连接');
  return {
    'features.apps': false,
    'features.multi_agent': false,
    ...Object.fromEntries(
      Object.keys(config.mcp_servers).map((name) => [
        `mcp_servers.${name}.enabled`,
        name === 'ai_desktop',
      ]),
    ),
  };
}
