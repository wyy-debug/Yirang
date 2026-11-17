import { z } from 'zod';
import { Id, SelectionRange, type MaterialRange } from './index.js';

export const COMMENT_BODY_LIMIT = 12000;
export const COMMENT_MESSAGE_LIMIT = 200;
export const COMMENT_DISPATCH_LIMIT = 40;
const Revision = z.number().int().positive(),
  Body = z.string().trim().min(1).max(COMMENT_BODY_LIMIT);
const mutation = { requestId: Id, threadId: Id, expectedRevision: Revision };
export const CommentAction = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list'), objectId: Id.optional() }).strict(),
  z.object({ operation: z.literal('read'), threadId: Id }).strict(),
  z
    .object({
      operation: z.literal('create'),
      requestId: Id,
      objectId: Id,
      baseRevision: Revision,
      range: SelectionRange.optional(),
      label: z.string().trim().max(160).optional(),
      body: Body,
    })
    .strict(),
  z.object({ operation: z.literal('reply'), ...mutation, body: Body }).strict(),
  z.object({ operation: z.literal('resolve'), ...mutation }).strict(),
  z.object({ operation: z.literal('reopen'), ...mutation }).strict(),
  z.object({ operation: z.literal('cancel'), ...mutation }).strict(),
  z
    .object({
      operation: z.literal('reanchor'),
      ...mutation,
      baseRevision: Revision,
      range: SelectionRange.optional(),
      label: z.string().trim().max(160).optional(),
    })
    .strict(),
  z.object({ operation: z.literal('prepare'), ...mutation }).strict(),
  z.object({ operation: z.literal('claim'), ...mutation, dispatchId: Id }).strict(),
  z
    .object({
      operation: z.literal('delivery'),
      ...mutation,
      dispatchId: Id,
      outcome: z.enum(['sent', 'unknown', 'failed']),
      message: z.string().max(2000).optional(),
    })
    .strict(),
]);
/** A plain object is intentional: the MCP adapter consumes .shape. */
export const CommentReport = z
  .object({
    operation: z.enum(['status', 'reply']),
    threadId: Id,
    dispatchId: Id,
    requestId: Id.optional(),
    status: z.enum(['running', 'waiting', 'completed', 'failed']).optional(),
    body: z.string().trim().max(COMMENT_BODY_LIMIT).optional(),
    resultObjectIds: z.array(Id).max(10).default([]),
  })
  .strict();
export interface CommentMessage {
  id: string;
  author: 'human' | 'ai';
  body: string;
  createdAt: string;
  dispatchId?: string;
  status?: 'running' | 'waiting' | 'completed' | 'failed';
  resultRevisions?: Record<string, number>;
}
export interface CommentDispatch {
  id: string;
  snapshotId?: string;
  session: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed';
  delivery: 'preparing' | 'prepared' | 'claimed' | 'sent' | 'unknown' | 'failed';
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  deliveredAt?: string;
  message?: string;
  baseRevision: number;
  range?: MaterialRange;
  messageIds: string[];
  resultRevisions: Record<string, number>;
  policyRevision: number;
  restoredAt?: string;
}
export interface CommentThread {
  id: string;
  objectId: string;
  baseRevision: number;
  range?: MaterialRange;
  label?: string;
  state: 'open' | 'resolved';
  revision: number;
  messages: CommentMessage[];
  dispatches: CommentDispatch[];
  createdAt: string;
  updatedAt: string;
  restoredAt?: string;
  /** List-only previews; read returns the complete persisted thread. */
  messagesTruncated?: boolean;
  dispatchesTruncated?: boolean;
  messageCount?: number;
  dispatchCount?: number;
}
export type CommentActionInput = z.infer<typeof CommentAction>;
export type CommentReportInput = z.infer<typeof CommentReport>;
