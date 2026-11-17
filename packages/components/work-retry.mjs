// Retry-After is a lower bound, never a reason to replay an uncertain request.
export function retryAfterMs(error, now = Date.now()) {
  const explicit = error?.retryAfterMs;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const headers = error?.headers ?? error?.response?.headers;
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  // Avoid Date.parse interpreting negative numbers as calendar dates.
  if (!/[A-Za-z]/.test(raw)) return undefined;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function retryDelayMs(backoff, requested) {
  return Math.max(backoff, typeof requested === 'number' && Number.isFinite(requested) && requested >= 0 ? requested : 0);
}

export function canRetrySubmission(error) {
  if (error?.beforeSend) return /ECONN|temporar|unavailable|timeout|断开/i.test(error.message || '');
  // Explicit rejection proves this request was not accepted. A timeout does not.
  return error?.rpcRejected === true && [429, 502, 503, 504].includes(error.status);
}
