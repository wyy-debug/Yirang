import { z } from 'zod';
import { Id } from './index.js';
export const ChartRead = z
  .object({
    operation: z.literal('chart_read'),
    objectId: Id,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const Color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const ChartChange = z
  .object({
    chartId: z.string().min(1).max(300),
    title: z
      .string()
      .max(500)
      .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))
      .optional(),
    series: z
      .array(z.object({ index: z.number().int().min(0).max(9999), color: Color }).strict())
      .max(12)
      .optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || !!v.series?.length);
export const ChartSave = z
  .object({
    operation: z.literal('chart_save'),
    objectId: Id,
    expectedRevision: z.number().int().positive(),
    requestId: Id,
    edits: z.array(ChartChange).min(1).max(24),
  })
  .strict();
export type NativeChartChange = z.infer<typeof ChartChange>;
export type NativeChartSeries = {
  index: number;
  name: string;
  color?: string;
  colorEditable: boolean;
  values: (number | null)[];
  categories: string[];
  valueFormula?: string;
  categoryFormula?: string;
  truncated: boolean;
  cachedPoints: number;
  warning?: string;
};
export type NativeChart = {
  id: string;
  title: string;
  titleEditable: boolean;
  kind: 'bar' | 'line' | 'pie' | 'unknown';
  direction?: 'horizontal' | 'vertical';
  sheets: string[];
  series: NativeChartSeries[];
  readOnly?: string;
  warnings: string[];
};
export type NativeChartList = {
  objectId: string;
  revision: number;
  fileName: string;
  charts: NativeChart[];
  total: number;
  truncated: boolean;
  warnings: string[];
  cacheStatus: 'unverified';
  calculationPending: boolean;
};
