import { expandEditedSharedFormulas } from './xlsx-shared-formulas.js';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  xmlTree,
  children,
  child,
  prefix,
  escape,
  textXml,
  attrs,
  replaceSpans,
  xml,
  xmlText,
  type XmlNode,
} from './xlsx-xml.js';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from '../../../contracts/index.js';
import {
  cellPosition,
  columnLabel,
  type SheetEdit,
  type XlsxCell,
  type XlsxPage,
  type XlsxCalculation,
  type StructureEdit,
} from '../../../contracts/xlsx.js';
import { NATIVE_FILE_LIMIT } from '../../../components/native-files.js';
import { XlsxStyles, EMPTY_STYLES } from './xlsx-styles.js';
import { XlsxCalculator, editValue } from './xlsx-calculation.js';
import { changeStructure, structureBlocked } from './xlsx-structure.js';

type SheetPart = {
  id: string;
  name: string;
  path: string;
  source: string;
  root: XmlNode;
  cells: Map<string, XmlNode>;
  rows: number;
  columns: number;
  blocked: { from: { row: number; column: number }; to: { row: number; column: number } }[];
};
export type Parsed = {
  zip: JSZip;
  book: ExcelJS.Workbook;
  workbookSource: string;
  parts: SheetPart[];
  signed: boolean;
  date1904: boolean;
  stylesPath?: string;
};
type WriteContext = { styles: XlsxStyles; calculator: XlsxCalculator; recalculate: boolean };
export class XlsxEditor {
  private cache = new Map<string, Promise<Parsed>>();
  private prepared = new Map<string, Promise<{ bytes: Buffer; hash: string }>>();
  private async prepare(
    bytes: Buffer,
    hash: string,
    operations: StructureEdit[] = [],
  ): Promise<{ bytes: Buffer; hash: string }> {
    if (!operations.length) return { bytes, hash };
    const payload = JSON.stringify(operations);
    if (
      Buffer.byteLength(payload) > 2 * 1024 * 1024 ||
      operations.length > 30 ||
      operations.reduce((n, op) => n + (op.editsBefore?.length ?? 0), 0) > 2000
    )
      fail('XLSX_LIMIT', '一次最多 30 次结构操作、2000 格编辑 / 2 MiB 草稿，请先保存。');
    const key = createHash('sha256').update(hash).update(payload).digest('hex'),
      cached = this.prepared.get(key);
    if (cached) return cached;
    const pending = (async () => {
      for (const op of operations) {
        if (op.editsBefore?.length) {
          bytes = await this.patch(bytes, hash, op.editsBefore);
          hash = createHash('sha256').update(bytes).digest('hex');
        }
        bytes = await changeStructure(bytes, await this.parse(bytes, hash), op);
        hash = createHash('sha256').update(bytes).digest('hex');
      }
      return { bytes, hash };
    })();
    this.prepared.set(key, pending);
    while (this.prepared.size > 3) this.prepared.delete(this.prepared.keys().next().value!);
    try {
      return await pending;
    } catch (error) {
      this.prepared.delete(key);
      throw error;
    }
  }
  async save(bytes: Buffer, hash: string, edits: SheetEdit[], operations: StructureEdit[] = []) {
    const draft = await this.prepare(bytes, hash, operations);
    return this.patch(draft.bytes, draft.hash, edits, operations.length > 0);
  }
  async parse(bytes: Buffer, hash: string) {
    let pending = this.cache.get(hash);
    if (pending) return pending;
    pending = this.load(bytes);
    this.cache.set(hash, pending);
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value!);
    try {
      return await pending;
    } catch (error) {
      this.cache.delete(hash);
      throw error;
    }
  }
  private async load(bytes: Buffer): Promise<Parsed> {
    const zip = await JSZip.loadAsync(bytes),
      entries = Object.values(zip.files);
    let total = 0;
    if (entries.length > 4000) fail('XLSX_LIMIT', '工作簿包含过多内部文件。');
    for (const entry of entries) {
      const size =
        (entry as unknown as { _data?: { uncompressedSize: number } })._data?.uncompressedSize ?? 0;
      total += size;
      if (size > 16 * 1024 * 1024 || total > 64 * 1024 * 1024)
        fail('XLSX_LIMIT', '工作簿解压后超过编辑限制（单项 16 MiB / 合计 64 MiB）。');
    }
    const workbookSource = await xml(zip, 'xl/workbook.xml'),
      root = xmlTree(workbookSource),
      rels = xmlTree(await xml(zip, 'xl/_rels/workbook.xml.rels'));
    const relationship = new Map(
      rels.children
        .filter((n) => n.local === 'Relationship' && n.attributes.TargetMode !== 'External')
        .map((n) => [n.attributes.Id, n.attributes]),
    );
    const parts: SheetPart[] = [];
    for (const node of child(root, 'sheets')?.children ?? []) {
      const rel = relationship.get(
        node.attributes[Object.keys(node.attributes).find((key) => key.endsWith(':id')) ?? 'r:id'],
      );
      if (!rel || !rel.Type.endsWith('/worksheet')) continue;
      const target = rel.Target.startsWith('/')
        ? rel.Target.slice(1)
        : posix.normalize(posix.join('xl', rel.Target));
      if (!target.startsWith('xl/') || target.includes('\\')) fail('XLSX_PART', '工作表路径无效。');
      const source = await xml(zip, target),
        sheetRoot = xmlTree(source),
        cells = new Map<string, XmlNode>(),
        blocked: SheetPart['blocked'] = [];
      for (const row of child(sheetRoot, 'sheetData')?.children ?? [])
        for (const cell of children(row, 'c')) {
          const address = cell.attributes.r;
          if (!cellPosition(address ?? '')) fail('XLSX_CELL', '工作表包含不支持的单元格坐标。');
          cells.set(address, cell);
          const formula = child(cell, 'f');
          if (formula?.attributes.ref && formula.attributes.t !== 'shared') {
            const [first, last] = formula.attributes.ref.split(':');
            const from = cellPosition(first),
              to = cellPosition(last ?? first);
            if (from && to) blocked.push({ from, to });
          }
        }
      let rows = 0,
        columns = 0;
      for (const address of cells.keys()) {
        const position = cellPosition(address)!;
        rows = Math.max(rows, position.row);
        columns = Math.max(columns, position.column);
      }
      const dimension = child(sheetRoot, 'dimension')?.attributes.ref?.split(':').at(-1),
        end = dimension && cellPosition(dimension);
      if (end) {
        rows = Math.max(rows, end.row);
        columns = Math.max(columns, end.column);
      }
      parts.push({
        id: node.attributes.sheetId,
        name: node.attributes.name,
        path: target,
        source,
        root: sheetRoot,
        cells,
        rows,
        columns,
        blocked,
      });
    }
    if (!parts.length) fail('XLSX_SHEETS', '没有可显示的工作表。');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as any);
    const styleRel = [...relationship.values()].find((rel) => rel.Type.endsWith('/styles')),
      stylesPath = styleRel
        ? styleRel.Target.startsWith('/')
          ? styleRel.Target.slice(1)
          : posix.normalize(posix.join('xl', styleRel.Target))
        : undefined;
    if (stylesPath && (!stylesPath.startsWith('xl/') || stylesPath.includes('\\')))
      fail('XLSX_PART', '样式文件路径无效。');
    return {
      zip,
      book,
      workbookSource,
      parts,
      stylesPath,
      signed: entries.some((entry) => entry.name.startsWith('_xmlsignatures/')),
      date1904: ['1', 'true'].includes(child(root, 'workbookPr')?.attributes.date1904 ?? ''),
    };
  }
  private sheet(parsed: Parsed, id?: string) {
    const part = id
      ? parsed.parts.find((part) => part.id === id)
      : (parsed.parts.find(
          (part) => parsed.book.getWorksheet(Number(part.id))?.state === 'visible',
        ) ?? parsed.parts[0]);
    if (!part) fail('XLSX_SHEET', '工作表不存在。');
    return part;
  }
  private blocked(parsed: Parsed, part: SheetPart, address: string) {
    if (parsed.signed) return '带数字签名的工作簿暂为只读';
    if (child(part.root, 'sheetProtection')) return '工作表已受保护';
    const cell = part.cells.get(address),
      formula = cell && child(cell, 'f'),
      position = cellPosition(address)!;
    if (cell && (cell.attributes.cm || cell.attributes.vm || child(cell, 'extLst')))
      return '此单元格含扩展数据，暂不支持修改';
    if (
      (formula?.attributes.t && !['normal', 'shared'].includes(formula.attributes.t)) ||
      part.blocked.some(
        (range) =>
          position.row >= range.from.row &&
          position.row <= range.to.row &&
          position.column >= range.from.column &&
          position.column <= range.to.column,
      )
    )
      return '数组或溢出公式区域暂不支持修改';
    const value = parsed.book.getWorksheet(Number(part.id))?.getCell(address);
    if (value?.isMerged && value.master.address !== address)
      return `合并单元格，请编辑 ${value.master.address}`;
    return undefined;
  }
  async page(
    bytes: Buffer,
    hash: string,
    input: {
      objectId: string;
      expectedRevision: number;
      sheetId?: string;
      row: number;
      column: number;
      rows: number;
      columns: number;
      operations?: StructureEdit[];
    },
    fileName: string,
  ): Promise<XlsxPage> {
    const draft = await this.prepare(bytes, hash, input.operations),
      parsed = await this.parse(draft.bytes, draft.hash),
      part = this.sheet(parsed, input.sheetId),
      sheet = parsed.book.getWorksheet(Number(part.id));
    if (!sheet) fail('XLSX_SHEET', '不支持此工作表结构。');
    const rows = Math.min(input.rows, 1048577 - input.row),
      columns = Math.min(input.columns, 16385 - input.column),
      cells: Record<string, XlsxCell> = {};
    const mergeRanges = (child(part.root, 'mergeCells')?.children ?? []).map((n) => {
      const [from, to = from] = n.attributes.ref.split(':');
      return { from, to, a: cellPosition(from)!, b: cellPosition(to)! };
    });
    const rgb = (color: Partial<ExcelJS.Color> | undefined) =>
      color?.argb && /^[a-f0-9]{8}$/i.test(color.argb) ? `#${color.argb.slice(2)}` : undefined;
    for (let r = input.row; r < input.row + rows; r++)
      for (let c = input.column; c < input.column + columns; c++) {
        const address = columnLabel(c) + r,
          cell = sheet.getCell(address),
          value = cell.value,
          formula = cell.type === ExcelJS.ValueType.Formula;
        const inputValue = formula
          ? `=${cell.formula ?? ''}`
          : value instanceof Date
            ? value.toISOString().slice(0, 10)
            : (cell.text ?? '');
        const fill = cell.fill as ExcelJS.FillPattern | undefined;
        cells[address] = {
          input: inputValue,
          display: formula
            ? cell.result === undefined
              ? inputValue
              : String(cell.result)
            : value instanceof Date
              ? inputValue
              : (cell.text ?? ''),
          formula,
          textValue: [
            ExcelJS.ValueType.String,
            ExcelJS.ValueType.RichText,
            ExcelJS.ValueType.Hyperlink,
          ].includes(cell.type),
          readOnly: this.blocked(parsed, part, address),
          bold: cell.font?.bold,
          italic: cell.font?.italic,
          underline: !!cell.font?.underline,
          fontSize: cell.font?.size,
          wrap: cell.alignment?.wrapText,
          color: rgb(cell.font?.color),
          background: fill?.pattern === 'solid' ? rgb(fill.fgColor) : undefined,
          align: cell.alignment?.horizontal,
          numberFormat: cell.numFmt,
          merged: cell.isMerged ? cell.master.address : undefined,
          mergeBounds: (() => {
            const m = mergeRanges.find(
              (m) => r >= m.a.row && r <= m.b.row && c >= m.a.column && c <= m.b.column,
            );
            return m ? { from: m.from, to: m.to } : undefined;
          })(),
        };
      }
    const page: XlsxPage = {
      objectId: input.objectId,
      revision: input.expectedRevision,
      fileName,
      sheetId: part.id,
      row: input.row,
      column: input.column,
      rows,
      columns,
      cells,
      structureBlocked: structureBlocked(parsed),
      nextSheetId: String(
        Math.max(
          ...(child(xmlTree(parsed.workbookSource), 'sheets')?.children ?? []).map(
            (n) => Number(n.attributes.sheetId) || 0,
          ),
        ) + 1,
      ),
      sheets: parsed.parts.map((part) => {
        const ws = parsed.book.getWorksheet(Number(part.id));
        return {
          id: part.id,
          name: part.name,
          rows: part.rows,
          columns: part.columns,
          hidden: ws?.state !== 'visible',
          readOnly: parsed.signed || !!child(part.root, 'sheetProtection'),
        };
      }),
      widths: Array.from({ length: columns }, (_, i) =>
        Math.max(8, Math.min(1793, (sheet.getColumn(input.column + i).width ?? 12) * 7 + 8)),
      ),
      heights: Array.from({ length: rows }, (_, i) =>
        Math.max(1, Math.min(545, (sheet.getRow(input.row + i).height ?? 20) * 1.33)),
      ),
      hiddenRows: Array.from({ length: rows }, (_, i) => input.row + i).filter(
        (r) => sheet.getRow(r).hidden,
      ),
      hiddenColumns: Array.from({ length: columns }, (_, i) => input.column + i).filter(
        (c) => sheet.getColumn(c).hidden,
      ),
      frozen: (() => {
        const pane = child(
          child(child(part.root, 'sheetViews') ?? part.root, 'sheetView') ?? part.root,
          'pane',
        );
        return pane && ['frozen', 'frozenSplit'].includes(pane.attributes.state)
          ? {
              rows: Number(pane.attributes.ySplit ?? 0),
              columns: Number(pane.attributes.xSplit ?? 0),
            }
          : undefined;
      })(),
      conditionalFormats: (sheet as any).conditionalFormattings
        ?.flatMap((f: any) =>
          f.rules
            .filter(
              (r: any) =>
                r.type === 'cellIs' &&
                ['greaterThan', 'lessThan', 'equal'].includes(r.operator) &&
                Number.isFinite(Number(r.formulae?.[0])),
            )
            .map((r: any) => ({
              ref: f.ref,
              operator: r.operator,
              value: Number(r.formulae[0]),
              color: r.style?.fill?.fgColor?.argb
                ? `#${r.style.fill.fgColor.argb.slice(-6)}`
                : undefined,
              priority: r.priority,
            })),
        )
        .sort((a: any, b: any) => a.priority - b.priority),
      warnings: [
        '兼容 XLSX 的本地编辑器，不是 Microsoft Excel。',
        '支持共享公式、XLOOKUP / XMATCH 的单行或单列查找（顺序/逆序）、TEXTJOIN、多条件汇总、1900 日期函数及固定命名区域的本地计算；动态命名、数组、外部及结构化引用暂不计算。单次范围最多 25000 格、依赖最多 32 层，整列引用请改为具体范围。行列变化会同步普通图表引用、绘图锚点、表格范围和透视表数据源；透视表在 Office 打开时刷新。表格内部列结构和透视表结果区域不支持增删；图表等未编辑部件保留在文件内。',
        ...(parsed.signed ? ['此文件带数字签名，当前只读。'] : []),
      ],
    };
    if (Buffer.byteLength(JSON.stringify(page)) > 4 * 1024 * 1024)
      fail('XLSX_PAGE_LIMIT', '当前区域文字过多，请缩小显示区域。');
    return page;
  }
  async calculate(
    bytes: Buffer,
    hash: string,
    input: {
      sheetId?: string;
      row: number;
      column: number;
      rows: number;
      columns: number;
      edits: SheetEdit[];
      operations?: StructureEdit[];
    },
  ): Promise<XlsxCalculation> {
    const draft = await this.prepare(bytes, hash, input.operations),
      parsed = await this.parse(draft.bytes, draft.hash),
      part = this.sheet(parsed, input.sheetId),
      calculator = this.calculator(parsed, input.edits),
      cells: XlsxCalculation['cells'] = {};
    for (let r = input.row; r < Math.min(1048577, input.row + input.rows); r++)
      for (let c = input.column; c < Math.min(16385, input.column + input.columns); c++) {
        const address = columnLabel(c) + r;
        cells[address] = calculator.display(part.id, address);
      }
    if (Buffer.byteLength(JSON.stringify(cells)) > 4 * 1024 * 1024)
      fail('XLSX_PAGE_LIMIT', '计算结果过大，请缩小显示区域。');
    return { cells, issues: Object.values(cells).filter((cell) => cell.error).length };
  }
  private calculator(parsed: Parsed, edits: SheetEdit[]) {
    const root = xmlTree(parsed.workbookSource),
      sheetNames = child(root, 'sheets')?.children.map((node) => node.attributes.name) ?? [];
    const names = (child(root, 'definedNames')?.children ?? []).map((node) => ({
      name: node.attributes.name,
      reference: xmlText(parsed.workbookSource, node),
      ...(node.attributes.localSheetId !== undefined
        ? { sheetName: sheetNames[Number(node.attributes.localSheetId)] ?? '__invalid_scope__' }
        : {}),
    }));
    return new XlsxCalculator(
      parsed.book,
      parsed.parts,
      edits,
      parsed.date1904,
      (sheet, address) => {
        const part = this.sheet(parsed, sheet),
          position = cellPosition(address)!,
          cell = part.cells.get(address),
          formula = cell && child(cell, 'f');
        if (
          (formula?.attributes.t && !['normal', 'shared'].includes(formula.attributes.t)) ||
          part.blocked.some(
            (range) =>
              position.row >= range.from.row &&
              position.row <= range.to.row &&
              position.column >= range.from.column &&
              position.column <= range.to.column,
          )
        )
          return '数组及溢出公式区域暂不支持实时计算';
      },
      names,
    );
  }
  async patch(bytes: Buffer, hash: string, edits: SheetEdit[], forceRecalculate = false) {
    let parsed = await this.parse(bytes, hash);
    const seen = new Set<string>();
    for (const edit of edits) {
      const key = edit.sheetId + ':' + edit.address;
      if (seen.has(key) || !cellPosition(edit.address))
        fail('XLSX_CELL', '单元格重复或坐标超出范围。');
      seen.add(key);
      const part = this.sheet(parsed, edit.sheetId),
        reason = this.blocked(parsed, part, edit.address);
      if (reason) fail('XLSX_READ_ONLY', `${part.name}!${edit.address}：${reason}`);
    }
    const expanded = await expandEditedSharedFormulas(bytes, parsed, edits);
    if (expanded) {
      bytes = expanded;
      hash = createHash('sha256').update(bytes).digest('hex');
      parsed = await this.parse(bytes, hash);
    }
    const zip = await JSZip.loadAsync(bytes),
      hasFormats = edits.some((edit) => edit.format),
      context: WriteContext = {
        styles: new XlsxStyles(
          parsed.stylesPath ? await xml(zip, parsed.stylesPath) : EMPTY_STYLES,
        ),
        calculator: this.calculator(parsed, edits),
        recalculate: forceRecalculate || edits.some((edit) => edit.value !== undefined),
      };
    for (const part of parsed.parts) {
      const changes = edits.filter((edit) => edit.sheetId === part.id);
      let source = part.source;
      const replacements: { start: number; end: number; text: string }[] = [];
      const data = child(part.root, 'sheetData');
      if (!data) fail('XLSX_XML', '工作表缺少 sheetData。');
      const rowMap = new Map(children(data, 'row').map((row) => [Number(row.attributes.r), row])),
        rowEdits = new Map<number, SheetEdit[]>();
      for (const edit of changes) {
        const row = cellPosition(edit.address)!.row;
        if (!rowEdits.has(row)) rowEdits.set(row, []);
        rowEdits.get(row)!.push(edit);
      }
      // Recalculate dependencies from the same pending edits used by the live preview.
      for (const [address, cell] of part.cells)
        if (
          context.recalculate &&
          child(cell, 'f') &&
          !changes.some((edit) => edit.address === address)
        ) {
          replacements.push({
            start: cell.start,
            end: cell.end,
            text: this.cachedXml(
              parsed,
              part,
              address,
              source.slice(cell.start, cell.end),
              context,
            ),
          });
        }
      const inserts = new Map<number, string[]>();
      for (const [rowNumber, values] of [...rowEdits].sort((a, b) => a[0] - b[0])) {
        const row = rowMap.get(rowNumber),
          rowPrefix = prefix(row?.name ?? part.root.name),
          cellValues = new Map(values.map((edit) => [edit.address, edit]));
        if (row) {
          const newCells = values.filter((edit) => !part.cells.has(edit.address));
          // Rebuild only this row's cell sequence. All cell attributes and non-value children are retained.
          const oldCells = children(row, 'c'),
            all = [
              ...oldCells.map((node) => ({
                address: node.attributes.r,
                xml: cellValues.has(node.attributes.r)
                  ? this.cellXml(
                      parsed,
                      part,
                      cellValues.get(node.attributes.r)!,
                      node,
                      rowPrefix,
                      context,
                    )
                  : this.cachedXml(
                      parsed,
                      part,
                      node.attributes.r,
                      part.source.slice(node.start, node.end),
                      context,
                    ),
              })),
              ...newCells.map((edit) => ({
                address: edit.address,
                xml: this.cellXml(parsed, part, edit, undefined, rowPrefix, context),
              })),
            ].sort((a, b) => cellPosition(a.address)!.column - cellPosition(b.address)!.column);
          const extras = row.children
            .filter((node) => node.local !== 'c')
            .map((node) => source.slice(node.start, node.end))
            .join('');
          const rendered = `<${row.name}${attrs(row, { spans: undefined })}>${all.map((cell) => cell.xml).join('')}${extras}</${row.name}>`;
          // Any child-cache replacements are contained in the complete row replacement.
          for (let i = replacements.length - 1; i >= 0; i--)
            if (replacements[i].start >= row.start && replacements[i].end <= row.end)
              replacements.splice(i, 1);
          replacements.push({ start: row.start, end: row.end, text: rendered });
        } else {
          const following = [...rowMap]
            .filter(([index]) => index > rowNumber)
            .sort((a, b) => a[0] - b[0])[0]?.[1];
          const at = following?.start ?? data.closeStart;
          const rendered = `<${rowPrefix}row r="${rowNumber}">${values
            .sort((a, b) => cellPosition(a.address)!.column - cellPosition(b.address)!.column)
            .map((edit) => this.cellXml(parsed, part, edit, undefined, rowPrefix, context))
            .join('')}</${rowPrefix}row>`;
          if (!inserts.has(at)) inserts.set(at, []);
          inserts.get(at)!.push(rendered);
        }
      }
      if (
        data.closeStart === data.openEnd &&
        /\/\s*>$/.test(source.slice(data.start, data.openEnd)) &&
        inserts.size
      ) {
        const rows = [...rowEdits]
          .sort((a, b) => a[0] - b[0])
          .map(
            ([r, values]) =>
              `<${prefix(data.name)}row r="${r}">${values
                .sort((a, b) => cellPosition(a.address)!.column - cellPosition(b.address)!.column)
                .map((edit) =>
                  this.cellXml(parsed, part, edit, undefined, prefix(data.name), context),
                )
                .join('')}</${prefix(data.name)}row>`,
          )
          .join('');
        replacements.push({
          start: data.start,
          end: data.end,
          text: `<${data.name}${attrs(data)}>${rows}</${data.name}>`,
        });
      } else
        for (const [at, rows] of inserts)
          replacements.push({ start: at, end: at, text: rows.join('') });
      if (changes.length) {
        const dimension = child(part.root, 'dimension');
        if (dimension) {
          const lastRow = Math.max(part.rows, ...changes.map((e) => cellPosition(e.address)!.row)),
            lastCol = Math.max(
              part.columns,
              ...changes.map((e) => cellPosition(e.address)!.column),
            );
          replacements.push({
            start: dimension.start,
            end: dimension.end,
            text: `<${dimension.name}${attrs(dimension, { ref: `A1:${columnLabel(lastCol)}${lastRow}` })}/>`,
          });
        }
      }
      if (replacements.length) zip.file(part.path, replaceSpans(source, replacements));
    }
    if (hasFormats) {
      zip.file(parsed.stylesPath ?? 'xl/styles.xml', context.styles.output());
      if (!parsed.stylesPath) {
        const path = 'xl/_rels/workbook.xml.rels',
          source = await xml(zip, path),
          root = xmlTree(source),
          used = new Set(root.children.map((node) => node.attributes.Id));
        let id = 'rIdDesktopStyles';
        while (used.has(id)) id += '_';
        zip.file(
          path,
          replaceSpans(source, [
            {
              start: root.closeStart,
              end: root.closeStart,
              text: `<${prefix(root.name)}Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
            },
          ]),
        );
        const types = await xml(zip, '[Content_Types].xml'),
          tree = xmlTree(types);
        if (!tree.children.some((node) => node.attributes.PartName === '/xl/styles.xml'))
          zip.file(
            '[Content_Types].xml',
            replaceSpans(types, [
              {
                start: tree.closeStart,
                end: tree.closeStart,
                text: `<${prefix(tree.name)}Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
              },
            ]),
          );
      }
    }
    const root = xmlTree(parsed.workbookSource),
      calc = child(root, 'calcPr'),
      name = calc?.name ?? `${prefix(root.name)}calcPr`;
    const calcXml = `<${name}${calc ? attrs(calc, { fullCalcOnLoad: '1', forceFullCalc: '1', calcMode: 'auto' }) : ' fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"'}/>`;
    // calcPr belongs before later workbook elements (pivotCaches/extLst/etc.).
    const following = root.children.find((node) =>
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
    );
    zip.file(
      'xl/workbook.xml',
      replaceSpans(parsed.workbookSource, [
        {
          start: calc?.start ?? following?.start ?? root.closeStart,
          end: calc?.end ?? following?.start ?? root.closeStart,
          text: calcXml,
        },
      ]),
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
        if (node.attributes.Target) {
          const target = node.attributes.Target;
          zip.remove(
            target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target)),
          );
        }
      if (remove.length)
        zip.file(
          path,
          replaceSpans(
            source,
            remove.map((node) => ({ start: node.start, end: node.end, text: '' })),
          ),
        );
    }
    const output = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    if (output.length > NATIVE_FILE_LIMIT)
      fail('XLSX_LIMIT', '保存后的文件超过 50 MiB，原文件没有覆盖。请减少本次修改。');
    return output;
  }
  private cachedXml(
    parsed: Parsed,
    part: SheetPart,
    address: string,
    source: string,
    context: WriteContext,
  ) {
    if (!context.recalculate) return source;
    const node = xmlTree(source),
      formula = child(node, 'f');
    if (!formula) return source;
    const result = this.blocked(parsed, part, address)
        ? undefined
        : context.calculator.cell(part.id, address),
      p = prefix(node.name);
    let type: string | undefined,
      value = '';
    if (result && !result.issue) {
      if (result.value instanceof Error) {
        type = 'e';
        value = String(result.value);
      } else if (typeof result.value === 'boolean') {
        type = 'b';
        value = result.value ? '1' : '0';
      } else if (typeof result.value === 'string') {
        type = 'str';
        value = result.value;
      } else value = String(result.value ?? 0);
    }
    const body = node.children
      .filter((item) => item.local !== 'v')
      .map(
        (item) =>
          source.slice(item.start, item.end) +
          (item === formula && result && !result.issue ? `<${p}v>${textXml(value)}</${p}v>` : ''),
      )
      .join('');
    return `<${node.name}${attrs(node, { t: type })}>${body}</${node.name}>`;
  }
  private cellXml(
    parsed: Parsed,
    part: SheetPart,
    edit: SheetEdit,
    node: XmlNode | undefined,
    p: string,
    context: WriteContext,
  ) {
    const existing = parsed.book.getWorksheet(Number(part.id))!.getCell(edit.address),
      name = node?.name ?? p + 'c',
      attributes: Record<string, string | undefined> = { r: edit.address };
    let body = '';
    if (edit.value === undefined) {
      body = node ? part.source.slice(node.openEnd, node.closeStart) : '';
    } else {
      const result = editValue(edit, existing, parsed.date1904);
      attributes.t = undefined;
      if (result.formula !== undefined) {
        if (!result.formula) fail('XLSX_FORMULA', '公式不能为空。');
        body = `<${p}f>${textXml(result.formula)}</${p}f>`;
      } else if (typeof result.value === 'boolean') {
        attributes.t = 'b';
        body = `<${p}v>${result.value ? 1 : 0}</${p}v>`;
      } else if (typeof result.value === 'number') body = `<${p}v>${result.value}</${p}v>`;
      else if (result.value !== null) {
        attributes.t = 'inlineStr';
        body = `<${p}is><${p}t xml:space="preserve">${textXml(String(result.value))}</${p}t></${p}is>`;
      }
      body += node
        ? node.children
            .filter((item) => !['f', 'v', 'is'].includes(item.local))
            .map((item) => part.source.slice(item.start, item.end))
            .join('')
        : '';
    }
    if (edit.format) {
      const position = cellPosition(edit.address)!,
        row = child(part.root, 'sheetData')?.children.find(
          (n) => n.local === 'row' && Number(n.attributes.r) === position.row,
        ),
        col = child(part.root, 'cols')?.children.find(
          (n) =>
            Number(n.attributes.min) <= position.column &&
            Number(n.attributes.max) >= position.column,
        );
      const base = Number(node?.attributes.s ?? row?.attributes.s ?? col?.attributes.style ?? 0);
      attributes.s = String(context.styles.apply(base, edit.format));
    }
    const rendered = `<${name}${
      node
        ? attrs(node, attributes)
        : Object.entries(attributes)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => ` ${k}="${escape(v!)}"`)
            .join('')
    }>${body}</${name}>`;
    return this.cachedXml(parsed, part, edit.address, rendered, context);
  }
}
