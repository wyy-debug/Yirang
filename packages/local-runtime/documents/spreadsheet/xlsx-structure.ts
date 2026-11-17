import { adjustAssociatedParts } from './xlsx-associated-parts.js';
import { rangeKinds, rangeStructure } from './xlsx-range.js';
import JSZip from 'jszip';
import { posix } from 'node:path';
import { cellPosition, columnLabel, type StructureEdit } from '../../../contracts/xlsx.js';
import { fail } from '../../../contracts/index.js';
import { NATIVE_FILE_LIMIT } from '../../../components/native-files.js';
import {
  xml,
  xmlTree,
  xmlText,
  child,
  children,
  attrs,
  prefix,
  textXml,
  escape,
  replaceSpans,
  type XmlNode,
} from './xlsx-xml.js';
import {
  rewriteFormula,
  shiftIndex,
  shiftInterval,
  shiftReference,
  rowAxis,
  type AxisEdit,
} from './xlsx-references.js';
import type { Parsed } from './xlsx-editor.js';
import { advancedKinds, advancedStructure } from './xlsx-advanced.js';

const unsupported: (reason: string) => never = (reason) =>
  fail('XLSX_STRUCTURE_UNSUPPORTED', reason);
export function structureBlocked(parsed: Parsed) {
  if (parsed.signed) return '带数字签名的工作簿暂不支持结构编辑';
  const lock = child(xmlTree(parsed.workbookSource), 'workbookProtection')?.attributes
    .lockStructure;
  if (lock === '1' || lock === 'true') return '工作簿结构已受保护';
  return undefined;
}
function rebuild(
  source: string,
  node: XmlNode,
  changes: Record<string, string | undefined>,
  body?: string,
) {
  if (body === undefined) body = source.slice(node.openEnd, node.closeStart);
  return body
    ? `<${node.name}${attrs(node, changes)}>${body}</${node.name}>`
    : `<${node.name}${attrs(node, changes)}/>`;
}
function inner(source: string, node: XmlNode, render: (node: XmlNode) => string) {
  let text = '',
    cursor = node.openEnd;
  for (const next of node.children) {
    text += source.slice(cursor, next.start) + render(next);
    cursor = next.end;
  }
  return text + source.slice(cursor, node.closeStart);
}
function position(address: string, op: AxisEdit, clamp = false) {
  const point = cellPosition(address.replace(/\$/g, ''));
  if (!point) unsupported('文件含不支持的区域坐标，结构修改未应用。');
  let n = shiftIndex(rowAxis(op) ? point.row : point.column, op);
  if (n === null) {
    if (!clamp) return null;
    n = op.at;
  }
  const limit = rowAxis(op) ? 1048576 : 16384;
  if (n > limit) {
    if (!clamp) fail('XLSX_LIMIT', '插入会把已有单元格移出工作表边界。');
    n = limit;
  }
  return columnLabel(rowAxis(op) ? point.column : n) + (rowAxis(op) ? n : point.row);
}

