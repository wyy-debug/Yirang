import { z } from 'zod';
import { Id } from './index.js';
import { WebCaptureInput, WebUrl } from './web-workspace.js';

export const WebTaskRequest = z
  .object({
    pageId: Id,
    expectedRevision: z.number().int().positive(),
    captureId: Id.optional(),
    instruction: z.string().trim().min(1).max(8000),
    formDraftId: Id.optional(),
    mode: z.enum(['browse', 'capture', 'fill', 'compare']),
  })
  .strict();
export type WebTaskRequestValue = z.infer<typeof WebTaskRequest>;
export const WebExecutionRef = z
  .object({
    browser: z.string().min(1).max(100),
    tabId: z.string().min(1).max(200),
    url: WebUrl.optional(),
  })
  .strict();
export type WebTaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed';
export type WebDelivery =
  | 'new'
  | 'preparing'
  | 'prepared'
  | 'claimed'
  | 'sent'
  | 'unknown'
  | 'failed';
export type WebTaskDispatch = {
  id: string;
  delivery: WebDelivery;
  createdAt: string;
  claimedAt?: string;
  snapshotId?: string;
  generation: number;
  sequence: number;
  reportedAt?: string;
  message?: string;
};
export type WebTask = {
  id: string;
  pageId: string;
  pageRevision: number;
  objectId: string;
  objectRevision: number;
  session: string;
  mode: WebTaskRequestValue['mode'];
  instruction: string;
  sourceUrl: string;
  status: WebTaskStatus;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  captureIds: string[];
  executionRef?: z.infer<typeof WebExecutionRef>;
  reports: { status: WebTaskStatus; body: string; at: string; sequence: number }[];
  dispatches: WebTaskDispatch[];
  reply?: string;
  cancelled?: boolean;
  restoredAt?: string;
};
export const WebTaskAction = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list'), pageId: Id.optional() }).strict(),
  WebTaskRequest.extend({ operation: z.literal('create'), requestId: Id }).strict(),
  z
    .object({
      operation: z.literal('prepare'),
      requestId: Id,
      taskId: Id,
      continuing: z.boolean().default(false),
    })
    .strict(),
  z.object({ operation: z.literal('claim'), requestId: Id, taskId: Id, dispatchId: Id }).strict(),
  z
    .object({
      operation: z.literal('delivery'),
      requestId: Id,
      taskId: Id,
      dispatchId: Id,
      outcome: z.enum(['sent', 'failed', 'unknown']),
      message: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('reply'),
      requestId: Id,
      taskId: Id,
      body: z.string().trim().min(1).max(8000),
    })
    .strict(),
  z.object({ operation: z.literal('cancel'), requestId: Id, taskId: Id }).strict(),
]);
export const WebTaskReport = z
  .object({
    operation: z.enum(['status', 'report']),
    taskId: Id,
    dispatchId: Id,
    requestId: Id.optional(),
    sequence: z.number().int().positive().optional(),
    status: z.enum(['running', 'waiting', 'completed', 'failed']).optional(),
    body: z.string().trim().max(8000).optional(),
    executionRef: WebExecutionRef.optional(),
    capture: WebCaptureInput.optional(),
  })
  .strict();
