import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DESKTOP_VERSION } from '../../contracts/version.js';
import { fail } from '../../contracts/index.js';

export function recordInstalledRuntime(directory: string, schema: number) {
  try {
    const path = join(directory, 'runtime-version.json'),
      previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    if (previous?.version === DESKTOP_VERSION && previous?.schema === schema) return;
    const record = {
      at: new Date().toISOString(),
      version: DESKTOP_VERSION,
      schema,
      previousVersion: previous?.version ?? null,
      previousSchema: previous?.schema ?? null,
      status: 'opened',
    };
    appendFileSync(join(directory, 'upgrade-history.jsonl'), JSON.stringify(record) + '\n');
    writeFileSync(path, JSON.stringify(record, null, 2));
  } catch {
    /* Failure to write an auxiliary log must not prevent opening saved materials. */
  }
}
export function maintenanceStatus(db: DatabaseSync, directory: string, input: any) {
  const operation = input?.command ?? 'inspect';
  if (operation === 'snapshot') {
    const path = join(directory, `before-rollback-${randomUUID()}.sqlite`);
    db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return { path, message: '已创建当前数据库的离线恢复快照；文件资产仍保留在原数据目录。' };
  }
  if (operation !== 'inspect' && operation !== 'plan') fail('UNKNOWN_ACTION', '未知恢复操作。');
  const snapshots = readdirSync(directory)
    .filter((name) => /^before-(?:v\d+|rollback)-[\w-]+\.sqlite$/.test(name))
    .flatMap((name) => {
      const path = join(directory, name),
        stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink()
        ? [{ name, path, bytes: stat.size, at: stat.mtime.toISOString() }]
        : [];
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 100);
  let history: any[] = [];
  try {
    const path = join(directory, 'upgrade-history.jsonl');
    if (existsSync(path))
      history = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .slice(-30)
        .map((line) => JSON.parse(line));
  } catch {}
  const packaged = resolve(dirname(fileURLToPath(import.meta.url)), '../tools/restore-data.mjs'),
    script = existsSync(packaged) ? packaged : resolve('scripts/restore-data.mjs');
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const base = {
    serviceVersion: DESKTOP_VERSION,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    schema: (db.prepare('PRAGMA user_version').get() as any).user_version,
    dataDirectory: directory,
    diagnostics: join(directory, 'diagnostics.jsonl'),
    snapshots,
    history,
    restoreScript: script,
    maintenanceLock: existsSync(join(directory, 'maintenance.lock')),
  };
  if (operation === 'inspect') return base;
  const chosen = snapshots.find((s) => s.name === input.snapshot);
  if (!chosen) fail('NOT_FOUND', '请选择此数据目录内已有的恢复快照。');
  return {
    ...base,
    selected: chosen,
    previewCommand: `& ${quote(process.execPath)} ${quote(script)} --data ${quote(directory)} --snapshot ${quote(chosen.path)}`,
    applyCommand: `& ${quote(process.execPath)} ${quote(script)} --data ${quote(directory)} --snapshot ${quote(chosen.path)} --apply`,
    instructions: [
      '先在当前工作区导出备份或创建当前快照。',
      '关闭 Codex，确保旧插件进程不再占用数据。',
      '先执行预览命令，核对数据目录和快照。',
      '确认后执行 --apply 命令；脚本保留当前数据库，失败时恢复。',
      '重新打开 Codex 和工作桌面，查看服务版本与材料。',
    ],
  };
}
