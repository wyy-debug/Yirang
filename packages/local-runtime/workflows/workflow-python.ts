import { createHash } from 'node:crypto';
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
import { join, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { fail } from '../../contracts/index.js';

export type WorkflowPythonSource = {
  objectId: string;
  revision: number;
  fileName: string;
  data: Buffer;
};
export type WorkflowPythonSpec = {
  workspaceId: string;
  runId: string;
  nodeId: string;
  source: WorkflowPythonSource;
  requirements?: WorkflowPythonSource;
  program?: string;
  inputs: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  entryFunction?: string;
  files?: WorkflowPythonSource[];
};
type FrozenFile = { relativePath: string; size: number; sha256: string };
export type WorkflowPythonRecord = {
  version: 1;
  workspaceId: string;
  runId: string;
  nodeId: string;
  createdAt: string;
  inputDigest: string;
  source: { objectId: string; revision: number; fileName: string; sha256: string };
  requirements?: { objectId: string; revision: number; fileName: string; sha256: string };
  entryFunction: string;
  inputFiles: {
    objectId: string;
    revision: number;
    fileName: string;
    relativePath: string;
    sha256: string;
    size: number;
  }[];
  frozenFiles: FrozenFile[];
  paths: {
    root: string;
    inputDirectory: string;
    outputDirectory: string;
    source: string;
    requirements?: string;
    inputs: string;
    runner: string;
  };
  execution: { program: string; args: string[]; workdir: string };
  note: string;
};
export type WorkflowPythonReport = {
  executionRef: { kind: 'tool' | 'python' | 'browser'; id: string; provider?: string };
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode: number | null;
};
export type WorkflowPythonArtifact = {
  relativePath: string;
  fileName: string;
  path: string;
  size: number;
  sha256: string;
  data: Buffer;
};
export type WorkflowPythonExecution = {
  version: 1;
  runId: string;
  nodeId: string;
  inputDigest: string;
  codeSha256: string;
  status: 'succeeded' | 'failed';
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  outputsSha256?: string;
  error?: string;
  logsTruncated: boolean;
  executionSource: 'local_python_runner';
  runtime: { executable: string; version: string };
};
export type WorkflowPythonCollection = {
  outputs: Record<string, unknown>;
  files: WorkflowPythonArtifact[];
  execution: WorkflowPythonExecution | null;
  report: WorkflowPythonReport;
  stdout: string;
  stderr: string;
  logsTruncated: boolean;
  issues: { code: string; message: string; fileName?: string }[];
};

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const jsonLimit = 1024 * 1024,
  sourceLimit = 2 * 1024 * 1024,
  fileLimit = 50 * 1024 * 1024,
  totalLimit = 256 * 1024 * 1024,
  logLimit = 512 * 1024;
const cleanId = (value: string) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 150 &&
  !/[\u0000-\u001f]/.test(value);
const safePart = (part: string) =>
  part.length > 0 &&
  part.length <= 120 &&
  part !== '.' &&
  part !== '..' &&
  !/[<>:"/\\|?*\u0000-\u001f]/.test(part) &&
  !/[. ]$/.test(part) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part);
const portablePath = (value: string) =>
  typeof value === 'string' &&
  value.length <= 600 &&
  value.split('/').length <= 6 &&
  value.split('/').every(safePart);
const normalizeFileName = (value: string) => {
  const name = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(-90);
  return safePart(name) ? name : 'material.bin';
};
const jsonBytes = (value: unknown) => {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    fail('WORKFLOW_PYTHON_INPUT', 'Python 输入必须可序列化为 JSON。');
  }
  if (!text || Buffer.byteLength(text, 'utf8') > jsonLimit)
    fail('WORKFLOW_PYTHON_LIMIT', 'Python 输入 JSON 不能超过 1 MiB。');
  return Buffer.from(text + '\n');
};
function objectValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** File exchange only. No subprocess, environment creation, dependency install or background execution. */
export class WorkflowPython {
  constructor(private directory: string) {}
  private directoryPath(root: string, path: string, create = false) {
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
      fail('WORKFLOW_PYTHON_PATH', 'Python 路径必须在本次运行目录内。');
    let cursor = root;
    for (const part of rel ? rel.split(sep) : []) {
      cursor = join(cursor, part);
      if (!existsSync(cursor)) {
        if (!create) fail('WORKFLOW_PYTHON_PATH', 'Python 运行目录不存在。');
        mkdirSync(cursor);
      }
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(cursor) !== cursor)
        fail('WORKFLOW_PYTHON_PATH', 'Python 运行目录不能经过链接或重定向。');
    }
    return path;
  }
  private root(workspaceId: string, runId: string, nodeId: string, create = false) {
    if (![workspaceId, runId, nodeId].every(cleanId))
      fail('WORKFLOW_PYTHON_INPUT', 'Python 工作区、运行和节点 ID 无效。');
    const base = realpathSync(this.directory),
      root = join(base, 'workflow-python', sha(JSON.stringify([workspaceId, runId, nodeId])));
    this.directoryPath(base, root, create);
    return root;
  }
  private filePath(root: string, path: string) {
    if (!portablePath(path))
      fail('WORKFLOW_PYTHON_PATH', 'Python 文件引用必须是运行目录内的相对文件路径。');
    const absolute = resolve(root, ...path.split('/')),
      rel = relative(root, absolute);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
      fail('WORKFLOW_PYTHON_PATH', 'Python 文件引用越过了运行目录。');
    this.directoryPath(root, resolve(absolute, '..'));
    return absolute;
  }
  private readFile(root: string, path: string, limit: number) {
    const absolute = this.filePath(root, path),
      before = lstatSync(absolute);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > limit ||
      realpathSync(absolute) !== absolute
    )
      fail('WORKFLOW_PYTHON_FILE', '只能收取大小范围内的普通文件，不能是链接。');
    const fd = openSync(absolute, 'r');
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        stat.size !== before.size
      )
        fail('WORKFLOW_PYTHON_CHANGED', 'Python 文件在读取前发生了变化。');
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const n = readSync(fd, data, offset, data.length - offset, offset);
        if (!n) fail('WORKFLOW_PYTHON_CHANGED', 'Python 文件在收取期间缩短。');
        offset += n;
      }
      const after = fstatSync(fd),
        named = lstatSync(absolute);
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        named.size !== stat.size ||
        named.ino !== stat.ino ||
        named.dev !== stat.dev ||
        realpathSync(absolute) !== absolute
      )
        fail('WORKFLOW_PYTHON_CHANGED', 'Python 文件在收取期间改变，请等执行结束后重试。');
      return data;
    } finally {
      closeSync(fd);
    }
  }
  private readJson(root: string, path: string) {
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(this.readFile(root, path, jsonLimit)),
      );
    } catch (error) {
      if (
        (error as { code?: unknown })?.code &&
        String((error as { code?: unknown }).code).startsWith('WORKFLOW_')
      )
        throw error;
      fail('WORKFLOW_PYTHON_JSON', `${path} 不是有效且完整的 UTF-8 JSON 文件。`);
    }
  }
  private assertFrozen(record: WorkflowPythonRecord) {
    const root = this.root(record.workspaceId, record.runId, record.nodeId);
    if (
      root !== record.paths.root ||
      record.paths.inputDirectory !== join(root, 'input') ||
      record.paths.outputDirectory !== join(root, 'output')
    )
      fail('WORKFLOW_PYTHON_CHANGED', 'Python 运行路径与冻结记录不一致。');
    this.directoryPath(root, record.paths.outputDirectory);
    const saved = this.readJson(root, 'record.json');
    if (JSON.stringify(saved) !== JSON.stringify(record))
      fail('WORKFLOW_PYTHON_CHANGED', 'Python 冻结记录被修改，不能把此次结果接入流程。');
    for (const file of record.frozenFiles) {
      const data = this.readFile(root, file.relativePath, fileLimit);
      if (data.length !== file.size || sha(data) !== file.sha256)
        fail(
          'WORKFLOW_PYTHON_CHANGED',
          `${file.relativePath} 与准备时的内容不一致，请保留结果并建立新的流程运行。`,
        );
    }
    return root;
  }
  prepare(spec: WorkflowPythonSpec): WorkflowPythonRecord {
    const { source, requirements } = spec,
      entryFunction = spec.entryFunction ?? 'run';
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(entryFunction))
      fail('WORKFLOW_PYTHON_ENTRY', 'Python 入口必须是有效函数名。');
    for (const file of [source, requirements, ...(spec.files ?? [])].filter(
      Boolean,
    ) as WorkflowPythonSource[]) {
      if (
        !cleanId(file.objectId) ||
        !Number.isInteger(file.revision) ||
        file.revision < 1 ||
        !Buffer.isBuffer(file.data) ||
        file.data.length > fileLimit
      )
        fail('WORKFLOW_PYTHON_INPUT', 'Python 源码、依赖或材料版本无效，单个材料最多 50 MiB。');
    }
    if (source.data.length > sourceLimit || (requirements && requirements.data.length > 64000))
      fail('WORKFLOW_PYTHON_LIMIT', 'Python 源码最多 2 MiB，依赖声明最多 64 KiB。');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(source.data);
      if (requirements) new TextDecoder('utf-8', { fatal: true }).decode(requirements.data);
    } catch {
      fail('WORKFLOW_PYTHON_INPUT', 'Python 源码和依赖声明必须是 UTF-8 文本。');
    }
    const inputs = spec.files ?? [];
    if (
      inputs.length > 32 ||
      new Set(inputs.map((file) => file.objectId)).size !== inputs.length ||
      inputs.reduce((sum, file) => sum + file.data.length, 0) > totalLimit
    )
      fail('WORKFLOW_PYTHON_LIMIT', 'Python 输入最多 32 个不同文件，合计最多 256 MiB。');
    const inputFiles = inputs.map((file) => ({
      objectId: file.objectId,
      revision: file.revision,
      fileName: file.fileName,
      relativePath: `input/files/${sha(file.objectId).slice(0, 12)}-${normalizeFileName(file.fileName)}`,
      sha256: sha(file.data),
      size: file.data.length,
    }));
    const inputBytes = jsonBytes(spec.inputs),
      parameterBytes = jsonBytes(spec.parameters ?? {}),
      sourceHash = sha(source.data),
      requirementsHash = requirements ? sha(requirements.data) : undefined;
    const inputDigest = sha(
      JSON.stringify({
        workspaceId: spec.workspaceId,
        runId: spec.runId,
        nodeId: spec.nodeId,
        source: { objectId: source.objectId, revision: source.revision, sha256: sourceHash },
        requirements: requirements
          ? {
              objectId: requirements.objectId,
              revision: requirements.revision,
              sha256: requirementsHash,
            }
          : null,
        entryFunction,
        inputs: sha(inputBytes),
        parameters: sha(parameterBytes),
        inputFiles,
      }),
    );
    const root = this.root(spec.workspaceId, spec.runId, spec.nodeId, true);
    const preparedFiles = [
      { relativePath: 'code/component.py', data: source.data },
      { relativePath: 'input/inputs.json', data: inputBytes },
      { relativePath: 'input/parameters.json', data: parameterBytes },
      { relativePath: 'runner.py', data: Buffer.from(PYTHON_RUNNER) },
      ...(requirements ? [{ relativePath: 'code/requirements.txt', data: requirements.data }] : []),
      ...inputs.map((file, index) => ({
        relativePath: inputFiles[index].relativePath,
        data: file.data,
      })),
    ];
    const frozenFiles = preparedFiles.map((file) => ({
      relativePath: file.relativePath,
      size: file.data.length,
      sha256: sha(file.data),
    }));
    const paths = {
      root,
      inputDirectory: join(root, 'input'),
      outputDirectory: join(root, 'output'),
      source: join(root, 'code', 'component.py'),
      ...(requirements ? { requirements: join(root, 'code', 'requirements.txt') } : {}),
      inputs: join(root, 'input', 'inputs.json'),
      runner: join(root, 'runner.py'),
    };
    const record: WorkflowPythonRecord = {
      version: 1,
      workspaceId: spec.workspaceId,
      runId: spec.runId,
      nodeId: spec.nodeId,
      createdAt: new Date().toISOString(),
      inputDigest,
      source: {
        objectId: source.objectId,
        revision: source.revision,
        fileName: source.fileName,
        sha256: sourceHash,
      },
      ...(requirements
        ? {
            requirements: {
              objectId: requirements.objectId,
              revision: requirements.revision,
              fileName: requirements.fileName,
              sha256: requirementsHash!,
            },
          }
        : {}),
      entryFunction,
      inputFiles,
      frozenFiles,
      paths,
      execution: {
        program: spec.program || 'python',
        args: [paths.runner],
        workdir: paths.outputDirectory,
      },
      note: '仅准备了冻结文件。由 Codex 原对话使用执行工具运行 runner，并提交真实执行会话引用和退出码；不自动创建环境或安装依赖。重复 prepare 不代表需要重跑。',
    };
    if (existsSync(join(root, 'record.json'))) {
      const previous = this.readJson(root, 'record.json') as WorkflowPythonRecord;
      if (
        !objectValue(previous) ||
        typeof previous.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(previous.createdAt)) ||
        JSON.stringify({ ...record, createdAt: previous.createdAt }) !== JSON.stringify(previous)
      )
        fail(
          'WORKFLOW_PYTHON_CHANGED',
          '这个节点已有冻结运行；不能覆盖输入或重复准备为另一次执行。请查看原运行状态。',
        );
      this.assertFrozen(previous);
      return previous;
    }
    // A partial prepare must never overwrite files that may have been executed already.
    if (readdirSync(root).length)
      fail(
        'WORKFLOW_PYTHON_PARTIAL',
        '这个节点留下了未完成的准备目录，已保留所有文件。请建立新的流程运行，勿覆盖或重跑原目录。',
      );
    for (const path of ['input', 'input/files', 'code', 'output', 'logs'])
      this.directoryPath(root, join(root, ...path.split('/')), true);
    for (const file of preparedFiles)
      writeFileSync(this.filePath(root, file.relativePath), file.data, { flag: 'wx' });
    writeFileSync(join(root, 'record.json'), JSON.stringify(record, null, 2) + '\n', {
      flag: 'wx',
    });
    return record;
  }
  readArtifact(
    record: WorkflowPythonRecord,
    artifact: { relativePath: string; sha256: string; size: number },
  ): WorkflowPythonArtifact {
    this.assertFrozen(record);
    if (
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isInteger(artifact.size) ||
      artifact.size < 0 ||
      artifact.size > fileLimit ||
      ['outputs.json', 'execution.json'].includes(artifact.relativePath)
    )
      fail('WORKFLOW_PYTHON_ARTIFACT', 'Python 产物登记无效。');
    const data = this.readFile(record.paths.outputDirectory, artifact.relativePath, fileLimit);
    if (data.length !== artifact.size || sha(data) !== artifact.sha256)
      fail('WORKFLOW_PYTHON_CHANGED', 'Python 产物在回收后变化，不能作为同一份结果继续使用。');
    const path = this.filePath(record.paths.outputDirectory, artifact.relativePath);
    return {
      relativePath: artifact.relativePath,
      fileName: basename(path),
      path,
      size: data.length,
      sha256: artifact.sha256,
      data,
    };
  }
  collect(record: WorkflowPythonRecord, report: WorkflowPythonReport): WorkflowPythonCollection {
    if (
      !report ||
      report.executionRef?.kind !== 'python' ||
      typeof report.executionRef.id !== 'string' ||
      !report.executionRef.id.trim() ||
      report.executionRef.id.length > 200 ||
      !['succeeded', 'failed', 'cancelled'].includes(report.status) ||
      (report.exitCode !== null && !Number.isInteger(report.exitCode)) ||
      (report.status === 'succeeded' && report.exitCode !== 0) ||
      (report.status === 'failed' && report.exitCode === 0)
    )
      fail(
        'WORKFLOW_PYTHON_REPORT',
        '收取 Python 结果需要真实执行会话引用和退出码；成功必须是退出码 0。',
      );
    const root = this.assertFrozen(record),
      output = record.paths.outputDirectory;
    const issues: WorkflowPythonCollection['issues'] = [];
    const issue = (error: unknown, fileName?: string) => {
      const detail = error as { code?: string; message?: string };
      issues.push({
        code: detail.code ?? 'WORKFLOW_PYTHON_COLLECTION',
        message: (detail.message ?? '文件回收失败。').slice(0, 600),
        ...(fileName ? { fileName } : {}),
      });
    };
    let execution: WorkflowPythonExecution | null = null,
      outputs: Record<string, unknown> = {};
    try {
      const value = this.readJson(output, 'execution.json') as WorkflowPythonExecution;
      if (
        !objectValue(value) ||
        value.version !== 1 ||
        value.runId !== record.runId ||
        value.nodeId !== record.nodeId ||
        value.inputDigest !== record.inputDigest ||
        value.codeSha256 !== record.source.sha256 ||
        !['succeeded', 'failed'].includes(value.status) ||
        !Number.isInteger(value.exitCode) ||
        value.executionSource !== 'local_python_runner' ||
        (value.status === 'succeeded' && value.exitCode !== 0) ||
        (value.status === 'failed' && value.exitCode === 0)
      )
        fail('WORKFLOW_PYTHON_CHANGED', 'Python 执行清单与冻结代码、输入或节点不一致。');
      if (value.status !== report.status || value.exitCode !== report.exitCode)
        fail(
          'WORKFLOW_PYTHON_REPORT',
          '原对话退出回报与 Python 执行清单不一致，暂不向下游传递结果。',
        );
      execution = value;
    } catch (error) {
      if (report.status === 'succeeded') throw error;
      issue(error, 'execution.json');
    }
    if (execution?.status === 'succeeded') {
      const bytes = this.readFile(output, 'outputs.json', jsonLimit);
      if (sha(bytes) !== execution.outputsSha256)
        fail('WORKFLOW_PYTHON_CHANGED', 'Python 输出在执行结束后发生变化，暂不向下游传递。');
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!objectValue(value)) throw new Error();
        outputs = value;
      } catch {
        fail('WORKFLOW_PYTHON_JSON', 'Python run 的返回值必须是以输出端口名称为键的 JSON 对象。');
      }
    }
    const files: WorkflowPythonArtifact[] = [];
    let total = 0,
      entries = 0;
    const scan = (folder: string, prefix: string, depth: number) => {
      this.directoryPath(root, folder);
      for (const name of readdirSync(folder).sort()) {
        if (++entries > 128) {
          issues.push({
            code: 'WORKFLOW_PYTHON_LIMIT',
            message: '输出目录条目超过 128 个，其余文件保留在本地。',
          });
          return;
        }
        const relativePath = prefix ? `${prefix}/${name}` : name;
        if (!prefix && ['outputs.json', 'execution.json'].includes(name)) continue;
        try {
          const path = this.filePath(output, relativePath),
            stat = lstatSync(path);
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            if (depth >= 5) fail('WORKFLOW_PYTHON_LIMIT', '产物子目录最多 5 层。');
            scan(path, relativePath, depth + 1);
            continue;
          }
          if (files.length >= 32 || total + stat.size > totalLimit)
            fail(
              'WORKFLOW_PYTHON_LIMIT',
              '回收产物最多 32 个文件、合计 256 MiB；其余文件保留在本地。',
            );
          const data = this.readFile(output, relativePath, fileLimit);
          total += data.length;
          files.push({
            relativePath,
            fileName: basename(path),
            path,
            size: data.length,
            sha256: sha(data),
            data,
          });
        } catch (error) {
          issue(error, relativePath);
        }
      }
    };
    try {
      scan(output, '', 0);
    } catch (error) {
      issue(error);
    }
    const validateReferences = (value: unknown, depth = 0) => {
      if (depth > 32) fail('WORKFLOW_PYTHON_LIMIT', 'Python 输出 JSON 嵌套不能超过 32 层。');
      if (Array.isArray(value)) {
        for (const item of value) validateReferences(item, depth + 1);
        return;
      }
      if (!objectValue(value)) return;
      if (Object.hasOwn(value, '$file')) {
        if (
          Object.keys(value).length !== 1 ||
          typeof value.$file !== 'string' ||
          !portablePath(value.$file) ||
          !files.some((file) => file.relativePath === value.$file)
        )
          fail(
            'WORKFLOW_PYTHON_OUTPUT',
            "Python 文件输出必须为 {$file: '相对路径'}，且指向已收取的普通产物。",
          );
      } else for (const item of Object.values(value)) validateReferences(item, depth + 1);
    };
    validateReferences(outputs);
    const readLog = (name: string) => {
      try {
        return new TextDecoder('utf-8').decode(this.readFile(root, `logs/${name}.log`, logLimit));
      } catch (error) {
        issue(error, `${name}.log`);
        return '';
      }
    };
    const stdout = readLog('stdout'),
      stderr = readLog('stderr');
    // The backend validates named output types and registers artifacts. It decides native-object writeback separately.
    return {
      outputs,
      files,
      execution,
      report,
      stdout,
      stderr,
      logsTruncated: execution?.logsTruncated ?? false,
      issues,
    };
  }
}

