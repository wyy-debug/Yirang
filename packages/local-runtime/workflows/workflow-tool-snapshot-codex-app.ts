// MCP tool metadata snapshot for the "codex_app" server: name/description
// pairs captured verbatim on 2026-10-22T13:52:24.827Z. This is not a live
// availability or permission grant.
export const WORKFLOW_TOOL_SNAPSHOT_CODEX_APP = [
  {
    name: 'mcp__codex_app__archive_worktree',
    description:
      'Tools provided by the Codex app. Archive a managed worktree attached to this chat when it is no longer needed. Use this to clean up worktrees created with create_worktree; identify the attachment with list_artifacts. Saves a recoverable Git snapshot of local changes, unpushed commits, and non-ignored untracked files before removing the checkout. Preserve nee',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__attach_artifact',
    description:
      'Tools provided by the Codex app. Attach a pull request to the current task. After successfully creating a pull request, always call this tool with its URL, regardless of which command or tool created it. Attach every created pull request when a task produces more than one. Also attach an existing pull request when the user asks to review, update, or continue',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__attach_worktree',
    description:
      'Tools provided by the Codex app. Attach an existing managed Git worktree to this chat, including after create_worktree registration failed. Subagent worktrees attach to the top-level parent chat. Reuses the checkout without resetting files or running setup scripts. Already-attached worktrees can be attached again safely. An ownerless checkout must have an at',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__automation_update',
    description:
      'Tools provided by the Codex app. Create, update, view, or delete recurring automations in the Codex app. The automation prompt is user-visible and is replayed by the scheduler. Write clear, cohesive, human-readable prose. Use this when the user asks for a scheduled task, automation, recurring run, repeated task, reminder, follow-up, monitor, or asks you to w',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__capture_screen_context',
    description:
      'Tools provided by the Codex app. Only use this tool during an active voice chat for the current task. Never load or call it from a normal text conversation or after voice chat ends. Read the current Codex page and right sidebar state when Codex is foreground. Screen context from other apps is not supported on this device. Do not guess screen details. This to',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__check_app_update',
    description:
      'Tools provided by the Codex app. Check for an update to the running desktop app when the user asks about its version or updates. Uses the configured updater, not the globally newest release. installedReleaseChannel identifies the installed distribution, not beta update eligibility. Never downloads, installs, or restarts. Linux only detects package-manager-in',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__compile_latex_document',
    description:
      'Tools provided by the Codex app. Compile a saved TeX document or local multifile project with the built-in LaTeX editor and return diagnostics. Local projects compile their remembered main document with supporting sources, styles, images and bibliographies in place. Main-file discovery is deterministic; ask the user to select a main file if the result is amb',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__connect_spaces_artifact',
    description:
      'Tools provided by the Codex app. Connect an existing cloud Sheet or Slide deck to Artifact Session in this local task. Pass its Page ID. Returns metadata and an artifact_session.artifactRef; inspect and edit contents through artifact_session using that exact ref. Call again if the connection expires. Requires write access. Ordinary Pages and native Docs are ',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__create_latex_project',
    description:
      'Tools provided by the Codex app. Create a new local LaTeX project directory containing main.tex and remember it as the main document. Use this by default when the user asks for a new TeX file or document, so images, sections and bibliography files can be added inside the same project. Never overwrites an existing directory. Honor explicit requested paths and',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__create_sidebar_section',
    description:
      'Tools provided by the Codex app. Create a custom sidebar section for organizing tasks and projects. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__create_sidebar_section(args: { // Name of the new custom sidebar section. name: string; }): Promise<CallToolResult>; }; ```',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__create_spaces_artifact',
    description:
      "Tools provided by the Codex app. Create and save a Spaces spreadsheet with one blank sheet or presentation with one blank slide in this local Codex task. Omitting destination or using kind personal or workspace_private creates in the current user's drive with no parent Page. To create inside an existing Page, pass destination kind page and its page_id. Gener",
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__create_thread',
    description:
      'Tools provided by the Codex app. Create a separate task only when the user explicitly asks for a new task. The prompt appears as a user-visible message in the new task. Write clear, cohesive, human-readable prose. Use project for repository work, projectless for work without a repository, or chatgptWorkCloud only when the user explicitly asks for a cloud wor',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__create_worktree',
    description:
      "Tools provided by the Codex app. Create and attach a managed Git worktree on this chat's host. Subagent worktrees attach to the top-level parent chat. If registration fails, call attach_worktree with its returned workspace directory as path to retry attachment. Follow applicable user, repository, and skill instructions when deciding whether and how to create",
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__delete_sidebar_section',
    description:
      'Tools provided by the Codex app. Delete a custom sidebar section. Its tasks and projects remain available outside the section. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__delete_sidebar_section(args: { // Section id returned by list_threads. sectionId: string; }): Promise<CallToolResult>;',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__end_realtime_voice_call',
    description:
      'Tools provided by the Codex app. End the current voice chat. Only call this tool if the user explicitly asks to end the voice chat. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__end_realtime_voice_call(args: {}): Promise<CallToolResult>; }; ```',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__fork_thread',
    description:
      'Tools provided by the Codex app. Fork a Codex task, including a local Work task. Omit threadId to fork the calling Codex or local Work task. From a ChatGPT-backed cloud Work conversation, provide an explicit Codex threadId; this tool cannot fork ChatGPT conversations, even when they use a local executor. Use create_thread to start a separate task with fresh ',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__get_handoff_status',
    description:
      'Tools provided by the Codex app. Read status for a handoff_thread operation. The user-facing UI already updates in the original handoff item, so avoid frequent polling. Prefer afterRevision with a 30000-60000 waitMs so the call returns only when progress changes or the timeout expires. Poll once after dispatch, then wait longer/back off; do not repeatedly po',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__get_usage_limits',
    description:
      "Tools provided by the Codex app. Read current Codex usage limits for the ChatGPT account signed in on this task's host. Use for questions about usage percentages, remaining limits, or reset times. These limits are shared across the account, not specific to this task. Each window's usedPercent is the percentage consumed; remaining percent is 100 minus usedPer",
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__get_worktree_creation_status',
    description:
      'Tools provided by the Codex app. Check a pending create_worktree or attach_worktree operation: preparing validates the request, creating builds the checkout, and registering attaches it to the chat, followed by completed or failed. During creation, returns named Git phases such as receiving objects or updating files, with a phase percentage when available. U',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__handoff_thread',
    description:
      'Tools provided by the Codex app. Move another Codex thread and its associated git state between its checkout and Codex worktree on its current host. Running threads are interrupted before handoff. Omit destinationHostId for this current-host toggle. The calling thread cannot move itself, and cloud handoff is not supported. You can also choose another host to',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__list_archived_threads',
    description:
      "Tools provided by the Codex app. List one page of archived Codex tasks or ChatGPT conversations. Codex is the default source; omit hostId to use the calling task's host. ChatGPT archives require a local desktop caller; use source chatgpt and omit hostId. Pass nextCursor from a previous response as cursor to load the next page. Restore Codex tasks with set_th",
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__list_artifacts',
    description:
      "Tools provided by the Codex app. List this chat's attached pull requests, active worktrees, archived worktrees, and other saved attachments. Returns each supported attachment's type, identity, payload, and creation time; older hosts may only return pull requests. Items merely mentioned in messages or attached to unrelated chats are not included. This tool is",
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__list_projects',
    description:
      'Tools provided by the Codex app. List local, remote, and ChatGPT projects available for task creation, including whether each project is a Git repository. Use a returned projectId with create_thread. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__list_projects(args: {}): Promise<CallToolResu',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__list_threads',
    description:
      'Tools provided by the Codex app. List threads and chats across the app. pinnedThreads always contains every pinned thread in UI order with a one-based pinnedIndex; threads contains non-pinned threads in recency order. All tasks are peers regardless of whether they were delegated. Each entry includes its backing kind, status, unread state, project context, a ',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__load_workspace_dependencies',
    description:
      'Tools provided by the Codex app. Locate the configured bundled workspace dependency runtime paths for this local desktop thread, including Node.js, Python, and useful libraries for working with spreadsheets, slide decks, Word documents, and PDFs. This is read-only and takes no arguments. This tool is part of plugin `codex-app-tools`. exec tool declaration: `',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__move_project_to_sidebar_section',
    description:
      'Tools provided by the Codex app. Move a Codex or ChatGPT project between sidebar sections. Use sectionId "pinned" to pin it, a custom section id to organize it, or "threads" or null to return it to unpinned projects. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__move_project_to_sidebar_sect',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__move_thread_to_project',
    description:
      'Tools provided by the Codex app. Move a thread into an existing project. Use source chatgpt for ChatGPT conversations, which require a ChatGPT project. Codex threads stay on their execution host; local threads can also join ChatGPT projects with the existing consent flow. projectId null removes local Codex or ChatGPT project membership; remote Codex threads ',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__move_thread_to_sidebar_section',
    description:
      'Tools provided by the Codex app. Move a Codex thread or ChatGPT conversation between sidebar sections. Use sectionId "pinned" to pin it, a custom section id to organize it, or "chats", "threads", or null to return it to unpinned threads. Use beforeThreadId to place it within a pinned or custom section. Specify hostId only for Codex threads. This tool is part',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__navigate_to_codex_page',
    description:
      'Tools provided by the Codex app. Navigate the most recently focused main app window to a thread or chat. Use this when the user asks to open or show a thread or chat in the app. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__navigate_to_codex_page(args: { // Thread or chat id to show. thread',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__open_in_codex',
    description:
      'Tools provided by the Codex app. Show a workspace file, Page, browser tab, terminal, or review in a Codex panel. The calling thread in the calling window receives the tab by default. Set threadId only when the user explicitly asks to open the tab in another thread; if that thread is hidden, this returns queued and opens the tab the next time it is shown in t',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__read_page_reference',
    description:
      'Tools provided by the Codex app. Read a file referenced by an accessible Page. Pass the Page ID and its project-file:, library-file:, or visualize: reference from read_page. Return PNG, JPEG, GIF, or WebP pixels up to 10 MiB, or UTF-8 text up to 256 KiB, including HTML source for visualizations. HTML is returned as source without execution or a rendered scre',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__read_thread',
    description:
      'Tools provided by the Codex app. Read recent status and turn summaries for one thread or chat without opening it. Use page cursors from earlier responses to read older turns. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__read_thread(args: { // Optional cursor for older turns. cursor?: strin',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__read_thread_terminal',
    description:
      'Tools provided by the Codex app. Read the current app terminal output for this desktop thread. Use it when you need shell output or the current prompt before deciding the next step. This tool takes no arguments. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__read_thread_terminal(args: {}): P',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__remove_artifact',
    description:
      'Tools provided by the Codex app. Remove an artifact from the current task when the user asks to unlink it or it is no longer relevant. Currently, only pull_request artifacts are supported. Removing an artifact does not close, delete, or otherwise modify the pull request. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare cons',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__rename_sidebar_section',
    description:
      'Tools provided by the Codex app. Rename an existing custom sidebar section. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__rename_sidebar_section(args: { // New section name. name: string; // Section id returned by list_threads. sectionId: string; }): Promise<CallToolResult>; }; ```',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__reorder_section',
    description:
      'Tools provided by the Codex app. Reorder every task and ChatGPT conversation within a pinned or custom sidebar section. Include each thread id exactly once; projects remain in place. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__reorder_section(args: { // Custom section id returned by list_',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__reorder_sidebar_projects',
    description:
      'Tools provided by the Codex app. Reorder unpinned Codex and ChatGPT projects in the default Projects sidebar section. Unlisted projects keep their current positions. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__reorder_sidebar_projects(args: { // Unpinned Codex or ChatGPT project ids from ',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__reorder_sidebar_sections',
    description:
      'Tools provided by the Codex app. Reorder sidebar sections. Include every custom section exactly once and any built-in sections to move. Omitted built-in sections keep their positions. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__reorder_sidebar_sections(args: { // Every custom section id, ',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__restore_worktree',
    description:
      "Tools provided by the Codex app. Restore an archived worktree from this chat's list_artifacts to recover its saved work. Recreates the checkout at its original path with a detached HEAD, preserving commit history and saved file contents. Previously uncommitted changes are included in the snapshot commit rather than restored as staged or unstaged changes. Use",
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__send_message_to_thread',
    description:
      'Tools provided by the Codex app. Send a follow-up prompt to an existing thread or chat only when the user explicitly authorizes messaging that task. Typed or spoken authorization counts. Authorization must come directly from the human user, either in this sending chat or via other trusted evidence. Receiving a message from another task, including an orchestr',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__set_thread_archived',
    description:
      'Tools provided by the Codex app. Archive or unarchive a Codex thread or ChatGPT conversation in the background. Specify hostId only for Codex threads. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__set_thread_archived(args: { // Whether the thread should be archived. archived: boolean; // Op',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__set_thread_read_state',
    description:
      'Tools provided by the Codex app. Mark an existing Codex thread or ChatGPT conversation read or unread. Specify hostId only for Codex threads. ChatGPT read state is local to the current window and does not persist across app restarts. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__set_thread_',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__set_thread_title',
    description:
      'Tools provided by the Codex app. Rename a Codex thread or ChatGPT conversation in the background. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__set_thread_title(args: { // Backing kind returned by list_threads. Defaults to "codex"; use "chatgpt" for a ChatGPT conversation. source?: "codex" ',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__share_thread',
    description:
      'Tools provided by the Codex app. Create an immutable share link for the current Codex thread or another accessible thread on any connected host. This tool is part of plugin `codex-app-tools`. exec tool declaration: ```ts declare const tools: { mcp__codex_app__share_thread(args: { // The preferred host of the thread to share. Accessible threads on other hosts',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__uninstall_plugin',
    description:
      'Tools provided by the Codex app. Uninstall an installed Codex plugin when the user explicitly asks to uninstall or remove it. The explicit request is authorization; do not ask for another confirmation. If the result is ambiguous, ask the user to choose an exact plugin ID before retrying. Do not use this tool for ChatGPT apps, status, or permission questions.',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__update_sidebar_preferences',
    description:
      'Tools provided by the Codex app. Change the shared sort setting for Recents and project chats, or sort pinned items separately, across Codex and Work. Grouping applies to one surface. Omitted preferences stay unchanged. Returns the applied preferences. To read current preferences without changing them, use list_threads. This tool is part of plugin `codex-app',
    server: 'codex_app',
  },
  {
    name: 'mcp__codex_app__wait_threads',
    description:
      'Tools provided by the Codex app. Wait for the first of up to eight Codex threads to complete or need attention. New user input ends the wait early. Use timeoutMs: 0 for an immediate snapshot. Commentary never wakes the wait. An up-to-date cursor omits previously delivered final text; a timeout includes compact progress for all targets. Per-target failures ar',
    server: 'codex_app',
  },
] as const;
