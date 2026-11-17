import { z } from 'zod';
import { Id } from './index.js';

export const DesktopSearch = z
  .object({
    query: z.string().trim().min(1).max(500),
    workspaceId: Id.optional(),
    regionId: Id.optional(),
    objectIds: z.array(Id).min(1).max(2000).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    mode: z.enum(['keyword', 'hybrid']).default('hybrid'),
  })
  .strict();
export const SearchHits = z.object({ hitIds: z.array(z.string().uuid()).min(1).max(10) }).strict();
export const SearchLocate = z
  .object({ hitId: z.string().uuid(), openObject: z.boolean().default(true) })
  .strict();
export type RetrievalConfig = {
  endpoint: string;
  model: string;
  dimensions?: number;
  apiKey: string;
  enabledWorkspaces: string[];
  paused: boolean;
};
export type SearchTarget = {
  page?: number;
  pageBase?: 0 | 1;
  paragraphId?: string;
  offset?: number;
  sheetId?: string;
  address?: string;
};
export const RetrievalConfiguration = z
  .object({
    endpoint: z.string().max(2000),
    model: z.string().max(200),
    dimensions: z.number().int().min(1).max(8192).optional(),
    apiKey: z.string().max(8000),
    enabledWorkspaces: z.array(Id).max(1000),
    paused: z.boolean(),
  })
  .strict();
export const RetrievalControl = z
  .object({
    operation: z.enum(['search', 'read', 'locate', 'status', 'rebuild', 'configure']),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type RetrievalChunk = {
  id: string;
  workspace: string;
  object_id: string;
  revision: number;
  content_hash: string;
  title: string;
  location: string;
  target: SearchTarget;
  text: string;
  score?: number;
  matchedBy?: string[];
};
