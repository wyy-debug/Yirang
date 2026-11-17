import {
  getUiLanguage as getUiLocale,
  subscribeUiLanguage as onUiLocale,
} from '../../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { createElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../../ui/icons.js';
import './native-svg-editor.css';

type Props = { source: string; change: (source: string) => void; readOnly: boolean };
type Shape = 'rect' | 'circle' | 'ellipse' | 'line' | 'text' | 'path';
type Entry = {
  key: string;
  tag: Shape;
  element: Element;
  label: string;
  definition: boolean;
  hidden: boolean;
};
type Parsed = {
  source: string;
  document: Document | null;
  root: Element | null;
  entries: Entry[];
  error: string;
  width: number;
  height: number;
  viewBox: string;
  stylesheet: boolean;
  omitted: number;
};
type Field = {
  name: string;
  label: string;
  kind?: 'paint' | 'text' | 'path' | 'transform' | 'number' | 'anchor';
  wide?: boolean;
};
type Form = {
  key: string;
  base: string;
  values: Record<string, string>;
  initial: Record<string, string>;
};
type History = { before: string; after: string };
type SelectionBox = { key: string; left: number; top: number; width: number; height: number };
const NS = 'http://www.w3.org/2000/svg';
const LIMIT = 1024 * 1024;
const shapes = new Set<string>(['rect', 'circle', 'ellipse', 'line', 'text', 'path']);
let labels: Record<Shape, string> = {
  rect: uiText('矩形'),
  circle: uiText('圆形'),
  ellipse: uiText('椭圆'),
  line: uiText('直线'),
  text: uiText('文字'),
  path: uiText('路径'),
};
// Source and preview are separate trees. This list only governs what is displayed;
// unsupported source nodes and attributes stay untouched in the original XML.
const previewTags = new Set([
  'svg',
  'g',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'symbol',
  'title',
  'desc',
]);
const definitionTags = new Set(['defs', 'clipPath', 'mask', 'pattern', 'symbol']);
const numericAttributes = new Set([
  'x',
  'y',
  'dx',
  'dy',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'stroke-width',
  'stroke-miterlimit',
  'stroke-dashoffset',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'font-size',
  'font-weight',
  'letter-spacing',
  'word-spacing',
  'offset',
  'stop-opacity',
  'fx',
  'fy',
  'fr',
  'pathLength',
]);
const paintAttributes = new Set(['fill', 'stroke', 'color', 'stop-color']);
const names: Record<string, string> = {
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  'fill-opacity': 'fillOpacity',
  'stroke-opacity': 'strokeOpacity',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'font-family': 'fontFamily',
  'font-style': 'fontStyle',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'letter-spacing': 'letterSpacing',
  'word-spacing': 'wordSpacing',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'clip-path': 'clipPath',
  'vector-effect': 'vectorEffect',
  'color-interpolation': 'colorInterpolation',
};
const numberPattern = /^[-+\d.eE%,\s]*(?:px|em|ex|cm|mm|in|pt|pc)?$/;
const plainNumber = /^[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?(?:%|px|em|ex|cm|mm|in|pt|pc)?$/i;
const paintPattern = /^(?:[a-z][a-z-]*|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.\s,%+\-/deg]*\))$/i;
let commonFields: Field[] = [
  { name: 'fill', label: uiText('填充'), kind: 'paint' },
  { name: 'stroke', label: uiText('描边'), kind: 'paint' },
  { name: 'stroke-width', label: uiText('描边宽度') },
  { name: 'opacity', label: uiText('不透明度') },
  { name: 'transform', label: uiText('变换'), kind: 'transform', wide: true },
];
let shapeFields: Record<Shape, Field[]> = {
  rect: [
    { name: 'x', label: 'X' },
    { name: 'y', label: 'Y' },
    { name: 'width', label: uiText('宽度') },
    { name: 'height', label: uiText('高度') },
    { name: 'rx', label: uiText('圆角 X') },
    { name: 'ry', label: uiText('圆角 Y') },
  ],
  circle: [
    { name: 'cx', label: uiText('中心 X') },
    { name: 'cy', label: uiText('中心 Y') },
    { name: 'r', label: uiText('半径') },
  ],
  ellipse: [
    { name: 'cx', label: uiText('中心 X') },
    { name: 'cy', label: uiText('中心 Y') },
    { name: 'rx', label: uiText('半径 X') },
    { name: 'ry', label: uiText('半径 Y') },
  ],
  line: [
    { name: 'x1', label: uiText('起点 X') },
    { name: 'y1', label: uiText('起点 Y') },
    { name: 'x2', label: uiText('终点 X') },
    { name: 'y2', label: uiText('终点 Y') },
  ],
  text: [
    { name: '$text', label: uiText('文字内容'), kind: 'text', wide: true },
    { name: 'x', label: 'X' },
    { name: 'y', label: 'Y' },
    { name: 'font-size', label: uiText('字号') },
    { name: 'font-weight', label: uiText('字重'), kind: 'number' },
    { name: 'text-anchor', label: uiText('对齐'), kind: 'anchor' },
  ],
  path: [{ name: 'd', label: uiText('路径数据'), kind: 'path', wide: true }],
};

