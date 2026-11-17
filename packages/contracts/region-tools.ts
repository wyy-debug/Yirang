import { z } from 'zod';
import { Id, CanvasRegionBounds } from './index.js';

export const RegionRead = z.object({ workspaceId: Id.optional() }).strict();
export const RegionWrite = z
  .object({
    workspaceId: Id,
    requestId: Id,
    operation: z.enum(['create', 'rename', 'move_objects', 'set_output_target']),
    groupsRevision: z.number().int().nonnegative(),
    viewRevision: z.number().int().positive(),
    outputBatchId: Id.optional(),
    regionId: Id.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    color: z.enum(['sage', 'blue', 'sand', 'rose']).optional(),
    bounds: CanvasRegionBounds.optional(),
    objectIds: z.array(Id).min(1).max(2000).optional(),
  })
  .strict();
