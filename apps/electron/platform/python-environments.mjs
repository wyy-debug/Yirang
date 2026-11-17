import { t as uiText } from './native-ui-language.mjs';
import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createPythonEnvironments({ preferences, window, emit }) {
  const jobs = new Map(),
    requirements = new Map();
  const all = () => preferences.get().pythonEnvironments || [];
  const save = (items) => preferences.set({ pythonEnvironments: items });
  const publish = (job) =>
    emit('python-job', {
      id: job.id,
      environmentId: job.environmentId,
      label: job.label,
      state: job.state,
      log: job.log,
    });
  function execute(environmentId, program, args, workdir, label, after) {
    if (
      [...jobs.values()].some(
        (job) => job.environmentId === environmentId && job.state === 'running',
      )
    )
      throw Error(uiText('这个环境正在处理另一个操作'));
    const id = randomUUID(),
      job = { id, environmentId, label, state: 'running', log: '', child: null };
    jobs.set(id, job);
    const child = spawn(program, args, {
      cwd: workdir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.child = child;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        job.log = (job.log + chunk.toString()).slice(-40000);
        publish(job);
      });
    child.on('error', (error) => {
      job.state = 'failed';
      job.log += error.message;
      publish(job);
    });
    child.on('exit', async (code) => {
      if (job.state === 'cancelled') return;
      job.state = code === 0 ? 'succeeded' : 'failed';
      try {
        if (code === 0) await after?.();
      } catch (error) {
        job.state = 'failed';
        job.log += error.message;
      }
      publish(job);
    });
    publish(job);
    return { id };
  }
  return {
    running() {
      return [...jobs.values()].some((job) => job.state === 'running');
    },
    async resolve(id) {
      const selected = id || preferences.get().pythonDefault,
        entry = all().find((item) => item.id === selected);
      if (!entry) {
        if (selected) throw Error(uiText('指定的 Python 环境已不存在，请重新选择'));
        return { program: 'python', name: uiText('系统 Python') };
      }
      if (!(await stat(entry.program).catch(() => null))?.isFile())
        throw Error(uiText('Python 解释器已移走，请在环境管理中重新选择'));
      return { id: entry.id, name: entry.name, program: entry.program };
    },
    async command(action, payload = {}) {
      if (action === 'list')
        return {
          environments: all(),
          defaultId: preferences.get().pythonDefault,
          jobs: [...jobs.values()].map(({ child, ...job }) => job),
        };
      if (action === 'register') {
        const result = await dialog.showOpenDialog(window(), {
          title: uiText('选择 Python 解释器'),
          properties: ['openFile'],
          filters: [{ name: 'Python', extensions: ['exe'] }],
        });
        if (result.canceled) return null;
        const program = result.filePaths[0],
          entry = {
            id: randomUUID(),
            name: String(payload.name || basename(program)).slice(0, 80),
            program,
            managed: false,
          };
        await save([...all(), entry]);
        return entry;
      }
      if (action === 'create') {
        const base = all().find((item) => item.id === payload.baseId);
        if (!base) throw Error(uiText('先登记一个基础 Python 解释器'));
        const id = randomUUID(),
          root = join(app.getPath('userData'), 'python-environments', id),
          parent = join(app.getPath('userData'), 'python-environments');
        await mkdir(parent, { recursive: true });
        return execute(
          id,
          base.program,
          ['-m', 'venv', root],
          parent,
          uiText('创建 Python 虚拟环境'),
          async () => {
            const program = join(root, 'Scripts', 'python.exe');
            if (!(await stat(program)).isFile()) throw Error(uiText('解释器没有生成'));
            await save([
              ...all(),
              {
                id,
                name: String(payload.name || uiText('Python 环境')).slice(0, 80),
                program,
                root,
                managed: true,
              },
            ]);
          },
        );
      }
      if (action === 'default') {
        if (payload.id && !all().some((item) => item.id === payload.id))
          throw Error(uiText('环境不存在'));
        return preferences.set({ pythonDefault: payload.id || null });
      }
      if (action === 'requirements') {
        const result = await dialog.showOpenDialog(window(), {
          title: uiText('选择依赖清单'),
          properties: ['openFile'],
          filters: [{ name: 'requirements.txt', extensions: ['txt'] }],
        });
        if (result.canceled) return null;
        const info = await stat(result.filePaths[0]);
        if (info.size > 64000) throw Error(uiText('依赖清单不能超过 64 KiB'));
        const text = await readFile(result.filePaths[0], 'utf8'),
          id = randomUUID();
        requirements.set(id, text);
        return { id, text };
      }
      if (action === 'install') {
        const entry = all().find((item) => item.id === payload.id);
        if (!entry?.managed) throw Error(uiText('依赖安装仅用于工作桌面创建的虚拟环境'));
        const text = requirements.get(payload.requirementsId);
        if (text === undefined) throw Error(uiText('请先选择并查看依赖清单'));
        const path = join(entry.root, `requirements-${randomUUID()}.txt`);
        await writeFile(path, text);
        return execute(
          entry.id,
          entry.program,
          ['-m', 'pip', 'install', '-r', path],
          entry.root,
          uiText('安装已确认的依赖'),
        );
      }
      if (action === 'packages') {
        const entry = all().find((item) => item.id === payload.id);
        if (!entry) throw Error(uiText('环境不存在'));
        return execute(
          entry.id,
          entry.program,
          ['-m', 'pip', 'list', '--format=json'],
          entry.root || app.getPath('userData'),
          uiText('查看已安装依赖'),
        );
      }
      if (action === 'stop') {
        const job = jobs.get(payload.id);
        if (job?.state === 'running' && job.child?.pid) {
          job.state = 'cancelled';
          if (process.platform === 'win32')
            spawn('taskkill.exe', ['/PID', String(job.child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
          else job.child.kill();
          publish(job);
        }
        return true;
      }
      throw Error(uiText('不支持的 Python 环境操作'));
    },
    close() {
      for (const job of jobs.values())
        if (job.state === 'running' && job.child?.pid) {
          if (process.platform === 'win32')
            spawn('taskkill.exe', ['/PID', String(job.child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
          else job.child.kill();
        }
    },
  };
}