function fields(entry: Entry) {
  return [...shapeFields[entry.tag], ...commonFields];
}
function simpleText(element: Element) {
  return Array.from(element.childNodes).every((node) => node.nodeType === 3 || node.nodeType === 4);
}
function dimension(value: string | null, fallback: number) {
  const n = value && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? parseFloat(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : fallback;
}
function parse(source: string): Parsed {
  const result: Parsed = {
    source,
    document: null,
    root: null,
    entries: [],
    error: '',
    width: 800,
    height: 600,
    viewBox: '0 0 800 600',
    stylesheet: false,
    omitted: 0,
  };
  try {
    if (source.length > LIMIT) throw Error(uiText('SVG 超过 1 MiB，请在源码中编辑。'));
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))
      throw Error(uiText('SVG 含 DTD 或实体声明，图形预览已停用；源码保持原样。'));
    const document = new DOMParser().parseFromString(source, 'image/svg+xml'),
      root = document.documentElement;
    if (
      document.querySelector('parsererror') ||
      root.localName !== 'svg' ||
      root.namespaceURI !== NS
    )
      throw Error(uiText('SVG 暂时无法解析。请在源码中补全有效的 SVG 根元素和命名空间。'));
    const box = (root.getAttribute('viewBox') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      box.length === 4 &&
      box.every(Number.isFinite) &&
      box[2] > 0 &&
      box[3] > 0 &&
      box.every((n) => Math.abs(n) <= 1000000)
    ) {
      result.viewBox = box.join(' ');
      result.width = box[2];
      result.height = box[3];
    } else {
      result.width = dimension(root.getAttribute('width'), 800);
      result.height = dimension(root.getAttribute('height'), 600);
      result.viewBox = `0 0 ${result.width} ${result.height}`;
    }
    let count = 0;
    const visit = (
      element: Element,
      key: string,
      definition: boolean,
      hidden: boolean,
      depth: number,
    ) => {
      if (++count > 2500 || depth > 80)
        throw Error(
          uiText('SVG 结构较复杂，图形模式支持最多 2,500 个元素及 80 层嵌套；可继续编辑源码。'),
        );
      const tag = element.localName,
        inDefinition = definition || definitionTags.has(tag),
        inHidden = hidden || element.namespaceURI !== NS || !previewTags.has(tag);
      if (tag === 'style') result.stylesheet = true;
      if (element.namespaceURI !== NS || !previewTags.has(tag)) result.omitted++;
      if (element.namespaceURI === NS && shapes.has(tag)) {
        const shape = tag as Shape,
          id = element.getAttribute('id'),
          text = tag === 'text' ? element.textContent?.trim().slice(0, 28) : '';
        result.entries.push({
          key,
          tag: shape,
          element,
          definition: inDefinition,
          hidden: inHidden,
          label: id
            ? `${labels[shape]} · ${id}`
            : text
              ? uiText('文字 · {0}', { '0': text })
              : `${labels[shape]} ${result.entries.length + 1}`,
        });
      }
      Array.from(element.children).forEach((child, index) =>
        visit(child, `${key}.${index}`, inDefinition, inHidden, depth + 1),
      );
    };
    visit(root, 'r', false, false, 0);
    result.document = document;
    result.root = root;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.entries = [];
  }
  return result;
}

