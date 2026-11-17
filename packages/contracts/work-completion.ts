export type CompletionEvidence = {
  objectId: string; revision: number; status: 'passed' | 'failed' | 'unknown';
  code: string; detail: string; hash?: string; text?: string; truncated?: boolean; facts?: Record<string, unknown>;
  criterion?: { id: string; source: string; description: string };
};
export type Continuation = {
  revision: number; attempts: number; spentMs: number; fingerprint: string;
  repeats: number; checkedRunId: string; evidence: CompletionEvidence[];
  missing: string[]; next: 'repair' | 'blocked' | 'done';
  conditions?: CompletionCondition[];
  grants?: { at: string; attempts: number; activeMs: number }[];
  reservation?: { rootTaskId: string; rootRevision: number; key: string; allowanceMs: number };
};
export type CompletionCondition = {
  id: string; requirementsRevision: number; source: string; description: string;
  method: 'delivery' | 'structure' | 'semantic'; status: 'passed' | 'failed' | 'unknown';
  evidence: { objectId: string; revision: number; hash?: string }[];
};
