import JSZip from 'jszip';
import { posix } from 'node:path';
import { fail } from '../../../contracts/index.js';
import { cellPosition, columnLabel, type StructureEdit } from '../../../contracts/xlsx.js';
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
import { rewriteFormula, translateFormula } from './xlsx-references.js';
import type { Parsed } from './xlsx-editor.js';
const raw = (s: string, n: XmlNode) => s.slice(n.start, n.end);
const build = (
  s: string,
  n: XmlNode,
  a: Record<string, string | undefined> = {},
  body = s.slice(n.openEnd, n.closeStart),
) => (body ? `<${n.name}${attrs(n, a)}>${body}</${n.name}>` : `<${n.name}${attrs(n, a)}/>`);
function walk(node: XmlNode): XmlNode[] {
  return [node, ...node.children.flatMap(walk)];
}
function replaceChild(
  source: string,
  root: XmlNode,
  name: string,
  value: string,
  before: string[] = [],
) {
  const node = child(root, name),
    at =
      node?.start ?? root.children.find((n) => before.includes(n.local))?.start ?? root.closeStart;
  return replaceSpans(source, [{ start: at, end: node?.end ?? at, text: value }]);
}
const refuse = (s: string): never => fail('XLSX_STRUCTURE_UNSUPPORTED', s);
export const advancedKinds = new Set([
  'copy_sheet',
  'move_sheet',
  'delete_sheet',
  'row_layout',
  'column_layout',
  'freeze',
  'fill_range',
  'sort_range',
]);
export async function advancedStructure(bytes: Buffer, parsed: Parsed, op: StructureEdit) {
  const zip = await JSZip.loadAsync(bytes),
    root = xmlTree(parsed.workbookSource),
    sheets = child(root, 'sheets')!,
    nodes = children(sheets, 'sheet'),
    target = parsed.parts.find((p) => p.id === op.sheetId);
  if (!target) fail('XLSX_SHEET', '工作表不存在。');
  if (child(target.root, 'sheetProtection')) fail('XLSX_READ_ONLY', '受保护工作表不能修改。');
  let workbook = parsed.workbookSource;
  const managing = ['copy_sheet', 'move_sheet', 'delete_sheet'].includes(op.kind);
  if (managing) {
    if (nodes.length !== parsed.parts.length || child(root, 'customWorkbookViews'))
      refuse('含图表工作表或自定义视图的工作簿暂不支持工作表管理。');
    // Reordering a sheet can change the meaning of 3-D references without changing their text.
    for (const part of parsed.parts)
      for (const n of walk(part.root).filter((n) =>
        ['f', 'formula', 'formula1', 'formula2'].includes(n.local),
      ))
        rewriteFormula(xmlText(part.source, n), part.name, target.name, {
          kind: 'rename_sheet',
          sheetId: target.id,
          name: target.name,
        });
    for (const n of child(root, 'definedNames')?.children ?? [])
      rewriteFormula(xmlText(workbook, n), '', target.name, {
        kind: 'rename_sheet',
        sheetId: target.id,
        name: target.name,
      });
    if (
      op.kind !== 'move_sheet' &&
      (Object.keys(zip.files).some((p) =>
        /^xl\/(charts|tables|pivot|externalLinks|slicers|drawings|queryTables|threadedComments)/i.test(
          p,
        ),
      ) ||
        parsed.parts.some((p) =>
          p.root.children.some((n) =>
            ['extLst', 'oleObjects', 'controls', 'legacyDrawing'].includes(n.local),
          ),
        ))
    )
      refuse('此工作簿有关联图表、透视表、绘图或扩展部件，暂不能复制或删除工作表。');
    let order = [...nodes],
      newNode = '',
      newId = '';
    const oldIndex = nodes.findIndex((n) => n.attributes.sheetId === op.sheetId);
    if (op.kind === 'copy_sheet') {
      if (nodes.length >= 200 || nodes.some((n) => n.attributes.sheetId === op.newSheetId))
        fail('XLSX_LIMIT', '新工作表标识冲突或已达 200 张表。');
      if (nodes.some((n) => n.attributes.name.toLowerCase() === op.name.toLowerCase()))
        fail('XLSX_SHEET_NAME', '工作表名称已存在。');
      const relFile = posix.join(
          posix.dirname(target.path),
          '_rels',
          posix.basename(target.path) + '.rels',
        ),
        relations = zip.file(relFile) ? await xml(zip, relFile) : null;
      if (
        relations &&
        xmlTree(relations).children.some(
          (n) =>
            n.attributes.TargetMode !== 'External' || !n.attributes.Type?.endsWith('/hyperlink'),
        )
      )
        refuse('工作表带内部关联部件，暂不能复制。');
      if (
        walk(target.root).some(
          (n) => n.local === 'f' && n.attributes.t && n.attributes.t !== 'normal',
        )
      )
        refuse('共享或数组公式工作表暂不能复制。');
      let path = `xl/worksheets/desktop-copy-${op.newSheetId}.xml`;
      while (zip.file(path)) path = path.replace(/\.xml$/, '_.xml');
      const renaming: StructureEdit = { kind: 'rename_sheet', sheetId: op.sheetId, name: op.name };
      let source = replaceSpans(
        target.source,
        walk(target.root)
          .filter((n) => ['f', 'formula', 'formula1', 'formula2'].includes(n.local))
          .map((n) => ({
            start: n.start,
            end: n.end,
            text: build(
              target.source,
              n,
              {},
              textXml(
                rewriteFormula(xmlText(target.source, n), target.name, target.name, renaming),
              ),
            ),
          })),
      );
      source = replaceSpans(
        source,
        walk(xmlTree(source))
          .filter((n) => n.local === 'sheetView')
          .map((n) => ({
            start: n.start,
            end: n.end,
            text: build(source, n, { tabSelected: undefined }),
          })),
      );
      zip.file(path, source);
      if (relations)
        zip.file(
          posix.join(posix.dirname(path), '_rels', posix.basename(path) + '.rels'),
          relations,
        );
      const relSource = await xml(zip, 'xl/_rels/workbook.xml.rels'),
        relRoot = xmlTree(relSource);
      let rid = `rIdDesktopCopy${op.newSheetId}`;
      while (relRoot.children.some((n) => n.attributes.Id === rid)) rid += '_';
      zip.file(
        'xl/_rels/workbook.xml.rels',
        build(
          relSource,
          relRoot,
          {},
          relSource.slice(relRoot.openEnd, relRoot.closeStart) +
            `<${prefix(relRoot.name)}Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${escape(posix.relative('xl', path))}"/>`,
        ),
      );
      const types = await xml(zip, '[Content_Types].xml'),
        tr = xmlTree(types);
      zip.file(
        '[Content_Types].xml',
        build(
          types,
          tr,
          {},
          types.slice(tr.openEnd, tr.closeStart) +
            `<${prefix(tr.name)}Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        ),
      );
      const node = nodes[oldIndex],
        ridName = Object.keys(node.attributes).find((k) => k.endsWith(':id')) ?? 'r:id';
      newId = op.newSheetId;
      newNode = build(workbook, node, {
        sheetId: newId,
        name: op.name,
        state: undefined,
        [ridName]: rid,
      });
    } else if (op.kind === 'delete_sheet') {
      if (
        nodes.length === 1 ||
        (nodes[oldIndex].attributes.state !== 'hidden' &&
          nodes[oldIndex].attributes.state !== 'veryHidden' &&
          nodes.filter((n) => !n.attributes.state || n.attributes.state === 'visible').length === 1)
      )
        fail('XLSX_SHEET', '不能删除最后一张可见工作表。');
      for (const part of parsed.parts) {
        if (part.id === target.id) continue;
        const replacements = [];
        for (const n of walk(part.root))
          if (['f', 'formula', 'formula1', 'formula2'].includes(n.local)) {
            if (n.local === 'f' && n.attributes.t && n.attributes.t !== 'normal')
              refuse('删除工作表前请先处理共享或数组公式。');
            const value = xmlText(part.source, n),
              next = rewriteFormula(value, part.name, target.name, op);
            if (next !== value) {
              if (child(part.root, 'sheetProtection'))
                fail('XLSX_READ_ONLY', '删除会修改受保护表的公式。');
              replacements.push({
                start: n.start,
                end: n.end,
                text: build(part.source, n, {}, textXml(next)),
              });
            }
          }
        zip.file(part.path, replaceSpans(part.source, replacements));
      }
      order = nodes.filter((n) => n.attributes.sheetId !== op.sheetId);
      zip.remove(target.path);
      zip.remove(
        posix.join(posix.dirname(target.path), '_rels', posix.basename(target.path) + '.rels'),
      );
      const rels = await xml(zip, 'xl/_rels/workbook.xml.rels'),
        rr = xmlTree(rels),
        rid =
          nodes[oldIndex].attributes[
            Object.keys(nodes[oldIndex].attributes).find((k) => k.endsWith(':id'))!
          ];
      zip.file(
        'xl/_rels/workbook.xml.rels',
        replaceSpans(
          rels,
          rr.children
            .filter((n) => n.attributes.Id === rid)
            .map((n) => ({ start: n.start, end: n.end, text: '' })),
        ),
      );
      const types = await xml(zip, '[Content_Types].xml');
      zip.file(
        '[Content_Types].xml',
        replaceSpans(
          types,
          xmlTree(types)
            .children.filter((n) => n.attributes.PartName === `/${target.path}`)
            .map((n) => ({ start: n.start, end: n.end, text: '' })),
        ),
      );
    } else if (op.kind === 'move_sheet') {
      if (op.position > nodes.length) fail('XLSX_SHEET', '移动位置超出工作表数量。');
      const [node] = order.splice(oldIndex, 1);
      order.splice(op.position - 1, 0, node);
    }
    const mapIndex = (i: number) =>
        order.findIndex((n) => n.attributes.sheetId === nodes[i]?.attributes.sheetId),
      replacements = [
        {
          start: sheets.start,
          end: sheets.end,
          text: build(workbook, sheets, {}, order.map((n) => raw(workbook, n)).join('') + newNode),
        },
      ];
    const names = child(root, 'definedNames');
    if (names) {
      let body = '';
      for (const n of names.children) {
        const local = n.attributes.localSheetId,
          index = local === undefined ? undefined : mapIndex(Number(local));
        if (index !== undefined && index < 0) continue;
        const owner = local === undefined ? '' : (nodes[Number(local)]?.attributes.name ?? ''),
          value =
            op.kind === 'delete_sheet'
              ? rewriteFormula(xmlText(workbook, n), owner, target.name, op)
              : xmlText(workbook, n);
        body += build(
          workbook,
          n,
          { localSheetId: index === undefined ? undefined : String(index) },
          textXml(value),
        );
        if (op.kind === 'copy_sheet' && Number(local) === oldIndex && local !== undefined)
          body += build(
            workbook,
            n,
            { localSheetId: String(nodes.length) },
            textXml(
              rewriteFormula(xmlText(workbook, n), owner, target.name, {
                kind: 'rename_sheet',
                sheetId: target.id,
                name: op.name,
              }),
            ),
          );
      }
      replacements.push({
        start: names.start,
        end: names.end,
        text: build(workbook, names, {}, body),
      });
    }
    const firstVisible = order.findIndex(
      (n) => !n.attributes.state || n.attributes.state === 'visible',
    );
    for (const n of child(root, 'bookViews')?.children ?? []) {
      const remap = (key: string) => {
        const index = mapIndex(Number(n.attributes[key] ?? 0));
        return String(index < 0 ? Math.max(0, firstVisible) : index);
      };
      replacements.push({
        start: n.start,
        end: n.end,
        text: build(workbook, n, {
          activeTab:
            op.kind === 'copy_sheet'
              ? String(nodes.length)
              : op.kind === 'move_sheet'
                ? String(order.findIndex((n) => n.attributes.sheetId === op.sheetId))
                : String(Math.max(0, firstVisible)),
          firstSheet: remap('firstSheet'),
        }),
      });
    }
    workbook = replaceSpans(workbook, replacements);
    for (const part of parsed.parts) {
      if (op.kind === 'delete_sheet' && part.id === target.id) continue;
      const source = await xml(zip, part.path);
      zip.file(
        part.path,
        replaceSpans(
          source,
          walk(xmlTree(source))
            .filter((n) => n.local === 'sheetView')
            .map((n) => ({
              start: n.start,
              end: n.end,
              text: build(source, n, { tabSelected: undefined }),
            })),
        ),
      );
    }
  } else {
    const source = target.source,
      pr = prefix(target.root.name);
    let next = source;
    if (op.kind === 'row_layout') {
      if (op.end < op.start || op.end - op.start >= 1000)
        fail('XLSX_LIMIT', '每次调整最多 1000 行。');
      const data = child(target.root, 'sheetData')!,
        rows = new Map(children(data, 'row').map((n) => [Number(n.attributes.r), raw(source, n)]));
      for (let r = op.start; r <= op.end; r++) {
        const n = children(data, 'row').find((n) => Number(n.attributes.r) === r);
        const a = {
          ht: op.size === undefined ? n?.attributes.ht : String(op.size),
          customHeight: op.size === undefined ? n?.attributes.customHeight : '1',
          hidden: op.hidden === undefined ? n?.attributes.hidden : op.hidden ? '1' : undefined,
        };
        rows.set(
          r,
          n
            ? build(source, n, a)
            : `<${pr}row r="${r}"${attrs({ attributes: {} } as XmlNode, a)}/>`,
        );
      }
      next = replaceSpans(source, [
        {
          start: data.start,
          end: data.end,
          text: build(
            source,
            data,
            {},
            [...rows]
              .sort(([a], [b]) => a - b)
              .map(([, v]) => v)
              .join(''),
          ),
        },
      ]);
    } else if (op.kind === 'column_layout') {
      if (op.end < op.start || op.end - op.start >= 1000)
        fail('XLSX_LIMIT', '每次调整最多 1000 列。');
      const cols = child(target.root, 'cols'),
        values = new Map<number, Record<string, string | undefined>>();
      for (const n of cols?.children ?? [])
        for (let i = Number(n.attributes.min); i <= Math.min(16384, Number(n.attributes.max)); i++)
          values.set(i, { ...n.attributes });
      for (let i = op.start; i <= op.end; i++) {
        const v = values.get(i) ?? {};
        if (op.size !== undefined) {
          v.width = String(op.size);
          v.customWidth = '1';
        }
        if (op.hidden !== undefined) v.hidden = op.hidden ? '1' : undefined;
        values.set(i, v);
      }
      const body = [...values]
        .sort(([a], [b]) => a - b)
        .map(
          ([i, a]) =>
            `<${pr}col${attrs({ attributes: {} } as XmlNode, { ...a, min: String(i), max: String(i) })}/>`,
        )
        .join('');
      next = replaceChild(source, target.root, 'cols', `<${pr}cols>${body}</${pr}cols>`, [
        'sheetData',
      ]);
    } else if (op.kind === 'freeze') {
      const views = child(target.root, 'sheetViews'),
        view = views && child(views, 'sheetView'),
        pane =
          op.rows || op.columns
            ? `<${pr}pane xSplit="${op.columns}" ySplit="${op.rows}" topLeftCell="${columnLabel(op.columns + 1)}${op.rows + 1}" activePane="${op.rows && op.columns ? 'bottomRight' : op.rows ? 'bottomLeft' : 'topRight'}" state="frozen"/>`
            : '';
      const body =
        pane +
        (view?.children
          .filter((n) => !['pane', 'selection'].includes(n.local))
          .map((n) => raw(source, n))
          .join('') ?? '');
      const viewXml = view
        ? build(source, view, {}, body)
        : `<${pr}sheetView workbookViewId="0">${body}</${pr}sheetView>`;
      next = replaceChild(
        source,
        target.root,
        'sheetViews',
        views
          ? build(
              source,
              views,
              {},
              viewXml +
                views.children
                  .filter((n) => n !== view)
                  .map((n) => raw(source, n))
                  .join(''),
            )
          : `<${pr}sheetViews>${viewXml}</${pr}sheetViews>`,
        ['sheetFormatPr', 'cols', 'sheetData'],
      );
    } else if (op.kind === 'fill_range' || op.kind === 'sort_range') {
      const a = cellPosition(op.from),
        b = cellPosition(op.to);
      if (
        !a ||
        !b ||
        b.row < a.row ||
        b.column < a.column ||
        (b.row - a.row + 1) * (b.column - a.column + 1) > 2000
      )
        fail('XLSX_LIMIT', '填充与排序最多 2000 格，区域不能倒置。');
      for (let r = a.row; r <= b.row; r++)
        for (let c = a.column; c <= b.column; c++) {
          const n = target.cells.get(columnLabel(c) + r),
            f = n && child(n, 'f');
          if (
            (n && (n.attributes.cm || n.attributes.vm || child(n, 'extLst'))) ||
            (f?.attributes.t && f.attributes.t !== 'normal') ||
            target.blocked.some(
              (range) =>
                r >= range.from.row &&
                r <= range.to.row &&
                c >= range.from.column &&
                c <= range.to.column,
            )
          )
            refuse('选区包含共享、数组、溢出或扩展单元格，暂不支持填充或排序。');
        }
      if (
        target.root.children.some((n) =>
          [
            'mergeCells',
            'conditionalFormatting',
            'dataValidations',
            'hyperlinks',
            'tableParts',
            'drawing',
            'legacyDrawing',
            'extLst',
          ].includes(n.local),
        )
      )
        refuse('有合并、批注、链接、条件格式或关联部件的工作表暂不支持区域填充和排序。');
      const map = new Map<string, string>();
      for (const [address, n] of target.cells) map.set(address, raw(source, n));
      const copy = (from: string, to: string) => {
        const n = target.cells.get(from);
        if (!n) {
          map.delete(to);
          return;
        }
        if (n.attributes.cm || n.attributes.vm || child(n, 'extLst'))
          refuse('扩展单元格暂不支持填充或排序。');
        const f = child(n, 'f');
        if (f?.attributes.t && f.attributes.t !== 'normal')
          refuse('共享、数组及溢出公式暂不支持填充或排序。');
        let body = source.slice(n.openEnd, n.closeStart);
        if (f) {
          const p = cellPosition(from)!,
            q = cellPosition(to)!;
          body = n.children
            .filter((c) => c.local !== 'v')
            .map((c) =>
              c === f
                ? build(
                    source,
                    c,
                    {},
                    textXml(
                      translateFormula(xmlText(source, c), q.row - p.row, q.column - p.column),
                    ),
                  )
                : raw(source, c),
            )
            .join('');
        }
        map.set(to, build(source, n, { r: to }, body));
      };
      if (op.kind === 'fill_range')
        for (let r = a.row; r <= b.row; r++)
          for (let c = a.column; c <= b.column; c++)
            copy(
              columnLabel(op.direction === 'right' ? a.column : c) +
                (op.direction === 'down' ? a.row : r),
              columnLabel(c) + r,
            );
      else {
        if (op.keyColumn < a.column || op.keyColumn > b.column)
          fail('XLSX_CELL', '排序列必须位于选区内。');
        const start = a.row + (op.header ? 1 : 0),
          ws = parsed.book.getWorksheet(Number(target.id))!,
          rows = Array.from({ length: Math.max(0, b.row - start + 1) }, (_, i) => start + i);
        if (rows.some((r) => ws.getCell(r, op.keyColumn).type === 6))
          refuse('排序键含公式，请先使用值列排序，避免依据过期缓存排序。');
        const value = (r: number) => ws.getCell(r, op.keyColumn).value;
        const compare = (x: number, y: number) => {
          let l = value(x),
            r = value(y);
          const empty = (v: unknown) => v === null || v === undefined || v === '';
          if (empty(l) || empty(r)) return empty(l) ? (empty(r) ? x - y : 1) : -1;
          let n =
            typeof l === 'number' && typeof r === 'number'
              ? l - r
              : String(ws.getCell(x, op.keyColumn).text).localeCompare(
                  String(ws.getCell(y, op.keyColumn).text),
                  'zh-CN',
                  { numeric: true },
                );
          return (op.descending ? -n : n) || x - y;
        };
        rows.sort(compare);
        rows.forEach((r, i) => {
          for (let c = a.column; c <= b.column; c++)
            copy(columnLabel(c) + r, columnLabel(c) + (start + i));
        });
      }
      const data = child(target.root, 'sheetData')!,
        rowNodes = new Map(children(data, 'row').map((n) => [Number(n.attributes.r), n])),
        byRow = new Map<number, string[]>();
      for (const [address, value] of [...map].sort(([a], [b]) => {
        const p = cellPosition(a)!,
          q = cellPosition(b)!;
        return p.row - q.row || p.column - q.column;
      })) {
        const r = cellPosition(address)!.row;
        if (!byRow.has(r)) byRow.set(r, []);
        byRow.get(r)!.push(value);
      }
      for (const r of rowNodes.keys()) if (!byRow.has(r)) byRow.set(r, []);
      const body = [...byRow]
        .sort(([a], [b]) => a - b)
        .map(([r, cells]) => {
          const n = rowNodes.get(r);
          return n
            ? build(
                source,
                n,
                { spans: undefined },
                cells.join('') +
                  n.children
                    .filter((n) => n.local !== 'c')
                    .map((n) => raw(source, n))
                    .join(''),
              )
            : `<${pr}row r="${r}">${cells.join('')}</${pr}row>`;
        })
        .join('');
      next = replaceSpans(source, [
        { start: data.start, end: data.end, text: build(source, data, {}, body) },
      ]);
      const dimension = child(xmlTree(next), 'dimension');
      if (dimension)
        next = replaceSpans(next, [
          {
            start: dimension.start,
            end: dimension.end,
            text: build(next, dimension, {
              ref: `A1:${columnLabel(Math.max(target.columns, b.column))}${Math.max(target.rows, b.row)}`,
            }),
          },
        ]);
    }
    zip.file(target.path, next);
  }
  zip.file('xl/workbook.xml', workbook);
  // Drop derived caches, retaining source formulas for normal recalculation on save/open.
  for (const path of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    const s = await xml(zip, path),
      r = xmlTree(s),
      remove = r.children.filter(
        (n) =>
          n.attributes.Type?.endsWith('/calcChain') ||
          n.attributes.ContentType?.endsWith('.calcChain+xml'),
      );
    for (const n of remove)
      if (n.attributes.Target)
        zip.remove(
          n.attributes.Target.startsWith('/')
            ? n.attributes.Target.slice(1)
            : posix.normalize(posix.join('xl', n.attributes.Target)),
        );
    zip.file(
      path,
      replaceSpans(
        s,
        remove.map((n) => ({ start: n.start, end: n.end, text: '' })),
      ),
    );
  }
  if (managing && zip.file('docProps/app.xml')) {
    const s = await xml(zip, 'docProps/app.xml');
    zip.file(
      'docProps/app.xml',
      replaceSpans(
        s,
        xmlTree(s)
          .children.filter((n) => ['HeadingPairs', 'TitlesOfParts'].includes(n.local))
          .map((n) => ({ start: n.start, end: n.end, text: '' })),
      ),
    );
  }
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (out.length > NATIVE_FILE_LIMIT) fail('XLSX_LIMIT', '保存后的文件超过 50 MiB。');
  return out;
}
