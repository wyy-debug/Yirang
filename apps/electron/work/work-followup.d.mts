import type { WorkRun } from '../../../packages/contracts/index.js';

export function createFollowupDelivery(options: {
  invoke: (workspaceId: string, operation: string, taskId: string | undefined, payload?: Record<string, unknown>) => Promise<any>;
  steer?: (run: WorkRun, context: any, content: any[]) => Promise<unknown>;
  reconcileEnded?: (run: WorkRun) => Promise<boolean>;
  changed: () => void;
}): (workspaceId: string, taskId: string) => Promise<void>;
