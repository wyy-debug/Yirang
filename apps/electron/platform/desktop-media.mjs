import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainText } from '../main-text.mjs';
import { t as uiText } from './native-ui-language.mjs';

// Resolve real paths before checking roots so aliases cannot bypass the output boundary.
export async function readOutputImage(value, listAllowedRoots) {
  if (typeof value !== 'string' || value.length > 4096) throw Error(uiText(mainText('host.152')));
  const path = await realpath(
    value.startsWith('file:') ? fileURLToPath(value) : value.replace(/^\/([a-z]:\/)/i, '$1'),
  );
  const extension = extname(path).toLowerCase(),
    mime = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    }[extension];
  if (!mime) throw Error(uiText(mainText('host.153')));
  const roots = await listAllowedRoots();
  let allowed = false;
  for (const root of roots) {
    try {
      const base = await realpath(root),
        part = relative(base, path);
      if (
        part !== '..' &&
        !part.startsWith('..\\') &&
        !part.startsWith('../') &&
        !isAbsolute(part)
      ) {
        allowed = true;
        break;
      }
    } catch {}
  }
  if (!allowed) throw Error(uiText(mainText('host.154')));
  const info = await stat(path);
  if (!info.isFile() || info.size > 10 * 1024 * 1024) throw Error(uiText(mainText('host.155')));
  return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
}

// Bounds are in the window content coordinate system, not the infinite canvas.
export async function captureCanvas(window, bounds) {
  if (!window?.isVisible() || window.isMinimized()) throw Error(uiText(mainText('host.157')));
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite))
    throw Error(uiText(mainText('host.158')));
  const [width, height] = window.getContentSize(),
    x = Math.max(0, Math.floor(bounds.x)),
    y = Math.max(0, Math.floor(bounds.y));
  const rect = {
    x,
    y,
    width: Math.min(width - x, Math.floor(bounds.width)),
    height: Math.min(height - y, Math.floor(bounds.height)),
  };
  if (rect.width < 20 || rect.height < 20) throw Error(uiText(mainText('host.159')));
  const captured = await window.webContents.capturePage(rect),
    size = captured.getSize();
  if (captured.isEmpty()) throw Error(uiText(mainText('host.160')));
  const image =
      Math.max(size.width, size.height) > 1920
        ? captured.resize(size.width >= size.height ? { width: 1920 } : { height: 1920 })
        : captured,
    bytes = image.toPNG();
  if (bytes.length > 10 * 1024 * 1024) throw Error(uiText(mainText('host.161')));
  return { mimeType: 'image/png', data: bytes.toString('base64') };
}
