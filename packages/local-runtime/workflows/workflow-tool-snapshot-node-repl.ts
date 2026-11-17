// MCP tool metadata snapshot for the "node_repl" server: name/description
// pairs captured verbatim on 2026-10-22T13:52:24.827Z. This is not a live
// availability or permission grant.
export const WORKFLOW_TOOL_SNAPSHOT_NODE_REPL = [
  {
    name: 'mcp__node_repl__js',
    description:
      'Use `js` for `node_repl` execution with persistent, redeclarable top-level bindings, `js_reset` to clear bindings, and `js_add_node_module_dir` to add package directories. Execute JavaScript in a persistent `node_repl` with top-level await. Top-level bindings persist until `js_reset` and can be redeclared. Use `const` for stable values and `let` for changing',
    server: 'node_repl',
  },
  {
    name: 'mcp__node_repl__js_add_node_module_dir',
    description:
      'Use `js` for `node_repl` execution with persistent, redeclarable top-level bindings, `js_reset` to clear bindings, and `js_add_node_module_dir` to add package directories. Add an absolute `node_modules` directory for package imports. The directory remains available after `js_reset`. exec tool declaration: ```ts declare const tools: { mcp__node_repl__js_add_n',
    server: 'node_repl',
  },
  {
    name: 'mcp__node_repl__js_reset',
    description:
      'Use `js` for `node_repl` execution with persistent, redeclarable top-level bindings, `js_reset` to clear bindings, and `js_add_node_module_dir` to add package directories. Reset the JavaScript kernel and clear all bindings. exec tool declaration: ```ts declare const tools: { mcp__node_repl__js_reset(args: {}): Promise<CallToolResult>; }; ```',
    server: 'node_repl',
  },
] as const;
