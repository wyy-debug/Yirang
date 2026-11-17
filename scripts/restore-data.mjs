// Offline rollback utility. It is never run by the server or during packaging.
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2),
  value = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
if (!value('--data') || !value('--snapshot')) {
  process.stderr.write(
    'Usage: node restore-data.mjs --data <desktop-data-directory> --snapshot <before-upgrade.sqlite> [--apply]\nClose Codex before --apply. Without --apply this only displays the plan.\n',
  );
  process.exitCode = 2;
} else {
  const directory = realpathSync(resolve(value('--data'))),
    snapshot = realpathSync(resolve(value('--snapshot'))),
    database = join(directory, 'desktop.sqlite');
  if (
    lstatSync(snapshot).isSymbolicLink() ||
    !lstatSync(snapshot).isFile() ||
    snapshot === database
  )
    throw Error('Choose a separate regular SQLite snapshot.');
  const source = new DatabaseSync(snapshot, { readOnly: true });
  const version = source.prepare('PRAGMA user_version').get().user_version;
  if (version < 1 || version > 6) {
    source.close();
    throw Error('Unsupported snapshot schema.');
  }
  source.prepare('SELECT id FROM workspaces LIMIT 1').get();
  source.close();
  const suffix = randomUUID(),
    backup = join(directory, `before-rollback-${suffix}.sqlite`),
    staged = join(directory, `rollback-staged-${suffix}.sqlite`),
    retired = join(directory, `retired-${suffix}.sqlite`),
    lock = join(directory, 'maintenance.lock');
  process.stdout.write(
    JSON.stringify(
      {
        directory,
        snapshot,
        schema: version,
        currentBackup: backup,
        apply: args.includes('--apply'),
      },
      null,
      2,
    ) + '\n',
  );
  if (args.includes('--apply')) {
    writeFileSync(lock, JSON.stringify({ operation: 'rollback', at: new Date().toISOString() }), {
      flag: 'wx',
    });
    let moved = false,
      installed = false;
    try {
      copyFileSync(snapshot, staged);
      if (existsSync(database)) {
        const current = new DatabaseSync(database);
        try {
          current.exec('PRAGMA busy_timeout=5000;');
          current.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
          const state = current.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
          if (state.busy) throw Error('Database is busy. Close Codex before rollback.');
        } finally {
          current.close();
        }
        renameSync(database, retired);
        moved = true;
        for (const ending of ['-wal', '-shm'])
          if (existsSync(database + ending)) renameSync(database + ending, retired + ending);
      }
      renameSync(staged, database);
      installed = true;
      process.stdout.write(
        'Rollback installed. Original database and current backup are retained. Restart Codex to reopen.\n',
      );
    } catch (error) {
      if (moved && !installed && !existsSync(database)) {
        renameSync(retired, database);
        for (const ending of ['-wal', '-shm'])
          if (existsSync(retired + ending) && !existsSync(database + ending))
            renameSync(retired + ending, database + ending);
      }
      throw error;
    } finally {
      if (existsSync(staged)) unlinkSync(staged);
      unlinkSync(lock);
    }
  }
}
