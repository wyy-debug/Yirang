// MCP tool metadata snapshot for the "wdcloud" server: name/description
// pairs captured verbatim on 2026-10-22T13:52:24.827Z. This is not a live
// availability or permission grant.
export const WORKFLOW_TOOL_SNAPSHOT_WDCLOUD = [
  {
    name: 'mcp__wdcloud__wdcloud_agent_get_current_source',
    description:
      'Fetch the Center-approved current source archive for an existing WDCloud Agent update. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_get_current_source(args: { // WDCloud Agent ID, for example agent-maker agentId: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_info',
    description:
      'Read WDCloud Agent details, including direct URL and run metadata. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_info(args: { // WDCloud Agent ID, for example agent-maker agentId: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_invocation_schema',
    description:
      'Read the formal Agent Invocation ABI, including actions, input schemas, defaults, and result mappings. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_invocation_schema(args: { // WDCloud Agent ID, for example agent-maker agentId: string; // Explicit WDCloud Agent release channel. Use tes',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_invocation_status',
    description:
      'Read or wait for an Agent Invocation result, preserving the canonical structuredResult plus text and summary projections. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_invocation_status(args: { // WDCloud Agent invocation ID returned by wdcloud_agent_invoke invocationId: string; // Poll',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_invoke',
    description:
      'Invoke a WDCloud Agent through its formal session/turn Invocation ABI and return an invocation ID for result polling. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_invoke(args: { // Invocation action ID. Omit to use the Agent ABI defaultAction. action?: string; // WDCloud Agent ID, for ',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_list',
    description:
      'List WDCloud Agents visible to the current logged-in user. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_list(args: {}): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_open_url',
    description:
      'Resolve the direct browser URL for one WDCloud Agent. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_open_url(args: { // WDCloud Agent ID, for example agent-maker agentId: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_run',
    description:
      'Create a WDCloud Agent task run with the supplied payload. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_run(args: { // WDCloud Agent ID, for example agent-maker agentId: string; // Task run request body, usually including input and optional title. payload: { [key: string]: unknown; }; ',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_submission_status',
    description:
      'Read Agent Maker/source submission MR, pipeline, job, and optional failed job trace status through Center. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_agent_submission_status(args: { // Include failed job trace tail when available. logs?: boolean; // WDCloud Agent Maker/source submission ta',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_agent_submit_source_archive',
    description:
      'Submit a WDCloud Agent source archive to Center for MR, CI, build, and release evidence. sourceFiles submissions must include expectedFileCount and sourceManifestSha256 from the original files. For large local directories, prefer wdcloud agent submit-source-archive <agent-id> --source-dir <agent-directory> to generate the inventory without rewriting file con',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_auth_poll',
    description:
      'Poll a WDCloud MCP browser login flow. Returns a reusable bearer token after browser approval. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_auth_poll(args: { // Opaque device code returned by wdcloud_auth_start. deviceCode: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_auth_start',
    description:
      'Start a WDCloud MCP browser login flow and return a one-time login URL plus device code. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_auth_start(args: { // Optional client display name shown in audit/debug output. clientName?: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_task_artifacts',
    description:
      'List artifacts produced by a WDCloud task run. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_task_artifacts(args: { // WDCloud task run ID taskRunId: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_task_cancel',
    description:
      'Cancel a WDCloud task run owned or visible to the current user. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_task_cancel(args: { // WDCloud task run ID taskRunId: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_task_logs',
    description:
      'Read execution logs for a WDCloud task run. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_task_logs(args: { // WDCloud task run ID taskRunId: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_task_retry',
    description:
      'Retry a WDCloud task run with the existing run payload. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_task_retry(args: { // WDCloud task run ID taskRunId: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
  {
    name: 'mcp__wdcloud__wdcloud_task_status',
    description:
      'Read the current status and metadata for a WDCloud task run. This tool is part of plugin `WDCloud`. exec tool declaration: ```ts declare const tools: { mcp__wdcloud__wdcloud_task_status(args: { // WDCloud task run ID taskRunId: string; }): Promise<CallToolResult>; }; ```',
    server: 'wdcloud',
  },
] as const;
