import { randomUUID } from 'node:crypto';

// Each confirmed selection is an immutable input to a work request. Never look
// up a mutable mouse selection after a request has already been accepted.
export function voiceSelectionSnapshot(blocks, workspaceId) {
  if (!Array.isArray(blocks) || blocks.some((b) => b.type !== 'text'))
    throw Error('请选中文件或文字后再交给语音');
  const refs = blocks.flatMap((b) =>
    b?._meta?.['ai-desktop/selection'] ? [b._meta['ai-desktop/selection']] : [],
  );
  if (refs.some((r) => r.workspaceId !== workspaceId)) throw Error('选区不属于当前桌面');
  const objects = refs.flatMap((r) => r.objects || []),
    quotes = blocks.flatMap((b) =>
      b?._meta?.['ai-desktop/quote'] ? [b._meta['ai-desktop/quote']] : [],
    );
  const references = blocks.map((b) => b.text).join('\n');
  if (references.length > 100000) throw Error('选区内容过多，请缩小范围');
  const titles = [
    ...new Set([...objects.map((o) => o.title), ...quotes.map((q) => q.title)].filter(Boolean)),
  ];
  return {
    id: randomUUID(),
    blocks: structuredClone(blocks),
    references,
    label: titles.join('、'),
    readOnly: quotes.length > 0,
    partial: objects.some((o) => o.selection) || quotes.length > 0,
    snippet: quotes
      .map((q) => q.text)
      .join(' ')
      .slice(0, 100),
    sourceSnapshots: [...new Set(refs.map((r) => r.snapshotId).filter(Boolean))],
    sources: [
      ...new Map(
        objects.map((o) => {
          const source = {
            objectId: o.id,
            revision: o.revision,
            ...(o.selection ? { selection: o.selection } : {}),
          };
          return [JSON.stringify(source), source];
        }),
      ).values(),
    ],
  };
}

export function voiceSelectionMessage(selection) {
  return JSON.stringify({ type: 'yirang.voice-selection', contextId: selection.id,
    selection, state: 'ready', authorizesExecution: false });
}

export function createVoiceSelection({ request, emit, validate, isCurrent }) {
  function status(s, state, error) {
    const selection = s.voiceSelection;
    emit('voice', {
      method: 'selection-status',
      threadId: s.threadId,
      state,
      contextId: selection?.id,
      label: selection?.label || '',
      partial: !!selection?.partial,
      readOnly: !!selection?.readOnly,
      snippet: selection?.snippet || '',
      error,
    });
  }
  function publish(s) {
    if (s.selectionPublishing) return s.selectionPublishing;
    s.selectionPublishing = (async () => {
      await s.starting?.catch(() => {});
      while (
        isCurrent(s) &&
        s.started &&
        !s.stopping &&
        s.selectionPublished !== s.selectionVersion
      ) {
        const version = s.selectionVersion,
          selection = s.voiceSelection;
        try {
          await request('thread/realtime/appendText', {
            threadId: s.threadId,
            role: 'developer',
            text: selection
              ? voiceSelectionMessage(selection)
              : JSON.stringify({ type: 'yirang.voice-selection', contextId: null,
                state: 'pending', authorizesExecution: false }),
          });
          if (!isCurrent(s) || s.stopping) return;
          s.selectionPublished = version;
          if (version === s.selectionVersion && selection) {
            s.selectionReady = true;
            status(s, 'ready');
          }
        } catch (error) {
          if (isCurrent(s) && version !== s.selectionVersion) continue;
          if (isCurrent(s) && version === s.selectionVersion) {
            s.selectionReady = false;
            status(s, 'error', '选区同步失败，请重新选择');
          }
          return;
        }
      }
    })().finally(() => {
      s.selectionPublishing = null;
    });
    return s.selectionPublishing;
  }
  return {
    status,
    async update(s, p) {
      if (!isCurrent(s) || !s.managed || s.stopping || !s.started || p.threadId !== s.threadId)
        throw Error('语音未连接');
      if (typeof p.id !== 'string' || !p.id || p.id.length > 100) throw Error('选区标识无效');
      if (p.phase === 'pending') {
        s.selectionAttempt = p.id;
        s.voiceSelection = null;
        s.selectionReady = false;
        s.selectionVersion++;
        status(s, 'pending');
        void publish(s);
        return;
      }
      if (s.selectionAttempt !== p.id) return;
      if (p.phase === 'error') {
        status(s, 'error', String(p.error || '无法读取选区，请重新选择').slice(0, 240));
        return;
      }
      if (p.phase !== 'ready') throw Error('选区状态无效');
      try {
        const next = voiceSelectionSnapshot(p.blocks, s.workspaceId);
        await validate(next, s.workspaceId);
        if (!isCurrent(s) || s.stopping || s.selectionAttempt !== p.id) return;
        next.snippet = typeof p.snippet === 'string' ? p.snippet.slice(0, 100) : next.snippet;
        s.voiceSelection = next;
        s.selectionVersion++;
        await publish(s);
      } catch (error) {
        if (isCurrent(s) && s.selectionAttempt === p.id) status(s, 'error', error.message);
        throw error;
      }
    },
  };
}
