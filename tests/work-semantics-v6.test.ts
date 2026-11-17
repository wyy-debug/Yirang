import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticEvidence } from '../packages/local-runtime/work/completion-semantics.js';
import { reviewCriteria } from '../packages/components/work-review-criteria.mjs';

test('each explicit requirement needs its own current multi-file evidence', () => {
  const criteria = reviewCriteria({ goal: '生成 FLOW', constraints: '保留文字\n生成可编辑文件' });
  assert.equal(criteria.length, 3);
  const files: any = [{ objectId: 'a', revision: 2, hash: 'h1', status: 'passed', text: 'FLOW' },
    { objectId: 'b', revision: 1, hash: 'h2', status: 'passed', text: 'Editable FLOW' }];
  const citation = (f: any) => ({ objectId: f.objectId, revision: f.revision, hash: f.hash, quote: 'FLOW' });
  const review: any = { requirementsRevision: 4, criteria: [
    { id: criteria[0]!.id, status: 'passed', reason: '两文件包含 FLOW', evidence: files.map(citation) },
    { id: criteria[1]!.id, status: 'passed', reason: '存在', evidence: [citation(files[0])] },
  ] };
  const inspect = () => semanticEvidence(files, review, 4, criteria).filter(e => e.criterion);
  assert.deepEqual(inspect().map(e => e.status), ['passed', 'passed', 'passed', 'unknown']);
  review.criteria[0].evidence[1].hash = 'old';
  assert.equal(inspect()[0]!.status, 'unknown', 'one stale citation invalidates the whole criterion');
  review.criteria.push(review.criteria[1]);
  assert.equal(inspect()[1]!.status, 'unknown', 'conflicting duplicate conclusions are not accepted');
});

test('semantic completion requires independent evidence tied to the current file and requirements', () => {
  const file: any = { objectId: 'a', revision: 2, hash: 'hash', status: 'passed', text: 'FLOW', code: 'structure_valid' };
  const review = { requirementsRevision: 3, files: [{ objectId: 'a', revision: 2, hash: 'hash', status: 'passed', quote: 'FLOW', reason: '要求的 FLOW 文字存在' }] };
  assert.equal(semanticEvidence([file], review, 3)[0]!.status, 'passed');
  review.files.push({ ...review.files[0], status: 'failed', reason: '冲突的复核结论' });
  assert.equal(semanticEvidence([file], review, 3)[0]!.status, 'unknown');
  review.files.pop();
  assert.equal(semanticEvidence([file], review, 4)[0]!.status, 'unknown');
  assert.equal(semanticEvidence([{ ...file, hash: 'changed' }], review, 3)[0]!.status, 'unknown');
  assert.equal(semanticEvidence([{ ...file, text: 'WRONG' }], review, 3)[0]!.status, 'unknown');
  assert.equal(semanticEvidence([file], { resultText: '完成了' }, 3)[0]!.status, 'unknown');
  review.files[0]!.status = 'failed';
  assert.equal(semanticEvidence([file], review, 3)[0]!.status, 'failed');
});
