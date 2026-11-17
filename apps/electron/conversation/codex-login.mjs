export function isLoginPortDenied(error) {
  const message = String(error?.message || error || '');
  return /(?:failed to start login server|login server).*(?:\b10013\b|\bEACCES\b|\bWSAEACCES\b|permission denied|access permissions|访问权限不允许)/i.test(message);
}

export async function startCodexLogin(request, openExternal) {
  const result = await request('account/login/start', { type: 'chatgpt' });
  if (result.authUrl) await openExternal(result.authUrl);
  return { loginId: result.loginId, method: 'browser' };
}
