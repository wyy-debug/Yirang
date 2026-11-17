import { z } from 'zod';
import { Id } from './index.js';

export const DesktopDisplayName = z
  .string()
  .trim()
  .min(1, '请输入桌面名称。')
  .max(120, '桌面名称最多 120 个字符。')
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), '名称不能包含换行或控制字符。');
export const ObjectRenameBatch = z
  .object({
    requestId: Id,
    items: z
      .array(
        z
          .object({
            objectId: Id,
            expectedRevision: z.number().int().positive(),
            // Compare the title separately: changing display names does not create a content revision.
            expectedTitle: z.string().max(120),
            title: DesktopDisplayName,
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .refine(
        (items) => new Set(items.map((item) => item.objectId)).size === items.length,
        '同一个对象不能重复改名。',
      ),
  })
  .strict();
export type ObjectRenameBatchInput = z.infer<typeof ObjectRenameBatch>;
