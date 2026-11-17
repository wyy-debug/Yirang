import { z } from 'zod';
import { Id } from './index.js';
export const OfficeRead = z
  .object({
    objectId: Id,
    expectedRevision: z.number().int().positive(),
    page: z.number().int().min(0).max(5000).default(0),
    pageCount: z.number().int().min(1).max(25).default(1),
  })
  .strict();
const text = z
  .string()
  .max(50000)
  .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
export const OfficeEdit = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('run'),
      id: z.string().max(150),
      text,
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      fontSize: z.number().min(1).max(400).optional(),
      fontFamily: z.string().min(1).max(100).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('paragraph'),
      id: z.string().max(150),
      align: z.enum(['left', 'center', 'right', 'both']).optional(),
      before: z.number().min(0).max(200).optional(),
      after: z.number().min(0).max(200).optional(),
      replacement: z.array(text).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('shape'),
      id: z.string().max(150),
      x: z.number().min(-10000).max(100000),
      y: z.number().min(-10000).max(100000),
      width: z.number().positive().max(100000),
      height: z.number().positive().max(100000),
      rotation: z.number().min(-360).max(360).optional(),
      fill: z
        .string()
        .regex(/^(none|#[0-9a-f]{6})$/i)
        .optional(),
      stroke: z
        .string()
        .regex(/^(none|#[0-9a-f]{6})$/i)
        .optional(),
      strokeWidth: z.number().min(0).max(100).optional(),
    })
    .strict(),
]);
export const OfficeSave = OfficeRead.omit({ page: true, pageCount: true })
  .extend({ requestId: Id, edits: z.array(OfficeEdit).min(1).max(2000) })
  .strict();
export type OfficeChange = z.infer<typeof OfficeEdit>;
export type OfficeRun = {
  id: string;
  text: string;
  bold: boolean;
  italic: boolean;
  underline?: boolean;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
};
export type OfficeParagraph = {
  id: string;
  shapeId?: string;
  runs: OfficeRun[];
  align: string;
  before: number;
  after: number;
  readOnly?: string;
  continuous?: boolean;
};
export type OfficeShape = {
  cell?: boolean;
  padding?: number[];
  verticalAlign?: 'start' | 'center' | 'end';
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  editable: boolean;
  image?: string;
  rotation?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  styleEditable?: boolean;
};
export type OfficePage = {
  objectId: string;
  revision: number;
  fileName: string;
  kind: 'docx' | 'pptx';
  page: number;
  pages: number;
  labels: string[];
  paragraphs: OfficeParagraph[];
  shapes: OfficeShape[];
  width: number;
  height: number;
  warnings: string[];
  background?: string;
  loadedPages?: number;
};
