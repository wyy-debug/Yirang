import JSZip from 'jszip';
import { posix } from 'node:path';
import { FileContent, fail } from '../../contracts/index.js';
import {
  ChartRead,
  ChartSave,
  type NativeChart,
  type NativeChartList,
  type NativeChartSeries,
} from '../../contracts/native-charts.js';
import { NATIVE_FILE_LIMIT } from '../../components/native-files.js';
import {
  xml,
  xmlTree,
  xmlText,
  child,
  attrs,
  escape,
  prefix,
  replaceSpans,
  type XmlNode,
} from './spreadsheet/xlsx-xml.js';
import type { WorkbenchAPI } from '../work/workbench.js';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const MAX_CHARTS = 24,
  MAX_SERIES = 12,
  MAX_POINTS = 128;
const walk = (n: XmlNode): XmlNode[] => [n, ...n.children.flatMap(walk)],
  raw = (s: string, n: XmlNode) => s.slice(n.start, n.end);
const build = (
  s: string,
  n: XmlNode,
  body = s.slice(n.openEnd, n.closeStart),
  changes: Record<string, string | undefined> = {},
) => `<${n.name}${attrs(n, changes)}>${body}</${n.name}>`;
const relPath = (part: string) =>
  posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
const rid = (node: XmlNode) =>
  node.attributes[Object.keys(node.attributes).find((k) => k.endsWith(':id')) ?? 'r:id'];
