import { t as uiText } from '../../../packages/components/ui-language.js';
import { useEffect, useRef, useState } from 'react';

export type DropPoint = { x: number; y: number };
const relativePaths = new WeakMap<File, string>();
const INTERNAL_DRAG = 'application/x-yirang-internal-drag';
export const fileRelativePath = (file: File) =>
  relativePaths.get(file) || file.webkitRelativePath || file.name;
export function fileOriginalPath(file: File): string {
  try {
    const path = (window.parent as any).desktop?.filePath(file);
    if (path) return path;
  } catch {
    /* Electron 30 also exposes the native File.path property. */
  }
  return (file as File & { path?: string }).path || '';
}
type Options = {
  scopeKey: string;
  blocked: (source: 'drop' | 'paste') => string | null;
  accept: (files: File[], point: DropPoint, warning: string, directories: string[]) => void;
  pasteTarget: (target: EventTarget | null) => DropPoint | null;
  acceptText: (text: string, point: DropPoint) => void;
  rejected: (reason: string) => void;
};
function carriesFiles(transfer: DataTransfer | null) {
  if (
    transfer &&
    Array.from(transfer.types).some(
      (type) =>
        type === INTERNAL_DRAG ||
        type.startsWith('application/x-ai-desktop-') ||
        type.startsWith('application/x-ai-workflow-'),
    )
  )
    return false;
  return (
    !!transfer &&
    (Array.from(transfer.types).includes('Files') ||
      Array.from(transfer.items).some((item) => item.kind === 'file') ||
      transfer.files.length > 0)
  );
}

