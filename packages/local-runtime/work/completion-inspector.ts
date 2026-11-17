import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompletionEvidence } from './completion-policy.js';

type File = { objectId: string; revision: number; hash: string; name: string; editable: boolean };
const cache = new Map<string, CompletionEvidence>();
let active = 0;
const waiters: (() => void)[] = [];
async function slot() {
  if (active >= 2) await new Promise<void>(resolve => waiters.push(resolve));
  else active++;
}
function release() { const next = waiters.shift(); if (next) next(); else active--; }
export async function inspectCompletion(directory: string, files: File[]): Promise<CompletionEvidence[]> {
  const signatures = new Map<string, string>();
  for (const f of files) {
    if (!/^[a-f0-9]{64}$/.test(f.hash)) continue;
    try {
      const s = await stat(join(directory, 'assets', f.hash));
      signatures.set(f.hash, `${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
    } catch { /* A removed asset must never inherit an earlier successful check. */ }
  }
  const key = (f: File) => JSON.stringify([directory, f.hash, f.name, f.editable, signatures.get(f.hash) || 'unavailable']);
  const hits = new Map(files.filter(f => cache.has(key(f))).map(f => [key(f), cache.get(key(f))!]));
  const pending = files.filter(f => !hits.has(key(f)));
  let checked: CompletionEvidence[] = [];
  if (pending.length) {
    await slot();
    try { checked = await inspectFiles(directory, pending); }
    finally { release(); }
    checked.forEach((e, i) => {
      if (e.status === 'unknown') return;
      cache.set(key(pending[i]!), e);
      while (cache.size > 256) cache.delete(cache.keys().next().value!);
    });
  }
  return files.map(f => ({ ...(hits.get(key(f)) || checked.find(e => e.objectId === f.objectId && e.revision === f.revision)!), objectId: f.objectId, revision: f.revision }));
}
function inspectFiles(directory: string, files: File[]): Promise<CompletionEvidence[]> {
  if (!files.length) return Promise.resolve([]);
  const bundled = new URL('./completion-worker.mjs', import.meta.url);
  return new Promise(resolve => {
    const unknown = () => files.map(f => ({ objectId: f.objectId, revision: f.revision,
      status: 'unknown' as const, code: 'check_unavailable', detail: '结构检查未完成，不能判定成功' }));
    let worker: Worker;
    try { worker = new Worker(existsSync(fileURLToPath(bundled)) ? bundled : new URL('./completion-worker.ts', import.meta.url), {
      workerData: { directory, files }, resourceLimits: { maxOldGenerationSizeMb: 128 },
    }); } catch { resolve(unknown()); return; }
    let done = false;
    const finish = (value?: CompletionEvidence[]) => {
      if (done) return;
      done = true; clearTimeout(timer); void worker.terminate();
      resolve(value || unknown());
    };
    const timer = setTimeout(() => finish(), 10000);
    worker.once('message', finish); worker.once('error', () => finish()); worker.once('exit', () => finish());
  });
}
