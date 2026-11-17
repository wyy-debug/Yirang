import { z } from 'zod';

export const WEB_PAGE_LIMIT = 200,
  WEB_CAPTURE_LIMIT = 16,
  WEB_CAPTURE_BYTE_LIMIT = 384 * 1024,
  WEB_HISTORY_BYTE_LIMIT = 2 * 1024 * 1024;
export const WEB_NOTE_LIMIT = 200,
  WEB_FORM_LIMIT = 20;
const Id = z.string().trim().min(1).max(150),
  Revision = z.number().int().positive();
export const WebUrl = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, '请输入不含账号密码的 http 或 https 网页地址。')
  .transform((value) => new URL(value).href);
export const WebFieldSchema = z
  .object({
    key: Id,
    name: z.string().max(200).optional(),
    label: z.string().max(300).optional(),
    type: z.string().max(80).default('text'),
    autocomplete: z.string().max(200).optional(),
    placeholder: z.string().max(500).optional(),
    options: z.array(z.string().max(500)).max(100).optional(),
    required: z.boolean().optional(),
    disabled: z.boolean().optional(),
    hidden: z.boolean().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();
export type WebField = z.infer<typeof WebFieldSchema>;
export const WebCaptureInput = z
  .object({
    url: WebUrl,
    title: z.string().max(300).default(''),
    text: z.string().max(200000).default(''),
    html: z.string().max(350000).optional(),
    links: z
      .array(z.object({ url: WebUrl, text: z.string().max(500).default('') }).strict())
      .max(200)
      .default([]),
    fields: z.array(WebFieldSchema).max(100).default([]),
  })
  .strict();
export type WebCaptureInputValue = z.infer<typeof WebCaptureInput>;
export type WebCapture = WebCaptureInputValue & {
  id: string;
  pageId: string;
  capturedAt: string;
  method: 'manual' | 'browser' | 'desktop-browser';
  sourceJobId?: string;
  sourceUrl?: string;
  sha256: string;
  excludedFieldCount: number;
};
export type WebCaptureReceipt = Pick<
  WebCapture,
  | 'id'
  | 'pageId'
  | 'url'
  | 'title'
  | 'capturedAt'
  | 'method'
  | 'sourceJobId'
  | 'sourceUrl'
  | 'sha256'
  | 'excludedFieldCount'
>;
export type WebCaptureResult = { page: WebPage } & (
  | { capture: WebCapture; captureRetained: true }
  | { capture: WebCaptureReceipt; captureRetained: false }
);
export type WebPage = {
  id: string;
  revision: number;
  title: string;
  url: string;
  group: string;
  tags: string[];
  favorite: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  latestCaptureId?: string;
  linkedObjects: { md?: string; html?: string };
};
export type WebNote = {
  id: string;
  revision: number;
  pageId: string;
  captureId: string;
  captureUrl: string;
  capturedAt: string;
  quote: string;
  start: number;
  end: number;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};
export type WebFormDraft = {
  id: string;
  revision: number;
  pageId: string;
  captureId: string;
  name: string;
  values: Record<string, string | boolean | string[]>;
  createdAt: string;
  updatedAt: string;
};
export type WebTab = { id: string; pageId?: string; url: string; title: string };
export type WebSession = {
  revision: number;
  tabs: WebTab[];
  activeTabId?: string;
  history: { url: string; title: string; pageId?: string; visitedAt: string }[];
  updatedAt: string;
};
export type WebPageDetail = {
  page: WebPage;
  captures: WebCapture[];
  notes: (WebNote & { orphaned: boolean })[];
  formDrafts: WebFormDraft[];
};
export const WebWorkspaceAction = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list'), includeArchived: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('read'), pageId: Id }).strict(),
  z
    .object({
      operation: z.literal('compare'),
      pageId: Id,
      beforeCaptureId: Id,
      afterCaptureId: Id,
    })
    .strict(),
  z
    .object({
      operation: z.literal('create'),
      requestId: Id,
      title: z.string().trim().min(1).max(300),
      url: WebUrl,
      group: z.string().trim().max(100).default(''),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
      favorite: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      operation: z.literal('update'),
      requestId: Id,
      pageId: Id,
      expectedRevision: Revision,
      title: z.string().trim().min(1).max(300).optional(),
      url: WebUrl.optional(),
      group: z.string().trim().max(100).optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      favorite: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('archive'),
      requestId: Id,
      pageId: Id,
      expectedRevision: Revision,
      archived: z.boolean(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('session'),
      requestId: Id,
      expectedRevision: z.number().int().nonnegative(),
      tabs: z
        .array(
          z
            .object({
              id: Id,
              pageId: Id.optional(),
              url: WebUrl,
              title: z.string().max(300).default(''),
            })
            .strict(),
        )
        .max(20),
      activeTabId: Id.optional(),
      visit: z
        .object({ url: WebUrl, title: z.string().max(300).default(''), pageId: Id.optional() })
        .strict()
        .optional(),
      clearHistory: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('capture'),
      requestId: Id,
      pageId: Id,
      expectedRevision: Revision,
      capture: WebCaptureInput,
      source: z.literal('desktop-browser').optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('note'),
      requestId: Id,
      pageId: Id,
      expectedRevision: Revision,
      action: z.enum(['create', 'update', 'resolve', 'delete']),
      noteId: Id.optional(),
      captureId: Id.optional(),
      quote: z.string().min(1).max(6000).optional(),
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().positive().optional(),
      body: z.string().max(8000).optional(),
      resolved: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('form'),
      requestId: Id,
      pageId: Id,
      expectedRevision: Revision,
      action: z.enum(['save', 'delete']),
      formId: Id.optional(),
      captureId: Id.optional(),
      name: z.string().trim().min(1).max(100).optional(),
      values: z
        .record(
          z.string().max(150),
          z.union([z.string().max(4000), z.boolean(), z.array(z.string().max(500)).max(50)]),
        )
        .optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('materialize'),
      requestId: Id,
      pageId: Id,
      expectedRevision: Revision,
      captureId: Id,
      format: z.enum(['md', 'html']),
      separate: z.boolean().optional(),
      bounds: z
        .object({
          x: z.number().finite().min(-200000).max(200000),
          y: z.number().finite().min(-200000).max(200000),
          width: z.number().min(220).max(3000),
          height: z.number().min(170).max(3000),
        })
        .strict()
        .optional(),
      expectedObjectRevision: Revision.optional(),
    })
    .strict(),
]);
export type WebWorkspaceActionValue = z.infer<typeof WebWorkspaceAction>;

/** Browser field metadata is untrusted. Persist only a conservative safe subset. */
export function webFieldSensitive(field: WebField) {
  const type = field.type.trim().toLowerCase();
  if (field.hidden || field.sensitive || ['password', 'hidden', 'file'].includes(type)) return true;
  const hint = [field.key, field.name, field.label, field.autocomplete, field.placeholder]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /password|passwd|passcode|pwd|secret|token|authorization|one.?time|otp|cvv|cvc|credit.?card|card.?number|card.?holder|card.?name|card.?expiry|cc-|payment|bank.?account|account.?number|iban|routing|security.?code|密码|口令|验证码|支付|银行卡|卡号|有效期|安全码/.test(
    hint,
  );
}