/** Only OS/browser file payloads are intercepted; text and canvas drags retain their behavior. */
export function useFileDrop(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [overlay, setOverlay] = useState<{ blocked: string | null } | null>(null);
  useEffect(() => {
    let depth = 0,
      reading = false,
      disposed = false,
      internalDrag = false;
    const reset = () => {
      depth = 0;
      setOverlay(null);
    };
    const end = () => {
      internalDrag = false;
      reset();
    };
    const start = (event: DragEvent) => {
      reset();
      // Browser-native dragging of an existing preview must not compete with
      // React Flow's pointer-driven move or turn its data URL into a new file.
      if (
        event.target instanceof Element &&
        event.target.closest('.object-card') &&
        event.target.closest('img')
      ) {
        event.preventDefault();
        internalDrag = false;
        return;
      }
      internalDrag = true;
      try {
        event.dataTransfer?.setData(INTERNAL_DRAG, '1');
      } catch {}
      queueMicrotask(() => {
        if (event.defaultPrevented) internalDrag = false;
      });
    };
    const externalFiles = (event: DragEvent) => !internalDrag && carriesFiles(event.dataTransfer);
    const componentTarget = (event: DragEvent) =>
      event.target instanceof Element && !!event.target.closest('.widget-file-field');
    const show = () => setOverlay({ blocked: latest.current.blocked('drop') });
    function enter(event: DragEvent) {
      if (!externalFiles(event)) {
        reset();
        return;
      }
      if (componentTarget(event)) {
        event.preventDefault();
        reset();
        return;
      }
      event.preventDefault();
      depth++;
      show();
    }
    function over(event: DragEvent) {
      if (!externalFiles(event)) {
        reset();
        return;
      }
      if (componentTarget(event)) {
        event.preventDefault();
        reset();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = reading || latest.current.blocked('drop') ? 'none' : 'copy';
      show();
    }
    function leave() {
      depth = Math.max(0, depth - 1);
      if (!depth) setOverlay(null);
    }
    function drop(event: DragEvent) {
      if (!externalFiles(event)) {
        if (internalDrag || event.dataTransfer?.types.includes(INTERNAL_DRAG))
          event.preventDefault();
        end();
        return;
      }
      if (componentTarget(event)) {
        event.preventDefault();
        reset();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      reset();
      receiveFiles(event.dataTransfer!, { x: event.clientX, y: event.clientY }, 'drop');
    }
    function paste(event: ClipboardEvent) {
      if (event.defaultPrevented || !event.clipboardData) return;
      const point = latest.current.pasteTarget(event.target);
      if (!point) return;
      if (carriesFiles(event.clipboardData)) {
        event.preventDefault();
        receiveFiles(event.clipboardData, point, 'paste');
        return;
      }
      const text = event.clipboardData.getData('text/plain');
      if (!text.trim()) return;
      event.preventDefault();
      const blocked = latest.current.blocked('paste');
      if (blocked) latest.current.rejected(blocked);
      else latest.current.acceptText(text, point);
    }
    function receiveFiles(transfer: DataTransfer, point: DropPoint, source: 'drop' | 'paste') {
      const blocked = reading
        ? uiText('正在读取文件夹，请稍后再试。')
        : latest.current.blocked(source);
      if (blocked) {
        latest.current.rejected(blocked);
        return;
      }
      // Capture file handles before the event's data store is protected.
      const items = Array.from(transfer.items).filter((item) => item.kind === 'file');
      const captured = items.map((item) => {
        let entry: FileSystemEntry | null = null;
        try {
          entry = item.webkitGetAsEntry?.() ?? null;
        } catch {
          /* Use the captured File. */
        }
        return { entry, file: item.getAsFile() };
      });
      const fallback = items.length ? [] : Array.from(transfer.files);
      reading = true;
      latest.current.rejected(uiText('正在读取文件与文件夹…'));
      const scopeKey = latest.current.scopeKey;
      void (async () => {
        const files: File[] = [],
          directories: string[] = [];
        let unreadable = 0,
          limited = false,
          visited = 0;
        const add = (file: File, path: string) => {
          if (files.length >= 500) {
            limited = true;
            return;
          }
          relativePaths.set(file, path);
          files.push(file);
        };
        async function walk(entry: FileSystemEntry, path: string, level = 0): Promise<void> {
          if (disposed) return;
          if (
            ++visited > 6000 ||
            level >= 32 ||
            files.length >= 500 ||
            directories.length >= 1000
          ) {
            limited = true;
            return;
          }
          try {
            if (entry.isFile) {
              const file = await new Promise<File>((resolve, reject) =>
                (entry as FileSystemFileEntry).file(resolve, reject),
              );
              add(file, path);
            } else if (entry.isDirectory) {
              directories.push(path);
              const reader = (entry as FileSystemDirectoryEntry).createReader();
              // Chromium returns directory entries in batches; drain every batch.
              while (!disposed) {
                const children = await new Promise<FileSystemEntry[]>((resolve, reject) =>
                  reader.readEntries(resolve, reject),
                );
                if (!children.length) break;
                for (const child of children) {
                  await walk(child, `${path}/${child.name}`, level + 1);
                  if (visited > 6000 || files.length >= 500 || directories.length >= 1000) break;
                }
                if (visited > 6000 || files.length >= 500 || directories.length >= 1000) {
                  limited = true;
                  break;
                }
              }
            }
          } catch {
            unreadable++;
          }
        }
        for (const item of captured) {
          if (item.file && (!item.entry || item.entry.isFile)) add(item.file, item.file.name);
          else if (item.entry) await walk(item.entry, item.entry.name);
          else unreadable++;
        }
        for (const file of fallback) add(file, fileRelativePath(file));
        if (disposed) return;
        if (latest.current.scopeKey !== scopeKey) {
          latest.current.rejected(uiText('读取期间切换了工作区，请重新导入文件。'));
          return;
        }
        const warning = [
          unreadable ? uiText('{0} 项无法读取，请重新选择。', { '0': unreadable }) : '',
          limited
            ? uiText('单次最多读取 500 个文件、1000 个文件夹和 32 层路径；其余内容请分批导入。')
            : '',
        ]
          .filter(Boolean)
          .join(' ');
        const changed = latest.current.blocked(source);
        if (changed) {
          latest.current.rejected(changed);
          return;
        }
        if (!files.length && !directories.length) {
          latest.current.rejected(warning || uiText('未收到可读取的文件，请使用文件选择器重试。'));
          return;
        }
        latest.current.accept(files, point, warning, directories);
      })()
        .catch(() => {
          if (!disposed)
            latest.current.rejected(uiText('读取文件夹失败，请通过导入材料重新选择。'));
        })
        .finally(() => {
          reading = false;
        });
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') end();
    };
    const hidden = () => {
      if (document.hidden) reset();
    };
    window.addEventListener('dragstart', start, true);
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('paste', paste);
    window.addEventListener('dragend', end, true);
    window.addEventListener('blur', reset);
    window.addEventListener('keydown', key, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disposed = true;
      window.removeEventListener('dragstart', start, true);
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('paste', paste);
      window.removeEventListener('dragend', end, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  return overlay;
}
