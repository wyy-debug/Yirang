import { t as uiText } from '../../../../packages/components/ui-language.js';
import { PDFDataRangeTransport } from 'pdfjs-dist/build/pdf.mjs';
import type { DesktopObject } from '../../../../packages/contracts/index.js';
import { NATIVE_FILE_LIMIT } from '../../../../packages/components/native-files.js';

type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export async function nativeByteChunk(
  object: DesktopObject,
  action: Action,
  offset: number,
  length = 1024 * 1024,
) {
  const result = await action('native_workbench', {
    operation: 'bytes',
    objectId: object.id,
    expectedRevision: object.revision,
    offset,
    length,
  });
  if (
    !Number.isSafeInteger(result.size) ||
    result.size < 0 ||
    result.size > NATIVE_FILE_LIMIT ||
    result.revision !== object.revision ||
    typeof result.sha256 !== 'string' ||
    typeof result.data !== 'string'
  )
    throw Error(uiText('文件分块信息无效。'));
  const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
  if (
    bytes.length > length ||
    offset + bytes.length > result.size ||
    bytes.length !== Math.min(length, Math.max(0, result.size - offset))
  )
    throw Error(uiText('文件分块读取不完整。'));
  return { bytes, size: result.size, sha256: result.sha256 as string };
}
/** PDF.js requests only the chunks needed for the current page; transport never fetches remote URLs. */
export class NativePdfSource extends PDFDataRangeTransport {
  private stopped = false;
  private failed = false;
  private queue: Promise<void> = Promise.resolve();
  private intervals: [number, number][];
  constructor(
    private object: DesktopObject,
    private action: Action,
    initial: Awaited<ReturnType<typeof nativeByteChunk>>,
    private alive: () => boolean,
    private onError: (error: unknown) => void,
    private progress: (loaded: number, size: number) => void,
  ) {
    super(initial.size, initial.bytes, false);
    this.hash = initial.sha256;
    this.intervals = [[0, initial.bytes.length]];
  }
  private hash: string;
  requestDataRange(begin: number, end: number) {
    this.queue = this.queue
      .then(async () => {
        if (this.stopped || !this.alive() || this.failed) return;
        if (
          !Number.isSafeInteger(begin) ||
          !Number.isSafeInteger(end) ||
          begin < 0 ||
          end <= begin ||
          end > this.length
        )
          throw Error(uiText('PDF 请求了无效的文件范围。'));
        // PDF.js expects one contiguous response for each requested interval.
        const result = new Uint8Array(end - begin);
        for (let offset = begin; offset < end; ) {
          if (this.stopped || !this.alive()) return;
          const part = await nativeByteChunk(
            this.object,
            this.action,
            offset,
            Math.min(1024 * 1024, end - offset),
          );
          if (part.size !== this.length || part.sha256 !== this.hash)
            throw Error(uiText('PDF 内容在读取过程中发生变化，请重新打开当前版本。'));
          if (this.stopped || !this.alive()) return;
          result.set(part.bytes, offset - begin);
          this.intervals.push([offset, offset + part.bytes.length]);
          offset += part.bytes.length;
          const merged: [number, number][] = [];
          for (const interval of this.intervals.sort((a, b) => a[0] - b[0])) {
            const previous = merged.at(-1);
            if (previous && interval[0] <= previous[1])
              previous[1] = Math.max(previous[1], interval[1]);
            else merged.push([...interval]);
          }
          this.intervals = merged;
          this.progress(
            merged.reduce((sum, [start, end]) => sum + end - start, 0),
            this.length,
          );
        }
        this.onDataRange(begin, result);
      })
      .catch((error) => {
        if (!this.stopped && !this.failed && this.alive()) {
          this.failed = true;
          this.onError(error);
        }
      });
  }
  abort() {
    this.stopped = true;
  }
}
