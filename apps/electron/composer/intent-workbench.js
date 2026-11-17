// The canvas entry reflects native Codex threads and collected output batches.
export function createIntentWorkbench({ frame, surface, status }) {
  const batches = new Map();
  let workspaceId = null;
  let loading = false;
  let refreshAgain = false;

  async function publish() {
    if (!workspaceId) return;
    if (loading) { refreshAgain = true; return; }
    loading = true;
    const requestedWorkspaceId = workspaceId;
    try {
      const result = await window.desktop.nativeWork(requestedWorkspaceId);
      if (requestedWorkspaceId !== workspaceId) return;
      for (const batch of result.batches || []) batches.set(batch.id, {
        id: batch.id, threadId: batch.threadId, workspaceId: batch.workspaceId,
        state: batch.state, sourceIds: batch.sourceIds || [],
        files: (batch.files || []).filter((file) => file.objectId).map((file) => ({
          objectId: file.objectId,
          title: file.path?.split(/[\\/]/).pop() || '文件', result: file.result,
        })),
        issues: (batch.issues || []).length,
      });
      frame.contentWindow?.postMessage({
        type: 'yirang:native-work-stream', workspaceId: requestedWorkspaceId,
        records: result.records || [],
        batches: [...batches.values()].filter((batch) =>
          batch.workspaceId === requestedWorkspaceId),
      }, '*');
    } catch (error) {
      if (requestedWorkspaceId === workspaceId) status.textContent = error.message;
    } finally {
      loading = false;
      if (refreshAgain) { refreshAgain = false; void publish(); }
    }
  }

  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'outputs' && payload?.id) {
      batches.set(payload.id, {
        id: payload.id, threadId: payload.threadId,
        workspaceId: payload.workspaceId, state: payload.state,
        sourceIds: payload.sourceIds || [],
        files: (payload.files || []).filter((file) => file.objectId).map((file) => ({
          objectId: file.objectId,
          title: file.path?.split(/[\\/]/).pop() || '文件',
          result: file.result,
        })),
        issues: (payload.issues || []).length,
      });
      void publish();
    }
    if (type === 'native-work-changed' || type === 'background-completed') void publish();
  });

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const message = event.data;
    if (message?.type === 'yirang:native-work-request') {
      workspaceId = message.workspaceId;
      void publish();
      return;
    }
    if (message?.type === 'yirang:ask-desktop' || message?.type === 'yirang:native-work-focus') {
      surface.dock();
      document.getElementById('input').focus();
      return;
    }
    if (message?.type === 'yirang:native-work-locate') {
      const batch = batches.get(message.batchId);
      if (!batch || batch.workspaceId !== workspaceId) return;
      frame.contentWindow?.postMessage({
        type: 'ai-desktop:locate-outputs', workspaceId: batch.workspaceId,
        objectIds: message.objectId
          ? [message.objectId] : batch.files.map((file) => file.objectId),
      }, '*');
      return;
    }
    if (message?.type === 'ai-desktop:locate-outputs' &&
        message.workspaceId === workspaceId)
      frame.contentWindow?.postMessage(message, '*');
  });
  frame.addEventListener('load', () => void publish());
  return { publish };
}
