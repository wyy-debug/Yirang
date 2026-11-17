import { t as uiText } from '../platform/native-ui-language.mjs';
import { shell } from 'electron';
import { stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { isGeneratedImage, stageGeneratedImages } from './generated-images.mjs';

export function createOutputCoordinator({ call, emit, readTurn }) {
  let context = null,
    finishing = Promise.resolve();
  const active = new Map();
  const collecting = new Map(),
    finishes = new Set();
  const imageEvents = new Map(),
    imageIssues = new Map();
  const imageKey = (thread, turn) => `${thread}:${turn}`;
  const command = async (payload, owner) => {
    const result = await call('desktop_generated_files', payload, owner || payload.threadId);
    if (result.isError)
      throw Error(
        result.structuredContent?.error?.message || uiText('产出收回失败，文件仍保留在原目录。'),
      );
    return result._meta?.desktop;
  };
  const publish = (batch) => {
    const extra = imageIssues.get(batch.id) || [];
    if (extra.length)
      batch = { ...batch, state: 'partial', issues: [...(batch.issues || []), ...extra] };
    emit('outputs', batch);
    return batch;
  };
  async function stage(batch, turn) {
    const key = imageKey(batch.threadId, turn.id),
      items = [...(turn.items || []), ...(imageEvents.get(key)?.values() || [])];
    const result = await stageGeneratedImages(batch, items);
    imageIssues.set(batch.id, result.issues);
    if (!result.issues.length) imageEvents.delete(key);
    return result;
  }
  async function collect(batch, interrupted = false) {
    if (collecting.has(batch.id)) return collecting.get(batch.id);
    const job = command(
      {
        operation: 'collect',
        id: batch.id,
        interrupted,
        view: context?.view,
        viewWorkspaceId: context?.workspaceId,
      },
      batch.threadId,
    )
      .then(publish)
      .catch((error) => {
        emit('outputs', {
          ...batch,
          issues: [{ path: '', message: error.message }],
          state: 'partial',
        });
        throw error;
      })
      .finally(() => collecting.delete(batch.id));
    collecting.set(batch.id, job);
    return job;
  }
  return {
    rememberImage(threadId, turnId, item) {
      if (!isGeneratedImage(item) || typeof turnId !== 'string') return;
      const key = imageKey(threadId, turnId);
      if (!imageEvents.has(key)) imageEvents.set(key, new Map());
      const items = imageEvents.get(key);
      if (items.size < 64 || items.has(item.id)) items.set(item.id, item);
    },
    async settle() {
      await Promise.all([...finishes]);
      await finishing;
      await Promise.all([...collecting.values()]);
      if (active.size) throw Error(uiText('产出任务尚未结束，请保留窗口，待收回完成后再退出。'));
    },
    suspend() {
      active.clear();
    },
    async failedStart(batch) {
      if (active.get(batch.threadId)?.id === batch.id) active.delete(batch.threadId);
      await collect(batch, true);
    },
    busy() {
      return active.size > 0 || collecting.size > 0;
    },
    tracksBatch(batch) {
      return active.get(batch.threadId)?.id === batch.id;
    },
    async checkpoint(threadId) {
      if (!active.has(threadId)) throw Error(uiText('没有可收回的当前产出任务'));
      await finishing;
      const saved = await collect(active.get(threadId));
      active.set(threadId, saved);
      return {
        workspaceId: saved.workspaceId,
        sourceIds: saved.sourceIds,
        objectIds: [
          ...new Set(saved.files.filter((file) => file.objectId).map((file) => file.objectId)),
        ],
        issues: saved.issues,
        batchId: saved.id,
      };
    },
    async manage(operation, payload) {
      await finishing;
      await Promise.allSettled([...collecting.values()]);
      return command({ operation, ...payload });
    },
    async listFor(threadId) {
      const result = await command({ operation: 'list', threadId }, threadId);
      return result.batches || [];
    },
    setContext(value) {
      if (
        value &&
        typeof value.workspaceId === 'string' &&
        value.view &&
        ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value.view[key])) &&
        value.view.width > 0 &&
        value.view.height > 0
      )
        context = value;
      else context = null;
    },
    async begin(threadId, title, sourceIds, workspaceId) {
      await finishing;
      await Promise.allSettled([...collecting.values()]);
      const batch = await command({
        operation: 'begin',
        threadId,
        title,
        sourceIds,
        workspaceId,
        view: context?.view,
        viewWorkspaceId: context?.workspaceId,
      });
      active.set(threadId, batch);
      return publish(batch);
    },
    async bind(batch, turnId) {
      const saved = await command({ operation: 'bind', id: batch.id, turnId }, batch.threadId);
      if (active.get(batch.threadId)?.id === batch.id) active.set(batch.threadId, saved);
      return publish(saved);
    },
    completed(threadId, turn) {
      const job = (async () => {
        let batch = active.get(threadId);
        if (!batch || batch.threadId !== threadId || (batch.turnId && batch.turnId !== turn.id)) {
          batch = (await command({ operation: 'list', threadId })).batches.find(
            (item) => item.turnId === turn.id,
          );
        }
        if (!batch) return;
        if (!batch.turnId)
          batch = await command(
            { operation: 'bind', id: batch.id, turnId: turn.id },
            batch.threadId,
          );
        await stage(batch, turn);
        if (active.get(batch.threadId)?.id === batch.id) active.delete(batch.threadId);
        return await collect(batch, turn.status !== 'completed');
      })();
      finishes.add(job);
      void job.then(
        () => finishes.delete(job),
        () => finishes.delete(job),
      );
      finishing = Promise.allSettled([...finishes]);
      return job;
    },
    async restore(threadId, history) {
      active.delete(threadId);
      const { batches } = await command({ operation: 'list', threadId });
      const recovery = new Map();
      for (let batch of [...batches].reverse()) {
        const turn = history.find(
          (turn) =>
            turn.id === batch.turnId ||
            (!batch.turnId && JSON.stringify(turn.items || []).includes(`产出批次 ${batch.id}`)),
        );
        if (turn && !batch.turnId)
          batch = await command(
            { operation: 'bind', id: batch.id, turnId: turn.id },
            batch.threadId,
          );
        if (
          turn &&
          !['inProgress', 'in_progress', 'running'].includes(turn.status) &&
          (turn.items || []).some(isGeneratedImage)
        ) {
          const images = await stage(batch, turn),
            latest = batches.find((other) => other.directory === batch.directory) || batch;
          if (
            images.paths.some(
              (path) => !batch.files.some((file) => file.path === path && file.objectId),
            )
          )
            recovery.set(latest.id, latest);
        }
        if (batch.state === 'running' && turn?.status === 'completed')
          await collect(batch).catch(() => {});
        else if (
          batch.state === 'running' &&
          turn &&
          !['inProgress', 'in_progress', 'running'].includes(turn.status)
        )
          await collect(batch, true).catch(() => {});
        else {
          if (batch.state === 'running' && turn) active.set(threadId, batch);
          publish(batch);
        }
      }
      for (const batch of recovery.values())
        if (![...active.values()].some((item) => item.directory === batch.directory))
          await collect(batch, batch.state === 'interrupted').catch(() => {});
    },
    async retry(id, runningTurn) {
      const batch = await command({ operation: 'get', id });
      if (
        batch.turnId === runningTurn ||
        [...active.values()].some((item) => item.id === id || item.directory === batch.directory)
      )
        throw Error(uiText('这个任务还在写文件，请先等待完成或停止。'));
      if (batch.turnId && readTurn) {
        const turn = await readTurn(batch.threadId, batch.turnId);
        if (turn) await stage(batch, turn);
      }
      return collect(batch, batch.state === 'running' || batch.state === 'interrupted');
    },
    async reveal(id, objectId) {
      const { directory } = await command({
        operation: 'location',
        id,
        ...(objectId ? { objectId } : {}),
      });
      if (!(await stat(directory).catch(() => null))?.isDirectory())
        throw Error(uiText('产出目录已被移动。'));
      const error = await shell.openPath(directory);
      if (error) throw Error(error);
      return true;
    },
  };
}
