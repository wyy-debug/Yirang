import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Id, FileContent, fail } from '../../contracts/index.js';
import { freePosition } from '../../components/canvas-spatial.js';
import type { WorkbenchAPI } from '../work/workbench.js';
type Job = {
  id: string;
  objectId: string;
  revision: number;
  from: number;
  to: number;
  language: string;
  pages: number[];
  version: number;
  result?: { id: string; revision: number };
  pending?: { id: string; revision?: number };
  at: string;
};
export function ocrBatch(api: WorkbenchAPI, input: unknown) {
  const p = z
    .object({
      command: z.enum(['get', 'start', 'page', 'read_page', 'save']),
      objectId: Id,
      expectedRevision: z.number().int().positive(),
      jobId: Id.optional(),
      requestId: Id.optional(),
      from: z.number().int().min(1).max(2000).optional(),
      to: z.number().int().min(1).max(2000).optional(),
      language: z.string().max(50).default(''),
      page: z.number().int().min(1).max(2000).optional(),
      text: z.string().max(100000).optional(),
      version: z.number().int().nonnegative().optional(),
    })
    .parse(input);
  const object = api.object(p.objectId);
  if (
    object.archived ||
    object.revision !== p.expectedRevision ||
    object.kind !== 'file' ||
    !FileContent.parse(object.content).fileName.toLowerCase().endsWith('.pdf')
  )
    fail('REVISION_CONFLICT', 'PDF 已更新或不可用，请重新打开。');
  const key = `ocr-latest:${object.id}:${object.revision}`;
  let job = api.get(`ocr-job:${p.jobId ?? api.get(key)}`) as Job | undefined;
  const save = () => {
    api.put(`ocr-job:${job!.id}`, job);
    return job;
  };
  if (p.command === 'start') {
    if (!p.requestId || !p.from || !p.to || p.from > p.to)
      fail('OCR_RANGE', '请选择有效页码范围。');
    const existing = api.get(`ocr-job:${p.requestId}`) as Job | undefined;
    if (existing) {
      if (
        existing.objectId !== object.id ||
        existing.revision !== object.revision ||
        existing.from !== p.from ||
        existing.to !== p.to ||
        existing.language !== p.language
      )
        fail('REQUEST_ID_REUSED', '该识别请求已用于其他范围。');
      return existing;
    }
    job = {
      id: p.requestId,
      objectId: object.id,
      revision: object.revision,
      from: p.from,
      to: p.to,
      language: p.language,
      pages: [],
      version: 0,
      at: new Date().toISOString(),
    };
    save();
    api.put(key, job.id);
    return job;
  }
  if (!job) {
    if (p.command === 'get') return null;
    fail('NOT_FOUND', '识别记录不存在。');
  }
  if (job.objectId !== object.id || job.revision !== object.revision)
    fail('REVISION_CONFLICT', '识别记录属于 PDF 的其他版本。');
  if (p.command === 'get') return job;
  if (p.command === 'read_page')
    return { text: api.get(`ocr-page:${job.id}:${p.page}`)?.text ?? '' };
  if (p.command === 'page') {
    if (job.pending) fail('OCR_SAVE_PENDING', '合并保存结果尚未确定，请先重试保存。');
    if (!p.page || p.page < job.from || p.page > job.to || p.text === undefined)
      fail('OCR_RANGE', '识别页不在本次范围内。');
    if (p.version !== job.version) fail('REVISION_CONFLICT', '识别记录已变化，请刷新后继续。');
    api.put(`ocr-page:${job.id}:${p.page}`, { text: p.text });
    job.pages = [...new Set([...job.pages, p.page])].sort((a, b) => a - b);
    job.version++;
    return save();
  }
  if (!job.pages.length) fail('OCR_EMPTY', '请先识别至少一页。');
  const text =
    `# ${object.title} · OCR\n\n来源对象：${object.id} · v${object.revision}\n页码范围：${job.from}–${job.to} · 已完成 ${job.pages.length} 页\n语言：${job.language || '系统语言'}\n\n` +
    Array.from({ length: job.to - job.from + 1 }, (_, i) => job!.from + i)
      .map(
        (page) =>
          `## 第 ${page} 页\n\n${api.get(`ocr-page:${job!.id}:${page}`)?.text ?? '[此页尚未识别]'}\n`,
      )
      .join('\n');
  const bytes = Buffer.from(text);
  if (bytes.length > 50 * 1024 * 1024) fail('OCR_LIMIT', '合并文字超过 50 MiB，请缩小页码范围。');
  job.pending ??= { id: randomUUID(), revision: job.result?.revision };
  save();
  const result = job.result
    ? api.save(
        job.pending.id,
        job.result.id,
        job.pending.revision!,
        bytes,
        '保存整份 PDF 的 OCR 文字',
        {
          type: 'ocr',
          sourceId: object.id,
          sourceRevision: object.revision,
          from: job.from,
          to: job.to,
        },
      )
    : api.create(
        job.pending.id,
        `${object.title.replace(/\.[^.]+$/, '').slice(0, 75)} - OCR.md`,
        bytes,
        freePosition(
          {
            x: object.bounds.x + object.bounds.width + 48,
            y: object.bounds.y,
            width: 400,
            height: 300,
          },
          api
            .objects()
            .filter((o) => !o.archived)
            .map((o) => ({ ...o.bounds, height: o.bounds.height + 40 })),
          { x: object.bounds.x, y: object.bounds.y, width: 1200, height: 900 },
        ),
      );
  api.put(`ocr-source:${result.id}`, {
    objectId: object.id,
    revision: object.revision,
    jobId: job.id,
    from: job.from,
    to: job.to,
  });
  job.result = { id: result.id, revision: result.revision };
  delete job.pending;
  save();
  return job;
}
