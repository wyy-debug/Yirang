import { z } from 'zod';
import { Id } from './index.js';
export const GeneratedControl = z
  .object({
    operation: z.enum([
      'references_check',
      'begin',
      'bind',
      'collect',
      'list',
      'get',
      'location',
      'tasks',
      'task_create',
      'task_select',
      'task_rename',
      'root_set',
      'sync_list',
      'sync_inspect',
      'sync_resolve',
      'browser_files',
      'browser_import',
      'browser_export',
      'search',
      'migration_scan',
      'migration_apply',
      'sync_flush',
      'open_local',
      'import_source',
      'open_region',
    ]),
    workspaceId: Id.optional(),
    objectIds: z.array(Id).max(2000).optional(),
    targets: z
      .array(
        z
          .object({
            objectId: Id,
            revision: z.number().int().positive(),
            path: z.string().max(4096),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(2000)
      .optional(),
    query: z.string().min(1).max(200).optional(),
    scope: z.enum(['current', 'all']).optional(),
    offset: z.number().int().nonnegative().optional(),
    url: z.string().max(4096).optional(),
    id: z.string().uuid().optional(),
    threadId: Id.optional(),
    turnId: Id.optional(),
    title: z.string().max(50000).optional(),
    view: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().positive().max(200000),
        height: z.number().positive().max(200000),
      })
      .strict()
      .optional(),
    viewWorkspaceId: Id.optional(),
    sourceIds: z.array(Id).max(10).optional(),
    interrupted: z.boolean().optional(),
    taskId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    path: z.string().max(4096).optional(),
    objectId: Id.optional(),
    expectedRevision: z.number().int().positive().optional(),
    diskHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mode: z.enum(['desktop', 'disk', 'merge']).optional(),
    text: z.string().max(512000).optional(),
    requestId: Id.optional(),
  })
  .strict();
