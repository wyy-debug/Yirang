import { createHash, randomUUID } from 'node:crypto';
import { voiceSelectionSnapshot } from './voice-selection.mjs';


export function createManagedVoice({ request, call, work, state, activate }) {
  async function validateSelection(selection, workspaceId) {
    const ids = selection.sources.map((s) => s.objectId);
    const current = await call('desktop_generated_files', {
      operation: 'references_check',
      objectIds: ids,
    });
    if (current.workspaceId !== workspaceId || ids.some((id) => !current.availableIds.includes(id)))
      throw Error('引用材料已失效，请重新选择');
  }
  async function prepare(cancelled = () => false) {
    const before = state(),
      origin = before.threadId;
    if (!before.ready || before.blocked || !origin) throw Error('桌面尚未就绪，请稍后开启语音');
    if (before.provider !== 'codex') throw Error('连续语音目前需要 Codex 对话');
    if (before.running) throw Error('请等待当前回复结束后开启语音');
    const blocks = structuredClone(before.selection);
    if (blocks.some((b) => b.type === 'image')) throw Error('请先把截图保存为桌面材料，再开启语音');
    const refs = blocks.flatMap((b) =>
      b?._meta?.['ai-desktop/selection'] ? [b._meta['ai-desktop/selection']] : [],
    );
    const sourceIds = [...new Set(refs.flatMap((r) => (r.objects || []).map((o) => o.id)))];
    const current = await call('desktop_generated_files', {
      operation: 'references_check',
      objectIds: sourceIds,
    });
    if (
      refs.some((r) => r.workspaceId !== current.workspaceId) ||
      sourceIds.some((id) => !current.availableIds.includes(id))
    )
      throw Error('引用材料已失效，请重新选择后开启语音');
    const { config } = await request('config/read', { includeLayers: false });
    const servers = config?.mcp_servers;
    if (!servers?.ai_desktop) throw Error('桌面工具尚未就绪，请重连后开启语音');
    // This is a per-thread profile. Never modify the user's global CLI configuration.
    // config/read contains nullable/default fields, not round-trippable TOML.
    // Override only enablement; inherit commands, credentials and timeouts from CLI.
    // The coordinator can register user-requested work through the host gate.
    // Keep shell/file approvals denied; do not approve the MCP server wholesale.
    const overrides = {
      'mcp_servers.ai_desktop.tools.desktop_voice_work.approval_mode': 'approve',
      'features.multi_agent': false,
      'features.apps': false,
      ...Object.fromEntries(
        Object.keys(servers).map((name) => [`mcp_servers.${name}.enabled`, name === 'ai_desktop']),
      ),
    };
    const profile = {
      cwd: before.outputRoot,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config: overrides,
    };
    if (cancelled() || state().threadId !== origin) throw Error('对话已切换，语音尚未开启');
    const result = await request(
      before.local ? 'thread/start' : 'thread/fork',
      before.local
        ? { ...profile, multiAgentMode: 'explicitRequestOnly' }
        : { ...profile, threadId: origin, excludeTurns: true, deferGoalContinuation: true },
    );
    const target = result.thread;
    await request('thread/settings/update', {
      threadId: target.id,
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'never',
      multiAgentMode: 'explicitRequestOnly',
    });
    await call('desktop_work_host', {
      workspaceId: current.workspaceId,
      command: {
        operation: 'voice_bind',
        requestId: randomUUID(),
        payload: { threadId: target.id },
      },
    });
    if (cancelled() || state().threadId !== origin) throw Error('对话已切换，语音尚未开启');
    await activate({ origin, target, blocks, local: before.local, cancelled });
    return {
      managed: true,
      threadId: target.id,
      workspaceId: current.workspaceId,
      sourceIds,
      blocks,
      references: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .slice(0, 18000),
      sourceSnapshots: [...new Set(refs.map((r) => r.snapshotId).filter(Boolean))],
      sources: [
        ...new Map(
          refs
            .flatMap((r) => r.objects || [])
            .map((o) => {
              const source = {
                objectId: o.id,
                revision: o.revision,
                ...(o.selection ? { selection: o.selection } : {}),
              };
              return [JSON.stringify(source), source];
            }),
        ).values(),
      ],
      tasks: new Set(),
      voiceSelection: voiceSelectionSnapshot(blocks, current.workspaceId),
      acceptedRequests: new Map(),
    };
  }
  async function handle(context, p) {
    if (!context.managed || p.threadId !== context.threadId)
      throw Error('语音会话已结束，请重新开启');
    const current = await call('desktop_workspace_overview');
    if (context.stopping) throw Error('语音会话已结束，请重新开启');
    if (current.workspaceId !== context.workspaceId) throw Error('桌面已切换，请重新开启语音');
    if (p.operation === 'list') {
      const snapshot = await work.command({
        workspaceId: context.workspaceId,
        command: { operation: 'list', payload: { compact: true } },
      });
      if (context.stopping) throw Error('语音会话已结束，请重新开启');
      const selected = context.voiceSelection,
        ready = !!context.selectionReady && !!selected;
      return {
        ...snapshot,
        selection: {
          state: ready ? 'ready' : 'pending',
          contextId: ready ? selected.id : null,
          label: selected?.label || '',
          partial: !!selected?.partial,
          readOnly: !!selected?.readOnly,
        },
      };
    }
    if (p.operation === 'detail')
      return work.command({
        workspaceId: context.workspaceId,
        command: { operation: 'detail', taskId: p.taskId },
      });
    if (
      !['submit', 'control'].includes(p.operation) ||
      typeof p.text !== 'string' ||
      !p.text.trim() ||
      p.text.length > 50000 ||
      typeof p.requestId !== 'string' ||
      !p.requestId ||
      p.requestId.length > 160
    )
      throw Error('语音工作要求不完整');
    if (p.taskId && (!Number.isInteger(p.expectedRevision) || p.expectedRevision < 1))
      throw Error('请先读取工作当前版本，再补充或控制工作');
    const requestId =
      'voice-' +
      createHash('sha256')
        .update(context.threadId + ':' + p.requestId)
        .digest('hex');
    const signature = JSON.stringify(p),
      accepted = context.acceptedRequests.get(requestId);
    if (accepted && accepted.signature !== signature)
      throw Error('同一次交办的重试内容发生变化，请使用新的 requestId');
    if (accepted) return accepted.result;
    const selected = context.voiceSelection;
    if (
      p.operation === 'submit' &&
      !p.taskId &&
      (!context.selectionReady || !selected || p.contextId !== selected.id)
    )
      throw Error(
        '选区已变化或尚未同步。请先调用 list 读取最新 selection，确认仍符合用户目标，再用新的 requestId 和 selection.contextId 交办',
      );
    let command;
    if (p.operation === 'control') {
      if (!p.taskId || !['pause', 'resume', 'cancel'].includes(p.action))
        throw Error('请选择要控制的工作');
      command = {
        operation: 'control',
        requestId,
        taskId: p.taskId,
        expectedRevision: p.expectedRevision,
        payload: { action: p.action, reason: p.text },
      };
    } else {
      command = {
        operation: p.taskId ? 'revise' : 'intake',
        requestId,
        taskId: p.taskId,
        expectedRevision: p.expectedRevision,
        payload: {
          text: p.text,
          threadId: context.threadId,
          entry: 'voice',
          provider: 'codex',
          ...(!p.taskId
            ? {
                intent: 'task',
                sources: structuredClone(selected.sources),
                sourceSnapshots: [...selected.sourceSnapshots],
                attachments: selected.blocks
                  .filter((b) => b.type === 'text' && b?._meta?.['ai-desktop/quote'])
                  .map((b) => ({ type: 'text', text: b.text })),
              }
            : {}),
        },
      };
    }
    const result = work.command({ workspaceId: context.workspaceId, command }).then((result) => {
      for (const id of [p.taskId, result.taskId, ...(result.taskIds || [])].filter(Boolean))
        context.tasks.add(id);
      return result;
    });
    context.acceptedRequests.set(requestId, { signature, result });
    try {
      return await result;
    } catch (error) {
      context.acceptedRequests.delete(requestId);
      throw error;
    }
  }
  async function progress(context) {
    if (!context.tasks.size) return [];
    const snapshot = await work.command({
      workspaceId: context.workspaceId,
      command: { operation: 'list', payload: { compact: true } },
    });
    return snapshot.tasks
      .filter((task) => context.tasks.has(task.id))
      .map((task) => ({
        id: task.id,
        title: task.title,
        state: task.management.state,
        revision: task.revision,
        requirementsRevision: task.management.currentRequirementsRevision,
        reason: task.management.reason,
      }));
  }
  return { prepare, handle, progress, validateSelection };
}
