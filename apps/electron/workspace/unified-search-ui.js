export function registerUnifiedSearch({ frame, status, showHistory, isRunning }) {
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (text, fn) => {
    const b = el('button', text);
    b.type = 'button';
    b.onclick = () =>
      void Promise.resolve()
        .then(fn)
        .catch((e) => (progress.textContent = e.message));
    return b;
  };
  const field = (text, input) => {
    const label = el('label'),
      caption = el('span', text);
    label.append(caption, input);
    return label;
  };
  const input = (type, placeholder) => {
    const n = el('input');
    n.type = type;
    n.placeholder = placeholder || '';
    return n;
  };
  const modal = el('dialog', null, 'desktop-settings unified-search');
  document.body.append(modal);
  const progress = el('p', null, 'retrieval-progress');
  progress.setAttribute('role', 'status');
  const query = input('search', '搜索桌面材料，或描述你要找的内容…');
  query.maxLength = 200;
  query.setAttribute('aria-label', '搜索桌面材料');
  const region = el('select');
  region.setAttribute('aria-label', '搜索区域');
  region.add(new Option('整个工作区', ''));
  const mode = el('select');
  mode.setAttribute('aria-label', '检索方式');
  mode.add(new Option('混合检索', 'hybrid'));
  mode.add(new Option('仅关键词', 'keyword'));
  const history = input('checkbox'),
    scope = el('select');
  scope.add(new Option('当前对话', 'current'));
  scope.add(new Option('全部 Codex 对话', 'all'));
  scope.disabled = true;
  history.onchange = () => (scope.disabled = !history.checked);
  const results = el('div', null, 'retrieval-results'),
    indexLine = el('p', null, 'retrieval-index'),
    indexDetails = el('details', null, 'retrieval-issues'),
    issueSummary = el('summary', '正文提取提示'),
    issueList = el('div');
  indexDetails.append(issueSummary, issueList);
  indexDetails.hidden = true;
  let id = null,
    workspaceId = null,
    configWorkspace = null,
    poll = null,
    refreshing = false,
    openGeneration = 0,
    startGeneration = 0;
  const title = el('h2', '查找桌面材料'),
    header = el('header');
  header.append(
    title,
    button('关闭', () => modal.close()),
  );
  async function search() {
    const generation = ++startGeneration;
    id = null;
    results.replaceChildren();
    progress.textContent = '正在检索…';
    const job = await window.desktop.search('start', {
      query: query.value,
      workspaceId,
      regionId: region.value || undefined,
      mode: mode.value,
      includeHistory: history.checked,
      scope: scope.value,
    });
    if (generation === startGeneration) id = job.id;
  }
  const bar = el('div', null, 'retrieval-bar');
  bar.append(
    query,
    button('搜索', search),
    button('停止', async () => {
      ++startGeneration;
      id = null;
      await window.desktop.search('cancel');
      progress.textContent = '已停止搜索';
    }),
  );
  query.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void search().catch((e) => (progress.textContent = e.message));
    }
  };
  const filters = el('div', null, 'retrieval-filters');
  filters.append(region, mode, field('同时搜索对话历史', history), scope);
  const settings = el('details', null, 'retrieval-settings');
  settings.append(el('summary', '向量服务与索引'));
  const endpoint = input('url', 'https://…/v1/embeddings'),
    model = input('text', '向量模型名称'),
    dimensions = input('number', '默认维度'),
    apiKey = input('password', '留空保留已保存密钥'),
    enabled = input('checkbox'),
    paused = input('checkbox'),
    clearKey = input('checkbox');
  dimensions.min = '1';
  dimensions.max = '8192';
  apiKey.autocomplete = 'new-password';
  const hint = el(
    'p',
    '本地使用 SQLite FTS5 + sqlite-vec。启用后，将此工作区非私有材料的文字片段和搜索词发送到下方商业向量 API；对话继续使用现有 CLI。API 需单独配置，未启用时仍可关键词检索。',
  );
  settings.append(
    hint,
    field('API 完整地址', endpoint),
    field('向量模型', model),
    field('维度（可选）', dimensions),
    field('API 密钥', apiKey),
    field('为当前工作区启用语义检索', enabled),
    field('暂停后台索引与向量请求', paused),
    field('清除已保存密钥', clearKey),
  );
  const save = button('保存向量设置', async () => {
    if (!configWorkspace || configWorkspace !== workspaceId)
      throw Error('正在读取当前工作区配置，请稍候');
    save.disabled = true;
    try {
      const cfg = await window.desktop.search('configure', {
        workspaceId: configWorkspace,
        endpoint: endpoint.value,
        model: model.value,
        dimensions: dimensions.value || null,
        apiKey: apiKey.value,
        enabled: enabled.checked,
        paused: paused.checked,
        clearKey: clearKey.checked,
      });
      apiKey.value = '';
      clearKey.checked = false;
      applyConfig(cfg);
      progress.textContent = '配置已保存。索引在后台按增量更新。';
      await refresh();
    } finally {
      save.disabled = false;
    }
  });
  const actions = el('div', null, 'settings-actions');
  actions.append(
    save,
    button('重建当前工作区索引', async () => {
      await window.desktop.search('rebuild', { workspaceId });
      progress.textContent = '已安排重建索引，原文件保持不变。';
      await refresh();
    }),
  );
  settings.append(actions);
  modal.append(header, bar, filters, indexLine, progress, results, indexDetails, settings);
  function applyConfig(cfg) {
    configWorkspace = cfg.workspaceId;
    endpoint.value = cfg.endpoint;
    model.value = cfg.model;
    dimensions.value = cfg.dimensions || '';
    enabled.checked = cfg.enabled;
    paused.checked = cfg.paused;
    apiKey.placeholder = cfg.hasKey ? '已保存 · 留空保留' : '商业向量 API 密钥';
    if (cfg.error) progress.textContent = cfg.error;
  }
  function displayStatus(s) {
    indexLine.textContent = `${s.workspaceName || title.dataset.workspace || '当前工作区'} · 已索引 ${s.indexed}/${s.total} 份 · ${s.chunks} 个片段 · ${s.embedded} 个向量${s.pending ? ' · 待处理 ' + s.pending + ' 份' : ''}${s.paused ? ' · 已暂停' : s.initializing ? ' · 建立初始索引中' : ''}`;
    indexLine.title = s.error || '';
    indexDetails.hidden = !s.issues?.length && !s.error;
    issueList.replaceChildren();
    if (s.error) issueList.append(el('p', s.error));
    for (const issue of s.issues || []) issueList.append(el('p', `${issue.title}：${issue.note}`));
  }
  async function refresh() {
    if (refreshing || !modal.open) return;
    refreshing = true;
    const generation = openGeneration;
    try {
      const s = await window.desktop.search('status');
      if (!modal.open || generation !== openGeneration) return;
      const changed = workspaceId && workspaceId !== s.workspaceId;
      if (changed) {
        id = null;
        results.replaceChildren();
        await window.desktop.search('cancel');
        progress.textContent = '工作区已切换，请重新搜索';
      }
      workspaceId = s.workspaceId;
      title.dataset.workspace = s.workspaceName;
      displayStatus(s);
      const value = region.value;
      region.replaceChildren(new Option('整个工作区', ''));
      for (const r of s.regions || []) region.add(new Option(r.name || '未命名区域', r.id));
      if ([...region.options].some((o) => o.value === value)) region.value = value;
      if (configWorkspace !== workspaceId) {
        const cfg = await window.desktop.search('config');
        if (modal.open && generation === openGeneration) applyConfig(cfg);
      }
    } catch (e) {
      if (modal.open) progress.textContent = e.message;
    } finally {
      refreshing = false;
    }
  }
  function open() {
    if (!modal.open) {
      modal.showModal();
      ++openGeneration;
      void refresh();
      poll = setInterval(() => void refresh(), 5000);
    }
    query.focus();
  }
  modal.addEventListener('close', () => {
    ++openGeneration;
    ++startGeneration;
    id = null;
    clearInterval(poll);
    apiKey.value = '';
    void window.desktop.search('cancel');
  });
  const entry = button('桌面搜索', open);
  entry.title = '查找桌面材料 · Ctrl+Shift+F';
  document.querySelector('.chat-utilities').append(entry);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      open();
    }
  });
  window.addEventListener('message', (e) => {
    if (e.source === frame.contentWindow && e.data?.type === 'ai-desktop:open-search') open();
  });
  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'search-locate') {
      frame.contentWindow?.postMessage({ type: 'ai-desktop:locate-outputs', ...payload }, '*');
      return;
    }
    if (type !== 'search-progress' || payload.id !== id) return;
    progress.textContent =
      (payload.error || payload.phase) +
      (payload.issues?.length ? ` · ${payload.issues.length} 项未能读取` : '');
    progress.title = (payload.issues || [])
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
    if (payload.indexStatus) displayStatus(payload.indexStatus);
    if (payload.replace) results.replaceChildren();
    for (const hit of payload.hits || []) {
      const row = el('article', null, 'search-hit'),
        heading = el('strong', `${hit.title} · ${hit.location}`),
        excerpt = el('p', hit.text),
        meta = el(
          'small',
          hit.kind === 'chat'
            ? '历史对话片段'
            : `v${hit.revision} · ${(hit.matchedBy || []).map((v) => (v === 'semantic' ? '语义' : '关键词')).join(' + ')}`,
        );
      const openHit = async (openObject) => {
        if (hit.kind === 'chat') {
          if (isRunning()) throw Error('请先等待当前任务完成，再查看历史回合');
          if (!hit.archived) await window.desktop.switchThread(hit.threadId);
          const context = await window.desktop.search('context', { id: hit.id });
          showHistory(context.turn);
          status.textContent = '正在查看搜索命中的历史回合';
        } else await window.desktop.search('locate', { hitId: hit.hitId, openObject });
        modal.close();
      };
      const controls = el('div', null, 'retrieval-hit-actions');
      controls.append(
        button(hit.kind === 'chat' ? '查看对话' : '打开匹配位置', () => openHit(true)),
      );
      if (hit.kind !== 'chat') controls.append(button('定位画布', () => openHit(false)));
      row.append(heading, meta, excerpt, controls);
      results.append(row);
    }
    if (payload.done && !payload.error && !results.childElementCount)
      results.append(el('p', '暂无命中。可以换一种描述；索引未完成的材料会在后台继续加入。'));
  });
}
