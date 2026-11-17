import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { fail } from '../../../contracts/index.js';
export type XmlNode = {
  name: string;
  local: string;
  attributes: Record<string, string>;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  children: XmlNode[];
};
export function xmlTree(source: string) {
  const parser = new SaxesParser({ xmlns: false }),
    stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    count = 0;
  parser.on('doctype', () => fail('XLSX_XML', '工作簿 XML 不支持 DTD。'));
  parser.on('opentag', (tag) => {
    if (++count > 400000) fail('XLSX_LIMIT', '工作表过于复杂，请拆分后编辑。');
    const end = parser.position,
      node: XmlNode = {
        name: tag.name,
        local: tag.name.split(':').pop()!,
        attributes: tag.attributes as Record<string, string>,
        start: source.lastIndexOf('<', end - 1),
        openEnd: end,
        closeStart: end,
        end,
        children: [],
      };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on('closetag', (tag) => {
    const node = stack.pop()!;
    node.end = parser.position;
    node.closeStart = tag.isSelfClosing ? node.openEnd : source.lastIndexOf('</', node.end - 1);
  });
  parser.write(source).close();
  if (!root) fail('XLSX_XML', '工作簿 XML 不完整。');
  return root;
}
export const children = (node: XmlNode, name: string) =>
  node.children.filter((n) => n.local === name);
export const child = (node: XmlNode, name: string) => node.children.find((n) => n.local === name);
export const prefix = (name: string) =>
  name.includes(':') ? name.slice(0, name.indexOf(':') + 1) : '';
export const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const textXml = (value: string) =>
  escape(value.replace(/_x[0-9a-f]{4}_/gi, (value) => '_x005F_' + value.slice(1)));
export function xmlText(source: string, node: XmlNode) {
  let text = '';
  const parser = new SaxesParser({ xmlns: false });
  parser.on('text', (value) => (text += value));
  parser.on('cdata', (value) => (text += value));
  parser.write(source.slice(node.start, node.end)).close();
  return text.replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
export function attrs(node: XmlNode, changes: Record<string, string | undefined> = {}) {
  return Object.entries({ ...node.attributes, ...changes })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escape(value!)}"`)
    .join('');
}
export function replaceSpans(
  source: string,
  replacements: { start: number; end: number; text: string }[],
) {
  let result = source;
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
export async function xml(zip: JSZip, path: string) {
  const entry = zip.file(path);
  if (!entry) fail('XLSX_PART', `工作簿缺少 ${path}。`);
  const value = await entry.async('string');
  if (Buffer.byteLength(value) > 16 * 1024 * 1024)
    fail('XLSX_LIMIT', '工作簿 XML 超过 16 MiB 编辑限制。');
  return value;
}
