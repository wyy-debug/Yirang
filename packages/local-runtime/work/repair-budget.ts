import type { DatabaseSync } from 'node:sqlite';
import { continuationLimits } from '../../components/work-continuation-config.mjs';

type Entry = { key: string; taskId: string; allowanceMs: number; spentMs: number; settled: boolean; recovery?: boolean };
type Ledger = { attempts: number; activeMs: number; entries: Entry[]; grants: string[] };
type PreviousUsage = { taskId: string; attempts: number; spentMs: number;
  grants?: { attempts: number; activeMs: number }[] };

/** A requirements version owns the budget, including every delegated child.
 * Call within the work command transaction: concurrent completions cannot each
 * spend the same remaining allowance. Reservations survive process restarts. */
export class RepairBudgetStore {
  constructor(private db: DatabaseSync) {}
  private key(root: string, revision: number) { return `work-repair-budget:${root}:${revision}`; }
  has(workspace: string, root: string, revision: number) {
    return !!this.db.prepare('SELECT 1 FROM settings WHERE workspace=? AND key=?')
      .get(workspace, this.key(root, revision));
  }
  read(workspace: string, root: string, revision: number): Ledger {
    const row = this.db.prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(workspace, this.key(root, revision)) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { attempts: continuationLimits.attempts,
      activeMs: continuationLimits.activeMs, entries: [], grants: [] };
  }
  private save(workspace: string, root: string, revision: number, value: Ledger) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(workspace, this.key(root, revision), JSON.stringify(value));
  }
  /** Import pre-ledger counters once, before reserving or granting more work. */
  initialize(workspace: string, root: string, revision: number, previous: PreviousUsage[]) {
    if (this.has(workspace, root, revision)) return;
    const ledger = this.read(workspace, root, revision);
    for (const usage of previous) {
      for (const [index, grant] of (usage.grants || []).entries()) {
        ledger.grants.push(`legacy:${usage.taskId}:${index}`);
        ledger.attempts += grant.attempts;
        ledger.activeMs += grant.activeMs;
      }
      const attempts = Math.max(0, Math.floor(usage.attempts));
      for (let index = 0; index < attempts; index++) {
        ledger.entries.push({ key: `legacy:${usage.taskId}:${index}`, taskId: usage.taskId,
          allowanceMs: 0, spentMs: index === 0 ? Math.max(0, usage.spentMs) : 0, settled: true });
      }
    }
    this.save(workspace, root, revision, ledger);
  }
  reserve(workspace: string, root: string, revision: number, taskId: string, key: string) {
    const ledger = this.read(workspace, root, revision);
    const existing = ledger.entries.find(entry => entry.key === key);
    if (existing) return existing;
    const slots = ledger.attempts - ledger.entries.filter(entry => !entry.recovery).length;
    const remaining = ledger.activeMs - ledger.entries.reduce((sum, entry) =>
      sum + (entry.settled ? entry.spentMs : entry.allowanceMs), 0);
    if (slots <= 0 || remaining <= 0) return null;
    const entry = { key, taskId, allowanceMs: Math.floor(remaining / slots), spentMs: 0, settled: false };
    ledger.entries.push(entry);
    this.save(workspace, root, revision, ledger);
    return entry;
  }
  reserveRecovery(workspace: string, root: string, revision: number, taskId: string, key: string) {
    const ledger = this.read(workspace, root, revision);
    const existing = ledger.entries.find(entry => entry.key === key);
    if (existing) return existing;
    let remaining = ledger.activeMs - ledger.entries.reduce((sum, entry) =>
      sum + (entry.settled ? entry.spentMs : entry.allowanceMs), 0);
    if (remaining <= 0) {
      // The host calls this only for an unknown run. Transfer a bounded slice
      // of this task's stranded reservation, never a sibling's or extra budget.
      const stranded = ledger.entries.find(entry => entry.taskId === taskId &&
        !entry.recovery && !entry.settled && entry.allowanceMs > 0);
      if (!stranded) return null;
      const transfer = Math.min(15000, stranded.allowanceMs);
      stranded.allowanceMs -= transfer;
      remaining += transfer;
    }
    if (remaining <= 0) return null;
    const entry: Entry = { key, taskId, recovery: true, allowanceMs: Math.min(90000, remaining),
      spentMs: 0, settled: false };
    ledger.entries.push(entry);
    this.save(workspace, root, revision, ledger);
    return entry;
  }
  settle(workspace: string, root: string, revision: number, key: string, elapsedMs: number) {
    const ledger = this.read(workspace, root, revision);
    const entry = ledger.entries.find(entry => entry.key === key);
    if (!entry || entry.settled) return;
    // Unknown duration consumes the reservation; it is never treated as free.
    entry.spentMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : entry.allowanceMs;
    entry.settled = true;
    this.save(workspace, root, revision, ledger);
  }
  grant(workspace: string, root: string, revision: number, requestId: string) {
    const ledger = this.read(workspace, root, revision);
    if (ledger.grants.includes(requestId)) return;
    ledger.grants.push(requestId);
    ledger.attempts += continuationLimits.attempts;
    ledger.activeMs += continuationLimits.activeMs;
    this.save(workspace, root, revision, ledger);
  }
}
