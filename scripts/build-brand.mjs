import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { PNG } from 'pngjs';

// Resize the approved master without altering its artwork. ICO entries contain PNGs.
const source = PNG.sync.read(await readFile('assets/brand/yirang-master.png'));
function resize(size) {
  const result = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const x0 = (x * source.width) / size,
        x1 = ((x + 1) * source.width) / size,
        y0 = (y * source.height) / size,
        y1 = ((y + 1) * source.height) / size;
      const sums = [0, 0, 0, 0];
      let total = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const weight =
            (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy));
          const i = (sy * source.width + sx) * 4;
          total += weight;
          for (let c = 0; c < 4; c++) sums[c] += source.data[i + c] * weight;
        }
      for (let c = 0; c < 4; c++) result.data[(y * size + x) * 4 + c] = Math.round(sums[c] / total);
    }
  return PNG.sync.write(result);
}
const sizes = [16, 24, 32, 48, 64, 128, 256],
  images = sizes.map(resize);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const at = 6 + i * 16;
  header[at] = header[at + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(images[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
await mkdir('apps/panel/assets', { recursive: true });
await writeFile('apps/panel/assets/yirang.png', images.at(-1));
await writeFile('assets/brand/yirang.ico', Buffer.concat([header, ...images]));
await writeFile('plugin/ai-desktop/assets/yirang.png', images.at(-1));
console.log('Created Yirang PNG and multi-resolution Windows icon.');
