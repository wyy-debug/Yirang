import test from 'node:test';
import assert from 'node:assert/strict';
import { decideContinuation } from '../packages/local-runtime/work/completion-policy.js';

test('asking for a missing file or reporting readonly cannot complete or automatically retry work', () => {
  const m: any = { currentRequirementsRevision: 1, state: 'review', requirements: [], artifacts: [] };
  for (const resultText of [
    '我这边没有看到需要修改的文件或具体内容。请把文件放到当前工作目录，或说明他指什么。',
    '当前工作区权限是只读。我无法在这里修改 SVG、生成 PPT 或把文件提交回原对象。',
  ]) {
    const result = decideContinuation(m, { id: 'r', controlled: true, state: 'succeeded', resultText } as any, [], []);
    assert.equal(result.next, 'blocked');
    assert.equal(result.attempts, 0);
    assert.equal(result.missing.length, 1);
  }
  assert.equal(decideContinuation(m, { id: 'r', state: 'succeeded', resultText: '3 乘 7 是 21。' } as any, [], []).next, 'done');
});