/** Patch original OOXML parts in operation order; no full ExcelJS serialization. */
export async function changeStructure(bytes: Buffer, parsed: Parsed, op: StructureEdit) {
  const blocked = structureBlocked(parsed);
  if (blocked) fail('XLSX_READ_ONLY', blocked);
  if (rangeKinds.has(op.kind)) return rangeStructure(bytes, parsed, op);
  if (advancedKinds.has(op.kind)) return advancedStructure(bytes, parsed, op);
  const zip = await JSZip.loadAsync(bytes),
    root = xmlTree(parsed.workbookSource),
    sheetsNode = child(root, 'sheets')!;
  const target = parsed.parts.find((part) => part.id === op.sheetId),
    sheetNodes = children(sheetsNode, 'sheet');
  if (op.kind !== 'add_sheet' && !target) fail('XLSX_SHEET', '工作表不存在。');
  if (
    'name' in op &&
    sheetNodes.some(
      (node) =>
        node.attributes.sheetId !== (op.kind === 'rename_sheet' ? op.sheetId : '') &&
        node.attributes.name.toLowerCase() === op.name.toLowerCase(),
    )
  )
    fail('XLSX_SHEET_NAME', '工作表名称已存在，请使用其他名称。');
  let workbook = parsed.workbookSource;
  if (op.kind === 'add_sheet') {
    if (sheetNodes.some((node) => node.attributes.sheetId === op.sheetId))
      fail('XLSX_SHEET', '新增工作表标识已存在。');
    if (sheetNodes.length >= 200) fail('XLSX_LIMIT', '当前编辑器最多支持 200 个工作表。');
    let path = `xl/worksheets/desktop-sheet-${op.sheetId}.xml`,
      suffix = 1;
    while (zip.file(path)) path = `xl/worksheets/desktop-sheet-${op.sheetId}-${suffix++}.xml`;
    zip.file(
      path,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>',
    );
    const relPath = 'xl/_rels/workbook.xml.rels',
      source = await xml(zip, relPath),
      rels = xmlTree(source),
      used = new Set(rels.children.map((n) => n.attributes.Id));
    let id = `rIdDesktopSheet${op.sheetId}`;
    while (used.has(id)) id += '_';
    zip.file(
      relPath,
      rebuild(
        source,
        rels,
        {},
        inner(source, rels, (n) => source.slice(n.start, n.end)) +
          `<${prefix(rels.name)}Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${escape(posix.relative('xl', path))}"/>`,
      ),
    );
    const sample = sheetNodes[0],
      rid = Object.keys(sample.attributes).find((key) => key.endsWith(':id')) ?? 'r:id';
    workbook = replaceSpans(workbook, [
      {
        start: sheetsNode.start,
        end: sheetsNode.end,
        text: rebuild(
          workbook,
          sheetsNode,
          {},
          inner(workbook, sheetsNode, (n) => workbook.slice(n.start, n.end)) +
            `<${sample.name} name="${escape(op.name)}" sheetId="${op.sheetId}" ${rid}="${id}"/>`,
        ),
      },
    ]);
    const types = await xml(zip, '[Content_Types].xml'),
      typesRoot = xmlTree(types);
    zip.file(
      '[Content_Types].xml',
      rebuild(
        types,
        typesRoot,
        {},
        inner(types, typesRoot, (n) => types.slice(n.start, n.end)) +
          `<${prefix(typesRoot.name)}Override PartName="/${escape(path)}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      ),
    );
  } else {
    const axis = 'at' in op ? op : undefined;
    if (axis && axis.at + axis.count - 1 > (rowAxis(axis) ? 1048576 : 16384))
      fail('XLSX_LIMIT', '所选行列范围超出工作表边界。');
    if (child(target!.root, 'sheetProtection'))
      fail('XLSX_READ_ONLY', '此工作表已受保护，不能修改结构。');
    if (child(root, 'calcPr')?.attributes.refMode === 'R1C1')
      unsupported('R1C1 引用模式暂不支持结构编辑。');
    // These parts carry coordinate graphs not covered by the scalar editor; never silently leave them stale.
    if (
      Object.keys(zip.files).some(
        (path) =>
          /^xl\/(externalLinks|slicers|queryTables)\//i.test(path) ||
          /^xl\/(metadata|connections)\.xml$/i.test(path),
      )
    )
      unsupported('此文件含外部数据、切片器或扩展数据部件，暂不能调整结构；原文件未修改。');
    if (
      parsed.parts.some((part) =>
        part.root.children.some((node) =>
          ['legacyDrawing', 'oleObjects', 'controls', 'extLst'].includes(node.local),
        ),
      ) ||
      (axis &&
        Object.keys(zip.files).some((path) =>
          /^xl\/(?:comments[^/]*\.xml|threadedComments\/)/i.test(path),
        ))
    )
      unsupported('工作簿含批注、绘图或扩展关联部件，暂不能安全调整此结构。');
    if (
      axis &&
      target!.root.children.some((node) =>
        [
          'extLst',
          'rowBreaks',
          'colBreaks',
          'customSheetViews',
          'legacyDrawing',
          'oleObjects',
          'controls',
        ].includes(node.local),
      )
    )
      unsupported('当前工作表含条件格式、数据验证或扩展布局，暂不支持增删行列；原文件未修改。');
    await adjustAssociatedParts(zip, parsed, target!.name, op);
    for (const part of parsed.parts) {
      for (const node of part.cells.values()) {
        const f = child(node, 'f');
        if (
          (f?.attributes.t &&
            !['normal', 'shared', ...(axis ? [] : ['array'])].includes(f.attributes.t)) ||
          node.attributes.cm ||
          node.attributes.vm
        )
          unsupported('此工作簿含数组、溢出或扩展单元格，暂不支持结构编辑。');
      }
      const source = part.source,
        affected = !!axis && part.id === target!.id;
      const transform = (formula: string) => rewriteFormula(formula, part.name, target!.name, op);
      let lastRow = 1,
        lastColumn = 1;
      if (affected)
        for (const address of part.cells.keys()) {
          const next = position(address, axis!);
          if (next) {
            const point = cellPosition(next)!;
            lastRow = Math.max(lastRow, point.row);
            lastColumn = Math.max(lastColumn, point.column);
          }
        }
      const filter = child(part.root, 'autoFilter'),
        filterStart = filter?.attributes.ref?.split(':')[0],
        filterColumn = filterStart ? cellPosition(filterStart)?.column : undefined;
      const render = (node: XmlNode): string => {
        const changes: Record<string, string | undefined> = {};
        let body: string | undefined;
        if (node.local === 'c') {
          const address = node.attributes.r,
            next = affected ? position(address, axis!) : address;
          if (!next) return '';
          changes.r = next;
          const formula = child(node, 'f');
          if (formula) {
            const original =
              formula.attributes.t === 'shared'
                ? parsed.book.getWorksheet(Number(part.id))?.getCell(address).formula
                : xmlText(source, formula);
            if (!original) unsupported('共享公式无法展开，结构修改未应用。');
            const rewritten = transform(original!);
            if (child(part.root, 'sheetProtection') && rewritten !== original)
              fail('XLSX_READ_ONLY', '引用调整会修改受保护工作表中的公式，操作未应用。');
            changes.t = undefined;
            body = inner(source, node, (n) =>
              n.local === 'v'
                ? ''
                : n.local === 'f'
                  ? rebuild(
                      source,
                      n,
                      n.attributes.t === 'array'
                        ? {}
                        : { t: undefined, si: undefined, ref: undefined },
                      textXml(rewritten),
                    )
                  : render(n),
            );
          }
        } else if (node.local === 'row' && affected) {
          if (rowAxis(axis!)) {
            const next = shiftIndex(Number(node.attributes.r), axis!);
            if (next === null) return '';
            if (next > 1048576) fail('XLSX_LIMIT', '插入会把已有行移出工作表边界。');
            changes.r = String(next);
          }
          changes.spans = undefined;
        } else if (node.local === 'col' && affected && !rowAxis(axis!)) {
          const range = shiftInterval(
            Number(node.attributes.min),
            Number(node.attributes.max),
            axis!,
          );
          if (!range || range[0] > 16384) return '';
          changes.min = String(range[0]);
          changes.max = String(Math.min(16384, range[1]));
        } else if (['formula', 'formula1', 'formula2'].includes(node.local)) {
          body = textXml(transform(xmlText(source, node)));
        }
        if (affected) {
          if (node.local === 'dimension') changes.ref = `A1:${columnLabel(lastColumn)}${lastRow}`;
          else if (
            ['mergeCell', 'hyperlink', 'autoFilter', 'sortState', 'sortCondition'].includes(
              node.local,
            ) &&
            node.attributes.ref
          ) {
            const next = shiftReference(node.attributes.ref, axis!);
            if (next === '#REF!') return '';
            else {
              if (
                node.local === 'mergeCell' &&
                (!next.includes(':') || next.split(':')[0] === next.split(':')[1])
              )
                return '';
              changes.ref = next;
            }
          }
          if (node.local === 'filterColumn' && !rowAxis(axis!) && filterColumn) {
            const next = shiftIndex(filterColumn + Number(node.attributes.colId), axis!),
              range = filter?.attributes.ref && shiftReference(filter.attributes.ref, axis!);
            if (next === null || !range || range === '#REF!') return '';
            changes.colId = String(next - cellPosition(range.split(':')[0])!.column);
          }
          if (node.attributes.sqref) {
            changes.sqref = node.attributes.sqref
              .split(/\s+/)
              .map((ref) => shiftReference(ref, axis!))
              .filter((ref) => ref !== '#REF!')
              .join(' ');
            if (!changes.sqref) {
              if (node.local !== 'selection') return '';
              changes.sqref = 'A1';
            }
            changes.activeCellId = undefined;
          }
          for (const field of ['activeCell', 'topLeftCell'])
            if (node.attributes[field])
              changes[field] = position(node.attributes[field], axis!, true)!;
          if (node.local === 'pane' && ['frozen', 'frozenSplit'].includes(node.attributes.state)) {
            const field = rowAxis(axis!) ? 'ySplit' : 'xSplit',
              count = Number(node.attributes[field] ?? 0);
            if (count > 0) {
              const range = shiftInterval(1, count, axis!);
              changes[field] = String(range ? range[1] : 0);
            }
          }
        }
        if (node.local === 'hyperlink' && node.attributes.location)
          changes.location = transform(node.attributes.location);
        if (body === undefined) body = inner(source, node, render);
        if (node.local === 'dataValidations') {
          const count = (body.match(/<(?:[\w]+:)?dataValidation\s/g) ?? []).length;
          if (!count) return '';
          changes.count = String(count);
        }
        if (node.local === 'mergeCells') {
          const count = (body.match(/<(?:[\w]+:)?mergeCell\s/g) ?? []).length;
          if (!count) return '';
          changes.count = String(count);
        }
        return rebuild(source, node, changes, body);
      };
      zip.file(
        part.path,
        source.slice(0, part.root.start) + render(part.root) + source.slice(part.root.end),
      );
    }
    const replacements: { start: number; end: number; text: string }[] = [];
    if (op.kind === 'rename_sheet') {
      const node = sheetNodes.find((n) => n.attributes.sheetId === op.sheetId)!;
      replacements.push({
        start: node.start,
        end: node.end,
        text: rebuild(workbook, node, { name: op.name }),
      });
    }
    for (const name of child(root, 'definedNames')?.children ?? []) {
      const owner =
        name.attributes.localSheetId === undefined
          ? ''
          : (sheetNodes[Number(name.attributes.localSheetId)]?.attributes.name ?? '');
      const rewritten = rewriteFormula(xmlText(workbook, name), owner, target!.name, op);
      replacements.push({
        start: name.start,
        end: name.end,
        text: rebuild(workbook, name, {}, textXml(rewritten)),
      });
    }
    workbook = replaceSpans(workbook, replacements);
  }
  const currentRoot = xmlTree(workbook),
    calc = child(currentRoot, 'calcPr'),
    following = currentRoot.children.find((node) =>
      [
        'oleSize',
        'customWorkbookViews',
        'pivotCaches',
        'smartTagPr',
        'smartTagTypes',
        'webPublishing',
        'fileRecoveryPr',
        'webPublishObjects',
        'extLst',
      ].includes(node.local),
    ),
    at = calc?.start ?? following?.start ?? currentRoot.closeStart;
  const calcXml = calc
    ? rebuild(workbook, calc, { fullCalcOnLoad: '1', forceFullCalc: '1', calcMode: 'auto' })
    : `<${prefix(currentRoot.name)}calcPr fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/>`;
  zip.file(
    'xl/workbook.xml',
    replaceSpans(workbook, [{ start: at, end: calc?.end ?? at, text: calcXml }]),
  );
  for (const path of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    const source = await xml(zip, path),
      tree = xmlTree(source),
      remove = tree.children.filter((node) =>
        path.endsWith('.rels')
          ? node.attributes.Type?.endsWith('/calcChain')
          : node.attributes.ContentType?.endsWith('.calcChain+xml'),
      );
    for (const node of remove)
      if (node.attributes.Target)
        zip.remove(
          node.attributes.Target.startsWith('/')
            ? node.attributes.Target.slice(1)
            : posix.normalize(posix.join('xl', node.attributes.Target)),
        );
    if (remove.length)
      zip.file(
        path,
        replaceSpans(
          source,
          remove.map((node) => ({ start: node.start, end: node.end, text: '' })),
        ),
      );
  }
  if ((op.kind === 'add_sheet' || op.kind === 'rename_sheet') && zip.file('docProps/app.xml')) {
    // Optional derived sheet-title metadata is regenerated by Office on next save.
    const source = await xml(zip, 'docProps/app.xml'),
      root = xmlTree(source);
    zip.file(
      'docProps/app.xml',
      replaceSpans(
        source,
        root.children
          .filter((n) => ['HeadingPairs', 'TitlesOfParts'].includes(n.local))
          .map((n) => ({ start: n.start, end: n.end, text: '' })),
      ),
    );
  }
  const output = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  if (output.length > NATIVE_FILE_LIMIT)
    fail('XLSX_LIMIT', '结构修改后的文件超过 50 MiB，未覆盖原文件。');
  return output;
}
