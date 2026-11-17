import { z } from 'zod';
import { Id } from './index.js';

export const WorkspaceCreate = z
  .object({
    workspaceId: Id,
    requestId: Id,
    name: z.string().trim().min(1).max(80),
    open: z.boolean().default(true),
  })
  .strict();
export const WorkspaceOpen = z
  .object({
    workspaceId: Id,
    targetId: Id,
    requestId: Id,
  })
  .strict();
