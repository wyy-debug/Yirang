// Codex reports authentication failures inside retry notifications as well as
// terminal errors. Keep these transport details out of the conversation UI.
export function isCodexAuthenticationFailure(value) {
  if (!value || typeof value !== 'object') return false;
  const error = value.error ?? value;
  const info = error.codexErrorInfo ?? value.codexErrorInfo;
  const status = info?.responseStreamDisconnected?.httpStatusCode ??
    info?.httpStatusCode ?? error.httpStatusCode ?? value.httpStatusCode;
  if (Number(status) === 401) return true;
  const detail = String(info?.responseStreamDisconnected?.additionalDetails ??
    error.message ?? value.message ?? '');
  return /401 Unauthorized|Missing bearer or basic authentication/i.test(detail);
}
