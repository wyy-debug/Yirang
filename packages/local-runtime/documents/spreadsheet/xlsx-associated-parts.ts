import type JSZip from 'jszip';
import { posix } from 'node:path';
import { fail } from '../../../contracts/index.js';
import { cellPosition, type StructureEdit } from '../../../contracts/xlsx.js';
import type { Parsed } from './xlsx-editor.js';
import { xml, xmlTree, xmlText, attrs, textXml, type XmlNode } from './xlsx-xml.js';
import {
  rewriteFormula,
  shiftIndex,
  shiftReference,
  rowAxis,
  type AxisEdit,
} from './xlsx-references.js';

const unsupported = (message: string): never => fail('XLSX_STRUCTURE_UNSUPPORTED', message);
function interval(ref: string, axis: AxisEdit) {
  const points = ref.split(':').map((value) => cellPosition(value.replace(/\$/g, '')));
  if (!points[0] || points.some((value) => !value)) unsupported('关联部件的区域坐标无法识别。');
  const a = points[0]!,
    b = points[1] ?? a;
  return rowAxis(axis) ? [a.row, b.row] : [a.column, b.column];
}
function overlaps(ref: string, axis: AxisEdit) {
  const [a, b] = interval(ref, axis);
  return axis.kind.startsWith('insert')
    ? axis.at > a && axis.at <= b
    : axis.at <= b && axis.at + axis.count - 1 >= a;
}

