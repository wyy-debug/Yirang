import { parentPort, workerData } from 'node:worker_threads';
import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import JSZip from 'jszip';

// This worker has no execution or write capability. Asset hashes are validated by the host.
async function inspect(file: any) {
  const base = { objectId: file.objectId, revision: file.revision, hash: file.hash };
  try {
    if (!/^[a-f0-9]{64}$/.test(file.hash)) throw Error('asset hash');
    const path = join(workerData.directory, 'assets', file.hash);
    if ((await stat(path)).size > 32 * 1024 * 1024) return { ...base, status: 'unknown', code: 'size_limit', detail: '文件超过结构检查大小限制' };
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== file.hash) throw Error('asset mismatch');
    if (!bytes.length) return { ...base, status: 'failed', code: 'empty', detail: '文件为空' };
    const ext = file.name.split('.').at(-1)?.toLowerCase();
    let content = '';
    const facts: Record<string, unknown> = {};
    if (ext === 'svg') {
      let root = '', error = '';
      const parser = new SaxesParser({ xmlns: true });
      parser.on('opentag', tag => { if (!root) root = tag.local; });
      parser.on('error', e => { error = e.message; });
      content = bytes.toString('utf8');
      parser.write(bytes.toString('utf8')).close();
      if (error || root !== 'svg') return { ...base, status: 'failed', code: 'svg_invalid', detail: 'SVG XML 格式无效', text: content.slice(0, 12000), truncated: content.length > 12000 };
    } else if (ext === 'pptx') {
      const zip = await JSZip.loadAsync(bytes);
      const entries = Object.values(zip.files);
      if (entries.length > 3000 || entries.some((f: any) => f._data?.uncompressedSize > 8 * 1024 * 1024) ||
          entries.reduce((sum, f: any) => sum + (f._data?.uncompressedSize || 0), 0) > 64 * 1024 * 1024)
        return { ...base, status: 'unknown', code: 'zip_limit', detail: 'PPT 超过结构检查限制' };
      const slides = entries.filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f.name));
      if (!zip.file('[Content_Types].xml') || !zip.file('ppt/presentation.xml') ||
          !zip.file('ppt/_rels/presentation.xml.rels') || !slides.length) throw Error('invalid presentation');
      const roots = [
        ['[Content_Types].xml', 'Types', 'http://schemas.openxmlformats.org/package/2006/content-types'],
        ['ppt/presentation.xml', 'presentation', 'http://schemas.openxmlformats.org/presentationml/2006/main'],
        ['ppt/_rels/presentation.xml.rels', 'Relationships', 'http://schemas.openxmlformats.org/package/2006/relationships'],
      ];
      const slideIds: string[] = [], linked = new Map<string, string>();
      for (const [name, local, uri] of roots) {
        let root = false;
        const parser = new SaxesParser({ xmlns: true });
        parser.on('opentag', tag => {
          if (!root) { if (tag.local !== local || tag.uri !== uri) throw Error('invalid package root'); root = true; }
          if (tag.local === 'sldId') for (const attr of Object.values(tag.attributes))
            if (typeof attr !== 'string' && attr.local === 'id' && attr.uri.endsWith('/relationships')) slideIds.push(attr.value);
          if (tag.local === 'Relationship') {
            const attr = (key: string) => { const value = tag.attributes[key]; return typeof value === 'string' ? value : value?.value; };
            if (attr('Type')?.endsWith('/slide')) {
              const target = attr('Target') || '';
              const normalized = posix.normalize(target.startsWith('/') ? target.slice(1) : 'ppt/' + target);
              if (attr('TargetMode') === 'External' || !/^ppt\/slides\/slide\d+\.xml$/.test(normalized) || !zip.file(normalized))
                throw Error('missing slide target');
              linked.set(attr('Id') || '', normalized);
            }
          }
        });
        parser.write(await zip.file(name!)!.async('string')).close();
      }
      if (!slideIds.length || slideIds.some(id => !linked.has(id))) throw Error('missing slide relationship');
      content = `Slides: ${slideIds.length}\n`;
      let editable = false;
      const pageFacts: { name: string; textRuns: number; images: number; editableShapes: number; otherGraphics: number }[] = [];
      for (const slide of slides) {
        if (![...linked.values()].includes(slide.name)) continue;
        const xml = await slide.async('string');
        const parser = new SaxesParser({ xmlns: true });
        const page = { name: slide.name, textRuns: 0, images: 0, editableShapes: 0, otherGraphics: 0 };
        pageFacts.push(page);
        parser.on('opentag', tag => {
          if (tag.local === 't' && tag.uri === 'http://schemas.openxmlformats.org/drawingml/2006/main') page.textRuns++;
          if (tag.uri === 'http://schemas.openxmlformats.org/presentationml/2006/main') {
            if (tag.local === 'pic') page.images++;
            if (tag.local === 'sp') page.editableShapes++;
            if (tag.local === 'graphicFrame') page.otherGraphics++;
          }
          if (['prstGeom', 'custGeom', 't', 'tbl'].includes(tag.local) &&
            tag.uri === 'http://schemas.openxmlformats.org/drawingml/2006/main') editable = true;
        });
        parser.on('text', text => { content += text + '\n'; });
        parser.write(xml).close();
      }
      facts.slideCount = slideIds.length;
      facts.pages = pageFacts;
      facts.nativeEditableContent = editable;
      if (file.editable && !editable) return { ...base, status: 'failed', code: 'ppt_not_editable', detail: 'PPT 中未找到原生可编辑对象' };
    } else if (!['md', 'txt'].includes(ext)) {
      return { ...base, status: 'unknown', code: 'unsupported_format', detail: '此格式尚无结构检查器' };
    } else content = bytes.toString('utf8');
    return { ...base, status: 'passed', code: 'structure_valid', detail: '文件存在且通过结构检查；不代表语义或视觉检查通过', text: content.slice(0, 12000), truncated: content.length > 12000, facts };
  } catch (error: any) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EIO'].includes(error?.code))
      return { ...base, status: 'unknown', code: 'asset_unavailable', detail: '无法读取文件，尚未完成检查' };
    return { ...base, status: 'failed', code: 'invalid_file', detail: '文件无法读取或解析' };
  }
}
// Bound peak decompression memory even when a turn produces many presentations.
const results = [];
for (const file of workerData.files) results.push(await inspect(file));
parentPort!.postMessage(results);
