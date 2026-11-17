import { tableShapes } from './office-tables.js';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { posix } from 'node:path';
import { fail } from '../../contracts/index.js';
import { NATIVE_FILE_LIMIT } from '../../components/native-files.js';
import type {
  OfficeChange,
  OfficePage,
  OfficeParagraph,
  OfficeShape,
  OfficeRun,
} from '../../contracts/office.js';
import {
  xml,
  xmlTree,
  child,
  attrs,
  prefix,
  escape,
  replaceSpans,
  type XmlNode,
} from './spreadsheet/xlsx-xml.js';
import {
  formatOfficeRun,
  formatOfficeShape,
  officeColor,
  replaceOfficeText,
} from './office-formatting.js';
function xmlText(source: string, node: XmlNode) {
  let text = '';
  const parser = new SaxesParser({ xmlns: false });
  parser.on('text', (v) => (text += v));
  parser.on('cdata', (v) => (text += v));
  parser.write(source.slice(node.start, node.end)).close();
  return text;
}
type Ref = {
  path: string;
  source: string;
  node: XmlNode;
  kind: 'run' | 'paragraph' | 'shape';
  word: boolean;
  blocked?: string;
  structural?: boolean;
  styleEditable?: boolean;
};
const all = (n: XmlNode): XmlNode[] => [n, ...n.children.flatMap(all)];
const raw = (s: string, n: XmlNode) => s.slice(n.start, n.end);
const build = (
  s: string,
  n: XmlNode,
  a: Record<string, string | undefined> = {},
  body = s.slice(n.openEnd, n.closeStart),
) => (body ? `<${n.name}${attrs(n, a)}>${body}</${n.name}>` : `<${n.name}${attrs(n, a)}/>`);
const val = (n: XmlNode | undefined, name: string) =>
  n?.attributes[
    Object.keys(n.attributes).find((k) => k === name || k.endsWith(':' + name)) ?? name
  ];
function orderFields(body: string, fields: string[], order: string[]) {
  for (const name of fields) {
    let wrapped = `<container>${body}</container>`,
      root = xmlTree(wrapped),
      node = child(root, name);
    if (!node) continue;
    const value = raw(wrapped, node);
    wrapped = replaceSpans(wrapped, [{ start: node.start, end: node.end, text: '' }]);
    root = xmlTree(wrapped);
    const next = root.children.find((n) => order.indexOf(n.local) > order.indexOf(name)),
      at = next?.start ?? root.closeStart;
    wrapped = wrapped.slice(0, at) + value + wrapped.slice(at);
    body = wrapped.slice('<container>'.length, -'</container>'.length);
  }
  return body;
}
const runOrder =
  'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange'.split(
    ' ',
  );
const paragraphOrder =
  'pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange'.split(
    ' ',
  );
