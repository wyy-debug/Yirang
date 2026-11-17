// Resume must overwrite temporary consultation restrictions, not inherit them.
// Explicit CLI policy remains authoritative; ordinary desktop work defaults to
// scoped workspace writes with approval for operations outside that scope.
export function executionPermissions(config, overrides = {}) {
  return {
    sandbox: config?.sandbox_mode ?? 'workspace-write',
    approvalPolicy: config?.approval_policy ?? 'on-request',
    approvalsReviewer: config?.approvals_reviewer ?? 'user',
    ...overrides,
  };
}

export function executionTurnPermissions(config, overrides, directory) {
  const policy = executionPermissions(config, overrides);
  let sandboxPolicy = {
    type: 'workspaceWrite',
    writableRoots: [directory],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
  if (policy.sandbox === 'read-only') sandboxPolicy = { type: 'readOnly' };
  if (policy.sandbox === 'danger-full-access') sandboxPolicy = { type: 'dangerFullAccess' };
  return {
    approvalPolicy: policy.approvalPolicy,
    approvalsReviewer: policy.approvalsReviewer,
    sandboxPolicy,
  };
}
