import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RepairBudgetStore } from '../packages/local-runtime/work/repair-budget.js';
import { remainingRepairMs } from '../packages/components/work-continuation-config.mjs';

test('upgrades preserve already spent family attempts and grants exactly once', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE settings(workspace TEXT,key TEXT,value TEXT,PRIMARY KEY(workspace,key))');
    const store = new RepairBudgetStore(db);
    const previous = [{ taskId: 'parent', attempts: 1, spentMs: 120000 },
      { taskId: 'child', attempts: 1, spentMs: 40000 }];
    store.initialize('w', 'parent', 1, previous);
    assert.equal(store.reserve('w', 'parent', 1, 'child', 'new'), null);
    assert.equal(store.read('w', 'parent', 1).entries.reduce((n, e) => n + e.spentMs, 0), 160000);
    store.grant('w', 'parent', 1, 'continue');
    new RepairBudgetStore(db).initialize('w', 'parent', 1, previous);
    assert.equal(store.read('w', 'parent', 1).attempts, 4);
    assert.equal(store.read('w', 'parent', 1).entries.length, 2);
    assert.ok(store.reserve('w', 'parent', 1, 'child', 'new'));
  } finally { db.close(); }
});

test('parent and children share attempts and reserved activity across store reloads', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE settings(workspace TEXT,key TEXT,value TEXT,PRIMARY KEY(workspace,key))');
    const first = new RepairBudgetStore(db);
    const a = first.reserve('desktop', 'parent', 1, 'child-a', 'a')!;
    const restored = new RepairBudgetStore(db);
    const b = restored.reserve('desktop', 'parent', 1, 'child-b', 'b')!;
    assert.equal(a.allowanceMs + b.allowanceMs, 600000);
    assert.equal(restored.reserve('desktop', 'parent', 1, 'parent', 'third'), null);
    assert.deepEqual(restored.reserve('desktop', 'parent', 1, 'child-a', 'a'), a);
    restored.settle('desktop', 'parent', 1, 'a', 1000);
    restored.settle('desktop', 'parent', 1, 'a', 0);
    assert.equal(restored.read('desktop', 'parent', 1).entries[0]!.spentMs, 1000);
    assert.equal(restored.reserve('desktop', 'parent', 1, 'parent', 'third'), null);
    assert.ok(restored.reserve('desktop', 'parent', 2, 'parent', 'new-version'));
    restored.grant('desktop', 'parent', 1, 'explicit-resume');
    restored.grant('desktop', 'parent', 1, 'explicit-resume');
    assert.equal(restored.read('desktop', 'parent', 1).attempts, 4);
    assert.ok(restored.reserve('desktop', 'parent', 1, 'parent', 'third'));
    assert.equal(remainingRepairMs({ spentMs: 0, reservation: a }), a.allowanceMs);
  } finally { db.close(); }
});

test('recovery activity consumes the same family time without spending repair rounds', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE settings(workspace TEXT,key TEXT,value TEXT,PRIMARY KEY(workspace,key))');
    const store = new RepairBudgetStore(db);
    const recovery = store.reserveRecovery('w', 'parent', 1, 'child', 'r')!;
    assert.equal(recovery.allowanceMs, 90000);
    store.settle('w', 'parent', 1, 'r', 60000);
    const first = store.reserve('w', 'parent', 1, 'parent', 'a')!;
    const second = store.reserve('w', 'parent', 1, 'child', 'b')!;
    assert.equal(first.allowanceMs + second.allowanceMs, 540000);
    assert.equal(new RepairBudgetStore(db).reserveRecovery('w', 'parent', 1, 'unrelated', 'another'), null);
    const observation = new RepairBudgetStore(db).reserveRecovery('w', 'parent', 1, 'child', 'observe')!;
    assert.equal(observation.allowanceMs, 15000);
    const ledger = store.read('w', 'parent', 1);
    assert.equal(ledger.entries.reduce((sum, entry) => sum + (entry.settled ? entry.spentMs : entry.allowanceMs), 0), 600000);
    assert.deepEqual(store.reserveRecovery('w', 'parent', 1, 'child', 'observe'), observation);
  } finally { db.close(); }
});
