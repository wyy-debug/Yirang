import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { z } from 'zod';
import { FileContent, fail } from '../../contracts/index.js';
import { isNativeTextFile } from '../../components/native-files.js';
import { textDelta } from '../../components/protection.js';
import { decodeNativeText, encodeNativeText } from '../documents/native-text.js';
import { XlsxEditor } from '../documents/spreadsheet/xlsx-editor.js';
import { OfficeEditor, loadOffice, parseOffice } from '../documents/office-editor.js';
import type { WorkbenchAPI } from '../work/workbench.js';

type Unit = { label: string; value: any; edit?: any };
type Snapshot = {
  kind: string;
  units: Map<string, Unit>;
  structure: string;
  bytes: Buffer;
  name: string;
  text?: string;
};
const json = (value: any) => JSON.stringify(value ?? null);
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const clip = (value: any) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (text ?? '（不存在）').slice(0, 12000);
};

/** Compare actual file content, then reverse only unchanged target units of a saved revision. */
export class NativeHistory {
  constructor(private api: WorkbenchAPI) {}
  private async read(id: string, revision: number): Promise<Snapshot> {
    const content = FileContent.parse(this.api.history(id, revision).content),
      bytes = this.api.load(content.assetHash),
      name = content.fileName,
      units = new Map<string, Unit>();
    if (isNativeTextFile(name)) {
      const text = decodeNativeText(bytes).text;
      if (text.length > 1000000)
        fail('DIFF_LIMIT', '正文比较上限为 100 万字符，请导出版本后比较。');
      return { kind: 'text', units, structure: 'text', bytes, name, text };
    }
    if (/\.xlsx$/i.test(name)) {
      const parsed = await new XlsxEditor().parse(bytes, content.assetHash);
      let count = 0;
      for (const sheet of parsed.book.worksheets)
        sheet.eachRow({ includeEmpty: false }, (row) =>
          row.eachCell({ includeEmpty: false }, (cell) => {
            if (++count > 50000) fail('DIFF_LIMIT', '单次最多比较 5 万个非空单元格。');
            const raw = cell.value as any,
              value =
                raw && typeof raw === 'object' && raw.formula ? { formula: raw.formula } : raw;
            const simple =
              value === null ||
              typeof value === 'string' ||
              typeof value === 'number' ||
              typeof value === 'boolean' ||
              (value && typeof value.formula === 'string');
            const key = `cell:${sheet.id}:${cell.address}`;
            units.set(key, {
              label: `${sheet.name}!${cell.address}`,
              value,
              edit: simple
                ? {
                    sheetId: String(sheet.id),
                    address: cell.address,
                    value: value?.formula
                      ? `=${value.formula}`
                      : value == null
                        ? ''
                        : String(value),
                    mode: typeof value === 'string' ? 'text' : 'auto',
                  }
                : undefined,
            });
            if (Object.keys(cell.style ?? {}).length)
              units.set(`${key}:style`, {
                label: `${sheet.name}!${cell.address} · 格式`,
                value: cell.style,
              });
          }),
        );
      // Structural changes invalidate address-based undo, even if later cells happen to match.
      const structure = json(
        parsed.book.worksheets.map((s) => ({
          id: s.id,
          name: s.name,
          rows: s.rowCount,
          columns: s.columnCount,
          merges: (s.model as any).merges,
        })),
      );
      return { kind: 'xlsx', units, structure, bytes, name };
    }
    if (/\.(docx|pptx)$/i.test(name)) {
      const parsed = await parseOffice(await loadOffice(bytes), name);
      if (parsed.paragraphs.length > 500) fail('DIFF_LIMIT', '文档比较最多 500 个编辑页。');
      for (let i = 0; i < parsed.paragraphs.length; i++) {
        const page = {
          paragraphs: parsed.paragraphs[i],
          shapes: parsed.shapes[i],
          labels: parsed.labels,
        };
        if (!parsed.word)
          units.set(`page:${i}`, {
            label: `第 ${i + 1} 页 · 页面属性`,
            value: {
              width: parsed.width,
              height: parsed.height,
              background: parsed.backgrounds[i],
            },
          });
        for (const paragraph of page.paragraphs) {
          for (const run of paragraph.runs) {
            const value = {
              text: run.text,
              bold: run.bold,
              italic: run.italic,
              underline: run.underline,
              fontSize: run.fontSize,
              fontFamily: run.fontFamily,
              color: run.color,
            };
            units.set(run.id, {
              label: `${page.labels[i] ?? `第 ${i + 1} 页`} · ${run.id}`,
              value,
              edit: paragraph.readOnly ? undefined : { kind: 'run', id: run.id, ...value },
            });
          }
          const value = {
            align: paragraph.align,
            before: paragraph.before,
            after: paragraph.after,
          };
          units.set(paragraph.id, {
            label: `段落格式 · ${paragraph.id}`,
            value,
            edit:
              paragraph.readOnly || !['left', 'center', 'right', 'both'].includes(paragraph.align)
                ? undefined
                : { kind: 'paragraph', id: paragraph.id, ...value },
          });
        }
        for (const shape of page.shapes) {
          const geometry = {
              x: shape.x,
              y: shape.y,
              width: shape.width,
              height: shape.height,
              rotation: shape.rotation,
            },
            style = { fill: shape.fill, stroke: shape.stroke, strokeWidth: shape.strokeWidth },
            value = { ...geometry, ...style };
          units.set(shape.id, {
            label: `元素属性 · ${shape.name}`,
            value,
            edit: shape.editable
              ? { kind: 'shape', id: shape.id, ...geometry, ...(shape.styleEditable ? style : {}) }
              : undefined,
          });
        }
      }
      return { kind: 'office', units, structure: json([...units.keys()]), bytes, name };
    }
    units.set('file', { label: name, value: { bytes: bytes.length, sha256: content.assetHash } });
    return { kind: 'binary', units, structure: 'binary', bytes, name };
  }
  async action(input: any) {
    const p = z
      .object({
        operation: z.enum(['native_diff', 'native_undo']),
        objectId: z.string(),
        fromRevision: z.number().int().positive(),
        toRevision: z.number().int().positive(),
        expectedRevision: z.number().int().positive().optional(),
        requestId: z.string().optional(),
        keys: z.array(z.string()).min(1).max(500).optional(),
      })
      .parse(input);
    const before = await this.read(p.objectId, p.fromRevision),
      after = await this.read(p.objectId, p.toRevision);
    if (before.kind !== after.kind || before.name !== after.name)
      fail('DIFF_FORMAT', '文件格式发生变化，请导出两个版本分别比较。');
    let entries: {
      key: string;
      label: string;
      before: string;
      after: string;
      undoable: boolean;
    }[] = [];
    const stable = before.structure === after.structure;
    if (before.kind === 'text') {
      const delta = textDelta(before.text!, after.text!);
      if (before.text !== after.text)
        entries = [
          {
            key: 'text',
            label: `正文 · 字符 ${delta.start + 1} 起`,
            before: clip(before.text!.slice(delta.start, delta.end)),
            after: clip(after.text!.slice(delta.start, delta.newEnd)),
            undoable: true,
          },
        ];
    } else {
      for (const key of new Set([...before.units.keys(), ...after.units.keys()])) {
        const a = before.units.get(key),
          b = after.units.get(key);
        if (json(a?.value) === json(b?.value)) continue;
        // Undefined Office style means inherited; the current edit contract cannot restore inheritance.
        const canRestore =
          before.kind !== 'office' ||
          !b ||
          Object.keys(b.value ?? {}).every(
            (field) => a?.value?.[field] !== undefined || b.value[field] === undefined,
          );
        entries.push({
          key,
          label: b?.label ?? a!.label,
          before: clip(a?.value),
          after: clip(b?.value),
          undoable: stable && canRestore && !!a?.edit && !!b?.edit,
        });
      }
      if (!stable)
        entries.unshift({
          key: 'structure',
          label: '工作表 / 文档结构',
          before: clip(before.structure),
          after: clip(after.structure),
          undoable: false,
        });
      // Also disclose unrepresented package edits instead of calling a blank semantic diff unchanged.
      if (digest(before.bytes) !== digest(after.bytes) && before.kind !== 'binary') {
        const [a, b] = await Promise.all([
          JSZip.loadAsync(before.bytes),
          JSZip.loadAsync(after.bytes),
        ]);
        const changed: string[] = [];
        for (const name of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
          if (a.files[name]?.dir || b.files[name]?.dir) continue;
          const old = a.file(name),
            next = b.file(name);
          if (
            !old ||
            !next ||
            digest(await old.async('nodebuffer')) !== digest(await next.async('nodebuffer'))
          )
            changed.push(name);
        }
        entries.push({
          key: 'package',
          label: '原文件部件变化（包含格式、图片及其它未展开内容）',
          before: '',
          after: changed.slice(0, 100).join('\n'),
          undoable: false,
        });
      }
    }
    if (p.operation === 'native_diff')
      return {
        kind: before.kind,
        entries: entries.slice(0, 500),
        truncated: entries.length > 500,
        total: entries.length,
        structural: !stable,
        fromRevision: p.fromRevision,
        toRevision: p.toRevision,
      };
    if (p.toRevision !== p.fromRevision + 1 || !p.expectedRevision || !p.requestId || !p.keys)
      fail('UNDO_RANGE', '只能选择一条修订中的具体修改进行撤销。');
    const unique = [...new Set(p.keys)];
    if (unique.some((key) => !entries.some((e) => e.key === key && e.undoable)))
      fail('UNDO_UNSUPPORTED', '选中的结构、格式或复杂内容不能局部撤销，请比较后恢复整份版本。');
    const current = this.api.object(p.objectId);
    if (current.revision !== p.expectedRevision)
      fail('REVISION_CONFLICT', '当前文件已变化，请重新比较。');
    const latest = await this.read(p.objectId, current.revision);
    let bytes: Buffer;
    if (before.kind === 'text') {
      const delta = textDelta(before.text!, after.text!),
        removed = before.text!.slice(delta.start, delta.end),
        inserted = after.text!.slice(delta.start, delta.newEnd);
      const prefix = after.text!.slice(Math.max(0, delta.start - 80), delta.start),
        suffix = after.text!.slice(delta.newEnd, delta.newEnd + 80),
        needle = prefix + inserted + suffix;
      const text = latest.text!,
        at = text.indexOf(needle);
      if (text === after.text) bytes = encodeNativeText(latest.bytes, before.text!, 'preserve');
      else {
        if (at < 0 || text.indexOf(needle, at + 1) >= 0 || !needle)
          fail('UNDO_CONFLICT', '修改位置已变化或有多处匹配，未覆盖后续内容。');
        const start = at + prefix.length;
        bytes = encodeNativeText(
          latest.bytes,
          text.slice(0, start) + removed + text.slice(start + inserted.length),
          'preserve',
        );
      }
    } else {
      if (latest.structure !== after.structure)
        fail('UNDO_CONFLICT', '文档结构已变化，无法安全按旧位置撤销。');
      for (const key of unique)
        if (json(latest.units.get(key)?.value) !== json(after.units.get(key)?.value))
          fail('UNDO_CONFLICT', '所选位置已有后续修改，未覆盖。');
      const edits = unique.map((key) => before.units.get(key)!.edit);
      bytes =
        before.kind === 'xlsx'
          ? await new XlsxEditor().save(latest.bytes, digest(latest.bytes), edits)
          : await new OfficeEditor().save(latest.bytes, latest.name, edits);
    }
    return this.api.save(
      p.requestId,
      p.objectId,
      current.revision,
      bytes,
      `局部撤销 v${p.toRevision} 的 ${unique.length} 项修改`,
      { type: 'native_undo', targetRevision: p.toRevision, keys: unique },
    );
  }
}
