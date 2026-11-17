import { t as uiText } from '../platform/native-ui-language.mjs';
export function createPermissions({ request, preferences, state, emit }) {
  const sessions = new Map(),
    reviews = new Map();
  function observe(id, value) {
    if (!id) return;
    const sandbox = value.sandboxPolicy ?? value.sandbox,
      previous = sessions.get(id) || {};
    sessions.set(id, {
      ...previous,
      ...(value.approvalPolicy !== undefined ? { approvalPolicy: value.approvalPolicy } : {}),
      ...(value.approvalsReviewer !== undefined
        ? { approvalsReviewer: value.approvalsReviewer }
        : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(value.cwd ? { cwd: value.cwd } : {}),
      ...(value.activePermissionProfile !== undefined
        ? { profile: value.activePermissionProfile?.id ?? null }
        : {}),
    });
    if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
    if (state().threadId === id) emit('permissions', { threadId: id, effective: sessions.get(id) });
  }
  async function read({ refresh = false } = {}) {
    const { threadId, ready } = state();
    if (!ready || !threadId) throw Error(uiText('请先连接 Codex 并打开对话'));
    const draft = threadId.startsWith('local-draft-');
    let readError = null;
    if (!draft && (refresh || typeof sessions.get(threadId)?.approvalsReviewer !== 'string')) {
      try {
        const result = await request('thread/resume', { threadId, excludeTurns: true });
        observe(threadId, result);
      } catch (error) {
        readError = error.message;
      }
    }
    const effective = sessions.get(threadId) || {},
      [configuration, requirements] = await Promise.allSettled([
        request('config/read', {
          includeLayers: false,
          ...(effective.cwd ? { cwd: effective.cwd } : {}),
        }),
        request('configRequirements/read', {}),
      ]);
    if (state().threadId !== threadId) throw Error(uiText('对话已切换，请重新打开权限设置'));
    const config = configuration.status === 'fulfilled' ? configuration.value.config : null,
      managed = requirements.status === 'fulfilled' ? requirements.value.requirements : null;
    return {
      threadId,
      effective,
      draft,
      readError,
      status: draft
        ? 'draft'
        : readError
          ? 'error'
          : typeof effective.approvalsReviewer === 'string'
            ? 'ready'
            : 'unknown',
      mode: preferences().get().approvalModes?.[threadId] ?? 'auto_review',
      supported: true,
      defaults: config
        ? {
            approvalsReviewer: config.approvals_reviewer ?? 'user',
            approvalPolicy: config.approval_policy,
          }
        : null,
      allowedReviewers: managed?.allowedApprovalsReviewers ?? null,
      allowedPolicies: managed?.allowedApprovalPolicies ?? null,
      requirementsKnown: requirements.status === 'fulfilled',
      reviews: [...reviews.values()].filter((item) => item.threadId === threadId).slice(-50),
    };
  }
  async function set(payload) {
    if (!['inherit', 'user', 'auto_review'].includes(payload.mode))
      throw Error(uiText('审批方式不正确'));
    const current = await read();
    if (payload.threadId !== current.threadId) throw Error(uiText('对话已切换，权限未修改'));
    const values =
      payload.mode === 'inherit'
        ? current.defaults
        : { approvalsReviewer: payload.mode, approvalPolicy: 'on-request' };
    if (
      !(current.draft && payload.mode === 'inherit') &&
      (!values?.approvalPolicy || !values.approvalsReviewer)
    )
      throw Error(uiText('CLI 默认审批设置未能读取，权限未修改'));
    if (
      values &&
      current.allowedReviewers &&
      !current.allowedReviewers.includes(values.approvalsReviewer)
    )
      throw Error(uiText('组织策略不允许此审批方式'));
    if (
      values &&
      current.allowedPolicies &&
      !current.allowedPolicies.some(
        (policy) => JSON.stringify(policy) === JSON.stringify(values.approvalPolicy),
      )
    )
      throw Error(uiText('组织策略不允许此审批策略'));
    if (!current.draft)
      await request('thread/settings/update', { threadId: current.threadId, ...values });
    // Successful CLI acknowledgement applies only these two fields. The next
    // settings notification remains authoritative for the full sandbox profile.
    if (!current.draft) observe(current.threadId, values);
    const modes = { ...preferences().get().approvalModes, [current.threadId]: payload.mode };
    while (Object.keys(modes).length > 200) delete modes[Object.keys(modes)[0]];
    try {
      await preferences().set({ approvalModes: modes });
    } catch (error) {
      if (current.draft) throw error;
      emit('notice', uiText('CLI 已应用审批设置，但界面偏好保存失败。'));
    }
    return read();
  }
  function notification(method, params) {
    if (method === 'thread/settings/updated') {
      observe(params.threadId, params.threadSettings || {});
      return true;
    }
    if (
      ![
        'item/autoApprovalReview/started',
        'item/autoApprovalReview/completed',
        'autoApprovalReview/strictReviewRequired',
        'guardianWarning',
      ].includes(method)
    )
      return false;
    const action = params.action || {},
      review = params.review || {},
      id = params.reviewId || `${params.turnId || params.threadId}:${method}`;
    const descriptions = {
      command: action.command,
      execve: action.program,
      writeStdin: uiText('向运行中的进程写入输入'),
      applyPatch: (action.files || []).slice(0, 8).join('、'),
      networkAccess: action.host || action.target,
      mcpToolCall: [action.server, action.toolName].filter(Boolean).join(' / '),
      requestPermissions: action.reason,
    };
    const value = {
      id,
      threadId: params.threadId,
      turnId: params.turnId,
      status:
        method === 'guardianWarning'
          ? 'warning'
          : method === 'autoApprovalReview/strictReviewRequired'
            ? 'strict'
            : review.status || 'inProgress',
      risk: review.riskLevel || null,
      action: String(descriptions[action.type] || uiText('操作权限审批')).slice(0, 1200),
      reason: String(params.message || review.rationale || '').slice(0, 6000),
      at: params.completedAtMs || params.startedAtMs || Date.now(),
    };
    reviews.set(id, value);
    while (reviews.size > 200) reviews.delete(reviews.keys().next().value);
    if (state().threadId === params.threadId) emit('auto-review', value);
    return true;
  }
  function startOptions(id) {
    const mode = preferences().get().approvalModes?.[id] ?? 'auto_review';
    return ['user', 'auto_review'].includes(mode)
      ? { approvalsReviewer: mode, approvalPolicy: 'on-request' }
      : {};
  }
  async function migrate(from, to) {
    const modes = { ...preferences().get().approvalModes };
    if (!Object.hasOwn(modes, from)) return;
    modes[to] = modes[from];
    delete modes[from];
    await preferences().set({ approvalModes: modes });
  }
  return {
    observe,
    notification,
    read,
    set,
    startOptions,
    migrate,
    reset() {
      sessions.clear();
      reviews.clear();
    },
  };
}
