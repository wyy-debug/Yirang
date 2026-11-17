import { z } from 'zod';

const CanvasId = z.string().min(1).max(150);
const Coordinate = z.number().finite().min(-100000).max(100000);
const Color = z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
export const CanvasMarkSchema = z
  .object({
    id: CanvasId,
    kind: z.enum(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'pen', 'text', 'note']),
    x: Coordinate,
    y: Coordinate,
    width: z.number().finite().min(0).max(100000),
    height: z.number().finite().min(0).max(100000),
    points: z
      .array(z.object({ x: Coordinate, y: Coordinate }).strict())
      .max(2000)
      .optional(),
    text: z.string().max(20000).optional(),
    stroke: Color,
    fill: z.union([Color, z.literal('transparent')]),
    strokeWidth: z.number().finite().min(0.5).max(40),
  })
  .strict();
export const CanvasLinkSchema = z
  .object({
    id: CanvasId,
    sourceId: CanvasId,
    targetId: CanvasId,
    label: z.string().max(200),
    arrow: z.boolean(),
  })
  .strict()
  .refine((link) => link.sourceId !== link.targetId, '连线需要两个不同的材料。');
const CanvasItems = z
  .array(CanvasMarkSchema)
  .max(2000)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    '画布元素 ID 不可重复。',
  );
const CanvasLinks = z
  .array(CanvasLinkSchema)
  .max(4000)
  .refine(
    (links) => new Set(links.map((link) => link.id)).size === links.length,
    '材料连线 ID 不可重复。',
  );
export const CanvasBoardSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    items: CanvasItems,
    links: CanvasLinks,
  })
  .strict()
  .refine(
    (board) => new TextEncoder().encode(JSON.stringify(board)).byteLength <= 4 * 1024 * 1024,
    '画布内容超过 4 MiB 限制。',
  );
export const CanvasBoardAction = z
  .discriminatedUnion('operation', [
    z.object({ operation: z.literal('read') }).strict(),
    z
      .object({
        operation: z.literal('save'),
        requestId: CanvasId,
        expectedRevision: z.number().int().nonnegative(),
        items: CanvasItems,
        links: CanvasLinks,
      })
      .strict(),
  ])
  .refine(
    (input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 4 * 1024 * 1024,
    '画布内容超过 4 MiB 限制。',
  );
export type CanvasMark = z.infer<typeof CanvasMarkSchema>;
export type CanvasLink = z.infer<typeof CanvasLinkSchema>;
export type CanvasBoard = z.infer<typeof CanvasBoardSchema>;
export type CanvasBoardInput = z.infer<typeof CanvasBoardAction>;
export function emptyCanvasBoard(): CanvasBoard {
  return { revision: 0, items: [], links: [] };
}
