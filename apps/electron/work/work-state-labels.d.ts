export declare const workStateLabels: Record<string, string>;
export declare function workStateLabel(state: string, fallback?: string): string;
export type WorkTone = 'done' | 'ask' | 'blocked' | 'running' | 'idle';
export declare function workStatus(
  task: { management?: any },
  now?: number,
): { tone: WorkTone; label: string; line: string; action?: string };
export declare function workStatusRank(task: { management?: any }): number;
