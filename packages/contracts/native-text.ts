import { z } from 'zod';
import { Id } from './index.js';
export const TEXT_FILE_LIMIT = 1024 * 1024;
export const TextNewline = z.enum(['preserve', 'lf', 'crlf', 'cr']);
export const TextFileRead = z
  .object({ objectId: Id, expectedRevision: z.number().int().positive() })
  .strict();
export const TextFileSave = TextFileRead.extend({
  requestId: Id,
  text: z.string().max(TEXT_FILE_LIMIT),
  newline: TextNewline.default('preserve'),
}).strict();
export type NativeTextPage = {
  objectId: string;
  revision: number;
  fileName: string;
  text: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  bom: boolean;
  newline: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
  bytes: number;
};
