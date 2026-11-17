import { t } from '../../../packages/components/ui-language.js';
import { createVoiceSelectionUI } from './voice-selection-ui.js';
const voiceError = (error) =>
  String(error?.message || error).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    '',
  );
export function registerVoiceUI({ state, status }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'voice-button';
  button.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-4 0h8"/></svg>';
  button.title = t('连续语音对话');
  button.setAttribute('aria-label', '开启连续语音');
  document.querySelector('.composer-tools').insertBefore(button, document.getElementById('stop'));
  const bar = document.createElement('div');
  bar.className = 'voice-status';
  bar.hidden = true;
  document.querySelector('.composer').prepend(bar);
  const selectionUI = createVoiceSelectionUI(bar);
  const transcript = document.createElement('details');
  transcript.className = 'voice-agents';
  transcript.hidden = true;
  transcript.open = true;
  transcript.innerHTML = '<summary>语音交流</summary><div></div>';
  document.querySelector('.composer').before(transcript);
  const agents = document.createElement('details');
  agents.className = 'voice-agents';
  agents.hidden = true;
  agents.innerHTML = '<summary>并行工作</summary><div></div>';
  document.querySelector('.composer').before(agents);
  const style = document.createElement('style');
  style.textContent = `.voice-button{border:0;border-radius:50%;width:30px;height:30px;background:#f2f5fa;cursor:pointer;font-size:16px}.voice-button[aria-pressed=true]{background:#fee7e7;color:#b42318}.voice-status{font-size:12px;padding:8px;color:#526782;background:#f2f6ff;border-radius:10px;margin-bottom:8px}.voice-agents{margin:6px 12px;padding:8px 12px;border:1px solid #e8edf5;border-radius:12px;font-size:12px}.voice-agents>div{max-height:150px;overflow:auto}.voice-agent{padding:7px 0;border-top:1px solid #eef1f5}.voice-agent small{display:block;color:#738095}`;
  document.head.append(style);
  const label = document.createElement('span');
  button.append(label);
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.hidden = true;
  document.body.append(audio);
  const playback = document.createElement('button');
  playback.type = 'button';
  playback.textContent = '播放 AI 语音';
  playback.hidden = true;
  bar.after(playback);
  playback.onclick = () =>
    void audio
      .play()
      .then(() => {
        playback.hidden = true;
      })
      .catch(() => {
        status.textContent = '声音播放被阻止，请检查系统输出设备后重试';
      });
  let audioOutput = true;
  try {
    audioOutput = localStorage.getItem('yirang:voice-output') !== 'text';
  } catch {}
  let pc = null,
    stream = null,
    owner = null,
    starting = false,
    ending = false,
    timer = null,
    serial = 0;
  const tasks = new Map(),
    seen = new Set(),
    spoken = [];
  function paint() {
    const supported = (document.documentElement.dataset.cliProvider || 'codex') === 'codex';
    button.disabled = !supported && !owner;
    button.setAttribute('aria-pressed', String(!!owner));
    button.setAttribute('aria-label', owner ? '结束语音' : '开启语音对话');
    label.textContent = owner ? '结束语音' : starting ? '取消连接' : '语音';
    button.title = !supported
      ? '语音对话目前需要 Codex CLI'
      : owner
        ? '结束语音（后台任务继续）'
        : '点击开始说话，AI ' + (audioOutput ? '用声音回复' : '用文字回复');
    bar.hidden = !owner && !starting;
  }
  function release() {
    selectionUI.stop();
    clearTimeout(timer);
    const connection = pc;
    pc = null;
    connection?.close();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    audio.pause();
    audio.srcObject = null;
    playback.hidden = true;
    owner = null;
    starting = false;
    paint();
  }
  async function end() {
    if (ending) return;
    ending = true;
    serial++;
    release();
    try {
      await window.desktop.voice('stop');
    } catch (e) {
      if (!status.dataset.voiceNotice) {
        status.dataset.voiceNotice = 'true';
        status.textContent = voiceError(e);
      }
    } finally {
      ending = false;
    }
  }
  function fail(message) {
    status.dataset.voiceNotice = 'true';
    status.textContent = voiceError(message);
    void end();
  }
  button.onclick = async () => {
    if (owner || starting) {
      await end();
      return;
    }
    if (ending) return;
    starting = true;
    const attempt = ++serial;
    delete status.dataset.voiceNotice;
    status.textContent = '';
    bar.textContent = t('正在连接语音…');
    paint();
    timer = setTimeout(() => fail(t('语音连接超时，请检查 CLI 账号和网络')), 90000);
    try {
      const prepared = await window.desktop.voice('prepare');
      if (attempt !== serial) {
        await window.desktop.voice('stop');
        return;
      }
      owner = prepared.threadId;
      paint();
      const captured = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (attempt !== serial) {
        captured.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = captured;
      pc = new RTCPeerConnection();
      const connection = pc;
      pc.ontrack = (event) => {
        if (pc !== connection) return;
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void audio.play().catch(() => {
          if (pc === connection) {
            playback.hidden = false;
            status.textContent = '点击“播放 AI 语音”启用声音';
          }
        });
      };
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      pc.createDataChannel('oai-events');
      pc.onconnectionstatechange = () => {
        if (pc !== connection) return;
        if (['failed', 'closed'].includes(pc.connectionState)) fail('语音连接已中断');
        if (pc.connectionState === 'connected') {
          clearTimeout(timer);
          bar.textContent = t('麦克风已开启 · 可以开始说话');
        }
      };
      await connection.setLocalDescription(await connection.createOffer());
      if (attempt !== serial) return;
      clearTimeout(timer);
      timer = setTimeout(() => fail(t('语音连接超时，请检查 CLI 账号和网络')), 30000);
      const connected = await window.desktop.voice('start', {
        threadId: owner,
        sdp: pc.localDescription.sdp,
        outputModality: audioOutput ? 'audio' : 'text',
      });
      if (attempt !== serial) return;
      starting = false;
      if (connected.managed) selectionUI.start(owner);
      paint();
    } catch (e) {
      if (attempt === serial)
        fail(
          e.name === 'NotAllowedError'
            ? t('麦克风权限被拒绝，请在系统设置中允许一壤使用麦克风')
            : e.name === 'NotFoundError'
              ? t('未找到可用麦克风，请连接后重试')
              : voiceError(e),
        );
    }
  };
  function renderTasks() {
    const list = agents.querySelector('div');
    list.replaceChildren();
    let count = 0;
    for (const [id, t] of tasks) {
      if (t.owner !== state().threadId) continue;
      count++;
      const row = document.createElement('div');
      row.className = 'voice-agent';
      const name = document.createElement('div');
      name.textContent = t.title || '子任务 ' + id.slice(0, 8);
      const detail = document.createElement('small');
      detail.textContent =
        {
          pendingInit: '准备中',
          queued: '已排队',
          scheduled: '等待开始',
          waiting: '等待中',
          revising: '修订中',
          review: '待验收',
          paused: '已暂停',
          attention: '需要你',
          cancelled: '已取消',
          running: '执行中',
          completed: '已完成',
          errored: '失败',
          interrupted: '已停止',
          shutdown: '已结束',
          notFound: '不可用',
        }[t.status] || '等待状态';
      row.append(name, detail);
      list.append(row);
    }
    agents.hidden = !count;
    agents.querySelector('summary').textContent = t('后台工作 · {0}', { 0: count });
  }
  function renderSpeech() {
    const list = transcript.querySelector('div');
    list.replaceChildren();
    const lines = spoken.filter((s) => s.threadId === state().threadId);
    transcript.hidden = !lines.length;
    for (const s of lines) {
      const row = document.createElement('div');
      row.className = 'voice-agent';
      row.textContent = (s.role === 'user' ? '我：' : 'AI：') + s.text;
      list.append(row);
    }
    list.scrollTop = list.scrollHeight;
  }
  window.desktop.onEvent(({ type, payload: p }) => {
    if (type === 'voice' && p.threadId === owner && p.method === 'selection-status')
      selectionUI.status(p);
    if (type === 'provider') queueMicrotask(paint);
    if (type === 'thread-switched') {
      if (owner && p.threadId !== owner) void end();
      queueMicrotask(() => {
        renderTasks();
        renderSpeech();
      });
    }
    if (type === 'closing' && p) void end();
    if (type === 'connection-error' && p.service === 'cli' && owner)
      fail(p.message || t('语音连接已中断'));
    if (type === 'agent-work') {
      const item = p.item;
      for (const id of item.receiverThreadIds || []) {
        const old = tasks.get(id) || {};
        tasks.set(id, {
          ...old,
          owner: p.threadId,
          title: item.tool === 'spawnAgent' ? item.prompt?.slice(0, 100) : old.title,
          status: item.agentsStates?.[id]?.status || old.status || 'pendingInit',
        });
      }
      while (tasks.size > 100) tasks.delete(tasks.keys().next().value);
      renderTasks();
    }
    if (type !== 'voice' || p.threadId !== owner) return;
    if (p.method === 'work-status') {
      for (const item of p.tasks)
        tasks.set(item.id, { owner, title: item.title, status: item.state });
      renderTasks();
    }
    if (p.method === 'work-status-error') status.textContent = t(p.message);
    if (p.method === 'sdp' && pc)
      void pc.setRemoteDescription({ type: 'answer', sdp: p.sdp }).catch((e) => fail(e.message));
    if (p.method === 'error') fail(p.message || '实时语音不可用');
    if (p.method === 'closed') {
      if (p.reason && !ending) {
        status.dataset.voiceNotice = 'true';
        status.textContent = t(p.reason);
      }
      serial++;
      release();
    }
    if (
      p.method === 'item/completed' &&
      p.item?.type === 'transcriptSegment' &&
      !seen.has(p.item.id)
    ) {
      bar.textContent = t('正在聆听 · 可以随时补充或打断');
      seen.add(p.item.id);
      if (seen.size > 300) seen.delete(seen.values().next().value);
      spoken.push({ threadId: p.threadId, role: p.item.role, text: p.item.text });
      if (spoken.length > 100) spoken.shift();
      renderSpeech();
    }
    if (p.method === 'transcript/delta' && p.role === 'user')
      bar.textContent = t('聆听中… ') + String(p.delta || '').slice(-90);
  });
  window.addEventListener('pagehide', () => {
    release();
    void window.desktop.voice('stop').catch(() => {});
  });
  window.addEventListener('desktop-settings-open', (event) => {
    const { row, button: make } = event.detail;
    const output = document.createElement('select');
    output.setAttribute('aria-label', t('语音回复方式'));
    for (const [value, text] of [
      ['audio', '语音回复'],
      ['text', '只显示文字'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = t(text);
      output.append(option);
    }
    output.value = audioOutput ? 'audio' : 'text';
    output.disabled = !!owner || starting;
    output.onchange = () => {
      try {
        localStorage.setItem('yirang:voice-output', output.value);
        audioOutput = output.value === 'audio';
        paint();
      } catch {
        output.value = audioOutput ? 'audio' : 'text';
        status.textContent = t('未能保存语音设置');
      }
    };
    row(
      'general',
      '语音对话',
      '点击输入框下方的「语音」即可说话，再点「结束语音」退出。回复方式在下次开始语音时生效，需要 Codex 账号支持语音。',
      [
        output,
        make(owner || starting ? '结束语音' : '开始语音', () => {
          event.detail.modal.close();
          button.click();
        }),
      ],
    );
  });
  const voiceStyle = document.createElement('style');
  voiceStyle.textContent =
    '.composer-tools .voice-button{display:inline-flex;align-items:center;gap:5px;width:auto;min-width:58px;height:30px;padding:0 9px;border-radius:8px;font-size:12px}.voice-button:disabled{opacity:.45;cursor:default}.voice-button span{white-space:nowrap}';
  document.head.append(voiceStyle);
  paint();
  // Written corrections during voice use the same realtime conversation rather
  // than sitting behind a long-running backing turn in the normal send queue.
  document.getElementById('send').addEventListener(
    'click',
    async (event) => {
      if (!owner) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const input = document.getElementById('input'),
        text = input.value.trim();
      if (!text || starting) return;
      try {
        await window.desktop.send(text);
        if (input.value.trim() === text) {
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        status.textContent = '已补充到语音会话';
      } catch (e) {
        status.textContent = e.message;
      }
    },
    true,
  );
}
