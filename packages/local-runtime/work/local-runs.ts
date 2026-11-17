import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  realpathSync,
  lstatSync,
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Id, SelectionRange, fail } from '../../contracts/index.js';

export const RunPermission = z.object({ codeObjectId: Id }).strict();
export const LocalRunInput = z
  .object({
    codeObjectId: Id,
    objectIds: z.array(Id).min(1).max(10),
    expectedRevisions: z.record(Id, z.number().int().positive()),
    ranges: z.record(Id, SelectionRange).default({}),
  })
  .strict();
export type LocalRunInputValue = z.infer<typeof LocalRunInput>;
export const ExecutionProgress = z
  .object({
    sequence: z.number().int().positive(),
    phase: z.enum(['running', 'waiting', 'unavailable']),
    executionRef: z.string().trim().min(1).max(200).optional(),
    summary: z.string().max(2000).default(''),
    stdout: z.string().max(24000).default(''),
    stderr: z.string().max(24000).default(''),
    logsTruncated: z.boolean().default(false),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.phase !== 'unavailable' && !p.executionRef)
      ctx.addIssue({ code: 'custom', message: '运行与等待回报需要真实执行会话引用。' });
  });
export const ExecutionReport = z
  .object({
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    exitCode: z.number().int().nullable(),
    stdout: z.string().max(70000).default(''),
    stderr: z.string().max(70000).default(''),
    logsTruncated: z.boolean().default(false),
    summary: z.string().max(3000).default(''),
    executionRef: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.status === 'succeeded' && p.exitCode !== 0)
      ctx.addIssue({ code: 'custom', message: '成功回报需要实际退出码 0。' });
    if (p.status === 'failed' && p.exitCode === 0)
      ctx.addIssue({ code: 'custom', message: '退出码 0 不能回报执行失败。' });
  });
export const LocalResultAction = z
  .object({
    operation: z.enum(['status', 'progress', 'complete', 'collect']),
    report: ExecutionReport.optional(),
    progress: ExecutionProgress.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if ((p.operation === 'complete') !== !!p.report)
      ctx.addIssue({ code: 'custom', message: 'complete 需要实际执行回报，其他操作不接受回报。' });
    if ((p.operation === 'progress') !== !!p.progress)
      ctx.addIssue({ code: 'custom', message: 'progress 需要进度回报，其他操作不接受进度。' });
  });
export type CreationAuthority = { authorize: () => void; actor: string; summary: string };
export type LocalInputs = {
  runtime: 'python' | 'javascript';
  entrypoint: string;
  inputs: { objectId: string; title: string; revision: number; name: string }[];
  files: { name: string; data: Buffer }[];
  origin: { x: number; y: number };
};
export type CollectionIssue = {
  fileName?: string;
  stage: 'scan' | 'read' | 'import' | 'report';
  code: string;
  message: string;
};
export type LocalRunRecord = {
  id: string;
  grantId: string;
  codeObjectId: string;
  createdAt: string;
  runtime: 'python' | 'javascript';
  reportCardVersion?: 2;
  inputs: LocalInputs['inputs'];
  inputDigest: string;
  inputFiles: { name: string; bytes: number; sha256: string }[];
  entrypoint: string;
  origin: { x: number; y: number };
  progress?: z.infer<typeof ExecutionProgress>;
  progressAt?: string;
  report?: z.infer<typeof ExecutionReport>;
  reportedAt?: string;
  reportObjectId?: string;
  outputs?: {
    name: string;
    bytes: number;
    sha256: string;
    assetHash: string;
    importedObjectId?: string;
  }[];
  collectedAt?: string;
  returnedAt?: string;
  warnings?: string[];
  collectionIssues?: CollectionIssue[];
  collectionAttemptAt?: string;
};
export type RunAccess = {
  grantId: string;
  recoveryOnly?: boolean;
  authorize: (record?: LocalRunRecord) => void;
};
type Api = {
  auth: (w: string, c: string, s: string | null, kind: 'panel') => unknown;
  tx: <T>(fn: () => T) => T;
  storeAsset: (data: Buffer) => string;
  loadAsset: (hash: string) => Buffer;
  importOutput: (
    w: string,
    c: string,
    s: string | null,
    input: unknown,
    authority: CreationAuthority,
  ) => { id: string };
  event: (
    w: string,
    type: string,
    objectId: string | null,
    revision: number | null,
    actor: string,
  ) => void;
};
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const maxFile = 50 * 1024 * 1024,
  maxTotal = 256 * 1024 * 1024;
