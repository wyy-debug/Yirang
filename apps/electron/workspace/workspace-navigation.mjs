// Workspace selection is global to the desktop. Defer model requests until all
// conversations have finished collecting files, then let the panel flush edits.
export function createWorkspaceNavigation({ busy, emit }) {
  let pending = null,
    timer = null,
    timeout = null;
  const receipts = new Map();
  function notify(value) {
    emit('workspace-navigation', value);
  }
  function finish(error) {
    if (!pending) return;
    clearTimeout(timer);
    clearTimeout(timeout);
    timer = null;
    timeout = null;
    const result = { ...pending, state: error ? 'failed' : 'opened', ...(error ? { error } : {}) };
    receipts.set(pending.requestId, result);
    pending = null;
    notify(result);
  }
  function drain() {
    timer = null;
    if (!pending || pending.state === 'opening') return;
    if (busy()) {
      timer = setTimeout(drain, 750);
      timer.unref?.();
      return;
    }
    pending = { ...pending, state: 'opening' };
    receipts.set(pending.requestId, pending);
    notify(pending);
    emit('workspace-open', pending);
    timeout = setTimeout(() => finish('桌面切换未确认。新桌面已保留，请在桌面列表中打开。'), 60000);
    timeout.unref?.();
  }
  return {
    opening: () => pending?.state === 'opening',
    request(value) {
      const prior = receipts.get(value.requestId);
      if (prior) {
        if (prior.workspaceId !== value.workspaceId || prior.targetId !== value.targetId)
          throw Error('请求 ID 已用于另一项桌面切换');
        return prior;
      }
      if (pending) throw Error('已有桌面等待打开，请等待当前切换完成');
      pending = {
        requestId: value.requestId,
        workspaceId: value.workspaceId,
        targetId: value.targetId,
        name: value.name,
        state: 'waiting_tasks',
      };
      receipts.set(value.requestId, pending);
      if (receipts.size > 64) receipts.delete(receipts.keys().next().value);
      notify(pending);
      timer = setTimeout(drain, 0);
      return pending;
    },
    settle(value) {
      if (pending?.state === 'opening' && value.requestId === pending.requestId)
        finish(value.error || undefined);
    },
    close() {
      clearTimeout(timer);
      clearTimeout(timeout);
      pending = null;
    },
  };
}
