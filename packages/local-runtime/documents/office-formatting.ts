import { SaxesParser } from 'saxes';
import {
  child,
  attrs,
  escape,
  xmlTree,
  replaceSpans,
  type XmlNode,
} from './spreadsheet/xlsx-xml.js';
import type { OfficeChange } from '../../contracts/office.js';
const raw = (s: string, n: XmlNode) => s.slice(n.start, n.end);
const build = (
  s: string,
  n: XmlNode,
  a: Record<string, string | undefined> = {},
  body = s.slice(n.openEnd, n.closeStart),
) => `<${n.name}${attrs(n, a)}>${body}</${n.name}>`;
function children(source: string, changes: Record<string, string>, order?: string[]) {
  const root = xmlTree(source),
    removed = new Set(Object.keys(changes)),
    entries = root.children
      .filter((n) => !removed.has(n.local))
      .map((n) => ({ name: n.local, value: raw(source, n) }));
  for (const [name, value] of Object.entries(changes)) if (value) entries.push({ name, value });
  if (order)
    entries.sort((a, b) => {
      const x = order.indexOf(a.name),
        y = order.indexOf(b.name);
      return (x < 0 ? 999 : x) - (y < 0 ? 999 : y);
    });
  return build(source, root, {}, entries.map((n) => n.value).join(''));
}
const wordOrder =
  'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange'.split(
    ' ',
  );
const drawingOrder =
  'ln noFill solidFill gradFill blipFill pattFill grpFill effectLst effectDag highlight uLnTx uLn uFillTx uFill latin ea cs sym hlinkClick hlinkMouseOver rtl extLst'.split(
    ' ',
  );