/** Move supported OOXML references in place, retaining chart/table/pivot definitions. */
export async function adjustAssociatedParts(
  zip: JSZip,
  parsed: Parsed,
  target: string,
  op: StructureEdit,
) {
  const axis = 'at' in op ? op : undefined,
    owners = new Map<string, string>();
  async function relations(part: string, owner: string, depth = 0) {
    if (depth > 3) return;
    const path = posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
    if (!zip.file(path)) return;
    for (const rel of xmlTree(await xml(zip, path)).children) {
      if (rel.attributes.TargetMode === 'External' || !rel.attributes.Target) continue;
      const to = rel.attributes.Target.startsWith('/')
        ? rel.attributes.Target.slice(1)
        : posix.normalize(posix.join(posix.dirname(part), rel.attributes.Target));
      if (!to.startsWith('xl/')) continue;
      if (owners.has(to) && owners.get(to) !== owner)
        unsupported('多个工作表共用关联部件，暂不能调整结构。');
      owners.set(to, owner);
      if (rel.attributes.Type?.endsWith('/drawing')) await relations(to, owner, depth + 1);
    }
  }
  for (const part of parsed.parts) await relations(part.path, part.name);
  const paths = Object.keys(zip.files).filter((path) =>
    /^xl\/(tables|charts|pivotTables|pivotCache|drawings)\/[^/]+\.xml$/i.test(path),
  );
  for (const path of paths) {
    const source = await xml(zip, path),
      root = xmlTree(source),
      owner = owners.get(path) ?? '',
      affected = !!axis && owner === target;
    if (axis && root.children.some((node) => node.local === 'extLst'))
      unsupported('关联部件带有扩展结构，暂不能安全调整行列。');
    if (affected && root.local === 'table' && root.attributes.ref) {
      const ref = root.attributes.ref,
        [first, last] = interval(ref, axis!);
      if (!rowAxis(axis!) && overlaps(ref, axis!))
        unsupported('Excel 表格内部增删列暂不支持；可在表格外调整列或增删数据行。');
      if (rowAxis(axis!) && axis!.kind.startsWith('delete')) {
        const end = axis!.at + axis!.count - 1,
          header = Number(root.attributes.headerRowCount ?? 1),
          totals = Number(root.attributes.totalsRowCount ?? 0);
        if (
          (header && axis!.at <= first + header - 1 && end >= first) ||
          (totals && axis!.at <= last && end >= last - totals + 1)
        )
          unsupported('删除会移除表格标题行或汇总行，请缩小范围。');
      }
    }
    let changed = false;
    const render = (node: XmlNode, parent?: XmlNode): string => {
      const changes: Record<string, string | undefined> = {};
      let body: string | undefined;
      if (['f', 'calculatedColumnFormula', 'totalsRowFormula'].includes(node.local)) {
        const old = xmlText(source, node),
          next = rewriteFormula(old, owner, target, op);
        if (next !== old) {
          body = textXml(next);
          changed = true;
        }
      }
      if (
        node.local === 'worksheetSource' &&
        node.attributes.sheet?.toLocaleLowerCase() === target.toLocaleLowerCase()
      ) {
        if (op.kind === 'rename_sheet') {
          changes.sheet = op.name;
          changed = true;
        }
        if (axis && node.attributes.ref) {
          if (!rowAxis(axis) && overlaps(node.attributes.ref, axis))
            unsupported('透视表数据源内部增删列会改变字段结构，暂不支持。');
          const next = shiftReference(node.attributes.ref, axis);
          if (next === '#REF!') unsupported('删除会移除透视表数据源。');
          changes.ref = next;
          changed ||= next !== node.attributes.ref;
        }
      }
      if (affected) {
        if (
          root.local === 'table' &&
          ['table', 'autoFilter', 'sortState', 'sortCondition'].includes(node.local) &&
          node.attributes.ref
        ) {
          const next = shiftReference(node.attributes.ref, axis!);
          if (next === '#REF!') unsupported('删除会移除整个表格区域。');
          changes.ref = next;
        }
        if (
          root.local === 'pivotTableDefinition' &&
          node.local === 'location' &&
          node.attributes.ref
        ) {
          if (overlaps(node.attributes.ref, axis!))
            unsupported('不能在透视表结果区域内增删行列，请在区域外操作。');
          changes.ref = shiftReference(node.attributes.ref, axis!);
        }
        if (
          ['from', 'to'].includes(parent?.local ?? '') &&
          node.local === (rowAxis(axis!) ? 'row' : 'col')
        ) {
          const value = Number(xmlText(source, node));
          if (!Number.isInteger(value)) unsupported('绘图锚点格式无法识别。');
          const shifted = shiftIndex(value + 1, axis!) ?? axis!.at,
            limit = rowAxis(axis!) ? 1048576 : 16384;
          if (shifted > limit) unsupported('插入会把绘图移出工作表边界。');
          body = String(Math.max(0, shifted - 1));
        }
      }
      if (body === undefined) {
        let cursor = node.openEnd;
        body = '';
        for (const child of node.children) {
          body += source.slice(cursor, child.start) + render(child, node);
          cursor = child.end;
        }
        body += source.slice(cursor, node.closeStart);
      }
      return body
        ? `<${node.name}${attrs(node, changes)}>${body}</${node.name}>`
        : `<${node.name}${attrs(node, changes)}/>`;
    };
    let output = source.slice(0, root.start) + render(root) + source.slice(root.end);
    if (changed && root.local === 'pivotCacheDefinition') {
      const tree = xmlTree(output);
      output =
        output.slice(0, tree.start) +
        `<${tree.name}${attrs(tree, { refreshOnLoad: '1' })}>` +
        output.slice(tree.openEnd);
    }
    if (changed && /^xl\/charts\//.test(path)) {
      // Reference caches are derived data. Office rebuilds them from the new references.
      const tree = xmlTree(output),
        spans: { start: number; end: number; text: string }[] = [];
      const visit = (node: XmlNode) => {
        if (['numCache', 'strCache'].includes(node.local)) {
          spans.push({ start: node.start, end: node.end, text: '' });
          return;
        }
        node.children.forEach(visit);
      };
      visit(tree);
      for (const span of spans.sort((a, b) => b.start - a.start))
        output = output.slice(0, span.start) + output.slice(span.end);
    }
    if (output !== source) zip.file(path, output);
  }
}
