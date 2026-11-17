// A persisted Work Host result is queued to the mapped main Bot conversation.
export function createBotFollowup({ conversations, context, runtime, emit }) {
  return async function followup(payload) {
    if (!payload?.runId || !payload.taskId) return false;
    const conversationState = typeof conversations === 'function' ? conversations() : conversations;
    if (!conversationState) throw Error('主 Bot 会话状态尚未就绪');
    const owner = context.resolve(payload.originThreadId || payload.threadId);
    const state = runtime();
    const primary = conversationState.primaryThread?.(payload.workspaceId);
    if (!primary) throw Error('主 Bot 主会话映射不存在');
    if (!owner || owner !== context.resolve(primary)) return false;
    // The durable event is read by runId when the queue is consumed. Do not
    // feed a status JSON to a model and hope its summary preserves the state.
    const text = `工作「${payload.title}」结果已更新`;
    try {
      await conversationState.enqueue(owner, {
          text,
          blocks: [{ type: 'text', text }],
          workspaceId: payload.workspaceId,
          requestId: 'followup-' + payload.runId,
          route: 'consult',
          consultTaskId: payload.taskId,
          review: state.reviewEnabled,
      });
      return true;
    } catch (error) {
      emit('notice', error.message);
      throw error;
    }
  };
}
