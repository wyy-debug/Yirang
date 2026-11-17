// Shared work-management primitives: request schemas, id/time generators and
// task/run state predicates used across the work command modules.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkTask } from '../../contracts/index.js';
import type { WorkRun } from '../../contracts/work-management.js';

export const at = () => new Date().toISOString(),
  uid = () => randomUUID(),
  text = z.string().trim().min(1).max(50000),
  id = z.string().min(1).max(160);
export const attachment = z.union([
  z.object({
    type: z.literal('image'),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().max(8000000),
  }),
  z.object({ type: z.literal('text'), text: z.string().max(50000) }),
]);
export const active = (r: WorkRun) =>
  ['starting', 'running', 'waiting', 'stopping', 'unknown'].includes(r.state);
export const terminal = (t: WorkTask) => ['completed', 'cancelled'].includes(t.management!.state);