// Split CSS declarations without altering unrelated values (including quoted
// semicolons and url/data contents). Only the explicitly edited property changes.
function declarations(style: string) {
  const parts: string[] = [];
  let start = 0,
    quote = '',
    depth = 0,
    comment = false;
  for (let i = 0; i < style.length; i++) {
    const char = style[i],
      next = style[i + 1];
    if (comment) {
      if (char === '*' && next === '/') {
        comment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '*') {
      comment = true;
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) {
      parts.push(style.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < style.length) parts.push(style.slice(start));
  return parts.map((raw) => {
    const match = raw.match(/^\s*([a-z-]+)\s*:\s*([\s\S]*?)\s*;?$/i);
    return { raw, name: match?.[1].toLowerCase() ?? '', value: match?.[2] ?? '' };
  });
}
function property(element: Element, name: string) {
  if (name === '$text') return simpleText(element) ? (element.textContent ?? '') : '';
  const inline = declarations(element.getAttribute('style') ?? '')
    .filter((item) => item.name === name)
    .at(-1);
  return (inline?.value ?? element.getAttribute(name) ?? '').replace(/\s*!important\s*$/i, '');
}
function setProperty(element: Element, name: string, value: string) {
  if (name === '$text') {
    element.textContent = value;
    return;
  }
  const style = element.getAttribute('style'),
    parts = declarations(style ?? ''),
    matches = parts.filter((item) => item.name === name);
  if (matches.length) {
    let first = true;
    const next = parts
      .map((item) => {
        if (item.name !== name) return item.raw;
        if (!first || !value) return '';
        first = false;
        return `${name}: ${value}${matches.some((part) => /!important\s*;?$/i.test(part.value)) ? ' !important' : ''};`;
      })
      .join('');
    if (next.trim()) element.setAttribute('style', next);
    else element.removeAttribute('style');
  }
  if (value) element.setAttribute(name, value);
  else element.removeAttribute(name);
}
function safeValue(name: string, value: string, ids: Map<string, string>): string | null {
  value = value.trim();
  if (!value || value.length > 100000) return null;
  if (paintAttributes.has(name) || name === 'clip-path' || name === 'mask') {
    const local = value.match(/^url\(\s*(['"]?)#([^\s'"()]+)\1\s*\)$/i);
    if (local) return ids.has(local[2]) ? `url(#${ids.get(local[2])})` : null;
    return (paintAttributes.has(name) && paintPattern.test(value)) || value === 'none'
      ? value
      : null;
  }
  if (numericAttributes.has(name))
    return numberPattern.test(value) || /^(?:normal|bold|bolder|lighter|inherit)$/.test(value)
      ? value
      : null;
  if (name === 'transform' || name === 'gradientTransform' || name === 'patternTransform')
    return /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([-+\d.eE,\s]+\)\s*)+$/.test(value)
      ? value
      : null;
  if (name === 'd') return /^[MmZzLlHhVvCcSsQqTtAa\d.eE+\-,\s]+$/.test(value) ? value : null;
  if (name === 'points' || name === 'stroke-dasharray')
    return value === 'none' || /^[-+\d.eE,\s]+$/.test(value) ? value : null;
  if (name === 'viewBox') return /^[-+\d.eE,\s]+$/.test(value) ? value : null;
  if (name === 'font-family')
    return /^(?:Arial|Helvetica|Verdana|Georgia|Tahoma|Times New Roman|Courier New|sans-serif|serif|monospace|system-ui)(?:\s*,\s*(?:sans-serif|serif|monospace|system-ui))*$/i.test(
      value,
    )
      ? value
      : null;
  if (
    [
      'preserveAspectRatio',
      'stroke-linecap',
      'stroke-linejoin',
      'fill-rule',
      'clip-rule',
      'font-style',
      'text-anchor',
      'dominant-baseline',
      'vector-effect',
      'gradientUnits',
      'spreadMethod',
      'patternUnits',
      'patternContentUnits',
      'clipPathUnits',
      'maskUnits',
      'maskContentUnits',
      'color-interpolation',
      'display',
      'visibility',
    ].includes(name)
  )
    return /^[a-zA-Z0-9\s-]+$/.test(value) ? value : null;
  return null;
}
function preview(parsed: Parsed, prefix: string) {
  if (!parsed.root) return { content: null, props: {}, omitted: 0 };
  const ids = new Map<string, string>();
  let serial = 0,
    omitted = 0;
  for (const element of [parsed.root, ...Array.from(parsed.root.querySelectorAll('[id]'))]) {
    const id = element.getAttribute('id');
    if (id && !ids.has(id)) ids.set(id, `${prefix}-${serial++}`);
  }
  const attributes = (element: Element) => {
    const props: Record<string, unknown> = {};
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'id') {
        props.id = ids.get(attribute.value);
        continue;
      }
      if (
        attribute.name === 'style' ||
        attribute.name === 'xmlns' ||
        attribute.name.startsWith('xmlns:') ||
        attribute.name === 'version'
      )
        continue;
      const value = safeValue(attribute.name, attribute.value, ids);
      if (value !== null) props[names[attribute.name] ?? attribute.name] = value;
      else if (!['class', 'role'].includes(attribute.name) && !attribute.name.startsWith('aria-'))
        omitted++;
    }
    for (const item of declarations(element.getAttribute('style') ?? '')) {
      const value = safeValue(item.name, item.value.replace(/\s*!important\s*$/i, ''), ids);
      if (value !== null) props[names[item.name] ?? item.name] = value;
      else if (item.raw.trim()) omitted++;
    }
    return props;
  };
  const render = (element: Element, key: string): React.ReactNode => {
    if (element.namespaceURI !== NS || !previewTags.has(element.localName)) return null;
    const props = attributes(element);
    props.key = key;
    if (shapes.has(element.localName)) props['data-native-svg-key'] = key;
    let childIndex = 0;
    const children = Array.from(element.childNodes).map((node) =>
      node.nodeType === 1
        ? render(node as Element, `${key}.${childIndex++}`)
        : node.nodeType === 3 || node.nodeType === 4
          ? node.textContent
          : null,
    );
    return createElement(element.localName, props, ...children);
  };
  const props = attributes(parsed.root),
    content = Array.from(parsed.root.children).map((element, index) =>
      render(element, `r.${index}`),
    );
  return { content, props, omitted };
}
function resolve(root: Element, key: string) {
  let element: Element | undefined = root;
  for (const index of key.split('.').slice(1))
    element = element?.children.item(Number(index)) ?? undefined;
  return element;
}
function elementKey(root: Element, element: Element) {
  let node: Element | null = element;
  const indexes: number[] = [];
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    indexes.unshift(Array.from(parent.children).indexOf(node));
    node = parent;
  }
  return node === root ? `r.${indexes.join('.')}` : null;
}
function serialize(document: Document, original: string) {
  const declaration = original.match(/^(?:\uFEFF)?\s*(<\?xml\s[^?]*\?>)(\r\n|\r|\n)?/i),
    xml = new XMLSerializer().serializeToString(document);
  return `${original.startsWith('\uFEFF') ? '\uFEFF' : ''}${declaration ? declaration[1] + (declaration[2] ?? '\n') : ''}${xml}`;
}
function validation(field: Field, value: string) {
  if (!value || field.kind === 'text') return '';
  if (field.kind === 'paint')
    return paintPattern.test(value) || /^url\(\s*(['"]?)#[^\s'"()]+\1\s*\)$/.test(value)
      ? ''
      : uiText('请输入颜色、none 或 url(#渐变ID)。');
  if (field.kind === 'path')
    return value.length <= 100000 && /^[MmZzLlHhVvCcSsQqTtAa\d.eE+\-,\s]+$/.test(value)
      ? ''
      : uiText('路径数据只能包含 SVG 路径指令和数字。');
  if (field.kind === 'transform')
    return /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([-+\d.eE,\s]+\)\s*)+$/.test(value)
      ? ''
      : uiText('请输入 translate、rotate、scale 或 matrix 等 SVG 变换。');
  if (field.kind === 'anchor')
    return ['start', 'middle', 'end'].includes(value) ? '' : uiText('请选择有效的文字对齐方式。');
  if (field.name === 'font-weight' && /^(normal|bold|bolder|lighter)$/.test(value)) return '';
  if (!plainNumber.test(value)) return uiText('请输入数字，可保留 px、%、em 等单位。');
  const number = parseFloat(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1000000)
    return uiText('数值需在 ±1,000,000 范围内。');
  if (
    ['width', 'height', 'r', 'rx', 'ry', 'stroke-width', 'font-size'].includes(field.name) &&
    number < 0
  )
    return uiText('尺寸不能为负数。');
  if (field.name === 'opacity' && (number < 0 || number > (value.endsWith('%') ? 100 : 1)))
    return uiText('不透明度范围为 0–1 或 0–100%。');
  return '';
}

function hasCssTransform(element: Element) {
  let current: Element | null = element;
  while (current) {
    if (
      declarations(current.getAttribute('style') ?? '').some((item) =>
        ['transform', 'transform-origin', 'transform-box'].includes(item.name),
      )
    )
      return true;
    current = current.parentElement;
  }
  return false;
}
function translateElement(element: Element, dx: number, dy: number) {
  if (hasCssTransform(element))
    throw Error(uiText('元素含 CSS 坐标变换，请在源码中移动；层级和其他属性仍可编辑。'));
  let transform = property(element, 'transform');
  if (
    transform &&
    validation({ name: 'transform', label: uiText('变换'), kind: 'transform' }, transform)
  )
    throw Error(uiText('现有变换较复杂，请在源码中调整。'));
  const leading = transform.match(/^translate\(\s*([-+\d.eE]+)(?:[\s,]+([-+\d.eE]+))?\s*\)\s*/);
  if (leading) {
    dx += Number(leading[1]);
    dy += Number(leading[2] ?? 0);
    transform = transform.slice(leading[0].length);
  }
  if (
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    Math.abs(dx) > 1000000 ||
    Math.abs(dy) > 1000000
  )
    throw Error(uiText('移动结果超出支持的坐标范围。'));
  setProperty(
    element,
    'transform',
    `translate(${Math.round(dx * 10000) / 10000} ${Math.round(dy * 10000) / 10000})${transform ? ` ${transform}` : ''}`,
  );
}

export function NativeSvgEditor({ source, change, readOnly }: Props) {
  useUiLocale();
  const prefix = `native-svg-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const [parsed, setParsed] = useState(() => parse(source)),
    [selected, setSelected] = useState<string | null>(null),
    [selectedKeys, setSelectedKeys] = useState<string[]>([]),
    [selectionBoxes, setSelectionBoxes] = useState<SelectionBox[]>([]),
    [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [shape, setShape] = useState<Exclude<Shape, 'path'>>('rect'),
    [history, setHistory] = useState<History[]>([]);
  const [zoom, setZoom] = useState<number | null>(null),
    [viewport, setViewport] = useState({ width: 640, height: 420 }),
    [bounds, setBounds] = useState<{
      left: number;
      top: number;
      width: number;
      height: number;
    } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null),
    canvasRef = useRef<HTMLDivElement>(null),
    composing = useRef(false),
    latest = useRef(source);
  latest.current = source;
  const drawing = useMemo(() => preview(parsed, prefix), [parsed, prefix, getUiLocale()]);
  const entry = parsed.entries.find((item) => item.key === selected),
    pending = parsed.source !== source,
    selectedEntries = parsed.entries.filter((item) => selectedKeys.includes(item.key)),
    multiple = selectedEntries.length > 1;
  const editableSelection =
      selectedEntries.length > 0 &&
      selectedEntries.every((item) => !item.definition && !item.hidden),
    sameParent =
      editableSelection &&
      selectedEntries.every(
        (item) =>
          item.key.slice(0, item.key.lastIndexOf('.')) ===
          selectedEntries[0].key.slice(0, selectedEntries[0].key.lastIndexOf('.')),
      );
  const movableSelection =
    editableSelection && selectedEntries.every((item) => !hasCssTransform(item.element));
  const formDirty =
    !!form && Object.keys(form.values).some((key) => form.values[key] !== form.initial[key]);
  const stale = !!form && form.base !== parsed.source;
  const disabled = readOnly || pending || !parsed.document || parsed.stylesheet;
  const maxScale = Math.min(4, 8192 / Math.max(parsed.width, parsed.height));
  const scale = Math.min(
    maxScale,
    zoom ??
      Math.max(
        0.000001,
        Math.min((viewport.width - 48) / parsed.width, (viewport.height - 48) / parsed.height),
      ),
  );
  useEffect(() => {
    if (source === parsed.source) return;
    const timer = window.setTimeout(() => setParsed(parse(source)), 240);
    return () => window.clearTimeout(timer);
  }, [source, parsed.source]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!entry || multiple) {
      setForm(null);
      return;
    }
    setForm((current) => {
      if (
        current?.key === entry.key &&
        current.base !== parsed.source &&
        Object.keys(current.values).some((key) => current.values[key] !== current.initial[key])
      )
        return current;
      const values = Object.fromEntries(
        fields(entry).map((field) => [field.name, property(entry.element, field.name)]),
      );
      return { key: entry.key, base: parsed.source, values, initial: values };
    });
  }, [parsed, selected, multiple]);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) {
      setBounds(null);
      setSelectionBoxes([]);
      return;
    }
    const origin = element.getBoundingClientRect(),
      boxes: SelectionBox[] = [];
    for (const key of selectedKeys) {
      const item = parsed.entries.find((entry) => entry.key === key),
        target = element.querySelector(`[data-native-svg-key="${key}"]`);
      if (!target || item?.definition || item?.hidden) continue;
      const rect = target.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      boxes.push({
        key,
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: Math.max(2, rect.width),
        height: Math.max(2, rect.height),
      });
    }
    setSelectionBoxes(boxes);
    if (!boxes.length) {
      setBounds(null);
      return;
    }
    const left = Math.min(...boxes.map((b) => b.left)),
      top = Math.min(...boxes.map((b) => b.top));
    setBounds({
      left,
      top,
      width: Math.max(...boxes.map((b) => b.left + b.width)) - left,
      height: Math.max(...boxes.map((b) => b.top + b.height)) - top,
    });
  }, [parsed, selectedKeys, scale]);
  function choose(key: string | null, extend = false) {
    if (extend && key && !selectedKeys.includes(key) && selectedKeys.length >= 100) {
      setNotice(uiText('一次最多选择 100 个元素。'));
      return;
    }
    if (formDirty) {
      setNotice(uiText('属性尚未应用，请先应用或重置属性，再切换元素。'));
      return;
    }
    const next = !key
      ? []
      : extend
        ? selectedKeys.includes(key)
          ? selectedKeys.filter((value) => value !== key)
          : [...selectedKeys, key]
        : [key];
    setSelectedKeys(next);
    setSelected(next.at(-1) ?? null);
    setError('');
    setNotice('');
  }
  function reloadForm() {
    if (!entry) return;
    const values = Object.fromEntries(
      fields(entry).map((field) => [field.name, property(entry.element, field.name)]),
    );
    setForm({ key: entry.key, base: parsed.source, values, initial: values });
    setError('');
    setNotice('');
  }
  function updateDocument(edit: (root: Element) => void) {
    if (disabled || latest.current !== parsed.source) return false;
    try {
      const document = parsed.document!.cloneNode(true) as Document;
      edit(document.documentElement);
      const next = serialize(document, source);
      if (next.length > LIMIT) throw Error(uiText('修改后超过 1 MiB，请减少内容后重试。'));
      if (next === source) return true;
      latest.current = next;
      change(next);
      setParsed(parse(next));
      setHistory((current) => {
        let nextHistory = [...current, { before: source, after: next }].slice(-12);
        while (
          nextHistory.length > 1 &&
          nextHistory.reduce((sum, item) => sum + item.before.length, 0) > 4 * LIMIT
        )
          nextHistory = nextHistory.slice(1);
        return nextHistory;
      });
      setForm((current) => (current ? { ...current, base: next, initial: current.values } : null));
      setError('');
      setNotice(uiText('已更新文件草稿。使用上方“保存”写回原 SVG 文件。'));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }
  function apply() {
    if (!entry || entry.hidden || !form || stale || composing.current) return;
    const changed = fields(entry).filter(
      (field) => form.values[field.name] !== form.initial[field.name],
    );
    for (const field of changed) {
      const problem = validation(field, form.values[field.name].trim());
      if (problem) {
        setError(`${field.label}：${problem}`);
        return;
      }
    }
    updateDocument((root) => {
      const target = resolve(root, entry.key);
      if (!target) throw Error(uiText('元素已变化，请重新选择。'));
      for (const field of changed)
        setProperty(
          target,
          field.name,
          field.kind === 'text' ? form.values[field.name] : form.values[field.name].trim(),
        );
    });
  }
  function add() {
    if (formDirty) {
      setNotice(uiText('请先应用或重置当前属性，再新增元素。'));
      return;
    }
    const box = parsed.viewBox.split(' ').map(Number),
      x = box[0] + box[2] / 2,
      y = box[1] + box[3] / 2,
      size = Math.max(1, Math.min(box[2], box[3]) * 0.18);
    let nextKey = '';
    if (
      updateDocument((root) => {
        const element = root.ownerDocument.createElementNS(NS, shape),
          round = (n: number) => String(Math.round(n * 100) / 100);
        const attributes: Record<string, string> =
          shape === 'rect'
            ? {
                x: round(x - size / 2),
                y: round(y - size / 2),
                width: round(size),
                height: round(size),
                rx: round(size * 0.1),
              }
            : shape === 'circle'
              ? { cx: round(x), cy: round(y), r: round(size / 2) }
              : shape === 'ellipse'
                ? { cx: round(x), cy: round(y), rx: round(size * 0.65), ry: round(size * 0.4) }
                : shape === 'line'
                  ? {
                      x1: round(x - size / 2),
                      y1: round(y),
                      x2: round(x + size / 2),
                      y2: round(y),
                      stroke: '#007aff',
                      'stroke-width': round(Math.max(1, size * 0.025)),
                    }
                  : {
                      x: round(x),
                      y: round(y),
                      'font-size': round(Math.max(12, size * 0.24)),
                      'text-anchor': 'middle',
                    };
        attributes.fill = shape === 'line' ? 'none' : shape === 'text' ? '#1d1d1f' : '#007aff';
        Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
        if (shape === 'text') element.textContent = uiText('新文字');
        nextKey = `r.${root.children.length}`;
        root.appendChild(root.ownerDocument.createTextNode('\n  '));
        root.appendChild(element);
        root.appendChild(root.ownerDocument.createTextNode('\n'));
      })
    ) {
      setSelected(nextKey);
      setSelectedKeys([nextKey]);
    }
  }
  function mutateSelection(edit: (targets: Element[], root: Element) => void) {
    if (!editableSelection || formDirty || disabled) {
      if (formDirty) setNotice(uiText('请先应用或重置属性，再操作多个元素。'));
      return;
    }
    let keys: string[] = [];
    if (
      updateDocument((root) => {
        const targets = selectedKeys.map((key) => resolve(root, key));
        if (targets.some((target) => !target)) throw Error(uiText('元素已变化，请重新选择。'));
        edit(targets as Element[], root);
        keys = (targets as Element[])
          .map((target) => elementKey(root, target))
          .filter((key): key is string => !!key);
      })
    ) {
      setSelectedKeys(keys);
      setSelected(keys.at(-1) ?? null);
      setForm(null);
    }
  }
  function remove() {
    mutateSelection((targets) => targets.forEach((target) => target.remove()));
  }
  function moveSelection(dx: number, dy: number) {
    mutateSelection((targets) => targets.forEach((target) => translateElement(target, dx, dy)));
  }
  function alignSelection(direction: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
    if (!sameParent || !movableSelection || selectedEntries.length < 2) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measured = selectedKeys.map((key) => {
      const element = canvas.querySelector(
        `[data-native-svg-key="${key}"]`,
      ) as SVGGraphicsElement | null;
      return { element, rect: element?.getBoundingClientRect() };
    });
    if (measured.some((item) => !item.rect || !item.element)) {
      setError(uiText('无法测量选中元素，请在源码中调整。'));
      return;
    }
    const rects = measured.map((item) => item.rect!),
      left = Math.min(...rects.map((r) => r.left)),
      right = Math.max(...rects.map((r) => r.right)),
      top = Math.min(...rects.map((r) => r.top)),
      bottom = Math.max(...rects.map((r) => r.bottom));
    const parent = measured[0].element!.parentElement as unknown as SVGGraphicsElement,
      matrix = parent.getScreenCTM?.();
    if (
      !matrix ||
      ![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite) ||
      Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12
    ) {
      setError(uiText('父分组的坐标变换不可逆，请在源码中调整。'));
      return;
    }
    const inverse = matrix.inverse();
    const moves = rects.map((rect) => {
      const dx =
          direction === 'left'
            ? left - rect.left
            : direction === 'right'
              ? right - rect.right
              : direction === 'center'
                ? (left + right - rect.left - rect.right) / 2
                : 0,
        dy =
          direction === 'top'
            ? top - rect.top
            : direction === 'bottom'
              ? bottom - rect.bottom
              : direction === 'middle'
                ? (top + bottom - rect.top - rect.bottom) / 2
                : 0;
      return {
        x: Math.round((inverse.a * dx + inverse.c * dy) * 10000) / 10000,
        y: Math.round((inverse.b * dx + inverse.d * dy) * 10000) / 10000,
      };
    });
    mutateSelection((targets) =>
      targets.forEach((target, index) => {
        const move = moves[index];
        if (move.x || move.y) translateElement(target, move.x, move.y);
      }),
    );
  }
  function reorderSelection(direction: 'front' | 'back' | 'forward' | 'backward') {
    if (!sameParent) return;
    mutateSelection((targets) => {
      const parent = targets[0].parentElement!,
        chosen = new Set(targets),
        ordered = Array.from(parent.children).filter((child) => chosen.has(child));
      if (direction === 'front') ordered.forEach((target) => parent.appendChild(target));
      else if (direction === 'back') {
        const first = Array.from(parent.children).find((child) => !chosen.has(child)) ?? null;
        ordered.forEach((target) => parent.insertBefore(target, first));
      } else if (direction === 'forward')
        for (const target of [...ordered].reverse()) {
          const next = target.nextElementSibling;
          if (next && !chosen.has(next)) parent.insertBefore(target, next.nextSibling);
        }
      else
        for (const target of ordered) {
          const previous = target.previousElementSibling;
          if (previous && !chosen.has(previous)) parent.insertBefore(target, previous);
        }
    });
  }
  function selectAll() {
    if (formDirty) {
      setNotice(uiText('请先应用或重置属性。'));
      return;
    }
    const keys = parsed.entries
      .filter((item) => !item.hidden && !item.definition)
      .slice(0, 100)
      .map((item) => item.key);
    setSelectedKeys(keys);
    setSelected(keys.at(-1) ?? null);
    setNotice(parsed.entries.length > 100 ? uiText('一次最多选择 100 个元素。') : '');
  }
  function canvasKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (
      (event.target as Element).closest('input,textarea,select,button') ||
      event.nativeEvent.isComposing
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAll();
      return;
    }
    if (disabled || !editableSelection || formDirty) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove();
      return;
    }
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      event.preventDefault();
      const amount = event.shiftKey ? 10 : 1;
      moveSelection(
        event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0,
        event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0,
      );
    }
  }
  function undo() {
    const previous = history.at(-1);
    if (readOnly || !previous || previous.after !== source) return;
    change(previous.before);
    setHistory((current) => current.slice(0, -1));
    setForm(null);
    setSelected(null);
    setSelectedKeys([]);
    setError('');
    setNotice(uiText('已撤销上一次图形操作，尚未写入文件。'));
  }
  const canUndo = !readOnly && history.at(-1)?.after === source;
  return (
    <div className="native-svg-editor" onKeyDown={canvasKeyDown}>
      <div className="native-svg-toolbar">
        <span className="native-svg-title">
          <Icon name="diagram" size={17} />
          {uiText('SVG 图形')}
        </span>
        <div className="native-svg-add">
          <select
            aria-label={uiText('新增图形类型')}
            value={shape}
            disabled={disabled}
            onChange={(event) => setShape(event.target.value as Exclude<Shape, 'path'>)}
          >
            <option value="rect">{uiText('矩形')}</option>
            <option value="circle">{uiText('圆形')}</option>
            <option value="ellipse">{uiText('椭圆')}</option>
            <option value="line">{uiText('直线')}</option>
            <option value="text">{uiText('文字')}</option>
          </select>
          <button type="button" disabled={disabled} onClick={add}>
            <Icon name="plus" size={14} />
            {uiText('新增')}
          </button>
        </div>
        <button
          type="button"
          disabled={!canUndo}
          onClick={undo}
          title={uiText('撤销上一次图形操作')}
        >
          {uiText('撤销')}
        </button>
        <div className="native-svg-zoom">
          <button
            type="button"
            aria-label={uiText('缩小画布')}
            onClick={() => setZoom(Math.max(0.000001, scale / 1.25))}
          >
            <Icon name="minus" size={14} />
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button
            type="button"
            aria-label={uiText('放大画布')}
            onClick={() => setZoom(Math.min(maxScale, scale * 1.25))}
          >
            <Icon name="plus" size={14} />
          </button>
          <button type="button" onClick={() => setZoom(null)} title={uiText('适应画布')}>
            <Icon name="fit" size={14} />
          </button>
        </div>
      </div>
      <div className="native-svg-selection-tools">
        <span>
          {selectedKeys.length
            ? uiText('已选 {0} 个元素', { '0': selectedKeys.length })
            : uiText('Shift / Ctrl 点击多选')}
        </span>
        <button disabled={disabled || formDirty} onClick={selectAll}>
          {uiText('选择可见图形')}
        </button>
        <button disabled={!selectedKeys.length || formDirty} onClick={() => choose(null)}>
          {uiText('取消选择')}
        </button>
        <div className="native-svg-align" role="group" aria-label={uiText('选区对齐')}>
          {(
            [
              ['left', uiText('左')],
              ['center', uiText('水平居中')],
              ['right', uiText('右')],
              ['top', uiText('上')],
              ['middle', uiText('垂直居中')],
              ['bottom', uiText('下')],
            ] as const
          ).map(([direction, label]) => (
            <button
              key={direction}
              disabled={disabled || formDirty || !sameParent || !multiple || !movableSelection}
              title={uiText('仅同一父分组内的图形可对齐')}
              onClick={() => alignSelection(direction)}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="group" aria-label={uiText('图形层级')}>
          {(
            [
              ['back', uiText('置底')],
              ['backward', uiText('下移一层')],
              ['forward', uiText('上移一层')],
              ['front', uiText('置顶')],
            ] as const
          ).map(([direction, label]) => (
            <button
              key={direction}
              disabled={disabled || formDirty || !sameParent}
              onClick={() => reorderSelection(direction)}
            >
              {label}
            </button>
          ))}
        </div>
        <button disabled={disabled || formDirty || !editableSelection} onClick={remove}>
          {uiText('删除选区')}
        </button>
      </div>
      {selectedEntries.length > 0 && !movableSelection && editableSelection && (
        <div className="native-svg-message">
          {uiText('选区含 CSS 坐标变换，微移和对齐请在源码中处理；可继续调整层级或删除。')}
        </div>
      )}
      {multiple && !sameParent && (
        <div className="native-svg-message">
          {uiText('跨父分组选区可删除或按各自坐标微移；对齐和层级调整仅适用于同一父分组。')}
        </div>
      )}
      {parsed.error ? (
        <div className="native-svg-message native-svg-error" role="alert">
          {parsed.error}
        </div>
      ) : null}
      {parsed.stylesheet ? (
        <div className="native-svg-message">
          {uiText(
            '此文件含 CSS 样式表，图形属性暂为只读。预览隐藏样式表，请在源码模式编辑，原文件内容仍完整保留。',
          )}
        </div>
      ) : null}
      {!parsed.error && (parsed.omitted > 0 || drawing.omitted > 0) ? (
        <div className="native-svg-message">
          {uiText(
            '安全预览仅显示支持的静态图形；脚本、外部资源、HTML、动画及不支持的样式已隐藏，保存时保留原内容。',
          )}
        </div>
      ) : null}
      <div className="native-svg-workspace">
        <div
          className="native-svg-viewport"
          ref={viewportRef}
          aria-busy={pending}
          tabIndex={0}
          aria-label={uiText('SVG 画布，方向键微移，Shift 方向键移动十个单位')}
        >
          <div className="native-svg-center">
            {!parsed.error ? (
              <div
                className="native-svg-canvas"
                ref={canvasRef}
                style={{
                  width: Math.max(1, parsed.width * scale),
                  height: Math.max(1, parsed.height * scale),
                }}
              >
                <svg
                  {...drawing.props}
                  xmlns={NS}
                  width="100%"
                  height="100%"
                  viewBox={parsed.viewBox}
                  role="img"
                  aria-label={uiText('SVG 文件预览')}
                  onClick={(event) => {
                    const target = (event.target as Element).closest('[data-native-svg-key]');
                    viewportRef.current?.focus();
                    choose(
                      target?.getAttribute('data-native-svg-key') ?? null,
                      event.shiftKey || event.ctrlKey || event.metaKey,
                    );
                  }}
                >
                  {drawing.content}
                </svg>
                {selectionBoxes.map(({ key, ...box }) => (
                  <div key={key} className="native-svg-selection" style={box} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                ))}
                {multiple && bounds ? (
                  <div className="native-svg-selection-union" style={bounds} aria-hidden="true" />
                ) : null}
              </div>
            ) : (
              <div className="native-svg-empty">
                <Icon name="code" size={32} />
                <strong>{uiText('继续编辑 SVG 源码')}</strong>
                <span>{uiText('补全内容后，图形预览会自动恢复。')}</span>
              </div>
            )}
          </div>
          {pending ? <span className="native-svg-refresh">{uiText('正在更新预览…')}</span> : null}
        </div>
        <aside className="native-svg-inspector" aria-label={uiText('SVG 元素属性')}>
          <div className="native-svg-inspector-heading">
            <span>{uiText('图形元素')}</span>
            <small>{parsed.entries.length}</small>
          </div>
          <div
            className="native-svg-elements"
            role="listbox"
            aria-multiselectable="true"
            aria-label={uiText('选择 SVG 元素')}
          >
            {parsed.entries.map((item) => (
              <button
                type="button"
                role="option"
                aria-selected={selectedKeys.includes(item.key)}
                className={selectedKeys.includes(item.key) ? 'is-selected' : ''}
                key={item.key}
                onClick={(event) =>
                  choose(item.key, event.shiftKey || event.ctrlKey || event.metaKey)
                }
              >
                <span className="native-svg-shape-symbol">
                  {item.tag === 'text'
                    ? 'T'
                    : item.tag === 'circle' || item.tag === 'ellipse'
                      ? '○'
                      : item.tag === 'line'
                        ? '╱'
                        : item.tag === 'path'
                          ? '⌁'
                          : '□'}
                </span>
                <span>{item.label}</span>
                {item.definition ? <small>{uiText('定义')}</small> : null}
              </button>
            ))}
            {!parsed.entries.length ? <p>{uiText('在工具栏新增图形，或编辑源码。')}</p> : null}
          </div>
          {entry && form && !multiple ? (
            <form
              className="native-svg-properties"
              onSubmit={(event) => {
                event.preventDefault();
                apply();
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current))
                  event.preventDefault();
              }}
            >
              <div className="native-svg-inspector-heading">
                <span>
                  {labels[entry.tag]}
                  {uiText('属性')}
                </span>
                <small>{formDirty ? uiText('未应用') : ''}</small>
              </div>
              <p className="native-svg-hint">
                {uiText('坐标沿用元素所在分组。留空会恢复继承值。')}
              </p>
              {entry.tag === 'text' && !simpleText(entry.element) ? (
                <p className="native-svg-hint">
                  {uiText('文字包含 tspan 等嵌套结构，请在源码中编辑文字内容。')}
                </p>
              ) : null}
              {entry.hidden ? (
                <p className="native-svg-message">
                  {uiText('该元素位于不支持的容器中，图形属性只读；请在源码模式编辑。')}
                </p>
              ) : null}
              {stale ? (
                <p className="native-svg-message">
                  {uiText('源码已变化。请重新载入属性后继续编辑。')}
                </p>
              ) : null}
              <fieldset disabled={disabled || stale || entry.hidden}>
                {fields(entry).map((field) => (
                  <label className={field.wide ? 'is-wide' : ''} key={field.name}>
                    <span>{field.label}</span>
                    {field.kind === 'text' || field.kind === 'path' ? (
                      <textarea
                        aria-label={field.label}
                        rows={field.kind === 'path' ? 4 : 2}
                        spellCheck={false}
                        maxLength={field.kind === 'path' ? 100000 : 20000}
                        disabled={field.kind === 'text' && !simpleText(entry.element)}
                        value={form.values[field.name] ?? ''}
                        onChange={(event) =>
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  values: { ...current.values, [field.name]: event.target.value },
                                }
                              : null,
                          )
                        }
                      />
                    ) : field.kind === 'anchor' ? (
                      <select
                        aria-label={field.label}
                        value={form.values[field.name] ?? ''}
                        onChange={(event) =>
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  values: { ...current.values, [field.name]: event.target.value },
                                }
                              : null,
                          )
                        }
                      >
                        <option value="">{uiText('继承')}</option>
                        <option value="start">{uiText('左对齐')}</option>
                        <option value="middle">{uiText('居中')}</option>
                        <option value="end">{uiText('右对齐')}</option>
                      </select>
                    ) : (
                      <div className="native-svg-input">
                        {field.kind === 'paint' &&
                        /^#[\da-f]{6}$/i.test(form.values[field.name] ?? '') ? (
                          <input
                            type="color"
                            aria-label={uiText('{0}选色', { '0': field.label })}
                            value={form.values[field.name]}
                            onChange={(event) =>
                              setForm((current) =>
                                current
                                  ? {
                                      ...current,
                                      values: {
                                        ...current.values,
                                        [field.name]: event.target.value,
                                      },
                                    }
                                  : null,
                              )
                            }
                          />
                        ) : null}
                        <input
                          aria-label={field.label}
                          spellCheck={false}
                          placeholder={uiText('继承')}
                          value={form.values[field.name] ?? ''}
                          maxLength={field.kind === 'transform' ? 1000 : 120}
                          onChange={(event) =>
                            setForm((current) =>
                              current
                                ? {
                                    ...current,
                                    values: { ...current.values, [field.name]: event.target.value },
                                  }
                                : null,
                            )
                          }
                        />
                      </div>
                    )}
                  </label>
                ))}
              </fieldset>
              <div className="native-svg-property-actions">
                <button type="button" onClick={reloadForm} disabled={pending}>
                  {stale ? uiText('重新载入') : uiText('重置属性')}
                </button>
                <button
                  className="native-svg-primary"
                  type="submit"
                  disabled={disabled || stale || entry.hidden || !formDirty}
                >
                  {uiText('应用属性')}
                </button>
              </div>
              <button
                className="native-svg-delete"
                type="button"
                disabled={disabled || formDirty || !editableSelection}
                onClick={remove}
              >
                {uiText('移除此元素')}
              </button>
            </form>
          ) : (
            <div className="native-svg-selection-hint">
              <Icon name="pen" size={22} />
              <span>
                {multiple
                  ? uiText(
                      '已选择 {0} 个图形，可对齐、调整层级或批量删除。点击画布后使用方向键微移，Shift 加速。',
                      { '0': selectedKeys.length },
                    )
                  : uiText('点击画布或列表选择元素；Shift / Ctrl 点击多选。编辑后应用到文件草稿。')}
              </span>
            </div>
          )}
        </aside>
      </div>
      {error || notice ? (
        <div
          className={`native-svg-message${error ? ' native-svg-error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error || notice}
        </div>
      ) : null}
      <div className="native-svg-status">
        <span>
          {readOnly
            ? uiText('当前文件不可编辑')
            : pending
              ? uiText('预览更新中')
              : parsed.stylesheet
                ? uiText('样式表文件 · 图形只读')
                : uiText('属性修改 → 应用到草稿 → 保存原文件')}
        </span>
        <span>
          {Math.round(parsed.width)} × {Math.round(parsed.height)}
        </span>
      </div>
    </div>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  labels = {
    rect: uiText('矩形'),
    circle: uiText('圆形'),
    ellipse: uiText('椭圆'),
    line: uiText('直线'),
    text: uiText('文字'),
    path: uiText('路径'),
  };
  commonFields = [
    { name: 'fill', label: uiText('填充'), kind: 'paint' },
    { name: 'stroke', label: uiText('描边'), kind: 'paint' },
    { name: 'stroke-width', label: uiText('描边宽度') },
    { name: 'opacity', label: uiText('不透明度') },
    { name: 'transform', label: uiText('变换'), kind: 'transform', wide: true },
  ];
  shapeFields = {
    rect: [
      { name: 'x', label: 'X' },
      { name: 'y', label: 'Y' },
      { name: 'width', label: uiText('宽度') },
      { name: 'height', label: uiText('高度') },
      { name: 'rx', label: uiText('圆角 X') },
      { name: 'ry', label: uiText('圆角 Y') },
    ],
    circle: [
      { name: 'cx', label: uiText('中心 X') },
      { name: 'cy', label: uiText('中心 Y') },
      { name: 'r', label: uiText('半径') },
    ],
    ellipse: [
      { name: 'cx', label: uiText('中心 X') },
      { name: 'cy', label: uiText('中心 Y') },
      { name: 'rx', label: uiText('半径 X') },
      { name: 'ry', label: uiText('半径 Y') },
    ],
    line: [
      { name: 'x1', label: uiText('起点 X') },
      { name: 'y1', label: uiText('起点 Y') },
      { name: 'x2', label: uiText('终点 X') },
      { name: 'y2', label: uiText('终点 Y') },
    ],
    text: [
      { name: '$text', label: uiText('文字内容'), kind: 'text', wide: true },
      { name: 'x', label: 'X' },
      { name: 'y', label: 'Y' },
      { name: 'font-size', label: uiText('字号') },
      { name: 'font-weight', label: uiText('字重'), kind: 'number' },
      { name: 'text-anchor', label: uiText('对齐'), kind: 'anchor' },
    ],
    path: [{ name: 'd', label: uiText('路径数据'), kind: 'path', wide: true }],
  };
});