/** This runner is bundled as text; importing this module never evaluates user Python. */
const PYTHON_RUNNER = String.raw`from __future__ import annotations
import asyncio
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys
import traceback
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "output"
LOG_LIMIT = 512 * 1024
JSON_LIMIT = 1024 * 1024

def now():
    return datetime.now(timezone.utc).isoformat()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def json_data(value):
    data = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    if len(data) > JSON_LIMIT:
        raise ValueError("Component JSON output exceeds 1 MiB")
    return data

def write_once(path, data):
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())

class Tee:
    def __init__(self, original, path):
        self.original = original
        self.stream = path.open("xb")
        self.count = 0
        self.truncated = False
        self.encoding = "utf-8"
    def write(self, text):
        text = str(text)
        data = text.encode("utf-8", errors="replace")
        remaining = max(0, LOG_LIMIT - self.count)
        self.stream.write(data[:remaining])
        self.count += min(len(data), remaining)
        self.truncated = self.truncated or len(data) > remaining
        self.stream.flush()
        self.original.write(text)
        self.original.flush()
        return len(text)
    def flush(self):
        self.stream.flush()
        self.original.flush()
    def isatty(self):
        return False
    def __getattr__(self, name):
        return getattr(self.original, name)

async def await_output(value):
    return await value

def main():
    # Exclusive marker prevents re-running a prepared node after an interrupted or unknown execution.
    try:
        write_once(ROOT / "started.json", json_data({"startedAt": now(), "pid": os.getpid()}))
    except FileExistsError:
        print("This workflow node was already started. Recover its original execution; do not rerun it.", file=sys.stderr)
        return 73
    started = now()
    record = None
    stdout = None
    stderr = None
    result_digest = None
    error = None
    exit_code = 1
    previous_stdout, previous_stderr = sys.stdout, sys.stderr
    try:
        stdout = Tee(previous_stdout, ROOT / "logs" / "stdout.log")
        stderr = Tee(previous_stderr, ROOT / "logs" / "stderr.log")
        sys.stdout, sys.stderr = stdout, stderr
        record = json.loads((ROOT / "record.json").read_text(encoding="utf-8"))
        for file in record["frozenFiles"]:
            path = ROOT.joinpath(*file["relativePath"].split("/"))
            if path.is_symlink() or path.resolve() != path or not path.is_file():
                raise ValueError("Frozen input path is not a regular file: " + file["relativePath"])
            data = path.read_bytes()
            if len(data) != file["size"] or digest(data) != file["sha256"]:
                raise ValueError("Frozen input changed: " + file["relativePath"])
        inputs = json.loads((ROOT / "input" / "inputs.json").read_text(encoding="utf-8"))
        parameters = json.loads((ROOT / "input" / "parameters.json").read_text(encoding="utf-8"))
        context = {
            "run_id": record["runId"], "node_id": record["nodeId"],
            "input_dir": str(ROOT / "input"), "output_dir": str(OUTPUT),
            "input_files": {file["objectId"]: str(ROOT.joinpath(*file["relativePath"].split("/"))) for file in record["inputFiles"]},
            "parameters": parameters,
        }
        os.chdir(OUTPUT)
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location("desktop_workflow_component", ROOT / "code" / "component.py")
        if spec is None or spec.loader is None:
            raise ValueError("Cannot load Python component")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        handler = getattr(module, record["entryFunction"], None)
        if not callable(handler):
            raise ValueError("Component entry function is missing: " + record["entryFunction"])
        outputs = handler(inputs, context)
        if inspect.isawaitable(outputs):
            outputs = asyncio.run(await_output(outputs))
        if not isinstance(outputs, dict):
            raise TypeError("Component must return a dict keyed by declared output port names")
        data = json_data(outputs)
        write_once(OUTPUT / "outputs.json", data)
        result_digest = digest(data)
        exit_code = 0
    except BaseException as exc:
        error = (type(exc).__name__ + ": " + str(exc))[:4000]
        traceback.print_exc()
    finally:
        sys.stdout, sys.stderr = previous_stdout, previous_stderr
        for stream in (stdout, stderr):
            if stream is not None:
                try:
                    stream.flush()
                    stream.stream.close()
                except Exception:
                    pass
        if record is not None:
            execution = {
                "version": 1, "runId": record["runId"], "nodeId": record["nodeId"],
                "inputDigest": record["inputDigest"], "codeSha256": record["source"]["sha256"],
                "status": "succeeded" if exit_code == 0 else "failed", "exitCode": exit_code,
                "startedAt": started, "finishedAt": now(), "executionSource": "local_python_runner",
                "logsTruncated": bool((stdout and stdout.truncated) or (stderr and stderr.truncated)),
                "runtime": {"executable": sys.executable, "version": sys.version},
            }
            if result_digest is not None:
                execution["outputsSha256"] = result_digest
            if error is not None:
                execution["error"] = error
            try:
                write_once(OUTPUT / "execution.json", json_data(execution))
            except Exception:
                traceback.print_exc(file=previous_stderr)
                exit_code = 1
    return exit_code

if __name__ == "__main__":
    sys.exit(main())
`;
