import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityClock } from '../apps/electron/work/activity-clock.mjs';

test('activity excludes user waiting and offline time across host segments', () => {
  let now = 0;
  const before = createActivityClock(() => now);
  now = 1000;
  assert.equal(before.sample(), 1000);
  before.waiting(true);
  now += 3600000;
  before.waiting(false);
  now += 500;
  assert.equal(before.sample(), 1500);
  const persisted = before.sample();
  now += 86400000;
  const after = createActivityClock(() => now);
  now += 1000;
  assert.equal(persisted + after.sample(), 2500);
});
