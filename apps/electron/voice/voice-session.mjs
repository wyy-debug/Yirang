// Codex owns speech segmentation, handoffs and delegation. The host must not
// re-submit transcript notifications as turns (that would execute work twice).
import { randomUUID } from 'node:crypto';
import {
  createVoiceSelection,
  voiceSelectionSnapshot,
} from './voice-selection.mjs';

export function createVoiceSession({ request, emit, prepare, outputs, isRunning, managed }) {
  let current = null,
    preparing = false,
    generation = 0;
  const selectionSync = createVoiceSelection({
    request,
    emit,
    validate: (snapshot, workspaceId) => managed.validateSelection(snapshot, workspaceId),
    isCurrent: (s) => !!s && current === s,
  });
  function refreshWork() {
    const s = current;
    if (!s?.managed || !s.started || s.stopping || s.progressTimer) return;
    if (s.refreshing) {
      s.progressDirty = true;
      return;
    }
    s.progressTimer = setTimeout(async () => {
      s.progressTimer = null;
      if (current !== s || s.stopping || s.refreshing) return;
      s.refreshing = true;
      try {
        const rows = await managed.progress(s),
          signature = JSON.stringify(rows);
        if (current !== s || s.stopping || !rows.length || signature === s.progressSignature)
          return;
        emit('voice', { method: 'work-status', threadId: s.threadId, tasks: rows });
        // Internal task revisions still refresh the UI, but must not repeatedly
        // prompt the voice model to speak when nothing meaningful has changed.
        const speechSignature = JSON.stringify(rows.map(({ revision, ...row }) => row));
        if (speechSignature === s.progressSpeechSignature) {
          s.progressSignature = signature;
          return;
        }
        await request('thread/realtime/appendText', {
          threadId: s.threadId,
          role: 'developer',
          text: JSON.stringify({ type: 'yirang.work-status', tasks: rows,
            authorizesExecution: false }),
        });
        s.progressSpeechSignature = speechSignature;
        s.progressSignature = signature;
      } catch (error) {
        if (current === s && !s.stopping)
          emit('voice', {
            method: 'work-status-error',
            threadId: s.threadId,
            message: '工作状态播报暂不可用，请在工作面板查看',
          });
      } finally {
        s.refreshing = false;
        if (s.progressDirty) {
          s.progressDirty = false;
          refreshWork();
        }
      }
    }, 500);
    s.progressTimer.unref?.();
  }
  async function finish(s) {
    if (s.finishing) return s.finishing;
    if (current !== s || !s.stopping || isRunning(s.threadId)) return;
    s.finishing = (async () => {
      try {
        await s.collection.catch(() => {});
        if (!s.managed) {
          if (s.lastTurn) await outputs.completed(s.threadId, s.lastTurn);
          else await outputs.failedStart(s.batch);
        }
      } finally {
        if (current === s) current = null;
      }
    })();
    return s.finishing;
  }
  async function stop() {
    generation++;
    const s = current;
    if (!s) return;
    if (s.stopPromise) return s.stopPromise;
    s.stopping = true;
    clearTimeout(s.progressTimer);
    s.stopPromise = (async () => {
      try {
        await s.starting?.catch(() => {});
        if (s.started) await request('thread/realtime/stop', { threadId: s.threadId });
      } finally {
        emit('voice', { method: 'closed', threadId: s.threadId });
        await finish(s);
      }
    })();
    return s.stopPromise;
  }
  return {
    owns: (id) => current?.threadId === id,
    active: () => !!current || preparing,
    connecting: () => preparing,
    selection: (payload) => selectionSync.update(current, payload),
    async attached(blocks) {
      const s = current;
      if (!s?.managed || s.stopping) return;
      if (!s.started) {
        const next = voiceSelectionSnapshot(blocks, s.workspaceId);
        await managed.validateSelection(next, s.workspaceId);
        if (current === s && !s.stopping) s.voiceSelection = next;
        return;
      }
      const id = randomUUID(),
        threadId = s.threadId;
      emit('voice', { method: 'selection-override', threadId });
      await selectionSync.update(s, { threadId, id, phase: 'pending' });
      await selectionSync.update(s, { threadId, id, phase: 'ready', blocks });
    },
    disconnected() {
      generation++;
      const s = current;
      if (!s) return;
      s.stopping = true;
      clearTimeout(s.progressTimer);
      emit('voice', { method: 'closed', threadId: s.threadId, reason: '语音连接已中断' });
      void finish(s).catch((e) => emit('notice', e.message));
    },
    async prepare() {
      if (current || preparing) throw Error('已有语音会话，请先结束语音');
      preparing = true;
      const attempt = ++generation;
      try {
        const context = await prepare(() => generation !== attempt);
        if (generation !== attempt) throw Error('语音连接已取消');
        const batch = context.managed
          ? null
          : await outputs.begin(
              context.threadId,
              '语音工作 ' + new Date().toLocaleString('sv').replaceAll(':', '-'),
              context.sourceIds.slice(0, 10),
            );
        current = {
          ...context,
          batch,
          collection: Promise.resolve(),
          selectionReady: false,
          selectionVersion: 0,
          selectionPublished: 0,
          started: false,
          stopping: false,
        };
        return { threadId: context.threadId };
      } finally {
        preparing = false;
      }
    },
    async start({ threadId, sdp, outputModality = 'audio' }) {
      const s = current;
      if (!s || s.threadId !== threadId || s.stopping || s.started) throw Error('语音会话已失效');
      if (typeof sdp !== 'string' || sdp.length > 100000) throw Error('语音连接参数不正确');
      if (!['audio', 'text'].includes(outputModality)) throw Error('语音输出方式不正确');
      s.started = true;
      const guide = JSON.stringify({
        type: 'yirang.voice-context', platform: process.platform,
        mode: s.managed ? 'managed' : 'conversation',
        selection: s.managed ? s.voiceSelection : s.references,
        output: s.batch ? { batchId: s.batch.id, directory: s.batch.directory } : null,
        workTool: s.managed ? 'desktop_voice_work' : null,
      });
      emit('turn-context', { threadId, context: guide });
      // AVAS requires quicksilver=v2, emitted by Codex realtime V3.
      // The WebRTC default is V1 and is rejected with invalid_quicksilver_alpha_header.
      try {
        s.starting = request('thread/realtime/start', {
          threadId,
          version: 'v3',
          outputModality,
          transport: { type: 'webrtc', sdp },
          prompt: guide,
          realtimeStartInstructions: guide,
          includeStartupContext: true,
          clientManagedHandoffs: false,
          flushTranscriptTailOnSessionEnd: false,
        });
        await s.starting;
        if (s.managed && !s.stopping && s.selectionVersion === 0) {
          s.selectionReady = true;
          selectionSync.status(s, 'ready');
        }
        return { threadId, managed: !!s.managed };
      } catch (error) {
        emit('voice', { method: 'error', threadId, message: '实时语音连接失败：' + error.message });
        await stop().catch(() => {});
        throw Error('实时语音连接失败：' + error.message);
      }
    },
    async text(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 50000)
        throw Error('消息为空或过长');
      const s = current;
      if (!s || s.stopping || !s.started) throw Error('语音未连接');
      await request('thread/realtime/appendText', { threadId: s.threadId, text });
      return { threadId: s.threadId, voice: true };
    },
    async work(payload) {
      const s = current;
      if (!s?.managed || s.stopping || !s.started || payload?.threadId !== s.threadId)
        throw Error('语音会话已结束，请重新开启');
      const result = await managed.handle(s, payload);
      refreshWork();
      return result;
    },
    refreshWork,
    notification(method, p) {
      const s = current;
      if (!method?.startsWith('thread/realtime/') || p.threadId !== s?.threadId) return false;
      emit('voice', { method: method.slice('thread/realtime/'.length), ...p });
      if (method.endsWith('/closed') || method.endsWith('/error')) {
        s.stopping = true;
        clearTimeout(s.progressTimer);
        void finish(s).catch((e) => emit('notice', e.message));
      }
      return true;
    },
    async completed(id, turn) {
      const s = current;
      if (s?.threadId !== id) return false;
      s.lastTurn = turn;
      s.collection = s.collection
        .catch(() => {})
        .then(() => (s.managed ? undefined : outputs.checkpoint(id)));
      await s.collection.catch((e) => emit('notice', '语音产出暂未收回：' + e.message));
      await finish(s);
      return true;
    },
    stop,
  };
}
