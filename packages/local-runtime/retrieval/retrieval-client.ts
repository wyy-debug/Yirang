import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Only the desktop's host MCP process owns this worker; CLI MCPs route to it. */
export class RetrievalClient {
  private worker?: Worker;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private seq = 0;
  private stopped = false;
  private startup?: ReturnType<typeof setTimeout>;
  private configuration: any;
  constructor(private directory: string) {
    this.startup = setTimeout(() => {
      try {
        this.start();
      } catch {}
    }, 8000);
    this.startup.unref();
  }
  private start(replayConfiguration = true) {
    if (this.stopped) throw Error('桌面索引已关闭');
    if (this.worker) return this.worker;
    const bundled = new URL('./retrieval-worker.mjs', import.meta.url),
      source = new URL('./retrieval-worker.ts', import.meta.url);
    const worker = new Worker(existsSync(fileURLToPath(bundled)) ? bundled : source, {
      workerData: { directory: this.directory },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker = worker;
    worker.unref();
    worker.on('message', ({ id, result, error }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      error ? p.reject(Error(error)) : p.resolve(result);
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error('索引后台已退出，请重试；原文件不受影响'));
      }
      this.pending.clear();
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    if (replayConfiguration && this.configuration)
      worker.postMessage({ id: 0, operation: 'configure', payload: this.configuration });
    return worker;
  }
  request(operation: string, payload: any = {}) {
    if (operation === 'configure') this.configuration = payload;
    return new Promise<any>((resolve, reject) => {
      try {
        const worker = this.start(operation !== 'configure'),
          id = ++this.seq;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Error('检索后台繁忙，请稍后重试'));
        }, 20000);
        timer.unref();
        this.pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, operation, payload });
      } catch (e) {
        reject(e);
      }
    });
  }
  close() {
    this.stopped = true;
    clearTimeout(this.startup);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error('桌面正在关闭'));
    }
    this.pending.clear();
    void this.worker?.terminate();
    this.worker = undefined;
  }
}