export function formatOfficeRun(
  source: string,
  word: boolean,
  edit: Extract<OfficeChange, { kind: 'run' }>,
) {
  let output = source || `<${word ? 'w' : 'a'}:rPr/>`,
    root = xmlTree(output);
  const changes: Record<string, string> = {};
  if (word) {
    for (const [name, value] of [
      ['b', edit.bold],
      ['i', edit.italic],
      ['u', edit.underline],
    ] as const)
      if (value !== undefined)
        changes[name] =
          `<w:${name} w:val="${name === 'u' ? (value ? 'single' : 'none') : value ? '1' : '0'}"/>`;
    if (edit.fontSize !== undefined) {
      changes.sz = `<w:sz w:val="${Math.round(edit.fontSize * 2)}"/>`;
      changes.szCs = `<w:szCs w:val="${Math.round(edit.fontSize * 2)}"/>`;
    }
    if (edit.color !== undefined) changes.color = `<w:color w:val="${edit.color.slice(1)}"/>`;
    if (edit.fontFamily !== undefined) {
      const fonts = child(root, 'rFonts'),
        a = {
          'w:ascii': edit.fontFamily,
          'w:hAnsi': edit.fontFamily,
          'w:eastAsia': edit.fontFamily,
          'w:cs': edit.fontFamily,
          'w:asciiTheme': undefined,
          'w:hAnsiTheme': undefined,
          'w:eastAsiaTheme': undefined,
          'w:cstheme': undefined,
        };
      changes.rFonts = fonts
        ? build(output, fonts, a)
        : `<w:rFonts${attrs({ attributes: {} } as XmlNode, a)}/>`;
    }
    return children(output, changes, wordOrder);
  }
  output = build(output, root, {
    b: edit.bold === undefined ? root.attributes.b : edit.bold ? '1' : '0',
    i: edit.italic === undefined ? root.attributes.i : edit.italic ? '1' : '0',
    u: edit.underline === undefined ? root.attributes.u : edit.underline ? 'sng' : 'none',
    sz: edit.fontSize === undefined ? root.attributes.sz : String(Math.round(edit.fontSize * 100)),
  });
  if (edit.color !== undefined) {
    for (const name of ['noFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])
      changes[name] = '';
    changes.solidFill = `<a:solidFill><a:srgbClr val="${edit.color.slice(1)}"/></a:solidFill>`;
  }
  if (edit.fontFamily !== undefined)
    for (const name of ['latin', 'ea', 'cs'])
      changes[name] = `<a:${name} typeface="${escape(edit.fontFamily)}"/>`;
  return children(output, changes, drawingOrder);
}
export function officeColor(container: XmlNode | undefined) {
  if (!container) return undefined;
  if (child(container, 'noFill')) return 'none';
  const solid = child(container, 'solidFill'),
    rgb = solid && child(solid, 'srgbClr');
  return rgb && /^[0-9a-f]{6}$/i.test(rgb.attributes.val) ? '#' + rgb.attributes.val : undefined;
}
export function formatOfficeShape(source: string, edit: Extract<OfficeChange, { kind: 'shape' }>) {
  const root = xmlTree(source),
    changes: Record<string, string> = {};
  if (edit.fill !== undefined) {
    for (const name of ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])
      changes[name] = '';
    changes[edit.fill === 'none' ? 'noFill' : 'solidFill'] =
      edit.fill === 'none'
        ? '<a:noFill/>'
        : `<a:solidFill><a:srgbClr val="${edit.fill.slice(1)}"/></a:solidFill>`;
  }
  if (edit.stroke !== undefined || edit.strokeWidth !== undefined) {
    const line = child(root, 'ln');
    let value = line ? raw(source, line) : '<a:ln/>';
    if (edit.stroke !== undefined) {
      const fills: Record<string, string> = {
        noFill: '',
        solidFill: '',
        gradFill: '',
        pattFill: '',
      };
      fills[edit.stroke === 'none' ? 'noFill' : 'solidFill'] =
        edit.stroke === 'none'
          ? '<a:noFill/>'
          : `<a:solidFill><a:srgbClr val="${edit.stroke.slice(1)}"/></a:solidFill>`;
      value = children(value, fills, [
        'noFill',
        'solidFill',
        'gradFill',
        'pattFill',
        'prstDash',
        'custDash',
        'round',
        'bevel',
        'miter',
        'headEnd',
        'tailEnd',
        'extLst',
      ]);
    }
    const ln = xmlTree(value);
    changes.ln = build(value, ln, {
      w:
        edit.strokeWidth === undefined
          ? ln.attributes.w
          : String(Math.round(edit.strokeWidth * 9525)),
    });
  }
  return children(source, changes, [
    'xfrm',
    'prstGeom',
    'custGeom',
    'noFill',
    'solidFill',
    'gradFill',
    'blipFill',
    'pattFill',
    'grpFill',
    'ln',
    'effectLst',
    'effectDag',
    'scene3d',
    'sp3d',
    'extLst',
  ]);
}
export function replaceOfficeText(source: string, text: string, word: boolean) {
  const root = xmlTree(source),
    runs = root.children.filter((n) => n.local === 'r'),
    plain = (n: XmlNode) =>
      n.children
        .filter((n) => ['t', 'tab', 'br'].includes(n.local))
        .map((n) =>
          n.local === 't' ? decodeText(raw(source, n)) : n.local === 'tab' ? '\t' : '\n',
        )
        .join('');
  const values = runs.map(plain),
    before = values.join('');
  let start = 0,
    end = 0;
  while (start < before.length && start < text.length && before[start] === text[start]) start++;
  while (
    end < before.length - start &&
    end < text.length - start &&
    before[before.length - 1 - end] === text[text.length - 1 - end]
  )
    end++;
  const content = (value: string) =>
    word
      ? value
          .split(/(\n|\t)/)
          .map((t) =>
            t === '\n'
              ? '<w:br/>'
              : t === '\t'
                ? '<w:tab/>'
                : `<w:t xml:space="preserve">${escape(t)}</w:t>`,
          )
          .join('')
      : `<a:t xml:space="preserve">${escape(value)}</a:t>`;
  if (!runs.length) {
    const p = word ? 'w' : 'a',
      body = source.slice(root.openEnd, root.closeStart) + `<${p}:r>${content(text)}</${p}:r>`;
    return build(source, root, {}, body);
  }
  let offset = 0,
    inserted = false;
  const patches = runs.map((r, i) => {
    const value = values[i],
      a = offset,
      b = offset + value.length;
    offset = b;
    let next = value;
    if (b >= start && a <= before.length - end) {
      const prefix = value.slice(0, Math.max(0, start - a)),
        suffix = value.slice(Math.max(0, before.length - end - a));
      next = prefix + (!inserted ? text.slice(start, text.length - end) : '') + suffix;
      inserted = true;
    }
    const props = child(r, 'rPr');
    return {
      start: r.start,
      end: r.end,
      text:
        next === value
          ? raw(source, r)
          : build(source, r, {}, (props ? raw(source, props) : '') + content(next)),
    };
  });
  return replaceSpans(source, patches);
}
function decodeText(value: string) {
  let text = '';
  const parser = new SaxesParser({ xmlns: false });
  parser.on('text', (v) => (text += v));
  parser.on('cdata', (v) => (text += v));
  parser.write(value).close();
  return text;
}
