# Product

## Register

product

## Users

People who use a local AI work desktop to organize their files and work with Codex on selected materials.

## Product Purpose

Yirang combines a visual workspace for local materials with a persistent Codex conversation. Users work from the desktop, bring selected materials into the conversation, and see AI actions and results connected to those same materials. Success means users can collaborate with AI without losing track of which files it is reading or changing.

## Brand Personality

Direct, calm, dependable. The interface should feel like a useful work surface that keeps attention on the user's materials and decisions.

## Anti-references

- Chat surfaces that expose raw tool names, command output, or internal protocol details during ordinary work.
- Pages crowded with repeated labels, diagnostics, or controls unrelated to the current task.
- Interfaces that obscure which files are being read or changed, or that make an AI action look complete when it is still running.

## Design Principles

- Avoid text-stacked interfaces. Establish a visual hierarchy around actual results, one concise state, and the next action. Use real previews, file types, spacing and layout instead of repeated status sentences. Keep frequently used controls visible; move provenance, version metadata and diagnostics to clearly named secondary views.

- Default to Everyday mode: one conversation accepts questions and multiple assignments, with a compact overview of progress, decisions, and results. Both modes expose model, reasoning effort and child model controls. Everyday mode keeps timings compact and expandable; Professional mode opens the detailed timeline by default and reveals scheduling controls. Model preferences apply to newly submitted work; accepted work captures its settings, without changing running work, permissions, or conversation context.
- Delegate useful independent analyses and drafts after requirements are clear. Keep separate task context and bounded concurrency; the responsible agent integrates results and writes final changes. Users should not manage worker conversations.
- Offer a configurable keyboard shortcut (Ctrl+Alt+A by default) to enter AI targeting, then click a file to reveal a compact input beside it with a short contact glow. Normal file clicks retain their existing behavior.
- Keep one current conversation across floating and sidebar presentations. Follow-up questions, draft text, approvals and history use that conversation; switching the targeted file changes its attached material, not its conversation identity.
- Start with the input; expand answers in place after sending. Let users reveal earlier turns or expand to the sidebar when needed. Close the floating view with Escape, its close button, or a click on blank desktop space. Closing clears the active material reference and cancels pending attachment; conversation history and drafts remain. Docking to the sidebar preserves the reference.
- Keep the composer to one action row: attachments, a combined model and reasoning label, permissions, voice and send. Put child model controls inside the same model popover, and mode switching beside the compact work summary. Show only nonzero work counts, reveal search and history on demand, and expire successful acknowledgements while preserving actionable errors.
- Keep frequent file actions directly visible in a stable order. Single selection exposes Ask AI, preview, rename and delete; multiple selection exposes Ask AI, grouping, arrangement and delete. Work remains a direct entry with an actionable attention count. Put reference settings and file history in secondary menus.
- Across surfaces, expose actions needed for the current task directly: search and result review in Work, Ask AI and editing in preview, export in editors, and recent/favorite files in navigation. Keep advanced options accessible in both modes; only diagnostics and history start collapsed. Connection failures and delegated work needing attention must reveal their recovery actions.
- Show a compact, plain-language status while the AI reads or changes files.
- Keep internal execution details out of the main conversation unless the user needs them to decide what to do.
- Put approvals, errors, and results where users can act on them.
- Show saved file previews as work results, with filenames opening the existing preview. Keep task instructions and execution records in details. Keep image input available through drag and drop and paste, without a redundant picker button.
- Let users dismiss one result or clear finished results without deleting files or changing work state. Persist this by desktop and delivery, offer undo, and show new deliveries again. Active work and requests for input stay visible.
- Preserve the connection between a request, the source material, and the saved result.
- A region is a desktop folder with explicit file and drawing ownership. Regions can nest, collapse, open with a breadcrumb path, and retain free, grid or list layouts. Moving a parent moves its descendants; dissolving it preserves its contents at the parent level. These containers organize the app desktop, without relocating linked originals on disk.
- Desktop tabs switch directly through the existing save-and-switch flow. Desktop options provide naming, copying and reversible local archiving. Copies use the backup restore path and do not inherit execution authority.
- Web materials are the primary entry for web work. Browser capability remains available when opening a page, rather than occupying a primary navigation item.

## Accessibility & Inclusion

- Keep all actions keyboard accessible and provide visible focus.
- Announce meaningful progress changes to assistive technology without announcing streaming output on every update.
- Do not rely on color alone for running, waiting, success, or error states; respect reduced-motion preferences.