function target(base: string, value: string) {
  if (!value || value.includes('\\') || value.includes(':') || value.includes('\0'))
    fail('CHART_PART', '图表关联路径无效。');
  const path = value.startsWith('/')
    ? value.slice(1)
    : posix.normalize(posix.join(posix.dirname(base), value));
  if (!path.startsWith('xl/') || path.includes('../')) fail('CHART_PART', '图表关联路径越界。');
  return path;
}
async function relationships(zip: JSZip, part: string) {
  const path = relPath(part);
  return zip.file(path)
    ? xmlTree(await xml(zip, path)).children.filter(
        (n) => n.local === 'Relationship' && n.attributes.TargetMode !== 'External',
      )
    : [];
}
async function load(bytes: Buffer) {
  if (bytes.length > NATIVE_FILE_LIMIT) fail('CHART_LIMIT', '工作簿超过 50 MiB。');
  const zip = await JSZip.loadAsync(bytes),
    entries = Object.values(zip.files);
  if (entries.length > 4000) fail('CHART_LIMIT', '工作簿内部文件超过 4000 个。');
  let total = 0;
  for (const entry of entries) {
    const size = (entry as any)._data?.uncompressedSize ?? 0;
    total += size;
    if (size > 16 * 1024 * 1024 || total > 64 * 1024 * 1024)
      fail('CHART_LIMIT', '工作簿解压超过单项 16 MiB / 合计 64 MiB 限制。');
  }
  return zip;
}
type ChartPart = { id: string; sheets: string[]; blocked?: string };
async function discover(zip: JSZip) {
  const source = await xml(zip, 'xl/workbook.xml'),
    root = xmlTree(source),
    rels = await relationships(zip, 'xl/workbook.xml'),
    parts = new Map<string, ChartPart>(),
    sheets = child(root, 'sheets')?.children ?? [];
  if (sheets.length > 500) fail('CHART_LIMIT', '图表浏览最多支持 500 张工作表。');
  const signed = Object.keys(zip.files).some((p) => p.startsWith('_xmlsignatures/'));
  let drawings = 0;
  for (const sheet of sheets) {
    const rel = rels.find(
      (r) => r.attributes.Id === rid(sheet) && r.attributes.Type?.endsWith('/worksheet'),
    );
    if (!rel) continue;
    const path = target('xl/workbook.xml', rel.attributes.Target),
      sheetRoot = xmlTree(await xml(zip, path)),
      drawingRefs = sheetRoot.children.filter((n) => n.local === 'drawing');
    if (!drawingRefs.length) continue;
    const sr = await relationships(zip, path),
      protectedSheet = !!child(sheetRoot, 'sheetProtection');
    for (const drawing of drawingRefs) {
      if (++drawings > 500) fail('CHART_LIMIT', '工作簿绘图部件超过 500 个。');
      const relation = sr.find(
        (r) => r.attributes.Id === rid(drawing) && r.attributes.Type?.endsWith('/drawing'),
      );
      if (!relation) continue;
      const drawingPath = target(path, relation.attributes.Target),
        dr = await relationships(zip, drawingPath),
        tree = xmlTree(await xml(zip, drawingPath));
      for (const node of walk(tree).filter((n) => n.local === 'chart')) {
        const relation = dr.find(
          (r) => r.attributes.Id === rid(node) && r.attributes.Type?.endsWith('/chart'),
        );
        if (!relation) continue;
        const id = target(drawingPath, relation.attributes.Target),
          entry = parts.get(id) ?? { id, sheets: [] };
        if (!entry.sheets.includes(sheet.attributes.name)) entry.sheets.push(sheet.attributes.name);
        if (signed) entry.blocked = '带数字签名的工作簿只读';
        else if (protectedSheet) entry.blocked = '图表所属工作表已受保护';
        parts.set(id, entry);
        if (parts.size > 200)
          fail('CHART_LIMIT', '工作簿超过 200 个内嵌图表，请在 Excel 中拆分后打开。');
      }
    }
  }
  const calc = child(root, 'calcPr'),
    calculationPending =
      !!calc &&
      ['fullCalcOnLoad', 'forceFullCalc'].some((k) => ['1', 'true'].includes(calc.attributes[k]));
  return { parts, calculationPending };
}
function cached(source: string, container: XmlNode | undefined, numeric: boolean) {
  if (!container)
    return {
      values: [] as (string | number | null)[],
      total: 0,
      truncated: false,
      formula: undefined as string | undefined,
    };
  const reference = container.children.find((n) => ['numRef', 'strRef'].includes(n.local)),
    cache =
      reference?.children.find((n) => ['numCache', 'strCache'].includes(n.local)) ??
      container.children.find((n) => ['numLit', 'strLit'].includes(n.local));
  const formula = reference && child(reference, 'f'),
    points = cache?.children.filter((n) => n.local === 'pt') ?? [];
  let max = -1;
  for (const p of points) {
    const i = Number(p.attributes.idx);
    if (Number.isInteger(i) && i >= 0 && i < 10000000) max = Math.max(max, i);
  }
  const declared = Number(cache && child(cache, 'ptCount')?.attributes.val),
    total = Math.max(max + 1, Number.isSafeInteger(declared) && declared >= 0 ? declared : 0),
    values: (string | number | null)[] = Array.from(
      { length: Math.min(MAX_POINTS, total) },
      () => null,
    );
  for (const p of points) {
    const index = Number(p.attributes.idx),
      v = child(p, 'v');
    if (!Number.isInteger(index) || index < 0 || index >= values.length || !v) continue;
    const text = xmlText(source, v);
    values[index] = numeric
      ? text.trim() && Number.isFinite(Number(text))
        ? Number(text)
        : null
      : text.slice(0, 500);
  }
  return {
    values,
    total,
    truncated: total > MAX_POINTS,
    formula: formula ? xmlText(source, formula).slice(0, 500) : undefined,
  };
}
function seriesStyle(n: XmlNode, kind: NativeChart['kind']) {
  const sp = child(n, 'spPr'),
    target = kind === 'line' ? sp && child(sp, 'ln') : sp;
  const complex =
    (!!sp &&
      sp.children.some((n) =>
        ['blipFill', 'gradFill', 'pattFill', 'grpFill', 'scene3d', 'sp3d', 'extLst'].includes(
          n.local,
        ),
      )) ||
    (!!target &&
      target.children.some((n) =>
        ['blipFill', 'gradFill', 'pattFill', 'grpFill', 'extLst'].includes(n.local),
      ));
  const solid = target && child(target, 'solidFill'),
    rgb = solid && child(solid, 'srgbClr'),
    color = rgb && /^[0-9a-f]{6}$/i.test(rgb.attributes.val) ? '#' + rgb.attributes.val : undefined;
  return {
    color,
    editable: !complex && !child(n, 'dPt') && !solid?.children.some((n) => n.children.length),
  };
}
type Parsed = {
  source: string;
  root: XmlNode;
  chart: XmlNode;
  plot: XmlNode;
  title?: XmlNode;
  titleText?: XmlNode;
  group?: XmlNode;
  seriesNodes: Map<number, XmlNode>;
  view: NativeChart;
};
async function parse(zip: JSZip, part: ChartPart): Promise<Parsed> {
  const source = await xml(zip, part.id);
  if (Buffer.byteLength(source) > 2 * 1024 * 1024)
    fail('CHART_LIMIT', '单个图表 XML 超过 2 MiB，请在 Excel 中编辑。');
  const root = xmlTree(source),
    chart = child(root, 'chart'),
    plot = chart && child(chart, 'plotArea');
  if (root.local !== 'chartSpace' || !chart || !plot)
    fail('CHART_FILE', '图表不是支持的 OOXML 图表部件。');
  const groups = plot.children.filter((n) => n.local.endsWith('Chart')),
    group = groups.length === 1 ? groups[0] : undefined,
    kind =
      (
        { barChart: 'bar', lineChart: 'line', pieChart: 'pie' } as Partial<
          Record<string, 'bar' | 'line' | 'pie'>
        >
      )[group?.local as string] ?? 'unknown';
  let readOnly =
    part.blocked ??
    (root.attributes[root.name.includes(':') ? `xmlns:${root.name.split(':')[0]}` : 'xmlns'] !== C
      ? '此图表使用未支持的命名空间，暂为只读'
      : undefined) ??
    (kind === 'unknown' ? '组合图、三维图或此图表类型暂为只读' : undefined);
  const warnings: string[] = [];
  if (child(root, 'externalData') || child(root, 'pivotSource'))
    readOnly = '外部数据或透视图表仅支持缓存预览';
  const protection = child(root, 'protection');
  if (
    protection &&
    protection.children.some((n) => !['0', 'false'].includes(n.attributes.val ?? '1'))
  )
    readOnly = '此图表受到保护';
  const grouping = group && child(group, 'grouping')?.attributes.val;
  if (grouping && !['standard', 'clustered'].includes(grouping))
    readOnly = '堆积或百分比图表暂为只读';
  const title = child(chart, 'title'),
    rich = title && child(title, 'tx') && child(child(title, 'tx')!, 'rich'),
    paragraphs = rich?.children.filter((n) => n.local === 'p') ?? [],
    runs = paragraphs[0]?.children.filter((n) => n.local === 'r') ?? [],
    titleText = runs.length === 1 ? child(runs[0], 't') : undefined;
  const simpleTitle =
    !title ||
    (!!rich &&
      paragraphs.length === 1 &&
      runs.length === 1 &&
      !!titleText &&
      paragraphs[0].children.every((n) => ['pPr', 'r', 'endParaRPr'].includes(n.local)) &&
      runs[0].children.every((n) => ['rPr', 't'].includes(n.local)) &&
      !walk(title).some((n) => ['fld', 'extLst'].includes(n.local)));
  const titleLabel = title
    ? walk(title)
        .filter((n) => n.local === 't' || n.local === 'v')
        .map((n) => xmlText(source, n))
        .join('')
        .slice(0, 500)
    : '未命名图表';
  const nodes = group?.children.filter((n) => n.local === 'ser') ?? [],
    seriesNodes = new Map<number, XmlNode>(),
    series: NativeChartSeries[] = [];
  if (nodes.length > MAX_SERIES)
    warnings.push(`仅预览前 ${MAX_SERIES} 个系列，更多系列保留在原文件中。`);
  if (kind === 'pie' && nodes.length !== 1) readOnly = '多系列饼图暂为只读';
  for (const [position, n] of nodes.slice(0, MAX_SERIES).entries()) {
    const index = Number(child(n, 'idx')?.attributes.val ?? position);
    if (!Number.isInteger(index) || index < 0 || index > 9999 || seriesNodes.has(index)) {
      readOnly = '图表系列索引不明确，暂为只读';
      continue;
    }
    seriesNodes.set(index, n);
    const tx = child(n, 'tx'),
      name = tx
        ? walk(tx)
            .filter((n) => n.local === 'v')
            .map((v) => xmlText(source, v))
            .join('')
            .slice(0, 200)
        : `系列 ${position + 1}`,
      values = cached(source, child(n, 'val'), true),
      categories = cached(source, child(n, 'cat'), false),
      style = seriesStyle(n, kind),
      warning = child(child(n, 'cat') ?? n, 'multiLvlStrRef')
        ? '多层分类标签未展开'
        : !values.values.some((v) => typeof v === 'number')
          ? '原文件没有可预览的数值缓存'
          : undefined;
    if (child(n, 'dPt')) warnings.push(`“${name}”含逐点颜色，预览以系列色示意；逐点样式保留。`);
    series.push({
      index,
      name: name || `系列 ${position + 1}`,
      color: style.color,
      colorEditable: style.editable && !readOnly,
      values: values.values as (number | null)[],
      categories: categories.values.map((v) => (v == null ? '' : String(v))),
      valueFormula: values.formula,
      categoryFormula: categories.formula,
      truncated: values.truncated || categories.truncated,
      cachedPoints: values.total,
      warning,
    });
  }
  if (!simpleTitle)
    warnings.push('此标题包含单元格引用或复杂富文本，仅显示原内容，不修改标题结构。');
  if (series.some((s) => s.truncated))
    warnings.push(`每个系列只预览前 ${MAX_POINTS} 个缓存数据点，原数据保持完整。`);
  if (series.some((s) => !s.color))
    warnings.push('主题色未解析的系列使用预览配色；保存颜色后改为显式 RGB 颜色。');
  return {
    source,
    root,
    chart,
    plot,
    title,
    titleText,
    group,
    seriesNodes,
    view: {
      id: part.id,
      title: titleLabel,
      titleEditable: simpleTitle && !readOnly,
      kind: grouping && !['standard', 'clustered'].includes(grouping) ? 'unknown' : kind,
      direction:
        group && child(group, 'barDir')?.attributes.val === 'bar' ? 'horizontal' : 'vertical',
      sheets: part.sheets,
      series,
      readOnly,
      warnings: [...new Set(warnings)],
    },
  };
}
function colorPatch(source: string, series: XmlNode, color: string, kind: NativeChart['kind']) {
  const sp = child(series, 'spPr'),
    solid = `<a:solidFill xmlns:a="${A}"><a:srgbClr val="${color.slice(1)}"/></a:solidFill>`;
  const applyFill = (s: string, n: XmlNode) => {
    const fills = n.children.filter((c) => ['noFill', 'solidFill'].includes(c.local));
    if (fills.length)
      return replaceSpans(s, [
        { start: fills[0].start, end: fills[0].end, text: solid },
        ...fills.slice(1).map((f) => ({ start: f.start, end: f.end, text: '' })),
      ]);
    const before = n.children.find((c) => !['xfrm', 'prstGeom', 'custGeom'].includes(c.local)),
      at = before?.start ?? n.closeStart,
      body = s.slice(n.openEnd, at) + solid + s.slice(at, n.closeStart);
    return replaceSpans(s, [{ start: n.start, end: n.end, text: build(s, n, body) }]);
  };
  if (!sp) {
    const body = kind === 'line' ? `<a:ln xmlns:a="${A}">${solid}</a:ln>` : solid;
    const before = series.children.find((n) =>
        [
          'invertIfNegative',
          'marker',
          'dPt',
          'dLbls',
          'trendline',
          'errBars',
          'cat',
          'val',
          'smooth',
          'shape',
          'extLst',
        ].includes(n.local),
      ),
      at = before?.start ?? series.closeStart;
    return { start: at, end: at, text: `<c:spPr xmlns:c="${C}">${body}</c:spPr>` };
  }
  let value = build(source, sp),
    node = xmlTree(value);
  if (kind === 'line') {
    const line = child(node, 'ln');
    if (line) value = applyFill(value, line);
    else {
      const before = node.children.find((n) =>
          ['effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst'].includes(n.local),
        ),
        at = before?.start ?? node.closeStart;
      value = value.slice(0, at) + `<a:ln xmlns:a="${A}">${solid}</a:ln>` + value.slice(at);
    }
  } else value = applyFill(value, node);
  return { start: sp.start, end: sp.end, text: value };
}
export class NativeCharts {
  constructor(private api: WorkbenchAPI) {}
  async action(input: unknown) {
    const operation = (input as any)?.operation,
      p = operation === 'chart_save' ? ChartSave.parse(input) : ChartRead.parse(input),
      object = this.api.object(p.objectId);
    if (object.archived) fail('OBJECT_ARCHIVED', '材料已归档。');
    const content = FileContent.parse(
      p.expectedRevision === object.revision
        ? object.content
        : this.api.history(p.objectId, p.expectedRevision).content,
    );
    if (!/\.xlsx$/i.test(content.fileName)) fail('CHART_FORMAT', '图表编辑只支持原生 .xlsx 文件。');
    const zip = await load(this.api.load(content.assetHash)),
      discovered = await discover(zip);
    if (p.operation === 'chart_read') {
      const charts: NativeChart[] = [];
      for (const part of [...discovered.parts.values()].slice(0, MAX_CHARTS)) {
        try {
          charts.push((await parse(zip, part)).view);
        } catch (e) {
          charts.push({
            id: part.id,
            title: '无法展开的图表',
            kind: 'unknown',
            titleEditable: false,
            sheets: part.sheets,
            series: [],
            readOnly: String(e),
            warnings: [],
          });
        }
      }
      return {
        objectId: p.objectId,
        revision: p.expectedRevision,
        fileName: content.fileName,
        charts,
        total: discovered.parts.size,
        truncated: discovered.parts.size > MAX_CHARTS,
        cacheStatus: 'unverified',
        calculationPending: discovered.calculationPending,
        warnings: [
          '预览来自文件内部的图表缓存快照，未由桌面重新计算。修改公式或单元格后，此快照可能过期；请在兼容的表格应用中刷新图表并保存后重新导入。',
          '这里只编辑现有图表标题和系列颜色；数据范围、坐标轴、主题、逐点格式及其他部件保留。',
        ],
      } satisfies NativeChartList;
    }
    const ids = new Set<string>();
    for (const edit of p.edits) {
      if (ids.has(edit.chartId)) fail('CHART_EDIT', '同一图表只能提交一组修改。');
      ids.add(edit.chartId);
      const part = discovered.parts.get(edit.chartId);
      if (!part) fail('CHART_EDIT', '图表已不存在或未嵌入工作表。');
      const parsed = await parse(zip, part);
      if (parsed.view.readOnly) fail('CHART_READ_ONLY', parsed.view.readOnly);
      const patches: { start: number; end: number; text: string }[] = [];
      if (edit.title !== undefined) {
        if (!parsed.view.titleEditable)
          fail('CHART_READ_ONLY', '该图表标题不能安全进行纯文本编辑。');
        if (parsed.titleText)
          patches.push({
            start: parsed.titleText.start,
            end: parsed.titleText.end,
            text: build(parsed.source, parsed.titleText, escape(edit.title), {
              'xml:space': 'preserve',
            }),
          });
        else {
          const at =
            parsed.chart.children.find((n) => !['title'].includes(n.local))?.start ??
            parsed.chart.closeStart;
          patches.push({
            start: at,
            end: at,
            text: `<c:title xmlns:c="${C}"><c:tx><c:rich><a:bodyPr xmlns:a="${A}"/><a:lstStyle xmlns:a="${A}"/><a:p xmlns:a="${A}"><a:r><a:t xml:space="preserve">${escape(edit.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`,
          });
        }
        const deleted = child(parsed.chart, 'autoTitleDeleted');
        if (deleted)
          patches.push({
            start: deleted.start,
            end: deleted.end,
            text: build(parsed.source, deleted, undefined, { val: '0' }),
          });
      }
      const seriesIds = new Set<number>();
      for (const series of edit.series ?? []) {
        if (seriesIds.has(series.index)) fail('CHART_EDIT', '图表系列重复。');
        seriesIds.add(series.index);
        const node = parsed.seriesNodes.get(series.index),
          view = parsed.view.series.find((s) => s.index === series.index);
        if (!node || !view?.colorEditable)
          fail('CHART_READ_ONLY', '该系列含复杂样式或已变化，不能安全修改颜色。');
        patches.push(colorPatch(parsed.source, node, series.color, parsed.view.kind));
      }
      zip.file(part.id, replaceSpans(parsed.source, patches));
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    if (bytes.length > NATIVE_FILE_LIMIT) fail('CHART_LIMIT', '保存后的工作簿超过 50 MiB。');
    return this.api.save(
      p.requestId,
      p.objectId,
      p.expectedRevision,
      bytes,
      `编辑 ${p.edits.length} 个原生图表`,
      { type: 'native_charts', chartIds: [...ids], cacheStatus: 'unverified' },
    );
  }
}
