import { z } from 'zod';
const address = z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/);
export const NativeSelection = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text_spans'),
      spans: z
        .array(
          z
            .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
            .strict(),
        )
        .min(1)
        .max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      start: z.number().int().min(0),
      end: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('xlsx'),
      sheetId: z.string().regex(/^\d+$/),
      from: address,
      to: address,
    })
    .strict(),
  z
    .object({
      kind: z.literal('office'),
      page: z.number().int().min(0).max(5000),
      ids: z.array(z.string().max(150)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pdf'),
      page: z.number().int().min(1),
      start: z.number().int().min(0),
      end: z.number().int().min(1),
    })
    .strict(),
]);
export type NativeSelectionSpec = z.infer<typeof NativeSelection>;
export type NativeReference = {
  id: string;
  objectId: string;
  baseRevision: number;
  selection: NativeSelectionSpec;
  selectedText: string;
  writable: boolean;
};
export type NativeSearchHit = {
  objectId: string;
  revision: number;
  title: string;
  location: string;
  text: string;
  target?: {
    sheetId?: string;
    address?: string;
    page?: number;
    paragraphId?: string;
    offset?: number;
  };
};
