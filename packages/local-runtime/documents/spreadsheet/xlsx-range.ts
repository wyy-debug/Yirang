import JSZip from 'jszip';
import { fail } from '../../../contracts/index.js';
import { cellPosition, columnLabel, type StructureEdit } from '../../../contracts/xlsx.js';
import type { Parsed } from './xlsx-editor.js';
import {
  xml,
  xmlTree,
  child,
  children,
  prefix,
  attrs,
  escape,
  replaceSpans,
  type XmlNode,
} from './xlsx-xml.js';
const raw = (s: string, n: XmlNode) => s.slice(n.start, n.end);
const build = (
  s: string,
  n: XmlNode,
  changes: Record<string, string | undefined>,
  body = s.slice(n.openEnd, n.closeStart),
) => `<${n.name}${attrs(n, changes)}>${body}</${n.name}>`;
const rangeKinds = new Set(['merge_cells', 'unmerge_cells', 'filter_range', 'conditional_format']);
export { rangeKinds };
export async function rangeStructure(bytes: Buffer, parsed: Parsed, operation: StructureEdit) {
  const op = operation as any,
    part = parsed.parts.find((p) => p.id === op.sheetId);
  if (!part) fail('XLSX_SHEET', '工作表不存在。');
  if (child(part.root, 'sheetProtection')) fail('XLSX_READ_ONLY', '工作表已保护。');
  const a = cellPosition(op.from),
    b = cellPosition(op.to);
  if (
    !a ||
    !b ||
    a.row > b.row ||
    a.column > b.column ||
    (b.row - a.row + 1) * (b.column - a.column + 1) > 10000
  )
    fail('XLSX_RANGE', '范围无效或超过 10000 格。');
  const zip = await JSZip.loadAsync(bytes),
    ref = `${op.from}:${op.to}`,
    p = prefix(part.root.name),
    sheet = parsed.book.getWorksheet(Number(part.id))!;
  let source = part.source;
  const replace = (name: string, value: string, before: string[]) => {
    const root = xmlTree(source),
      old = child(root, name),
      at =
        old?.start ?? root.children.find((n) => before.includes(n.local))?.start ?? root.closeStart;
    source = replaceSpans(source, [{ start: at, end: old?.end ?? at, text: value }]);
  };
  if (op.kind === 'merge_cells' || op.kind === 'unmerge_cells') {
    const merges = child(part.root, 'mergeCells'),
      items = merges?.children ?? [],
      intersects = (r: string) => {
        const [first, last = first] = r.split(':'),
          x = cellPosition(first)!,
          y = cellPosition(last)!;
        return x.row <= b.row && y.row >= a.row && x.column <= b.column && y.column >= a.column;
      };
    if (op.kind === 'merge_cells') {
      if (items.some((n) => intersects(n.attributes.ref)))
        fail('XLSX_MERGE', '范围与已有合并单元格重叠，请先取消合并。');
      for (let r = a.row; r <= b.row; r++)
        for (let c = a.column; c <= b.column; c++)
          if ((r !== a.row || c !== a.column) && sheet.getCell(r, c).value !== null)
            fail('XLSX_MERGE', '合并会隐藏其他单元格内容，请先移走这些内容。');
    }
    const next =
      op.kind === 'merge_cells'
        ? [...items.map((n) => raw(part.source, n)), `<${p}mergeCell ref="${ref}"/>`]
        : items.filter((n) => !intersects(n.attributes.ref)).map((n) => raw(part.source, n));
    replace(
      'mergeCells',
      next.length ? `<${p}mergeCells count="${next.length}">${next.join('')}</${p}mergeCells>` : '',
      [
        'phoneticPr',
        'conditionalFormatting',
        'dataValidations',
        'hyperlinks',
        'printOptions',
        'pageMargins',
        'pageSetup',
        'drawing',
        'extLst',
      ],
    );
  } else if (op.kind === 'filter_range') {
    const metadataPath = 'customXml/ai-desktop-filters.xml',
      metadataSource = zip.file(metadataPath)
        ? await xml(zip, metadataPath)
        : '<filters xmlns="urn:ai-desktop:filters"/>',
      metadata = xmlTree(metadataSource),
      previous = metadata.children.find((n) => n.attributes.sheet === op.sheetId),
      prior = previous ? JSON.parse(previous.attributes.rows ?? '{}') : {};
    const column = Number(op.column);
    if (column < a.column || column > b.column) fail('XLSX_FILTER', '筛选列不在范围内。');
    if (
      !op.clear &&
      Array.from({ length: b.row - a.row }, (_, i) => sheet.getCell(a.row + i + 1, column)).some(
        (c) => c.type === 6,
      )
    )
      fail('XLSX_FILTER', '公式列请先转换为明确的筛选值；不能按过期缓存筛选。');
    const original = new Map<number, boolean>(
        Object.entries(prior).map(([r, h]) => [Number(r), !!h]),
      ),
      changes = new Map<number, boolean>();
    for (const [r, h] of original) changes.set(r, h);
    if (!op.clear)
      for (let r = a.row + 1; r <= b.row; r++) {
        const hidden = original.get(r) ?? sheet.getRow(r).hidden;
        original.set(r, hidden);
        const value = sheet.getCell(r, column).text,
          match =
            op.match === 'contains'
              ? value.toLocaleLowerCase().includes(op.value.toLocaleLowerCase())
              : value === op.value;
        changes.set(r, hidden || !match);
      }
    const data = child(part.root, 'sheetData')!,
      rows = new Map(
        data.children.filter((n) => n.local === 'row').map((n) => [Number(n.attributes.r), n]),
      ),
      allRows = new Set([...rows.keys(), ...changes.keys()]);
    const body = [...allRows]
      .sort((x, y) => x - y)
      .map((r) => {
        const node = rows.get(r),
          hidden = changes.get(r);
        return node
          ? build(
              part.source,
              node,
              hidden === undefined ? {} : { hidden: hidden ? '1' : undefined },
            )
          : `<${p}row r="${r}"${hidden ? ' hidden="1"' : ''}/>`;
      })
      .join('');
    source = replaceSpans(source, [
      { start: data.start, end: data.end, text: build(part.source, data, {}, body) },
    ]);
    replace(
      'autoFilter',
      op.clear
        ? ''
        : `<${p}autoFilter ref="${ref}"><${p}filterColumn colId="${column - a.column}">${op.match === 'contains' ? `<${p}customFilters><${p}customFilter operator="equal" val="*${escape(op.value.replace(/([~*?])/g, '~$1'))}*"/></${p}customFilters>` : `<${p}filters><${p}filter val="${escape(op.value)}"/></${p}filters>`}</${p}filterColumn></${p}autoFilter>`,
      [
        'sortState',
        'dataConsolidate',
        'customSheetViews',
        'mergeCells',
        'conditionalFormatting',
        'dataValidations',
        'hyperlinks',
        'pageMargins',
        'extLst',
      ],
    );
    const rest = metadata.children
      .filter((n) => n !== previous)
      .map((n) => raw(metadataSource, n))
      .join('');
    zip.file(
      metadataPath,
      `<filters xmlns="urn:ai-desktop:filters">${rest}${op.clear ? '' : `<sheet sheet="${op.sheetId}" rows="${escape(JSON.stringify(Object.fromEntries(original)))}"/>`}</filters>`,
    );
    const relpath = '_rels/.rels',
      rels = await xml(zip, relpath),
      root = xmlTree(rels);
    if (!root.children.some((n) => n.attributes.Target === metadataPath))
      zip.file(
        relpath,
        replaceSpans(rels, [
          {
            start: root.closeStart,
            end: root.closeStart,
            text: `<Relationship Id="aiDesktopFilter${Date.now()}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="${metadataPath}"/>`,
          },
        ]),
      );
  } else {
    const root = xmlTree(source),
      rules = root.children.filter(
        (n) => n.local === 'conditionalFormatting' && n.attributes.sqref === ref,
      );
    if (op.clear)
      source = replaceSpans(
        source,
        rules.map((n) => ({ start: n.start, end: n.end, text: '' })),
      );
    else {
      if (!parsed.stylesPath) fail('XLSX_FORMAT', '此工作簿没有样式部件。');
      const styles = await xml(zip, parsed.stylesPath),
        sroot = xmlTree(styles),
        dxfs = child(sroot, 'dxfs'),
        dxfId = dxfs?.children.length ?? 0,
        sp = prefix(sroot.name),
        dxf = `<${sp}dxf><${sp}fill><${sp}patternFill patternType="solid"><${sp}fgColor rgb="FF${op.color.slice(1).toUpperCase()}"/><${sp}bgColor indexed="64"/></${sp}patternFill></${sp}fill></${sp}dxf>`;
      const replacement = dxfs
          ? build(
              styles,
              dxfs,
              { count: String(dxfId + 1) },
              styles.slice(dxfs.openEnd, dxfs.closeStart) + dxf,
            )
          : `<${sp}dxfs count="1">${dxf}</${sp}dxfs>`,
        at =
          dxfs?.start ??
          sroot.children.find((n) => ['tableStyles', 'colors', 'extLst'].includes(n.local))
            ?.start ??
          sroot.closeStart;
      zip.file(
        parsed.stylesPath,
        replaceSpans(styles, [{ start: at, end: dxfs?.end ?? at, text: replacement }]),
      );
      const priority =
          1 +
          Math.max(
            0,
            ...root.children
              .filter((n) => n.local === 'conditionalFormatting')
              .flatMap((n) => n.children.map((r) => Number(r.attributes.priority) || 0)),
          ),
        atRule =
          root.children.find((n) =>
            ['dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'extLst'].includes(
              n.local,
            ),
          )?.start ?? root.closeStart;
      source = replaceSpans(source, [
        {
          start: atRule,
          end: atRule,
          text: `<${p}conditionalFormatting sqref="${ref}"><${p}cfRule type="cellIs" dxfId="${dxfId}" priority="${priority}" operator="${op.operator}"><${p}formula>${op.value}</${p}formula></${p}cfRule></${p}conditionalFormatting>`,
        },
      ]);
    }
  }
  zip.file(part.path, source);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