const safeName = (name: string) =>
  name.length > 0 &&
  name.length <= 120 &&
  !/[<>:"/\\|?*\u0000-\u001f]/.test(name) &&
  !/[. ]$/.test(name) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) &&
  name !== '.' &&
  name !== '..';

/** Material exchange only. No process launch, shell, VM, execution monitor or background runner. */
export class LocalRuns {
  constructor(
    private db: DatabaseSync,
    private directory: string,
    private api: Api,
  ) {}
  private auth(
    w: string,
    c: string,
    s: string | null,
    record?: LocalRunRecord,
    access?: RunAccess,
  ) {
    if (access) access.authorize(record);
    else this.api.auth(w, c, s, 'panel');
  }
  private read(w: string, id: string): LocalRunRecord {
    z.string().uuid().parse(id);
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(w, `local-run:record:${id}`) as { value: string } | undefined;
    if (!row) fail('NOT_FOUND', '本地运行记录不存在。');
    return JSON.parse(row.value);
  }
  private write(w: string, record: LocalRunRecord) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES(?,?,?)')
      .run(w, `local-run:record:${record.id}`, JSON.stringify(record));
  }
  private folder(w: string, id: string) {
    z.string().uuid().parse(id);
    const root = realpathSync(this.directory),
      path = join(root, 'local-runs', sha(w), id);
    let cursor = root;
    for (const part of relative(root, path).split(sep)) {
      cursor = join(cursor, part);
      if (
        existsSync(cursor) &&
        (!lstatSync(cursor).isDirectory() || lstatSync(cursor).isSymbolicLink())
      )
        fail('RUN_PATH', '运行目录不能经过链接或普通文件。');
    }
    return path;
  }
  private child(folder: string, name: string) {
    if (!safeName(name)) fail('OUTPUT_NAME', '产物需要无路径的普通文件名，最多 120 字符。');
    const path = resolve(folder, name),
      rel = relative(folder, path);
    if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..')
      fail('RUN_PATH', '文件不在运行目录内。');
    return path;
  }
  private readFile(folder: string, name: string, limit: number) {
    const path = this.child(folder, name),
      before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
      fail('OUTPUT_FILE', '只能收取大小范围内的普通文件，不能是链接。');
    if (realpathSync(path) !== path) fail('RUN_PATH', '文件路径发生重定向。');
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        stat.size !== before.size
      )
        fail('OUTPUT_CHANGED', '文件在读取前发生变化。');
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const n = readSync(fd, data, offset, data.length - offset, offset);
        if (!n) fail('OUTPUT_CHANGED', '文件在收取期间缩短。');
        offset += n;
      }
      const after = fstatSync(fd),
        named = lstatSync(path);
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        named.isSymbolicLink() ||
        named.ino !== stat.ino ||
        named.dev !== stat.dev ||
        realpathSync(path) !== path
      )
        fail('OUTPUT_CHANGED', '文件在收取期间改变，请等本地执行结束再收取。');
      return data;
    } finally {
      closeSync(fd);
    }
  }
  private paths(w: string, record: LocalRunRecord) {
    const root = this.folder(w, record.id);
    return {
      root,
      inputDirectory: join(root, 'input'),
      outputDirectory: join(root, 'output'),
      entrypoint: join(root, 'input', record.entrypoint),
    };
  }
  view(w: string, record: LocalRunRecord) {
    const paths = this.paths(w, record),
      outputs = record.outputs ?? [],
      issues = record.collectionIssues ?? [];
    return {
      ...record,
      paths,
      executionSource: 'codex_report' as const,
      collection: {
        imported: outputs.filter((item) => item.importedObjectId).length,
        pending: outputs.filter((item) => !item.importedObjectId).length,
        issues: issues.length,
        state: record.returnedAt
          ? 'returned'
          : issues.length
            ? 'needs_attention'
            : record.collectedAt
              ? 'partial'
              : 'not_collected',
      },
      nextAction: record.returnedAt
        ? '结果已回到桌面，无需重跑。'
        : record.report
          ? '执行回报已保存；如有收取失败项，处理文件后调用 collect 继续，不要重新执行代码。'
          : record.progress?.phase === 'unavailable'
            ? '执行会话暂时无法恢复，状态未知。只收回实际存在的文件，不推断成功、不重跑；找回真实执行回报后仍可补齐。'
            : record.progress
              ? `先在原对话通过 ${record.progress.executionRef} 恢复执行状态，再提交 complete；没有新回报不代表进程仍在运行，也不要重新执行。`
              : '先查看原对话是否已有执行调用；没有回报不能作为尚未运行的依据。',
      execution: {
        program: record.runtime === 'python' ? 'python' : 'node',
        args: [paths.entrypoint],
        workdir: paths.outputDirectory,
      },
      note: '插件只准备文件和收取结果。实际运行、停止与权限审批使用 Codex 原对话的执行工具；尚无回报不代表尚未运行，不要因重复准备而重跑。',
    };
  }
  get(w: string, c: string, s: string | null, id: string, access?: RunAccess) {
    this.auth(w, c, s, undefined, access);
    const record = this.read(w, id);
    this.auth(w, c, s, record, access);
    return record;
  }
  list(w: string, c: string, s: string | null) {
    this.auth(w, c, s);
    return (
      this.db
        .prepare("SELECT value FROM settings WHERE workspace=? AND key LIKE 'local-run:record:%'")
        .all(w) as { value: string }[]
    )
      .map((row) => this.view(w, JSON.parse(row.value)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  forGrant(w: string, c: string, s: string | null, access: RunAccess) {
    access.authorize();
    const row = this.db
      .prepare('SELECT value FROM settings WHERE workspace=? AND key=?')
      .get(w, `local-run:by-grant:${access.grantId}`) as { value: string } | undefined;
    return row ? this.get(w, c, s, JSON.parse(row.value), access) : null;
  }
  prepare(
    w: string,
    c: string,
    s: string | null,
    codeObjectId: string,
    selected: LocalInputs,
    inputDigest: string,
    access: RunAccess,
  ) {
    return this.api.tx(() => {
      const existing = this.forGrant(w, c, s, access);
      if (existing) return this.view(w, existing);
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM settings WHERE workspace=? AND key LIKE 'local-run:record:%'",
        )
        .get(w) as { n: number };
      if (count.n >= 200) fail('RUN_LIMIT', '工作区最多保留 200 份本地运行记录。');
      const id = randomUUID(),
        root = this.folder(w, id);
      mkdirSync(root, { recursive: true });
      const input = join(root, 'input'),
        output = join(root, 'output');
      mkdirSync(input);
      mkdirSync(output);
      const inputFiles = selected.files.map((file) => {
        writeFileSync(this.child(input, file.name), file.data, { flag: 'wx' });
        return { name: file.name, bytes: file.data.length, sha256: sha(file.data) };
      });
      const record: LocalRunRecord = {
        id,
        grantId: access.grantId,
        codeObjectId,
        createdAt: new Date().toISOString(),
        runtime: selected.runtime,
        reportCardVersion: 2,
        entrypoint: selected.entrypoint,
        origin: selected.origin,
        inputs: selected.inputs,
        inputDigest,
        inputFiles,
      };
      access.authorize(record);
      this.write(w, record);
      this.db
        .prepare('INSERT INTO settings VALUES(?,?,?)')
        .run(w, `local-run:by-grant:${access.grantId}`, JSON.stringify(id));
      this.api.event(w, 'local_run.prepared', codeObjectId, null, 'ai');
      return this.view(w, record);
    });
  }
  report(w: string, c: string, s: string | null, id: string, input: unknown, access: RunAccess) {
    const report = ExecutionReport.parse(input);
    return this.api.tx(() => {
      const current = this.get(w, c, s, id, access);
      if (current.report) {
        if (JSON.stringify(current.report) !== JSON.stringify(report))
          fail(
            'REPORT_EXISTS',
            '已保存这次执行回报；不能用另一次运行结果覆盖，请重新选择材料建立新记录。',
          );
        return current;
      }
      const next = { ...current, report, reportedAt: new Date().toISOString() };
      this.write(w, next);
      this.api.event(w, 'local_run.reported', current.codeObjectId, null, 'ai');
      return next;
    });
  }
  progress(w: string, c: string, s: string | null, id: string, input: unknown, access: RunAccess) {
    const parsed = ExecutionProgress.parse(input);
    return this.api.tx(() => {
      const current = this.get(w, c, s, id, access);
      // Losing the tool session must not erase the last known reference or partial logs.
      const progress =
        parsed.phase === 'unavailable' && current.progress
          ? {
              ...parsed,
              executionRef: parsed.executionRef ?? current.progress.executionRef,
              stdout: parsed.stdout || current.progress.stdout,
              stderr: parsed.stderr || current.progress.stderr,
              logsTruncated: parsed.logsTruncated || current.progress.logsTruncated,
            }
          : parsed;
      // Late progress must never overwrite a final report or a newer progress snapshot.
      if (current.report || (current.progress && progress.sequence < current.progress.sequence))
        return this.view(w, current);
      if (current.progress?.sequence === progress.sequence) {
        if (JSON.stringify(current.progress) !== JSON.stringify(progress))
          fail('PROGRESS_CONFLICT', '同一进度序号内容不一致；请读取 status 后使用更大的序号。');
        return this.view(w, current);
      }
      const next = { ...current, progress, progressAt: new Date().toISOString() };
      this.write(w, next);
      this.api.event(w, 'local_run.progress', current.codeObjectId, null, 'ai');
      return this.view(w, next);
    });
  }
  collect(w: string, c: string, s: string | null, id: string, access?: RunAccess) {
    let current = this.get(w, c, s, id, access);
    if (current.returnedAt) return this.view(w, current);
    const issues: CollectionIssue[] = [];
    const noteIssue = (error: unknown, stage: CollectionIssue['stage'], fileName?: string) => {
      // Access failures are never softened into a per-file error.
      this.get(w, c, s, id, access);
      const detail = error as { code?: unknown; message?: unknown };
      issues.push({
        stage,
        ...(fileName ? { fileName } : {}),
        code: typeof detail?.code === 'string' ? detail.code.slice(0, 60) : 'COLLECTION_FAILED',
        message: (typeof detail?.message === 'string'
          ? detail.message
          : '收取未完成，请重试。'
        ).slice(0, 600),
      });
    };
    const authority: CreationAuthority = {
      authorize: () => {
        this.get(w, c, s, id, access);
      },
      actor: 'ai',
      summary: `Codex 本地运行 ${id}；输入 ${current.inputs.map((item) => `${item.title} v${item.revision}`).join('、')}`,
    };
    // Save the real execution report independently, even if a file cannot be collected.
    if (current.report && !current.reportObjectId) {
      try {
        const report = current.report,
          title =
            current.inputs.find((item) => item.objectId === current.codeObjectId)?.title ?? '代码';
        const body =
          current.reportCardVersion === 2
            ? [
                `本地运行结果：${title}`,
                `状态：${report.status}（由 Codex 回报）；退出码：${report.exitCode ?? '未提供'}`,
                `记录：${id}`,
                `执行工具引用：${report.executionRef ?? current.progress?.executionRef ?? '未提供'}`,
                `输入：${current.inputs.map((item) => `${item.title} v${item.revision}`).join('；')}`,
                report.summary,
                '标准输出',
                report.stdout.slice(0, 16000),
                '错误输出',
                report.stderr.slice(0, 16000),
                `日志是否由 Codex 截断：${report.logsTruncated ? '是' : '否'}`,
                '本卡片每个通道最多展示 16000 字符，运行记录保留 Codex 提交的日志。',
                '文件回收进度与失败项请查看桌面的运行记录；本卡片仅记录执行回报。',
              ].join('\n')
            : // Preserve old report bytes so a lost 0.20 import receipt can still be recovered.
              [
                `本地运行结果：${title}`,
                `状态：${report.status}（由 Codex 回报）；退出码：${report.exitCode ?? '未提供'}`,
                `记录：${id}`,
                `执行工具引用：${report.executionRef ?? '未提供'}`,
                `输入：${current.inputs.map((item) => `${item.title} v${item.revision}`).join('；')}`,
                report.summary,
                '标准输出',
                report.stdout.slice(0, 16000),
                '错误输出',
                report.stderr.slice(0, 16000),
                '本卡片每个通道最多展示 16000 字符，运行记录保留 Codex 提交的日志。',
                ...(current.warnings ?? []),
              ].join('\n');
        const object = this.api.importOutput(
          w,
          c,
          s,
          {
            requestId: `local-report-${id}`,
            fileName: `运行结果-${id.slice(0, 8)}.txt`,
            data: Buffer.from(body).toString('base64'),
            bounds: { ...current.origin, width: 480, height: 360 },
          },
          authority,
        );
        current = this.api.tx(() => {
          const latest = this.get(w, c, s, id, access),
            next = { ...latest, reportObjectId: object.id };
          this.write(w, next);
          return next;
        });
      } catch (error) {
        noteIssue(error, 'report');
      }
    }
    try {
      const folder = this.paths(w, current).outputDirectory;
      if (
        lstatSync(folder).isSymbolicLink() ||
        !lstatSync(folder).isDirectory() ||
        realpathSync(folder) !== folder
      )
        fail('RUN_PATH', '输出目录发生重定向。');
      const names = readdirSync(folder).sort();
      // Bound each attempt while allowing good files to return alongside rejected ones.
      if (names.length > 64)
        issues.push({
          stage: 'scan',
          code: 'OUTPUT_LIMIT',
          message:
            '本次只处理前 64 个条目；请将不需要回收的文件移出 output 后重试。最多保存 32 个产物。',
        });
      for (const name of names.slice(0, 64)) {
        try {
          const path = this.child(folder, name);
          if (lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink())
            fail(
              'OUTPUT_DIRECTORY',
              '子目录不支持收取；请将需要的文件放到 output 顶层，并移走子目录后重试。',
            );
          const data = this.readFile(folder, name, maxFile),
            digest = sha(data);
          current = this.api.tx(() => {
            const latest = this.get(w, c, s, id, access);
            if (latest.returnedAt) return latest;
            const outputs = latest.outputs ?? [],
              previous = outputs.find((output) => output.name === name);
            if (previous) {
              if (previous.sha256 !== digest)
                fail(
                  'OUTPUT_CHANGED',
                  '已收取文件又发生变化；原产物保留。请将新版本另存为其他文件名并移走当前同名文件，再重试收取。',
                );
              return latest;
            }
            if (
              outputs.length >= 32 ||
              outputs.reduce((sum, item) => sum + item.bytes, 0) + data.length > maxTotal
            )
              fail(
                'OUTPUT_LIMIT',
                '累计产物达到 32 个或 256 MiB；请将本文件移出 output，保留在本地。其他已收取产物不受影响。',
              );
            const next = {
              ...latest,
              outputs: [
                ...outputs,
                { name, bytes: data.length, sha256: digest, assetHash: this.api.storeAsset(data) },
              ],
            };
            this.write(w, next);
            return next;
          });
        } catch (error) {
          noteIssue(error, 'read', name);
        }
      }
    } catch (error) {
      noteIssue(error, 'scan');
    }
    current = this.get(w, c, s, id, access);
    // Each successful import is checkpointed. A later file cannot roll it back.
    for (const [index, output] of (current.outputs ?? []).entries()) {
      if (output.importedObjectId) continue;
      try {
        const data = this.api.loadAsset(output.assetHash);
        if (data.length !== output.bytes || sha(data) !== output.sha256)
          fail('OUTPUT_CHANGED', '已收取产物不完整。');
        const object = this.api.importOutput(
          w,
          c,
          s,
          {
            requestId: `local-output-${id}-${sha(output.name).slice(0, 16)}`,
            fileName: output.name,
            data: data.toString('base64'),
            bounds: {
              x: Math.min(99000, current.origin.x + 520 + (index % 2) * 460),
              y: Math.min(99000, current.origin.y + Math.floor(index / 2) * 340),
              width: 420,
              height: 300,
            },
          },
          authority,
        );
        current = this.api.tx(() => {
          const latest = this.get(w, c, s, id, access),
            next = {
              ...latest,
              outputs: latest.outputs!.map((item) =>
                item.name === output.name ? { ...item, importedObjectId: object.id } : item,
              ),
            };
          this.write(w, next);
          return next;
        });
      } catch (error) {
        noteIssue(error, 'import', output.name);
      }
    }
    current = this.api.tx(() => {
      const latest = this.get(w, c, s, id, access);
      if (latest.returnedAt) return latest;
      if (!latest.outputs?.length && !latest.report && !issues.length)
        issues.push({
          stage: 'scan',
          code: 'OUTPUT_EMPTY',
          message: '尚无输出文件或执行回报；请在原对话执行结束后收取，不要据此重跑。',
        });
      const at = new Date().toISOString(),
        complete =
          !!latest.reportObjectId &&
          !issues.length &&
          (latest.outputs ?? []).every((output) => output.importedObjectId);
      const next = {
        ...latest,
        collectedAt: at,
        collectionAttemptAt: at,
        collectionIssues: issues,
        ...(complete ? { returnedAt: at } : {}),
      };
      this.write(w, next);
      this.api.event(
        w,
        complete ? 'local_run.collected' : 'local_run.collection_pending',
        latest.reportObjectId ?? null,
        null,
        access ? 'ai' : 'human',
      );
      return next;
    });
    return this.view(w, current);
  }
  output(w: string, c: string, s: string | null, id: string, name: string, access: RunAccess) {
    const record = this.get(w, c, s, id, access),
      output = record.outputs?.find((item) => item.name === name);
    if (!output) fail('NOT_FOUND', '此文件尚未收取。');
    const bytes = this.api.loadAsset(output.assetHash);
    if (bytes.length !== output.bytes || sha(bytes) !== output.sha256)
      fail('OUTPUT_CHANGED', '产物内容不完整。');
    return { output, bytes };
  }
}
