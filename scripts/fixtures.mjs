import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('test-results/fixtures', { recursive: true });
for (let variant = 0; variant < 2; variant++) {
  const png = new PNG({ width: 560, height: 360 });
  for (let y = 0; y < 360; y++)
    for (let x = 0; x < 560; x++) {
      let c = [240, 243, 232, 255];
      if ((x - (variant ? 410 : 150)) ** 2 + (y - 135) ** 2 < 64 ** 2)
        c = variant ? [57, 109, 170, 255] : [205, 103, 72, 255];
      if (x > 300 && x < 450 && y > 210 && y < 290)
        c = variant ? [205, 103, 72, 255] : [57, 109, 170, 255];
      png.data.set(c, (y * 560 + x) * 4);
    }
  await writeFile(`test-results/fixtures/reference-${variant + 1}.png`, PNG.sync.write(png));
}
