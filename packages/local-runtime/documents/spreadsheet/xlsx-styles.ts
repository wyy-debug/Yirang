import { type CellFormat } from '../../../contracts/xlsx.js';
import { xmlTree, child, children, prefix, attrs, escape, type XmlNode } from './xlsx-xml.js';

export const EMPTY_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/** Append style records, never reserialize the workbook or replace unrelated styles. */
export class XlsxStyles {
  private root: XmlNode;
  private groups = new Map<string, string[]>();
  private p: string;
  constructor(private source: string) {
    this.root = xmlTree(source);
    this.p = prefix(this.root.name);
  }
  private records(name: string) {
    if (!this.groups.has(name))
      this.groups.set(
        name,
        (child(this.root, name)?.children ?? []).map((n) => this.source.slice(n.start, n.end)),
      );
    return this.groups.get(name)!;
  }
  private add(name: string, value: string) {
    const records = this.records(name),
      existing = records.indexOf(value);
    if (existing >= 0) return existing;
    records.push(value);
    return records.length - 1;
  }
  private changeNode(
    source: string,
    name: string,
    updates: Record<string, string | undefined>,
    replace: Record<string, string> = {},
  ) {
    const node = xmlTree(source),
      found = new Set<string>();
    let body = '';
    for (const item of node.children) {
      if (Object.hasOwn(replace, item.local)) {
        if (!found.has(item.local)) body += replace[item.local];
        found.add(item.local);
      } else body += source.slice(item.start, item.end);
    }
    for (const [key, value] of Object.entries(replace)) if (!found.has(key)) body += value;
    return `<${name}${attrs(node, updates)}>${body}</${name}>`;
  }
  apply(base: number, format: CellFormat) {
    const source =
        this.records('cellXfs')[base] ??
        this.records('cellXfs')[0] ??
        `<${this.p}xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`,
      xf = xmlTree(source),
      updates: Record<string, string | undefined> = {},
      replace: Record<string, string> = {};
    if (
      ['bold', 'italic', 'underline', 'fontSize', 'color'].some((key) => Object.hasOwn(format, key))
    ) {
      const fontSource =
          this.records('fonts')[Number(xf.attributes.fontId ?? 0)] ?? `<${this.p}font/>`,
        font = xmlTree(fontSource),
        p = prefix(font.name),
        changes: Record<string, string> = {};
      for (const [key, tag] of [
        ['bold', 'b'],
        ['italic', 'i'],
        ['underline', 'u'],
      ] as const)
        if (format[key] !== undefined) changes[tag] = format[key] ? `<${p}${tag}/>` : '';
      if (format.fontSize !== undefined) changes.sz = `<${p}sz val="${format.fontSize}"/>`;
      if (format.color !== undefined)
        changes.color = `<${p}color rgb="FF${format.color.slice(1).toUpperCase()}"/>`;
      updates.fontId = String(
        this.add('fonts', this.changeNode(fontSource, font.name, {}, changes)),
      );
      updates.applyFont = '1';
    }
    if (format.background !== undefined) {
      updates.fillId =
        format.background === null
          ? '0'
          : String(
              this.add(
                'fills',
                `<${this.p}fill><${this.p}patternFill patternType="solid"><${this.p}fgColor rgb="FF${format.background.slice(1).toUpperCase()}"/><${this.p}bgColor indexed="64"/></${this.p}patternFill></${this.p}fill>`,
              ),
            );
      updates.applyFill = '1';
    }
    if (format.numberFormat !== undefined) {
      const records = this.records('numFmts'),
        formats = records.map((text) => xmlTree(text));
      const existing = formats.find((node) => node.attributes.formatCode === format.numberFormat);
      let id =
        format.numberFormat === 'General'
          ? 0
          : existing
            ? Number(existing.attributes.numFmtId)
            : Math.max(163, ...formats.map((node) => Number(node.attributes.numFmtId))) + 1;
      if (id !== 0 && !existing)
        records.push(
          `<${this.p}numFmt numFmtId="${id}" formatCode="${escape(format.numberFormat)}"/>`,
        );
      updates.numFmtId = String(id);
      updates.applyNumberFormat = '1';
    }
    if (format.align !== undefined || format.wrap !== undefined) {
      const alignment = child(xf, 'alignment'),
        values: Record<string, string | undefined> = {};
      if (format.align !== undefined) values.horizontal = format.align;
      if (format.wrap !== undefined) values.wrapText = format.wrap ? '1' : '0';
      const name = alignment?.name ?? `${prefix(xf.name)}alignment`;
      replace.alignment = `<${name}${
        alignment
          ? attrs(alignment, values)
          : Object.entries(values)
              .map(([k, v]) => ` ${k}="${v}"`)
              .join('')
      }/>`;
      updates.applyAlignment = '1';
    }
    // Alignment must precede protection and extension elements in CT_Xf.
    let rendered = this.changeNode(source, xf.name, updates, replace);
    if (replace.alignment && !child(xf, 'alignment')) {
      const node = xmlTree(rendered),
        alignment = child(node, 'alignment')!,
        before = node.children.find((n) => n.local === 'protection' || n.local === 'extLst');
      if (before) {
        const body = rendered.slice(alignment.start, alignment.end);
        rendered = rendered.slice(0, alignment.start) + rendered.slice(alignment.end);
        rendered = rendered.slice(0, before.start) + body + rendered.slice(before.start);
      }
    }
    return this.add('cellXfs', rendered);
  }
  output() {
    const order = [
        'numFmts',
        'fonts',
        'fills',
        'borders',
        'cellStyleXfs',
        'cellXfs',
        'cellStyles',
        'dxfs',
        'tableStyles',
        'colors',
        'extLst',
      ],
      emitted = new Set<string>();
    let body = '';
    const emit = (name: string, node?: XmlNode) => {
      emitted.add(name);
      const records = this.groups.get(name);
      if (records) {
        if (!records.length && !node) return;
        const tag = node?.name ?? this.p + name;
        body += `<${tag}${node ? attrs(node, { count: String(records.length) }) : ` count="${records.length}"`}>${records.join('')}</${tag}>`;
      } else if (node) body += this.source.slice(node.start, node.end);
    };
    for (const node of this.root.children) {
      for (const name of order)
        if (
          !emitted.has(name) &&
          this.groups.has(name) &&
          !child(this.root, name) &&
          order.indexOf(name) < order.indexOf(node.local)
        )
          emit(name);
      emit(node.local, node);
    }
    for (const name of order) if (!emitted.has(name) && this.groups.has(name)) emit(name);
    return (
      this.source.slice(0, this.root.start) +
      `<${this.root.name}${attrs(this.root)}>${body}</${this.root.name}>` +
      this.source.slice(this.root.end)
    );
  }
}
