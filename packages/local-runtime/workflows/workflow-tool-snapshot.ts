/** Public tool metadata captured from this development session. This is not a live availability or permission grant. */
import { WORKFLOW_TOOL_SNAPSHOT_ARTIFACT_SESSION } from './workflow-tool-snapshot-artifact-session.js';
import { WORKFLOW_TOOL_SNAPSHOT_CODE_REVIEW } from './workflow-tool-snapshot-code-review.js';
import { WORKFLOW_TOOL_SNAPSHOT_CODEX_APP } from './workflow-tool-snapshot-codex-app.js';
import { WORKFLOW_TOOL_SNAPSHOT_CODEX_APPS } from './workflow-tool-snapshot-codex-apps.js';
import { WORKFLOW_TOOL_SNAPSHOT_DEEPSEEK_HARNESS } from './workflow-tool-snapshot-deepseek-harness.js';
import { WORKFLOW_TOOL_SNAPSHOT_NODE_REPL } from './workflow-tool-snapshot-node-repl.js';
import { WORKFLOW_TOOL_SNAPSHOT_WDCLOUD } from './workflow-tool-snapshot-wdcloud.js';

export const WORKFLOW_TOOL_SNAPSHOT_AT = '2026-10-22T13:52:24.827Z';
// Per-server snapshot chunks live in workflow-tool-snapshot-<server>.ts; this
// file composes them in capture order so the exported array stays identical.
export const WORKFLOW_TOOL_SNAPSHOT = [
  ...WORKFLOW_TOOL_SNAPSHOT_ARTIFACT_SESSION,
  ...WORKFLOW_TOOL_SNAPSHOT_CODE_REVIEW,
  ...WORKFLOW_TOOL_SNAPSHOT_CODEX_APP,
  ...WORKFLOW_TOOL_SNAPSHOT_CODEX_APPS,
  ...WORKFLOW_TOOL_SNAPSHOT_DEEPSEEK_HARNESS,
  ...WORKFLOW_TOOL_SNAPSHOT_NODE_REPL,
  ...WORKFLOW_TOOL_SNAPSHOT_WDCLOUD,
];
