import { z } from 'zod';
import { Id, Bounds, RelativeFilePath } from './index.js';
export const QueueStage = z
  .object({
    requestId: Id,
    fileName: z.string().min(1).max(120),
    data: z.string().max(70000000),
    bounds: Bounds,
    relativePath: RelativeFilePath,
    lastModified: z.number().int().nonnegative(),
  })
  .strict();
export const ImportQueue = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('stage'), entry: QueueStage }).strict(),
  z.object({ operation: z.literal('request'), id: Id }).strict(),
  z.object({ operation: z.literal('forget'), ids: z.array(Id).max(500) }).strict(),
  z
    .object({
      operation: z.literal('folders'),
      job: z.object({ requestId: Id, paths: z.array(RelativeFilePath).max(1000) }).strict(),
    })
    .strict(),
]);
export const NativeDraftSync = z
  .object({
    entries: z
      .array(
        z
          .object({
            objectId: Id,
            kind: z.enum(['text', 'xlsx', 'office', 'charts']),
            data: z.string().max(5000000).nullable(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
