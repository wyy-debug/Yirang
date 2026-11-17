import test from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterMs, retryDelayMs, canRetrySubmission } from '../packages/components/work-retry.mjs';

test('Retry-After supports seconds and HTTP dates without shortening backoff', () => {
  assert.equal(retryAfterMs({ headers: { 'Retry-After': '120' } }), 120000);
  assert.equal(retryAfterMs({ response: { headers: new Headers({ 'retry-after': 'Thu, 05 Nov 2026 12:00:10 GMT' }) } }, Date.parse('2026-11-05T12:00:00Z')), 10000);
  assert.equal(retryDelayMs(3000, 1000), 3000);
  assert.equal(retryDelayMs(1000, 120000), 120000);
  for (const value of ['', '-1', '1.5', 'Infinity', 'broken'])
    assert.equal(retryAfterMs({ headers: { 'retry-after': value } }), undefined);
  assert.equal(retryAfterMs({ retryAfterMs: NaN }), undefined);
  assert.equal(retryAfterMs({ retryAfterMs: 4000 }), 4000);
});
test('retryability requires explicit non-acceptance, never just a transient status', () => {
  assert.equal(canRetrySubmission({ status: 503, message: 'timeout' }), false);
  assert.equal(canRetrySubmission({ rpcRejected: true, status: 503 }), true);
  assert.equal(canRetrySubmission({ rpcRejected: true, status: 403 }), false);
  assert.equal(canRetrySubmission({ beforeSend: true, message: 'ECONNRESET' }), true);
});