function resolvePart(base: string, target: string) {
  const p = target.startsWith('/')
    ? target.slice(1)
    : posix.normalize(posix.join(posix.dirname(base), target));
  if (p.startsWith('../') || p.includes('\\')) fail('OFFICE_FILE', '文档关联路径无效。');
  return p;
}
export async function loadOffice(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes),
    files = Object.values(zip.files);
  let total = 0;
  if (files.length > 4000) fail('OFFICE_LIMIT', '文档部件过多。');
  for (const f of files) {
    const n = (f as any)._data?.uncompressedSize ?? 0;
    total += n;
    if (n > 16 * 1024 * 1024 || total > 64 * 1024 * 1024)
      fail('OFFICE_LIMIT', '文档解压后超过 64 MiB 限制。');
  }
  return zip;
}
function property(
  source: string,
  container: XmlNode | undefined,
  tag: string,
  name: string,
  value: string,
  word: boolean,
) {
  const p = word ? 'w:' : 'a:',
    existing = container?.children.find((n) => n.local === tag),
    attr = word ? `w:${name}` : name;
  const rendered = existing
    ? build(source, existing, {
        [Object.keys(existing.attributes).find((k) => k === name || k.endsWith(':' + name)) ??
        attr]: value,
      })
    : `<${p}${tag} ${attr}="${escape(value)}"/>`;
  return { existing, rendered };
}
export async function parseOffice(
  zip: JSZip,
  fileName: string,
  options: { textOnly?: boolean } = {},
) {
  const word = /\.docx$/i.test(fileName),
    refs = new Map<string, Ref>(),
    paragraphs: OfficeParagraph[][] = [],
    shapes: OfficeShape[][] = [],
    labels: string[] = [],
    backgrounds: (string | undefined)[] = [],
    signed = Object.keys(zip.files).some((p) => p.startsWith('_xmlsignatures/'));
  let globalBlock = signed ? '带数字签名的文档只读' : '',
    width = 960,
    height = 540;
  const parts: string[] = [];
  if (word) {
    if (zip.file('word/settings.xml')) {
      const settings = xmlTree(await xml(zip, 'word/settings.xml'));
      if (
        all(settings).some(
          (n) =>
            n.local === 'documentProtection' &&
            !['0', 'false', 'off'].includes(val(n, 'enforcement') ?? '1'),
        )
      )
        globalBlock = '文档已受保护';
    }
    parts.push('word/document.xml');
  } else {
    const source = await xml(zip, 'ppt/presentation.xml'),
      root = xmlTree(source),
      rels = xmlTree(await xml(zip, 'ppt/_rels/presentation.xml.rels')),
      size = child(root, 'sldSz');
    width = Number(size?.attributes.cx ?? 9144000) / 9525;
    height = Number(size?.attributes.cy ?? 5143500) / 9525;
    for (const n of child(root, 'sldIdLst')?.children ?? []) {
      const relation =
        rels.children.find(
          (r) => r.attributes.Id === val(n, 'id') && r.attributes.Type?.endsWith('/slide'),
        ) ??
        rels.children.find(
          (r) =>
            r.attributes.Id ===
            n.attributes[Object.keys(n.attributes).find((k) => k.endsWith(':id')) ?? 'r:id'],
        );
      if (relation && relation.attributes.TargetMode !== 'External')
        parts.push(resolvePart('ppt/presentation.xml', relation.attributes.Target));
    }
    if (!parts.length) fail('OFFICE_FILE', '没有可浏览的幻灯片。');
    if (parts.length > 500) fail('OFFICE_LIMIT', '当前最多支持 500 张幻灯片。');
  }
  for (let pi = 0; pi < parts.length; pi++) {
    const path = parts[pi],
      source = await xml(zip, path),
      root = xmlTree(source),
      pagePars: OfficeParagraph[] = [],
      pageShapes: OfficeShape[] = [];
    if (word && root.name !== 'w:document')
      globalBlock = '此文档采用未支持的命名空间形式，当前只读';
    const ancestors = new Map<XmlNode, XmlNode[]>();
    const collect = (n: XmlNode, parents: XmlNode[]) => {
      ancestors.set(n, parents);
      n.children.forEach((c) => collect(c, [...parents, n]));
    };
    collect(root, []);
    const shapeMap = new Map<XmlNode, string>(),
      tree = !word ? child(child(root, 'cSld') ?? root, 'spTree') : undefined;
    if (tree) {
      const relPath = posix.join(posix.dirname(path), '_rels', posix.basename(path) + '.rels'),
        relationships = zip.file(relPath) ? xmlTree(await xml(zip, relPath)).children : [];
      for (const [si, n] of tree.children
        .filter((n) => ['sp', 'pic', 'graphicFrame', 'grpSp'].includes(n.local))
        .entries()) {
        const id = `s${pi}:${si}`,
          properties = child(n, 'spPr'),
          transform =
            n.local === 'graphicFrame' ? child(n, 'xfrm') : properties && child(properties, 'xfrm'),
          off = transform && child(transform, 'off'),
          ext = transform && child(transform, 'ext'),
          meta = all(n).find((n) => n.local === 'cNvPr'),
          editable =
            !!off && !!ext && !globalBlock && n.local !== 'grpSp' && n.local !== 'graphicFrame';
        const styleEditable = n.local === 'sp' && !globalBlock;
        const shape: OfficeShape = {
          rotation: Number(transform?.attributes.rot ?? 0) / 60000,
          fill: officeColor(properties),
          stroke: officeColor(properties && child(properties, 'ln')),
          strokeWidth: Number((properties && child(properties, 'ln')?.attributes.w) ?? 0) / 9525,
          styleEditable,
          id,
          name: meta?.attributes.name ?? `元素 ${si + 1}`,
          x: Number(off?.attributes.x ?? 0) / 9525,
          y: Number(off?.attributes.y ?? 0) / 9525,
          width: Number(ext?.attributes.cx ?? 2857500) / 9525,
          height: Number(ext?.attributes.cy ?? 952500) / 9525,
          editable,
        };
        if (n.local === 'pic' && !options.textOnly) {
          const blip = all(n).find((n) => n.local === 'blip'),
            rid = blip && val(blip, 'embed'),
            rel = relationships.find((r) => r.attributes.Id === rid);
          if (rel && rel.attributes.TargetMode !== 'External') {
            const asset = resolvePart(path, rel.attributes.Target),
              mime = /\.png$/i.test(asset)
                ? 'image/png'
                : /\.jpe?g$/i.test(asset)
                  ? 'image/jpeg'
                  : null,
              entry = zip.file(asset);
            if (mime && entry) {
              const data = await entry.async('nodebuffer');
              if (data.length <= 1024 * 1024)
                shape.image = `data:${mime};base64,${data.toString('base64')}`;
            }
          }
        }
        const table =
          n.local === 'graphicFrame' ? all(n).find((node) => node.local === 'tbl') : undefined;
        if (table) {
          pageShapes.push(...tableShapes(table, shape, shapeMap));
          continue;
        }
        pageShapes.push(shape);
        shapeMap.set(n, id);
        if (transform && properties)
          refs.set(id, {
            path,
            source,
            node: properties!,
            kind: 'shape',
            word,
            styleEditable,
            blocked: editable ? undefined : globalBlock || '此元素继承布局或采用组合变换，位置只读',
          });
      }
    }
    let pindex = 0;
    for (const n of all(root).filter(
      (n) => n.local === 'p' && (word ? n.name === 'w:p' : n.name === 'a:p'),
    )) {
      const parents = ancestors.get(n) ?? [],
        id = `p${pi}:${pindex++}`,
        shapeParent = [...parents].reverse().find((n) => shapeMap.has(n)),
        shapeId = shapeParent && shapeMap.get(shapeParent),
        ppr = child(n, 'pPr');
      const complex =
        parents.some((n) => ['ins', 'del', 'sdt', 'AlternateContent', 'grpSp'].includes(n.local)) ||
        n.children.some((n) => !['pPr', 'r', 'endParaRPr'].includes(n.local)) ||
        n.children
          .filter((n) => n.local === 'r')
          .some((r) => r.children.some((c) => !['rPr', 't', 'tab', 'br'].includes(c.local)));
      const blocked = globalBlock || (complex ? '域、修订、超链接、组合元素或复杂段落只读' : '');
      const runs: OfficeRun[] = n.children
        .filter((n) => n.local === 'r')
        .map((r, ri) => {
          const rid = `${id}:r${ri}`,
            direct = child(r, 'rPr'),
            defaults = !word && ppr ? child(ppr, 'defRPr') : undefined,
            rpr =
              direct && defaults
                ? {
                    ...direct,
                    attributes: { ...defaults.attributes, ...direct.attributes },
                    children: [
                      ...direct.children,
                      ...defaults.children.filter(
                        (c) => !direct.children.some((d) => d.local === c.local),
                      ),
                    ],
                  }
                : (direct ?? defaults),
            text = r.children
              .filter((c) => ['t', 'tab', 'br'].includes(c.local))
              .map((c) => (c.local === 't' ? xmlText(source, c) : c.local === 'tab' ? '\t' : '\n'))
              .join('');
          refs.set(rid, { path, source, node: r, kind: 'run', word, blocked });
          const on = (name: string) =>
            word
              ? !!child(rpr ?? r, name) &&
                !['0', 'false', 'off'].includes(val(child(rpr ?? r, name), 'val') ?? '1')
              : rpr?.attributes[name] === '1';
          return {
            id: rid,
            text,
            bold: on('b'),
            italic: on('i'),
            underline: word
              ? !!child(rpr ?? r, 'u') && val(child(rpr ?? r, 'u'), 'val') !== 'none'
              : !!rpr?.attributes.u && rpr.attributes.u !== 'none',
            fontSize: word
              ? Number(val(rpr && child(rpr, 'sz'), 'val')) || undefined
              : Number(rpr?.attributes.sz) || undefined,
            fontFamily: word
              ? val(rpr && child(rpr, 'rFonts'), 'ascii')
              : rpr && child(rpr, 'latin')?.attributes.typeface,
            color: word
              ? /^([0-9a-f]{6})$/i.test(val(rpr && child(rpr, 'color'), 'val') ?? '')
                ? '#' + val(rpr && child(rpr, 'color'), 'val')
                : undefined
              : officeColor(rpr)?.startsWith('#')
                ? officeColor(rpr)
                : undefined,
          };
        });
      // Empty simple paragraphs can be edited by adding their first run.
      if (!runs.length && !blocked) {
        const rid = `${id}:empty`;
        refs.set(rid, { path, source, node: n, kind: 'run', word });
        runs.push({ id: rid, text: '', bold: false, italic: false });
      }
      if (blocked) {
        runs.splice(0, runs.length, {
          id: `${id}:readonly`,
          text: all(n)
            .filter((n) => ['t', 'br', 'tab'].includes(n.local))
            .map((t) => (t.local === 't' ? xmlText(source, t) : t.local === 'br' ? '\n' : '\t'))
            .join(''),
          bold: false,
          italic: false,
        });
      }
      const continuous =
        word &&
        !blocked &&
        parents.at(-1)?.local === 'body' &&
        !all(n).some(
          (c) =>
            c.local === 'sectPr' ||
            (c.local === 'br' && val(c, 'type') && val(c, 'type') !== 'textWrapping'),
        );
      refs.set(id, {
        path,
        source,
        node: n,
        kind: 'paragraph',
        word,
        blocked,
        structural: continuous,
      });
      for (const run of runs) if (run.fontSize) run.fontSize /= word ? 2 : 100;
      const spacing = ppr && child(ppr, 'spacing'),
        align = word ? val(ppr && child(ppr, 'jc'), 'val') : ppr?.attributes.algn;
      pagePars.push({
        id,
        shapeId,
        runs,
        continuous,
        readOnly: blocked || undefined,
        align:
          ({ l: 'left', ctr: 'center', r: 'right', just: 'both' } as Record<string, string>)[
            align ?? ''
          ] ??
          align ??
          'left',
        before: Number(val(spacing, 'before') ?? 0) / 20,
        after: Number(val(spacing, 'after') ?? 0) / 20,
      });
    }
    if (word) {
      const rp = 'word/_rels/document.xml.rels',
        rels = zip.file(rp) ? xmlTree(await xml(zip, rp)).children : [];
      for (const [pi, para] of (options.textOnly
        ? []
        : all(root).filter((n) => n.name === 'w:p')
      ).entries())
        for (const blip of all(para).filter((n) => n.local === 'blip')) {
          const rel = rels.find((r) => r.attributes.Id === val(blip, 'embed'));
          if (!rel || rel.attributes.TargetMode === 'External') continue;
          const asset = resolvePart(path, rel.attributes.Target),
            entry = zip.file(asset),
            mime = /\.png$/i.test(asset)
              ? 'image/png'
              : /\.jpe?g$/i.test(asset)
                ? 'image/jpeg'
                : null;
          if (entry && mime) {
            const bytes = await entry.async('nodebuffer');
            if (bytes.length <= 5 * 1024 * 1024)
              pageShapes.push({
                id: `p0:${pi}:image`,
                name: `段落 ${pi + 1} 的图片`,
                x: 0,
                y: 0,
                width: 400,
                height: 300,
                editable: false,
                image: `data:${mime};base64,${bytes.toString('base64')}`,
              });
          }
        }
      if (pagePars.length > 10000) fail('OFFICE_LIMIT', '文档超过 10000 个段落。');
      for (let start = 0; start < Math.max(1, pagePars.length); start += 40) {
        paragraphs.push(pagePars.slice(start, start + 40));
        shapes.push(
          pageShapes.filter((s) => {
            const i = Number(s.id.split(':')[1]);
            return i >= start && i < start + 40;
          }),
        );
        labels.push(`段落 ${start + 1}–${Math.min(start + 40, pagePars.length)}`);
      }
    } else {
      backgrounds.push(
        officeColor(
          child(child(root, 'cSld') ?? root, 'bg') &&
            child(child(child(root, 'cSld') ?? root, 'bg')!, 'bgPr'),
        ),
      );
      paragraphs.push(pagePars);
      shapes.push(pageShapes);
      labels.push(
        `第 ${pi + 1} 页 · ${pagePars
          .flatMap((p) => p.runs.map((r) => r.text))
          .join(' ')
          .slice(0, 40)}`,
      );
    }
  }
  return { refs, paragraphs, shapes, labels, width, height, word, globalBlock, backgrounds };
}
export class OfficeEditor {
  async read(
    bytes: Buffer,
    fileName: string,
    objectId: string,
    revision: number,
    page: number,
    pageCount = 1,
  ): Promise<OfficePage> {
    const parsed = await parseOffice(await loadOffice(bytes), fileName);
    if (page >= parsed.paragraphs.length) fail('OFFICE_PAGE', '页码不存在。');
    const loadedPages = parsed.word
      ? Math.min(Math.max(1, Math.min(25, pageCount)), parsed.paragraphs.length - page)
      : 1;
    return {
      objectId,
      revision,
      fileName,
      kind: parsed.word ? 'docx' : 'pptx',
      page,
      pages: parsed.paragraphs.length,
      loadedPages,
      labels: parsed.labels,
      paragraphs: parsed.paragraphs.slice(page, page + loadedPages).flat(),
      shapes: parsed.shapes.slice(page, page + loadedPages).flat(),
      width: parsed.width,
      height: parsed.height,
      background: parsed.backgrounds[page],
      warnings: [
        parsed.globalBlock || '基于原文件的兼容编辑，保留未编辑的部件；复杂内容只读。',
        parsed.word
          ? '连续正文按需载入，最多同时编辑 1000 段；页眉页脚、图像和原排版保留在文件内。'
          : '画布用于定位文本和图片，并非 PowerPoint 的完整渲染；主题、母版、动画及复杂对象保留在原文件。',
      ],
    };
  }
  async save(bytes: Buffer, fileName: string, edits: OfficeChange[]) {
    const zip = await loadOffice(bytes),
      parsed = await parseOffice(zip, fileName),
      byPath = new Map<string, Map<string, OfficeChange>>(),
      seen = new Set<string>();
    for (const edit of edits) {
      if (seen.has(edit.id)) fail('OFFICE_EDIT', '编辑标识重复。');
      seen.add(edit.id);
      const ref = parsed.refs.get(edit.id);
      if (!ref || ref.kind !== edit.kind) fail('OFFICE_EDIT', '编辑位置已失效。');
      if (ref.blocked) fail('OFFICE_READ_ONLY', ref.blocked);
      if (edit.kind === 'paragraph' && edit.replacement !== undefined && !ref.structural)
        fail(
          'OFFICE_READ_ONLY',
          '只有正文普通段落支持连续结构编辑，分节、表格及复杂段落请使用兼容编辑。',
        );
      if (
        edit.kind === 'shape' &&
        !ref.styleEditable &&
        (edit.fill !== undefined || edit.stroke !== undefined || edit.strokeWidth !== undefined)
      )
        fail('OFFICE_READ_ONLY', '此元素仅支持位置、尺寸和旋转调整。');
      if (!byPath.has(ref.path)) byPath.set(ref.path, new Map());
      byPath.get(ref.path)!.set(edit.id, edit);
    }
    if (
      parsed.word &&
      parsed.paragraphs.flat().length +
        edits.reduce(
          (n, e) =>
            n +
            (e.kind === 'paragraph' && e.replacement !== undefined ? e.replacement.length - 1 : 0),
          0,
        ) >
        10000
    )
      fail('OFFICE_LIMIT', '编辑后超过 10000 个段落。保存前请减少新增段落。');
    for (const [path, changes] of byPath) {
      let source = await xml(zip, path);
      const nodes = new Map<XmlNode, OfficeChange[]>();
      for (const [id, edit] of changes) {
        const ref = parsed.refs.get(id)!;
        if (!nodes.has(ref.node)) nodes.set(ref.node, []);
        nodes.get(ref.node)!.push(edit);
      }
      const root = xmlTree(source),
        offsetChanges = new Map([...nodes].map(([n, e]) => [n.start, e]));
      const render = (n: XmlNode): string => {
        const own = offsetChanges.get(n.start) ?? [],
          run = own.find((e) => e.kind === 'run'),
          para = own.find((e) => e.kind === 'paragraph'),
          shape = own.find((e) => e.kind === 'shape');
        let body = '',
          at = n.openEnd;
        for (const c of n.children) {
          body += source.slice(at, c.start) + render(c);
          at = c.end;
        }
        body += source.slice(at, n.closeStart);
        if (run?.kind === 'run') {
          const word = parsed.word,
            p = word ? 'w:' : 'a:',
            rpr = child(n, 'rPr');
          let properties = rpr ? raw(source, rpr) : '';
          properties = formatOfficeRun(properties, word, run);
          const content = word
            ? run.text
                .split(/(\n|\t)/)
                .map((t) =>
                  t === '\n'
                    ? `<${p}br/>`
                    : t === '\t'
                      ? '<w:tab/>'
                      : `<${p}t xml:space="preserve">${escape(t)}</${p}t>`,
                )
                .join('')
            : `<a:t xml:space="preserve">${escape(run.text)}</a:t>`;
          if (n.local === 'p') body = body + `<${p}r>${properties}${content}</${p}r>`;
          else body = properties + content;
        }
        if (para?.kind === 'paragraph') {
          const word = parsed.word,
            p = word ? 'w:' : 'a:',
            old = child(n, 'pPr');
          let props = old ? source.slice(old.openEnd, old.closeStart) : '';
          if (word) {
            if (para.align !== undefined) {
              const jc = property(source, old, 'jc', 'val', para.align, true);
              if (jc.existing)
                props = replaceSpans(props, [
                  {
                    start: jc.existing.start - old!.openEnd,
                    end: jc.existing.end - old!.openEnd,
                    text: jc.rendered,
                  },
                ]);
              else props += jc.rendered;
            }
            const spacing = child(
              xmlTree(
                `<w:pPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${props}</w:pPr>`,
              ),
              'spacing',
            );
            const propertySource = `<w:pPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${props}</w:pPr>`;
            if (para.before !== undefined || para.after !== undefined) {
              const a = {
                'w:before':
                  para.before === undefined
                    ? val(spacing, 'before')
                    : String(Math.round(para.before * 20)),
                'w:after':
                  para.after === undefined
                    ? val(spacing, 'after')
                    : String(Math.round(para.after * 20)),
              };
              const sp = spacing
                ? build(propertySource, spacing, a)
                : `<w:spacing${attrs({ attributes: {} } as XmlNode, a)}/>`;
              props = spacing
                ? replaceSpans(propertySource, [
                    { start: spacing.start, end: spacing.end, text: sp },
                  ]).replace(/^<w:pPr[^>]*>|<\/w:pPr>$/g, '')
                : props + sp;
            }
          }
          if (word) props = orderFields(props, ['spacing', 'jc'], paragraphOrder);
          const replacement = old
            ? build(
                source,
                old,
                word || para.align === undefined
                  ? {}
                  : { algn: { left: 'l', center: 'ctr', right: 'r', both: 'just' }[para.align] },
                props,
              )
            : `<${p}pPr${word || para.align === undefined ? '' : ` algn="${{ left: 'l', center: 'ctr', right: 'r', both: 'just' }[para.align]}"`}>${props}</${p}pPr>`;
          if (old) body = body.replace(raw(source, old), replacement);
          else body = replacement + body;
        }
        if (shape?.kind === 'shape') {
          let properties = build(source, n, {}, body),
            pr = xmlTree(properties),
            transform = child(pr, 'xfrm')!,
            off = child(transform, 'off')!,
            ext = child(transform, 'ext')!;
          const transformed = replaceSpans(properties, [
            {
              start: off.start,
              end: off.end,
              text: build(properties, off, {
                x: String(Math.round(shape.x * 9525)),
                y: String(Math.round(shape.y * 9525)),
              }),
            },
            {
              start: ext.start,
              end: ext.end,
              text: build(properties, ext, {
                cx: String(Math.round(shape.width * 9525)),
                cy: String(Math.round(shape.height * 9525)),
              }),
            },
          ]);
          const t = xmlTree(transformed),
            x = child(t, 'xfrm')!;
          properties = replaceSpans(transformed, [
            {
              start: x.start,
              end: x.end,
              text: build(transformed, x, {
                rot:
                  shape.rotation === undefined
                    ? x.attributes.rot
                    : String(Math.round(shape.rotation * 60000)),
              }),
            },
          ]);
          return formatOfficeShape(properties, shape);
        }
        if (para?.kind === 'paragraph' && para.replacement !== undefined) {
          if (!para.replacement.length) return '';
          const value = build(source, n, {}, body);
          return para.replacement
            .map((text, index) => {
              let replacement = replaceOfficeText(value, text, true);
              if (index) {
                const p = xmlTree(replacement);
                replacement = build(
                  replacement,
                  p,
                  Object.fromEntries(
                    Object.keys(p.attributes)
                      .filter((k) => k.endsWith(':paraId') || k.endsWith(':textId'))
                      .map((k) => [k, undefined]),
                  ),
                );
              }
              return replacement;
            })
            .join('');
        }
        return own.length || n.children.some((c) => offsetChanges.has(c.start))
          ? build(source, n, {}, body)
          : body !== source.slice(n.openEnd, n.closeStart)
            ? build(source, n, {}, body)
            : raw(source, n);
      };
      let output = source.slice(0, root.start) + render(root) + source.slice(root.end);
      if (parsed.word) {
        const r = xmlTree(output),
          b = child(r, 'body');
        if (b && !b.children.some((n) => n.local === 'p')) {
          const at = child(b, 'sectPr')?.start ?? b.closeStart;
          output = output.slice(0, at) + '<w:p/>' + output.slice(at);
        }
      }
      zip.file(path, output);
    }
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    if (out.length > NATIVE_FILE_LIMIT) fail('OFFICE_LIMIT', '保存后的文档超过 50 MiB。');
    return out;
  }
}
