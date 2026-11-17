import { createRequire } from 'node:module';
import type { CanvasPreview } from '../../contracts/canvas-preview.js';

const localRequire = createRequire(import.meta.url);
type Raster = Extract<CanvasPreview, { kind: 'image' | 'pdf' }>;
const cache = new Map<string, { value: Raster; cost: number }>(),
  pending = new Map<string, Promise<Raster>>();
let memory = 0,
  tail: Promise<unknown> = Promise.resolve();
const MEMORY_LIMIT = 16 * 1024 * 1024,
  MAX_PIXELS = 40_000_000;
// Read raster dimensions before decoding. Reject SVG/HTML disguised with an image extension.
function dimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)))
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X')
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42)
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && bytes[20] === 47) {
      const value = bytes.readUInt32LE(21);
      return { width: (value & 0x3fff) + 1, height: ((value >>> 14) & 0x3fff) + 1 };
    }
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return;
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) return;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) return;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 7
      )
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
}
function remember(key: string, value: Raster) {
  const cost = value.dataUrl.length * 2;
  while (cache.size && (memory + cost > MEMORY_LIMIT || cache.size >= 64)) {
    const oldest = cache.keys().next().value!;
    memory -= cache.get(oldest)!.cost;
    cache.delete(oldest);
  }
  if (cost <= MEMORY_LIMIT) {
    cache.set(key, { value, cost });
    memory += cost;
  }
  return value;
}
function serial(key: string, run: () => Promise<Raster>) {
  const known = cache.get(key);
  if (known) {
    cache.delete(key);
    cache.set(key, known);
    return Promise.resolve(known.value);
  }
  const existing = pending.get(key);
  if (existing) return existing;
  const job = tail
    .catch(() => {})
    .then(run)
    .then((value) => remember(key, value))
    .finally(() => pending.delete(key));
  pending.set(key, job);
  tail = job;
  return job;
}
export function imageThumbnail(bytes: Buffer, hash: string): Promise<Raster> {
  return serial(`image:${hash}`, async () => {
    const size = dimensions(bytes);
    if (!size || !size.width || !size.height) throw Error('图片格式暂不支持缩略预览，请展开文件。');
    if (size.width * size.height > MAX_PIXELS || Math.max(size.width, size.height) > 50000)
      throw Error('超大尺寸图片请展开后按需载入原图。');
    const { loadImage, createCanvas } = localRequire(
      '@napi-rs/canvas',
    ) as typeof import('@napi-rs/canvas');
    const image = await loadImage(bytes),
      scale = Math.min(1, 1440 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale)),
      height = Math.max(1, Math.round(image.height * scale));
    const surface = createCanvas(width, height),
      ctx = surface.getContext('2d');
    ctx.drawImage(image, 0, 0, width, height);
    const encoded = await surface.encode('webp', 78);
    if (encoded.length > 2 * 1024 * 1024) throw Error('缩略图过大，请展开文件。');
    return {
      kind: 'image',
      dataUrl: `data:image/webp;base64,${encoded.toString('base64')}`,
      width,
      height,
      sourceWidth: image.width,
      sourceHeight: image.height,
      quality: 'thumbnail',
    };
  });
}
export function pdfThumbnail(bytes: Buffer, hash: string): Promise<Raster> {
  return serial(`pdf:${hash}`, async () => {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw Error('PDF 文件头无效，请展开文件查看。');
    const { createCanvas } = localRequire('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
    (globalThis as any).pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      enableXfa: false,
      maxImageSize: MAX_PIXELS,
    });
    let document: any, render: any, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        document = await loading.promise;
        if (!document.numPages) throw Error('PDF 没有可预览页面。');
        const page = await document.getPage(1),
          base = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(base.width) ||
          !Number.isFinite(base.height) ||
          Math.min(base.width, base.height) <= 0
        )
          throw Error('PDF 页面尺寸无效。');
        const viewport = page.getViewport({
          scale: Math.min(1.5, 900 / Math.max(base.width, base.height)),
        });
        const width = Math.max(1, Math.ceil(viewport.width)),
          height = Math.max(1, Math.ceil(viewport.height)),
          surface = createCanvas(width, height);
        render = page.render({
          canvas: surface as any,
          canvasContext: surface.getContext('2d') as any,
          viewport,
          background: 'rgb(255,255,255)',
        });
        await render.promise;
        const encoded = await surface.encode('webp', 80);
        page.cleanup();
        return {
          kind: 'pdf' as const,
          dataUrl: `data:image/webp;base64,${encoded.toString('base64')}`,
          page: 1,
          pages: document.numPages,
          width,
          height,
        };
      })();
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            render?.cancel();
            reject(Error('PDF 首页较复杂，请展开后按页阅读。'));
          }, 12000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await loading.destroy();
    }
  });
}
