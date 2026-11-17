import test from 'node:test';
import assert from 'node:assert/strict';
import { isCodexAuthenticationFailure } from '../apps/electron/conversation/codex-auth-notice.mjs';

test('401 retry notification requires login without exposing transport details', () => {
  const notification = {
    error: {
      message: 'Reconnecting... 2/5',
      codexErrorInfo: {
        responseStreamDisconnected: { httpStatusCode: 401,
          additionalDetails: '401 Unauthorized: Missing bearer or basic authentication in header' },
      },
      willRetry: true,
    },
  };
  assert.equal(isCodexAuthenticationFailure(notification), true);
  assert.equal(isCodexAuthenticationFailure({ error: { message: 'Reconnecting... 2/5',
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } } }), false);
});
