import JSZip from 'jszip';
import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from '../../contracts/index.js';
import { parseOffice, loadOffice } from './office-editor.js';
import {
  xml,
  xmlTree,
  child,
  attrs,
  escape,
  replaceSpans,
  type XmlNode,
} from './spreadsheet/xlsx-xml.js';
const walk = (n: XmlNode): XmlNode[] => [n, ...n.children.flatMap(walk)];
const raw = (s: string, n: XmlNode) => s.slice(n.start, n.end);
const inside = (s: string, n: XmlNode) => s.slice(n.openEnd, n.closeStart);
const build = (s: string, n: XmlNode, body: string) => `<${n.name}${attrs(n)}>${body}</${n.name}>`;
const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships',
  officeNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const partPath = (base: string, target: string) =>
  target.startsWith('/')
    ? target.slice(1)
    : posix.normalize(posix.join(posix.dirname(base), target));
const relPath = (part: string) =>
  posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
function parentOf(root: XmlNode, node: XmlNode): XmlNode | undefined {
  return walk(root).find((n) =>
    n.children.some((c) => c.start === node.start && c.end === node.end),
  );
}
async function addRelation(zip: JSZip, part: string, type: string, target: string) {
  const path = relPath(part),
    source = zip.file(path) ? await xml(zip, path) : `<Relationships xmlns="${relNs}"/>`,
    root = xmlTree(source),
    id = 'rId' + randomUUID().replace(/-/g, '');
  zip.file(
    path,
    build(
      source,
      root,
      inside(source, root) +
        `<Relationship Id="${id}" Type="${officeNs}/${type}" Target="${escape(target)}"/>`,
    ),
  );
  return id;
}
async function contentType(zip: JSZip, part: string, type: string) {
  const s = await xml(zip, '[Content_Types].xml'),
    root = xmlTree(s);
  if (!root.children.some((n) => n.attributes.PartName === '/' + part))
    zip.file(
      '[Content_Types].xml',
      build(s, root, inside(s, root) + `<Override PartName="/${part}" ContentType="${type}"/>`),
    );
}
async function imagePart(zip: JSZip, folder: string, data: unknown) {
  const encoded = z.string().max(7000000).parse(data),
    bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length > 5 * 1024 * 1024)
    fail('OFFICE_IMAGE', '图片最多 5 MiB。');
  const ext = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'png'
    : bytes[0] === 255 && bytes[1] === 216
      ? 'jpeg'
      : null;
  if (!ext) fail('OFFICE_IMAGE', '请选择 PNG 或 JPEG 图片。');
  const part = `${folder}/media/image-${randomUUID()}.${ext}`;
  zip.file(part, bytes);
  await contentType(zip, part, `image/${ext}`);
  return part;
}
const paragraph = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;
export async function structureOffice(bytes: Buffer, fileName: string, input: unknown) {
  const op = z
    .object({
      kind: z.enum([
        'insert_paragraph',
        'delete_paragraph',
        'list',
        'insert_table',
        'insert_image',
        'slide_add',
        'slide_copy',
        'slide_delete',
        'slide_move',
        'shape_add',
        'shape_delete',
        'shape_layer',
        'slide_style',
        'slide_size',
      ]),
      id: z.string().max(150).optional(),
      page: z.number().int().min(0).max(499).default(0),
      text: z.string().max(50000).default(''),
      list: z.enum(['bullet', 'decimal', 'none']).optional(),
      rows: z.number().int().min(1).max(30).optional(),
      columns: z.number().int().min(1).max(12).optional(),
      position: z.number().int().min(1).max(500).optional(),
      data: z.string().max(7000000).optional(),
      x: z.number().min(0).max(10000).default(60),
      y: z.number().min(0).max(10000).default(60),
      width: z.number().min(1).max(10000).default(400),
      height: z.number().min(1).max(10000).default(180),
      color: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .optional(),
      layer: z.enum(['front', 'back', 'forward', 'backward']).optional(),
    })
    .strict()
    .parse(input);
  const zip = await loadOffice(bytes),
    parsed = await parseOffice(zip, fileName);
  if (parsed.globalBlock) fail('OFFICE_READ_ONLY', parsed.globalBlock);
  if (parsed.word) {
    const path = 'word/document.xml',
      source = await xml(zip, path),
      root = xmlTree(source),
      body = child(root, 'body')!,
      ref = op.id ? parsed.refs.get(op.id) : undefined,
      anchor = ref?.kind === 'paragraph' ? ref.node : undefined;
    if (op.id && (!anchor || ref?.blocked))
      fail('OFFICE_READ_ONLY', ref?.blocked ?? '段落位置已改变。');
    const at = anchor?.end ?? child(body, 'sectPr')?.start ?? body.closeStart;
    let replacement = '';
    if (op.kind === 'delete_paragraph') {
      if (!anchor) fail('OFFICE_EDIT', '请选择段落。');
      if (walk(anchor).some((n) => n.local === 'sectPr'))
        fail('OFFICE_EDIT', '此段落承载分节设置，不能直接删除。');
      const parent = parentOf(root, anchor)!;
      replacement = parent.children.filter((n) => n.local === 'p').length === 1 ? '<w:p/>' : '';
      zip.file(
        path,
        replaceSpans(source, [{ start: anchor.start, end: anchor.end, text: replacement }]),
      );
    } else if (op.kind === 'list') {
      if (!anchor) fail('OFFICE_EDIT', '请选择段落。');
      const ppr = child(anchor, 'pPr');
      let properties = ppr ? inside(source, ppr) : '',
        numPr = ppr && child(ppr, 'numPr');
      if (numPr)
        properties = replaceSpans(properties, [
          { start: numPr.start - ppr!.openEnd, end: numPr.end - ppr!.openEnd, text: '' },
        ]);
      if (op.list !== 'none') {
        const np = 'word/numbering.xml',
          ns = zip.file(np)
            ? await xml(zip, np)
            : '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
          nr = xmlTree(ns),
          aid =
            Math.max(
              0,
              ...nr.children
                .filter((n) => n.local === 'abstractNum')
                .map((n) => Number(n.attributes['w:abstractNumId']) || 0),
            ) + 1,
          nid =
            Math.max(
              0,
              ...nr.children
                .filter((n) => n.local === 'num')
                .map((n) => Number(n.attributes['w:numId']) || 0),
            ) + 1;
        const abstract = `<w:abstractNum w:abstractNumId="${aid}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${op.list ?? 'bullet'}"/><w:lvlText w:val="${op.list === 'decimal' ? '%1.' : '•'}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
        const firstNum = nr.children.find((n) => n.local === 'num'),
          newBody = firstNum
            ? inside(ns, nr).slice(0, firstNum.start - nr.openEnd) +
              abstract +
              inside(ns, nr).slice(firstNum.start - nr.openEnd)
            : inside(ns, nr) + abstract;
        zip.file(
          np,
          build(
            ns,
            nr,
            newBody + `<w:num w:numId="${nid}"><w:abstractNumId w:val="${aid}"/></w:num>`,
          ),
        );
        await contentType(
          zip,
          np,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
        );
        const rels = zip.file(relPath(path)) ? await xml(zip, relPath(path)) : '';
        if (!rels.includes(`${officeNs}/numbering`))
          await addRelation(zip, path, 'numbering', 'numbering.xml');
        const wrapper = `<w:pPr>${properties}</w:pPr>`,
          pr = xmlTree(wrapper),
          before = pr.children.find(
            (n) =>
              ![
                'pStyle',
                'keepNext',
                'keepLines',
                'pageBreakBefore',
                'framePr',
                'widowControl',
              ].includes(n.local),
          ),
          offset = before ? before.start - pr.openEnd : properties.length;
        properties =
          properties.slice(0, offset) +
          `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${nid}"/></w:numPr>` +
          properties.slice(offset);
      }
      const value = `<w:pPr>${properties}</w:pPr>`;
      zip.file(
        path,
        replaceSpans(source, [
          { start: ppr?.start ?? anchor.openEnd, end: ppr?.end ?? anchor.openEnd, text: value },
        ]),
      );
    } else {
      if (op.kind === 'insert_paragraph') replacement = paragraph(op.text);
      else if (op.kind === 'insert_table') {
        const rows = op.rows ?? 3,
          cols = op.columns ?? 3;
        replacement = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((k) => `<w:${k} w:val="single" w:sz="4" w:color="999999"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>${Array.from({ length: rows }, () => `<w:tr>${Array.from({ length: cols }, () => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraph('')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
      } else if (op.kind === 'insert_image') {
        const image = await imagePart(zip, 'word', op.data),
          rid = await addRelation(zip, path, 'image', posix.relative('word', image)),
          cx = Math.round(op.width * 9525),
          cy = Math.round(op.height * 9525),
          docId =
            1 +
            Math.max(
              0,
              ...walk(root)
                .filter((n) => n.local === 'docPr')
                .map((n) => Number(n.attributes.id) || 0),
            );
        replacement = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docId}" name="图片 ${docId}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="图片"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="${officeNs}" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
      } else fail('OFFICE_OPERATION', '此操作适用于 PowerPoint。');
      zip.file(path, replaceSpans(source, [{ start: at, end: at, text: replacement }]));
    }
  } else {
    let presentation = await xml(zip, 'ppt/presentation.xml'),
      root = xmlTree(presentation),
      list = child(root, 'sldIdLst')!,
      nodes = [...list.children];
    const relations = await xml(zip, 'ppt/_rels/presentation.xml.rels'),
      rr = xmlTree(relations),
      current = nodes[op.page];
    if (!current) fail('OFFICE_PAGE', '幻灯片不存在。');
    const relation = rr.children.find(
        (r) =>
          r.attributes.Id ===
          current.attributes[Object.keys(current.attributes).find((k) => k.endsWith(':id'))!],
      )!,
      part = partPath('ppt/presentation.xml', relation.attributes.Target);
    if (op.kind === 'slide_size') {
      const size = child(root, 'sldSz');
      if (!size) fail('OFFICE_EDIT', '演示文稿缺少页面尺寸。');
      const value = `<${size.name}${attrs(size, { cx: String(Math.round(op.width * 9525)), cy: String(Math.round(op.height * 9525)), type: 'custom' })}/>`;
      zip.file(
        'ppt/presentation.xml',
        replaceSpans(presentation, [{ start: size.start, end: size.end, text: value }]),
      );
    } else if (op.kind === 'slide_style') {
      if (!op.color) fail('OFFICE_EDIT', '请选择背景颜色。');
      const source = await xml(zip, part),
        sr = xmlTree(source),
        cs = child(sr, 'cSld')!;
      const bg = child(cs, 'bg'),
        value = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${op.color.slice(1)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
      zip.file(
        part,
        replaceSpans(source, [
          { start: bg?.start ?? cs.openEnd, end: bg?.end ?? cs.openEnd, text: value },
        ]),
      );
    } else if (op.kind === 'slide_delete') {
      if (nodes.length <= 1) fail('OFFICE_SLIDE', '至少保留一张幻灯片。');
      nodes.splice(op.page, 1);
      zip.file(
        'ppt/presentation.xml',
        replaceSpans(presentation, [
          {
            start: list.start,
            end: list.end,
            text: build(presentation, list, nodes.map((n) => raw(presentation, n)).join('')),
          },
        ]),
      );
      zip.file(
        'ppt/_rels/presentation.xml.rels',
        replaceSpans(relations, [{ start: relation.start, end: relation.end, text: '' }]),
      );
    } else if (op.kind === 'slide_move') {
      const position = Math.min(nodes.length, op.position ?? 1) - 1;
      nodes.splice(op.page, 1);
      nodes.splice(position, 0, current);
      zip.file(
        'ppt/presentation.xml',
        replaceSpans(presentation, [
          {
            start: list.start,
            end: list.end,
            text: build(presentation, list, nodes.map((n) => raw(presentation, n)).join('')),
          },
        ]),
      );
    } else if (op.kind === 'slide_add' || op.kind === 'slide_copy') {
      if (nodes.length >= 500) fail('OFFICE_LIMIT', '最多 500 张幻灯片。');
      const name = `ppt/slides/slide-${randomUUID()}.xml`;
      if (op.kind === 'slide_copy') await clonePart(zip, part, name, new Map());
      else {
        zip.file(
          name,
          '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
        );
        if (zip.file(relPath(part))) {
          const old = await xml(zip, relPath(part)),
            layout = xmlTree(old).children.find((r) => r.attributes.Type?.endsWith('/slideLayout'));
          if (layout)
            await addRelation(
              zip,
              name,
              'slideLayout',
              posix.relative(posix.dirname(name), partPath(part, layout.attributes.Target)),
            );
        }
      }
      await contentType(
        zip,
        name,
        'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
      );
      const rid = await addRelation(
          zip,
          'ppt/presentation.xml',
          'slide',
          posix.relative('ppt', name),
        ),
        sid = 1 + Math.max(255, ...nodes.map((n) => Number(n.attributes.id) || 0)),
        entry = `<p:sldId id="${sid}" r:id="${rid}"/>`,
        position = op.page + 1,
        body = nodes
          .map((n, i) => raw(presentation, n) + (i === position - 1 ? entry : ''))
          .join('');
      zip.file(
        'ppt/presentation.xml',
        replaceSpans(presentation, [
          { start: list.start, end: list.end, text: build(presentation, list, body) },
        ]),
      );
    } else {
      const source = await xml(zip, part),
        sr = xmlTree(source),
        tree = child(child(sr, 'cSld')!, 'spTree')!;
      if (op.kind === 'shape_layer') {
        const ref = op.id && parsed.refs.get(op.id);
        if (!ref || ref.path !== part || ref.blocked)
          fail('OFFICE_SHAPE', '请选择可编辑的当前页元素。');
        const shape = tree.children.find((n) => n.start <= ref.node.start && n.end >= ref.node.end),
          drawable = tree.children.filter((n) =>
            ['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].includes(n.local),
          );
        if (!shape || !drawable.includes(shape)) fail('OFFICE_SHAPE', '此元素不支持层级调整。');
        const from = drawable.indexOf(shape),
          to =
            op.layer === 'front'
              ? drawable.length - 1
              : op.layer === 'back'
                ? 0
                : op.layer === 'forward'
                  ? Math.min(drawable.length - 1, from + 1)
                  : Math.max(0, from - 1);
        drawable.splice(from, 1);
        drawable.splice(to, 0, shape);
        let i = 0;
        zip.file(
          part,
          replaceSpans(source, [
            {
              start: tree.start,
              end: tree.end,
              text: build(
                source,
                tree,
                tree.children
                  .map((n) =>
                    ['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].includes(n.local)
                      ? raw(source, drawable[i++])
                      : raw(source, n),
                  )
                  .join(''),
              ),
            },
          ]),
        );
      } else if (op.kind === 'shape_delete') {
        const ref = op.id && parsed.refs.get(op.id);
        if (!ref || ref.path !== part || ref.blocked)
          fail('OFFICE_SHAPE', '请选择可编辑的当前页元素。');
        const shape = tree.children.find((n) => n.start <= ref.node.start && n.end >= ref.node.end);
        if (!shape || !['sp', 'pic'].includes(shape.local))
          fail('OFFICE_SHAPE', '此元素不能删除。');
        zip.file(part, replaceSpans(source, [{ start: shape.start, end: shape.end, text: '' }]));
      } else if (op.kind === 'shape_add' || op.kind === 'insert_image') {
        const id =
            1 +
            Math.max(
              1,
              ...walk(sr)
                .filter((n) => n.local === 'cNvPr')
                .map((n) => Number(n.attributes.id) || 0),
            ),
          transform = `<a:xfrm><a:off x="${Math.round(op.x * 9525)}" y="${Math.round(op.y * 9525)}"/><a:ext cx="${Math.round(op.width * 9525)}" cy="${Math.round(op.height * 9525)}"/></a:xfrm>`,
          geometry = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
        let shape;
        if (op.kind === 'insert_image') {
          const image = await imagePart(zip, 'ppt', op.data),
            rid = await addRelation(zip, part, 'image', posix.relative(posix.dirname(part), image));
          shape = `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片 ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform}${geometry}</p:spPr></p:pic>`;
        } else
          shape = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="文本 ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${transform}${geometry}<a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2400"/><a:t>${escape(op.text || '新文本')}</a:t></a:r></a:p></p:txBody></p:sp>`;
        zip.file(
          part,
          replaceSpans(source, [{ start: tree.closeStart, end: tree.closeStart, text: shape }]),
        );
      } else fail('OFFICE_OPERATION', '此操作适用于 Word。');
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
async function clonePart(zip: JSZip, from: string, to: string, map: Map<string, string>) {
  if (map.size > 500) fail('OFFICE_LIMIT', '复制页的关联部件过多。');
  map.set(from, to);
  zip.file(to, await zip.file(from)!.async('nodebuffer'));
  const types = await xml(zip, '[Content_Types].xml'),
    type = xmlTree(types).children.find((n) => n.attributes.PartName === '/' + from)?.attributes
      .ContentType;
  if (type) await contentType(zip, to, type);
  const rp = relPath(from);
  if (!zip.file(rp)) return;
  const rels = await xml(zip, rp),
    root = xmlTree(rels);
  const output = [];
  for (const rel of root.children) {
    if (rel.attributes.TargetMode === 'External') {
      output.push(raw(rels, rel));
      continue;
    }
    const target = partPath(from, rel.attributes.Target);
    let dest = map.get(target);
    if (!dest) {
      if (/\/(slideLayouts|slideMasters|theme|media)\//.test(target)) dest = target;
      else {
        const extension = posix.extname(target);
        dest = posix.join(
          posix.dirname(target),
          `${posix.basename(target, extension)}-${randomUUID()}${extension}`,
        );
        if (!zip.file(target)) fail('OFFICE_PART', '关联部件缺失，未复制。');
        await clonePart(zip, target, dest, map);
      }
    }
    output.push(`<${rel.name}${attrs(rel, { Target: posix.relative(posix.dirname(to), dest) })}/>`);
  }
  zip.file(relPath(to), build(rels, root, output.join('')));
}
