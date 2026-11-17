import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  FileContent,
  Bounds,
  Annotation,
  fail,
  type DesktopObject,
} from '../../contracts/index.js';
import {
  NativeSelection,
  type NativeReference,
  type NativeSearchHit,
} from '../../contracts/workbench.js';
import { XlsxEdit, cellPosition, columnLabel, type SheetEdit } from '../../contracts/xlsx.js';
import { OfficeEdit, type OfficeChange } from '../../contracts/office.js';
import { XlsxEditor } from '../documents/spreadsheet/xlsx-editor.js';
import { structureOffice } from '../documents/office-structure.js';
import { OfficeEditor } from '../documents/office-editor.js';
import { newNativeFile, convertNativeFile } from '../documents/native-documents.js';
import {
  nativeFormat,
  isNativeTextFile,
  NATIVE_FILE_LIMIT,
} from '../../components/native-files.js';
import { decodeNativeText, encodeNativeText } from '../documents/native-text.js';
import { canvasPreview } from '../workspace/canvas-preview.js';
import { NativeHistory } from '../files/native-history.js';
import { NativeCharts } from '../documents/native-charts.js';
import { ocrBatch } from '../documents/pdf-ocr-jobs.js';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type WorkbenchAPI = {
  object: (id: string) => DesktopObject;
  objects: () => DesktopObject[];
  history: (id: string, revision: number) => any;
  load: (hash: string) => Buffer;
  loadRange: (hash: string, offset: number, length: number, expectedSize: number) => Buffer;
  get: (key: string) => any;
  put: (key: string, value: any) => void;
  create: (
    requestId: string,
    fileName: string,
    bytes: Buffer,
    bounds: any,
    relativePath?: string,
  ) => DesktopObject;
  save: (
    requestId: string,
    objectId: string,
    revision: number,
    bytes: Buffer,
    summary: string,
    location?: any,
    fileName?: string,
  ) => DesktopObject;
};
export class NativeWorkbench {
  private xlsx = new XlsxEditor();
  private office = new OfficeEditor();
  constructor(readonly api: WorkbenchAPI) {}
  source(objectId: string, revision?: number) {
    const object = this.api.object(objectId);
    if (object.archived) fail('OBJECT_ARCHIVED', '材料已归档。');
    const content = FileContent.parse(
      revision && revision !== object.revision
        ? this.api.history(objectId, revision).content
        : object.content,
    );
    return { object, content, bytes: this.api.load(content.assetHash) };
  }
  async action(input: any) {
    const p = z.object({ operation: z.string() }).passthrough().parse(input);
    if (p.operation === 'ocr_batch') return ocrBatch(this.api, p);
    if (p.operation === 'native_diff' || p.operation === 'native_undo')
      return new NativeHistory(this.api).action(p);
    if (p.operation === 'chart_read' || p.operation === 'chart_save')
      return new NativeCharts(this.api).action(p);
    if (p.operation === 'create') {
      const format = z
          .enum(['xlsx', 'docx', 'pptx', 'md', 'html', 'txt', 'py', 'js', 'ts', 'svg', 'csv'])
          .parse(p.format),
        title = z.string().min(1).max(100).parse(p.title),
        requestId = z.string().min(1).max(150).parse(p.requestId);
      return this.api.create(
        requestId,
        `${title}.${format}`,
        await newNativeFile(format, title),
        Bounds.parse(p.bounds),
      );
    }
    if (p.operation === 'convert') {
      const o = this.api.object(z.string().parse(p.objectId));
      if (o.revision !== p.expectedRevision) fail('REVISION_CONFLICT', '对象已更新。');
      const { extension, bytes } = await convertNativeFile(o);
      return this.api.save(
        z.string().parse(p.requestId),
        o.id,
        o.revision,
        bytes,
        '转换为原生文件',
        { type: 'object', convertedFrom: o.kind },
        `${o.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.${extension}`,
      );
    }
    if (p.operation === 'search')
      return this.search(
        z.string().min(1).max(200).parse(p.query),
        Array.isArray(p.objectIds) ? p.objectIds : undefined,
      );
    const id = z.string().parse(p.objectId),
      revision = z.number().int().positive().optional().parse(p.expectedRevision);
    if (p.operation === 'bytes') {
      const object = this.api.object(id);
      if (object.archived) fail('OBJECT_ARCHIVED', '材料已归档。');
      const content = FileContent.parse(
        revision && revision !== object.revision
          ? this.api.history(id, revision).content
          : object.content,
      );
      const offset = z.number().int().min(0).max(NATIVE_FILE_LIMIT).default(0).parse(p.offset),
        length = z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024)
          .default(1024 * 1024)
          .parse(p.length);
      if (offset > content.size) fail('FILE_RANGE', '读取起点超出文件大小。');
      const bytes = this.api.loadRange(content.assetHash, offset, length, content.size);
      return {
        data: bytes.toString('base64'),
        size: content.size,
        mime: content.mime,
        sha256: content.assetHash,
        revision: revision ?? object.revision,
      };
    }
    const { object, content, bytes } = this.source(id, revision);
    if (p.operation === 'preview')
      return canvasPreview(
        bytes,
        content.fileName,
        content.assetHash,
        id,
        revision ?? object.revision,
      );
    if (p.operation === 'location')
      return this.api.get(`contribution:${id}:${object.revision}`)?.location ?? null;
    if (p.operation === 'annotations')
      return (
        this.api.get(`contribution:${id}:${revision ?? object.revision}`)?.location?.annotations ??
        this.api.get(`file-annotations:${id}:${revision ?? object.revision}`) ??
        []
      );
    if (p.operation === 'annotate') {
      if (revision !== object.revision) fail('REVISION_CONFLICT', '图片已更新，请载入最新版本。');
      const annotations = z.array(Annotation).max(200).parse(p.annotations);
      return this.api.save(z.string().parse(p.requestId), id, revision!, bytes, '保存图片批注', {
        type: 'image_annotations',
        annotations,
      });
    }
    if (p.operation === 'office_structure') {
      if (revision !== object.revision) fail('REVISION_CONFLICT', '文件已更新。');
      const next = await structureOffice(bytes, content.fileName, p.change);
      return this.api.save(z.string().parse(p.requestId), id, revision!, next, '原生文档结构编辑', {
        type: 'native',
        change: p.change,
      });
    }
    if (p.operation === 'reference')
      return this.reference(id, revision!, NativeSelection.parse(p.selection));
    if (p.operation === 'reference_quote') {
      const quote = z
        .object({
          text: z.string().min(1).max(24000),
          start: z.number().int().nonnegative().optional(),
          spans: z
            .array(
              z
                .object({
                  start: z.number().int().nonnegative(),
                  end: z.number().int().positive(),
                  text: z.string().min(1).max(24000),
                })
                .strict(),
            )
            .min(1)
            .max(2000)
            .optional(),
        })
        .strict()
        .parse(p.quote);
      if (revision !== object.revision) fail('STALE_SELECTION', '文件已变化，请重新选择文字。');
      if (!isNativeTextFile(content.fileName))
        return {
          range: null,
          reason: '此预览选文仅可提问；请在文件编辑器中选择可修改的原生范围。',
        };
      const text = decodeNativeText(bytes).text;
      if (quote.spans) {
        let end = 0,
          total = 0;
        for (const span of quote.spans) {
          if (
            span.start < end ||
            span.end <= span.start ||
            text.slice(span.start, span.end) !== span.text
          )
            fail('STALE_SELECTION', '预览选区与原文不一致，请刷新预览后重新选择。');
          end = span.end;
          total += span.end - span.start;
        }
        if (total > 24000) fail('FILE_SELECTION', '文本选区过大。');
        return {
          range: await this.reference(id, revision!, {
            kind: 'text_spans',
            spans: quote.spans.map(({ start, end }) => ({ start, end })),
          }),
        };
      }
      const start = quote.start ?? text.indexOf(quote.text);
      if (
        start < 0 ||
        text.slice(start, start + quote.text.length) !== quote.text ||
        (quote.start === undefined && text.indexOf(quote.text, start + 1) !== -1)
      )
        return { range: null, reason: '预览选区缺少来源位置，请刷新预览后重新选择。' };
      return {
        range: await this.reference(id, revision!, {
          kind: 'text',
          start,
          end: start + quote.text.length,
        }),
      };
    }
    if (p.operation === 'merge')
      return this.merge(
        id,
        z.number().int().positive().parse(p.baseRevision),
        p.format,
        p.edits,
        p.operations,
      );
    fail('UNKNOWN_ACTION', '未知文件操作。');
  }
  async reference(objectId: string, revision: number, selection: z.infer<typeof NativeSelection>) {
    const { object, content, bytes } = this.source(objectId);
    if (object.revision !== revision) fail('STALE_SELECTION', '请保存并引用最新文件。');
    let selectedText = '',
      writable = true;
    if (selection.kind === 'text_spans') {
      if (!isNativeTextFile(content.fileName)) fail('FILE_SELECTION', '请选择文本或代码文件。');
      const text = decodeNativeText(bytes).text;
      let end = 0,
        total = 0;
      const runs = selection.spans.map((span, index) => {
        if (span.start < end || span.end <= span.start || span.end > text.length)
          fail('FILE_SELECTION', '文本选区无效。');
        end = span.end;
        total += span.end - span.start;
        return { span: index, text: text.slice(span.start, span.end) };
      });
      if (total > 24000) fail('FILE_SELECTION', '文本选区过大。');
      selectedText = JSON.stringify({ runs });
    } else if (selection.kind === 'text') {
      if (!isNativeTextFile(content.fileName)) fail('FILE_SELECTION', '请选择文本或代码文件。');
      const text = decodeNativeText(bytes).text;
      if (
        selection.end > text.length ||
        selection.end <= selection.start ||
        selection.end - selection.start > 24000
      )
        fail('FILE_SELECTION', '文本选区无效或过大。');
      selectedText = text.slice(selection.start, selection.end);
    } else if (selection.kind === 'xlsx') {
      if (!/\.xlsx$/i.test(content.fileName)) fail('FILE_SELECTION', '请选择 XLSX 文件。');
      const a = cellPosition(selection.from),
        b = cellPosition(selection.to);
      if (
        !a ||
        !b ||
        a.row > b.row ||
        a.column > b.column ||
        (b.row - a.row + 1) * (b.column - a.column + 1) > 2000
      )
        fail('FILE_SELECTION', '选区最多 2000 格。');
      const parsed = await this.xlsx.parse(bytes, content.assetHash),
        part = parsed.parts.find((s) => s.id === selection.sheetId),
        sheet = parsed.book.worksheets.find((s) => String(s.id) === selection.sheetId);
      if (!part || !sheet) fail('FILE_SELECTION', '工作表不存在。');
      const rows = [];
      for (let r = a.row; r <= b.row; r++)
        for (let c = a.column; c <= b.column; c++) {
          const cell = sheet.getCell(r, c);
          rows.push({ address: cell.address, value: cell.value });
        }
      selectedText = JSON.stringify({
        sheet: part.name,
        range: `${selection.from}:${selection.to}`,
        cells: rows,
      });
    } else if (selection.kind === 'office') {
      const page = await this.office.read(
          bytes,
          content.fileName,
          objectId,
          revision,
          selection.page,
          25,
        ),
        paragraphs = page.paragraphs.filter(
          (p) => selection.ids.includes(p.id) || (p.shapeId && selection.ids.includes(p.shapeId)),
        ),
        shapes = page.shapes.filter((s) => selection.ids.includes(s.id));
      if (
        selection.ids.some(
          (id) => !paragraphs.some((p) => p.id === id) && !shapes.some((s) => s.id === id),
        )
      )
        fail('FILE_SELECTION', '选区元素不存在。');
      selectedText = JSON.stringify({
        page: selection.page,
        paragraphs,
        shapes: shapes.map(({ image, ...s }) => s),
      });
    } else {
      const pages = await pdfText(bytes);
      const text = pages[selection.page - 1];
      if (text === undefined || selection.end > text.length || selection.end <= selection.start)
        fail('FILE_SELECTION', 'PDF 页码或文字范围无效。');
      selectedText = text.slice(selection.start, selection.end);
      writable = false;
    }
    if (selectedText.length > 100000) fail('FILE_SELECTION', '选区过大，请缩小范围。');
    const ref: NativeReference = {
      id: randomUUID(),
      objectId,
      baseRevision: revision,
      selection,
      selectedText,
      writable,
    };
    this.api.put(`native-reference:${ref.id}`, ref);
    return { type: 'native' as const, selectionId: ref.id, baseRevision: revision };
  }
  async editReference(reference: NativeReference, requestId: string, edits: unknown) {
    const { object, content, bytes } = this.source(reference.objectId);
    if (object.revision !== reference.baseRevision)
      fail('REVISION_CONFLICT', '选区版本已改变，请重新引用。');
    let next: Buffer;
    const spec = reference.selection;
    let nextSpec: NativeReference['selection'] = spec;
    if (spec.kind === 'text_spans') {
      const changes = z
        .array(
          z
            .object({
              kind: z.literal('text'),
              span: z.number().int().nonnegative(),
              text: z.string().max(1000000),
            })
            .strict(),
        )
        .min(1)
        .max(2000)
        .parse(edits);
      const replacements = new Map<number, string>();
      let total = 0;
      for (const change of changes) {
        if (change.span >= spec.spans.length || replacements.has(change.span))
          fail('PERMISSION_DENIED', '修改超出选中的文字范围。');
        replacements.set(change.span, change.text);
        total += change.text.length;
      }
      if (total > 1000000) fail('FILE_SELECTION', '替换文本过大。');
      const original = decodeNativeText(bytes).text;
      let text = original,
        delta = 0;
      const spans: { start: number; end: number }[] = [];
      for (let i = spec.spans.length - 1; i >= 0; i--) {
        const span = spec.spans[i];
        if (replacements.has(i))
          text = text.slice(0, span.start) + replacements.get(i)! + text.slice(span.end);
      }
      for (let i = 0; i < spec.spans.length; i++) {
        const span = spec.spans[i],
          length = replacements.has(i) ? replacements.get(i)!.length : span.end - span.start,
          start = span.start + delta;
        if (length) spans.push({ start, end: start + length });
        delta += length - (span.end - span.start);
      }
      nextSpec = { kind: 'text_spans', spans };
      next = encodeNativeText(bytes, text, 'preserve');
    } else if (spec.kind === 'text') {
      const [edit] = z
          .array(z.object({ kind: z.literal('text'), text: z.string().max(1000000) }).strict())
          .length(1)
          .parse(edits),
        text = decodeNativeText(bytes).text;
      next = encodeNativeText(
        bytes,
        text.slice(0, spec.start) + edit.text + text.slice(spec.end),
        'preserve',
      );
    } else if (spec.kind === 'xlsx') {
      const changes = z.array(XlsxEdit).min(1).max(2000).parse(edits),
        a = cellPosition(spec.from)!,
        b = cellPosition(spec.to)!;
      for (const edit of changes) {
        const p = cellPosition(edit.address);
        if (
          edit.sheetId !== spec.sheetId ||
          !p ||
          p.row < a.row ||
          p.row > b.row ||
          p.column < a.column ||
          p.column > b.column
        )
          fail('PERMISSION_DENIED', '修改超出引用单元格。');
      }
      next = await this.xlsx.save(bytes, content.assetHash, changes);
    } else if (spec.kind === 'office') {
      const changes = z.array(OfficeEdit).min(1).max(2000).parse(edits),
        page = await this.office.read(
          bytes,
          content.fileName,
          object.id,
          object.revision,
          spec.page,
          25,
        ),
        allowed = new Set<string>();
      if (changes.some((change) => change.kind === 'paragraph' && change.replacement !== undefined))
        fail(
          'FILE_SELECTION_STRUCTURE',
          '局部引用不能拆分或删除段落，位置标识会变化。结构编辑请由用户引用完整文件后处理；本次未修改原文件。',
        );
      for (const para of page.paragraphs)
        if (spec.ids.includes(para.id) || (para.shapeId && spec.ids.includes(para.shapeId))) {
          allowed.add(para.id);
          para.runs.forEach((r) => allowed.add(r.id));
        }
      spec.ids.forEach((id) => allowed.add(id));
      if (changes.some((e) => !allowed.has(e.id)))
        fail('PERMISSION_DENIED', '修改超出引用段落或元素。');
      next = await this.office.save(bytes, content.fileName, changes);
    } else fail('PERMISSION_DENIED', 'PDF 文字引用只读。');
    // Derive the next selection from the candidate bytes before the save transaction.
    // The transaction publishes the file, new reference and task source revision together.
    const candidate = next!,
      candidateHash = sha(candidate),
      nextRevision = object.revision + 1;
    if (spec.kind === 'text')
      nextSpec = { ...spec, end: spec.start + (edits as { text: string }[])[0].text.length };
    let rebasedReference: NativeReference | undefined;
    if (
      (nextSpec.kind === 'text' && nextSpec.start === nextSpec.end) ||
      (nextSpec.kind === 'text_spans' && !nextSpec.spans.length)
    ) {
      rebasedReference = {
        id: randomUUID(),
        objectId: object.id,
        baseRevision: nextRevision,
        selection: nextSpec,
        selectedText: '',
        writable: true,
      };
    } else {
      const candidateWorkbench = new NativeWorkbench({
        ...this.api,
        object: (id) =>
          id === object.id
            ? {
                ...object,
                revision: nextRevision,
                content: { ...content, assetHash: candidateHash, size: candidate.length },
              }
            : this.api.object(id),
        load: (assetHash) => (assetHash === candidateHash ? candidate : this.api.load(assetHash)),
        put: (key, value) => {
          if (key.startsWith('native-reference:')) rebasedReference = value as NativeReference;
          else fail('INVALID_STATE', '准备选区不应修改工作区设置。');
        },
      });
      await candidateWorkbench.reference(object.id, nextRevision, nextSpec);
    }
    if (!rebasedReference) fail('FILE_SELECTION', '无法建立修改后的选区，原文件未提交。');
    return this.api.save(requestId, object.id, object.revision, candidate, 'Codex 修改引用选区', {
      type: 'native',
      selection: spec,
      referenceId: reference.id,
      rebasedReference,
    });
  }
  async merge(id: string, baseRevision: number, format: any, edits: unknown, operations: unknown) {
    const base = this.source(id, baseRevision),
      latest = this.source(id),
      accepted: any[] = [],
      conflicts: any[] = [];
    for (let rev = baseRevision + 1; rev <= latest.object.revision; rev++) {
      const change = this.api.get(`contribution:${id}:${rev}`);
      if (change?.structureOperations?.length || change?.location?.change)
        fail('MERGE_STRUCTURE', '期间发生了文件结构修改，请按最新结构重新确认编辑位置。');
    }
    if (format === 'xlsx') {
      if (Array.isArray(operations) && operations.length)
        fail('MERGE_STRUCTURE', '请先处理结构操作草稿；结构位置改变时不能按旧地址自动合并。');
      const changes = z.array(XlsxEdit).max(2000).parse(edits),
        a = await this.xlsx.parse(base.bytes, base.content.assetHash),
        b = await this.xlsx.parse(latest.bytes, latest.content.assetHash);
      if (
        JSON.stringify(a.book.worksheets.map((s) => [s.id, s.name, s.rowCount, s.columnCount])) !==
        JSON.stringify(b.book.worksheets.map((s) => [s.id, s.name, s.rowCount, s.columnCount]))
      )
        fail('MERGE_STRUCTURE', '工作表结构已改变，无法按旧地址自动合并。');
      for (const edit of changes) {
        const old = a.book.worksheets.find((s) => String(s.id) === edit.sheetId),
          current = b.book.worksheets.find((s) => String(s.id) === edit.sheetId),
          x = old?.getCell(edit.address),
          y = current?.getCell(edit.address);
        const comparable = (c: any) => JSON.stringify({ value: c?.value, style: c?.style });
        if (old && current && old.name === current.name && comparable(x) === comparable(y))
          accepted.push(edit);
        else
          conflicts.push({
            id: `${edit.sheetId}!${edit.address}`,
            base: x?.value,
            current: y?.value,
            edit,
          });
      }
    } else {
      const changes = z.array(OfficeEdit).max(2000).parse(edits),
        a = await officeMap(this.office, base.bytes, base.content.fileName, id, baseRevision),
        b = await officeMap(
          this.office,
          latest.bytes,
          latest.content.fileName,
          id,
          latest.object.revision,
        );
      if (JSON.stringify([...a.keys()]) !== JSON.stringify([...b.keys()]))
        fail('MERGE_STRUCTURE', '文档元素结构已改变，请按最新文档重新定位。');
      for (const edit of changes) {
        const old = a.get(edit.id),
          current = b.get(edit.id);
        if (old && current && JSON.stringify(old) === JSON.stringify(current)) accepted.push(edit);
        else conflicts.push({ id: edit.id, base: old, current, edit });
      }
    }
    return { revision: latest.object.revision, accepted, conflicts };
  }
  async search(
    query: string,
    ids?: string[],
  ): Promise<{ hits: NativeSearchHit[]; issues: { objectId: string; message: string }[] }> {
    const hits: NativeSearchHit[] = [],
      issues: { objectId: string; message: string }[] = [],
      q = query.toLocaleLowerCase();
    for (const object of this.api
      .objects()
      .filter((o) => o.kind === 'file' && !o.archived && (!ids || ids.includes(o.id)))) {
      try {
        const content = FileContent.parse(object.content),
          cached = this.api.get(`native-search-index:${object.id}`),
          segments: { text: string; location: string; target: any }[] = [],
          indexLimit = 2000000;
        let indexedChars = 0,
          truncated = false;
        const push = (text: string, location: string, target: any) => {
          const remaining = Math.max(0, indexLimit - indexedChars);
          if (text.length > remaining) truncated = true;
          text = text.slice(0, remaining);
          if (!text) return;
          segments.push({ text, location, target });
          indexedChars += text.length;
          const index = text.toLocaleLowerCase().indexOf(q);
          if (index >= 0 && hits.length < 200)
            hits.push({
              objectId: object.id,
              revision: object.revision,
              title: object.title,
              location,
              text: text.slice(Math.max(0, index - 60), index + 160),
              target: location === '正文' ? { ...target, offset: index } : target,
            });
        };
        if (cached?.hash === content.assetHash) {
          for (const item of cached.segments) push(item.text, item.location, item.target);
          if (cached.truncated || truncated)
            issues.push({ objectId: object.id, message: '正文索引达到 200 万字符上限' });
          continue;
        }
        const bytes = this.api.load(content.assetHash);
        if (/\.xlsx$/i.test(content.fileName)) {
          const book = await this.xlsx.parse(bytes, content.assetHash);
          for (const sheet of book.book.worksheets)
            sheet.eachRow((row) =>
              row.eachCell((cell) =>
                push(cell.text, `${sheet.name}!${cell.address}`, {
                  sheetId: String(sheet.id),
                  address: cell.address,
                }),
              ),
            );
        } else if (/\.(docx|pptx)$/i.test(content.fileName)) {
          let page = await this.office.read(bytes, content.fileName, object.id, object.revision, 0);
          for (let i = 0; i < page.pages; i++) {
            if (i)
              page = await this.office.read(bytes, content.fileName, object.id, object.revision, i);
            for (const paragraph of page.paragraphs)
              push(paragraph.runs.map((r) => r.text).join(''), page.labels[i], {
                page: i,
                paragraphId: paragraph.id,
              });
          }
        } else if (/\.pdf$/i.test(content.fileName)) {
          const pages = await pdfText(bytes);
          pages.forEach((text, page) => push(text, `第 ${page + 1} 页`, { page: page + 1 }));
        } else if (isNativeTextFile(content.fileName)) {
          const text = decodeNativeText(bytes).text;
          push(text, '正文', { offset: text.toLocaleLowerCase().indexOf(q) });
        }
        this.api.put(`native-search-index:${object.id}`, {
          hash: content.assetHash,
          segments,
          truncated,
        });
        if (truncated) issues.push({ objectId: object.id, message: '正文索引达到 200 万字符上限' });
      } catch (e) {
        issues.push({ objectId: object.id, message: String(e) });
      }
      if (hits.length >= 200) break;
    }
    return { hits, issues };
  }
}
async function officeMap(
  editor: OfficeEditor,
  bytes: Buffer,
  name: string,
  id: string,
  revision: number,
) {
  const map = new Map<string, any>();
  let page = await editor.read(bytes, name, id, revision, 0);
  for (let i = 0; i < page.pages; i++) {
    if (i) page = await editor.read(bytes, name, id, revision, i);
    for (const p of page.paragraphs) {
      map.set(p.id, p);
      p.runs.forEach((r) =>
        map.set(r.id, { ...r, paragraphText: p.runs.map((r) => r.text).join('') }),
      );
    }
    page.shapes.forEach((s) => map.set(s.id, s));
  }
  return map;
}
export async function pdfText(bytes: Buffer) {
  (globalThis as any).pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await task.promise;
  try {
    if (doc.numPages > 2000) fail('PDF_LIMIT', 'PDF 超过 2000 页。');
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((item: any) => item.str ?? '').join(' '));
    }
    return pages;
  } finally {
    await doc.loadingTask.destroy();
  }
}
