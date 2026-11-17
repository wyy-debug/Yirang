import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOutputImage, captureCanvas } from '../apps/electron/platform/desktop-media.mjs';

test('image preview accepts output files but rejects a sibling directory with the same prefix', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'yirang-media-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const allowed = join(home, 'output');
  const sibling = join(home, 'output-private');
  await mkdir(allowed);
  await mkdir(sibling);
  const bytes = Buffer.from('image fixture');
  const image = join(allowed, 'preview.png');
  const outside = join(sibling, 'private.png');
  await writeFile(image, bytes);
  await writeFile(outside, bytes);
  const roots = async () => [allowed];
  assert.equal(
    await readOutputImage(pathToFileURL(image).href, roots),
    `data:image/png;base64,${bytes.toString('base64')}`,
  );
  await assert.rejects(readOutputImage(outside, roots));
  let consulted = false;
  await assert.rejects(
    readOutputImage(null, async () => {
      consulted = true;
      return [];
    }),
  );
  assert.equal(consulted, false);
});

test('canvas capture clamps to visible content and downsizes the image before returning it', async () => {
  let rectangle, resize;
  const bytes = Buffer.from('png');
  const window = {
    isVisible: () => true,
    isMinimized: () => false,
    getContentSize: () => [1200, 800],
    webContents: {
      capturePage: async (rect) => {
        rectangle = rect;
        return {
          getSize: () => ({ width: 2400, height: 1600 }),
          isEmpty: () => false,
          resize: (options) => {
            resize = options;
            return { toPNG: () => bytes };
          },
        };
      },
    },
  };
  assert.deepEqual(await captureCanvas(window, { x: 100.9, y: 50.8, width: 1300, height: 1000 }), {
    mimeType: 'image/png',
    data: bytes.toString('base64'),
  });
  assert.deepEqual(rectangle, { x: 100, y: 50, width: 1100, height: 750 });
  assert.deepEqual(resize, { width: 1920 });
  await assert.rejects(captureCanvas(window, { x: 1201, y: 0, width: 100, height: 100 }));
  await assert.rejects(
    captureCanvas({ ...window, isVisible: () => false }, { x: 0, y: 0, width: 100, height: 100 }),
  );
});
