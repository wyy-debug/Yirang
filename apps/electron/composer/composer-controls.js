import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { bindUiLabel } from '../ui/ui-labels.js';
import { subscribeUiLanguage, getUiLanguage } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
const effortNames = () => ({
  none: uiText('无'),
  minimal: uiText('最低'),
  low: uiText('低'),
  medium: uiText('中'),
  high: uiText('高'),
  xhigh: uiText('极高'),
  max: uiText('最高'),
  ultra: uiText('超高'),
});
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const remaining = (window) =>
  finite(window?.usedPercent) ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
const percent = (value) =>
  new Intl.NumberFormat(getUiLanguage(), { maximumFractionDigits: 1 }).format(value) + '%';
const duration = (value, fallback) =>
  !finite(value) || value <= 0
    ? fallback
    : value % 1440 === 0
      ? uiText('{0} 天', { 0: value / 1440 })
      : value % 60 === 0
        ? uiText('{0} 小时', { 0: value / 60 })
        : uiText('{0} 分钟', { 0: value });
const resetTime = (value) =>
  !finite(value)
    ? uiText('重置时间未提供')
    : value * 1000 <= Date.now()
      ? uiText('已到重置时间，等待更新')
      : uiText('{0} 重置', {
          0: new Date(value * 1000).toLocaleString(getUiLanguage(), {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        });
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// Account limits and conversation tokens are separate measures. Missing data is
// never converted to zero, and responses from a previous connection are ignored.
export function createComposerControls({ state }) {
  let catalog = [],
    preferences = {},
    runtime = null,
    modelsLoading = false,
    account = null,
    buckets = {},
    resetCredits = null,
    usage = null;
  let provider = 'codex';
  let connected = false,
    epoch = 0,
    revision = 0,
    loading = false,
    saving = false,
    loadedAt = 0,
    lastAttempt = 0,
    error = '',
    modelError = '',
    active = '',
    modelView = 'effort';
  const row = element('div', undefined, 'composer-preferences');
  const modelButton = element('button', uiText('CLI 默认模型 ▾'), 'composer-model');
  modelButton.type = 'button';
  modelButton.setAttribute('aria-haspopup', 'dialog');
  modelButton.setAttribute('aria-expanded', 'false');
  bindUiLabel(modelButton, 'title', '选择模型与思考强度');
  row.append(modelButton);
  document.querySelector('.composer-tools').prepend(row);
  const popup = element('dialog', undefined, 'composer-popover');
  bindUiLabel(popup, 'aria-label', '对话选项');
  document.body.append(popup);
  const header = element('header'),
    title = element('strong'),
    close = element('button', '×');
  close.type = 'button';
  bindUiLabel(close, 'aria-label', '关闭');
  close.onclick = () => popup.close();
  const body = element('div', undefined, 'composer-popover-body');
  header.append(title, close);
  popup.append(header, body);
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active === 'model' && modelView === 'models') {
      event.preventDefault();
      event.stopPropagation();
      modelView = 'effort';
      renderModel();
      body.querySelector('.effort-model')?.focus();
    }
  });
  popup.addEventListener('close', () => {
    active = '';
    modelView = 'effort';
    modelButton.setAttribute('aria-expanded', 'false');
  });
  popup.addEventListener('click', (event) => {
    if (event.target !== popup) return;
    const r = popup.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      popup.close();
  });
  function position() {
    if (!popup.open) return;
    const anchor = modelButton.getBoundingClientRect();
    popup.style.width = `${Math.min(active !== 'quota' ? 280 : 350, window.innerWidth - 24)}px`;
    const left = anchor.left;
    popup.style.left = `${Math.max(12, Math.min(left, window.innerWidth - popup.offsetWidth - 12))}px`;
    const above = anchor.top - popup.offsetHeight - 8;
    popup.style.top = `${above >= 12 ? above : Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - popup.offsetHeight - 12))}px`;
  }
  window.addEventListener('resize', position);
  new ResizeObserver(position).observe(popup);
  function show(kind) {
    if (active !== kind) modelView = 'effort';
    active = kind;
    popup.classList.toggle('model-compact', kind !== 'quota');
    title.textContent = uiText(kind === 'quota' ? 'Codex 额度' : '模型与思考强度');
    popup.setAttribute('aria-label', title.textContent);
    render();
    if (!popup.open) popup.showModal();
    position();
    modelButton.setAttribute('aria-expanded', 'true');
  }
  function label() {
    const id = preferences.model || runtime?.config?.model,
      model = catalog.find((item) => item.model === id),
      effort = preferences.model ? preferences.effort : runtime?.config?.effort;
    const name = model?.displayName || id || uiText('默认模型'),
      strength = effortNames()[effort || model?.defaultReasoningEffort];
    modelButton.replaceChildren(
      element('span', `${name}${strength ? ' · ' + strength : ''}`, 'composer-model-caption'),
      element('span', '', 'composer-model-arrow ui-chevron'),
    );
    modelButton.disabled = saving;
    modelButton.setAttribute(
      'aria-label',
      uiText('模型与思考强度') + '：' + modelButton.textContent,
    );
    modelButton.title = uiText('选择模型与思考强度');
  }
  function renderQuota() {
    body.replaceChildren();
    body.append(
      element(
        'p',
        account
          ? uiText('Codex 账号 · {0}', {
              0: account.planType || account.type || uiText('已登录'),
            })
          : uiText('Codex 账号'),
        'quota-account',
      ),
    );
    if (!connected)
      body.append(element('p', uiText('连接已断开，以下为上次读取的数据。'), 'composer-notice'));
    if (error) body.append(element('p', error, 'composer-notice'));
    if (!Object.keys(buckets).length)
      body.append(
        element(
          'p',
          loading
            ? uiText('正在读取账号额度…')
            : account?.type === 'apiKey'
              ? uiText('API Key 登录不提供 ChatGPT 订阅额度。')
              : uiText('暂时没有额度信息。'),
          'quota-empty',
        ),
      );
    for (const [id, bucket] of Object.entries(buckets)) {
      const section = element('section', undefined, 'quota-bucket');
      section.append(element('h3', bucket.limitName || id));
      for (const [key, fallback] of [
        ['primary', uiText('主周期')],
        ['secondary', uiText('次周期')],
      ]) {
        const window = bucket[key];
        if (!window) continue;
        const left = remaining(window),
          line = element('div', undefined, 'quota-window-title');
        line.append(
          element('span', duration(window.windowDurationMins, fallback)),
          element(
            'strong',
            left === null ? uiText('未提供') : uiText('剩余 {0}', { 0: percent(left) }),
          ),
        );
        section.append(line);
        if (left !== null) {
          const meter = element('progress');
          meter.max = 100;
          meter.value = left;
          bindUiLabel(meter, 'aria-label', '{0}剩余 {1}', {
            0: duration(window.windowDurationMins, fallback),
            1: percent(left),
          });
          meter.dataset.low = String(left <= 10);
          section.append(meter);
        }
        section.append(
          element(
            'p',
            `${finite(window.usedPercent) ? uiText('已用 {0} · ', { 0: percent(window.usedPercent) }) : ''}${resetTime(window.resetsAt)}`,
            'quota-caption',
          ),
        );
      }
      if (!bucket.primary && !bucket.secondary)
        section.append(element('p', uiText('周期额度未提供'), 'quota-caption'));
      const credits = bucket.credits;
      if (credits)
        section.append(
          element(
            'p',
            credits.unlimited === true
              ? uiText('积分：无限制')
              : credits.balance != null
                ? uiText('积分余额：{0}', { 0: credits.balance })
                : credits.hasCredits === false
                  ? uiText('无可用积分')
                  : uiText('积分余额未提供'),
            'quota-caption',
          ),
        );
      if (bucket.rateLimitReachedType)
        section.append(
          element('p', uiText('已达到使用限制，请查看重置时间或账号额度。'), 'composer-notice'),
        );
      body.append(section);
    }
    if (finite(resetCredits?.availableCount))
      body.append(
        element(
          'p',
          uiText('可用额度重置次数：{0}', { 0: resetCredits.availableCount }),
          'quota-caption',
        ),
      );
    if (finite(usage?.total?.totalTokens))
      body.append(
        element(
          'p',
          uiText('当前对话累计 {0} Token{1}', {
            0: usage.total.totalTokens.toLocaleString(interfaceLocale()),
            1: finite(usage?.last?.totalTokens)
              ? uiText(' · 本轮 {0}', {
                  0: usage.last.totalTokens.toLocaleString(interfaceLocale()),
                })
              : '',
          }),
          'quota-caption',
        ),
      );
    const footer = element('footer'),
      stamp = element(
        'span',
        loadedAt
          ? uiText('{0} 更新', {
              0: new Date(loadedAt).toLocaleString(getUiLanguage(), {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }),
            })
          : uiText('尚未读取'),
      ),
      refresh = element('button', loading ? uiText('读取中…') : uiText('刷新额度'));
    refresh.type = 'button';
    refresh.disabled = loading || !connected;
    refresh.onclick = () => void refreshQuota(true);
    footer.append(stamp, refresh);
    body.append(footer);
  }
  function renderModel() {
    renderModelView();
    position();
  }
  function renderModelView() {
    body.replaceChildren();
    popup.classList.add('model-compact');
    let modelId = preferences.model || '',
      selectedEffort = preferences.effort || '';
    const locked = () => !connected || saving || modelsLoading;
    const selected = catalog.find((item) => item.model === (modelId || runtime?.config?.model));
    const save = async (focusTarget) => {
      if (locked()) return;
      const generation = epoch;
      saving = true;
      for (const control of body.querySelectorAll('button,input')) control.disabled = true;
      try {
        const value = await window.desktop.chat('configure', {
          model: modelId,
          effort: selectedEffort,
        });
        if (generation === epoch) {
          preferences = value;
          modelError = '';
        }
      } catch (e) {
        if (generation === epoch) modelError = e.message;
      } finally {
        saving = false;
        label();
        if (active === 'model') {
          renderModel();
          body.querySelector(focusTarget)?.focus();
        }
      }
    };
    const backToEffort = () => {
      modelView = 'effort';
      renderModel();
      body.querySelector('.effort-model')?.focus();
    };
    if (modelView === 'models') {
      const back = element('button', undefined, 'model-back');
      back.type = 'button';
      back.setAttribute('aria-label', uiText('返回思考强度'));
      back.append(element('span', '', 'ui-chevron'), element('span', uiText('模型')));
      back.onclick = backToEffort;
      const list = element('div', undefined, 'model-choice-list');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', uiText('可用模型'));
      const current = modelId || runtime?.config?.model || '';
      const choices = [
        {
          model: '',
          displayName:
            uiText('CLI 默认') + (runtime?.config?.model ? ` · ${runtime.config.model}` : ''),
          label: uiText('CLI 默认模型'),
        },
        ...catalog.filter((item) => !item.hidden || item.model === current),
      ];
      for (const item of choices) {
        const option = element('button', undefined, 'model-choice-option');
        option.type = 'button';
        option.setAttribute('aria-label', item.label || item.displayName || item.model);
        option.setAttribute('aria-pressed', String(item.model === modelId));
        option.disabled = locked();
        option.append(
          element('span', item.displayName || item.model, 'model-choice-name'),
          element('span', '', 'model-choice-check'),
        );
        option.onclick = () => {
          modelView = 'effort';
          if (item.model === modelId) {
            renderModel();
            body.querySelector('.effort-model')?.focus();
            return;
          }
          modelId = item.model;
          selectedEffort = '';
          void save('.effort-model');
        };
        list.append(option);
      }
      body.append(back, list);
      if (modelsLoading) body.append(element('small', uiText('正在读取模型…'), 'model-note'));
      return;
    }
    const values = [
      ...new Set((selected?.supportedReasoningEfforts || []).map((x) => x.reasoningEffort)),
    ];
    const effective =
      selectedEffort ||
      (!modelId ? runtime?.config?.effort : null) ||
      selected?.defaultReasoningEffort;
    const head = element('div', undefined, 'effort-head'),
      name = element(
        'strong',
        effortNames()[effective] || effective || uiText('默认'),
        'effort-name',
      );
    const pick = element('button', undefined, 'effort-model');
    pick.type = 'button';
    pick.setAttribute('aria-label', uiText('选择模型'));
    pick.disabled = locked();
    pick.append(
      element(
        'span',
        selected?.displayName || modelId || runtime?.config?.model || uiText('CLI 默认模型'),
        'effort-model-name',
      ),
      element('span', '', 'ui-chevron right'),
    );
    pick.onclick = () => {
      modelView = 'models';
      renderModel();
      (
        body.querySelector('.model-choice-option[aria-pressed="true"]') ||
        body.querySelector('.model-choice-option')
      )?.focus();
    };
    head.append(name, pick);
    body.append(head);
    if (values.length) {
      const slider = element('div', undefined, 'effort-slider'),
        dots = element('div', undefined, 'effort-dots'),
        input = element('input');
      let index = Math.max(0, values.indexOf(effective));
      input.type = 'range';
      input.min = '0';
      input.max = String(values.length - 1);
      input.step = '1';
      input.value = String(index);
      input.disabled = locked() || values.length < 2;
      input.setAttribute('aria-label', uiText('思考强度'));
      for (let i = 0; i < values.length; i++) dots.append(element('i'));
      const paint = () => {
        const value = values[index];
        name.textContent = effortNames()[value] || value;
        input.setAttribute('aria-valuetext', name.textContent);
        slider.style.setProperty(
          '--ratio',
          String(values.length > 1 ? index / (values.length - 1) : 0),
        );
        [...dots.children].forEach((dot, i) => dot.classList.toggle('on', i < index));
      };
      input.oninput = () => {
        index = Number(input.value);
        paint();
      };
      input.onchange = () => {
        const value = values[Number(input.value)];
        if (value === effective) return;
        selectedEffort = value;
        if (!modelId) modelId = runtime?.config?.model || '';
        void save('.effort-slider input');
      };
      slider.append(element('div', undefined, 'effort-track'), dots, input);
      paint();
      body.append(slider);
    } else if (!modelsLoading)
      body.append(
        element(
          'small',
          uiText(
            selected
              ? '该模型没有可调的思考强度。'
              : '当前模型不在模型列表中，思考强度使用 Codex 的默认设置。',
          ),
          'model-note',
        ),
      );
    if (modelsLoading) body.append(element('small', uiText('正在读取模型…'), 'model-note'));
    if (modelError) {
      body.append(element('p', modelError, 'composer-notice'));
      const retry = element('button', uiText('重新读取模型'), 'model-retry');
      retry.type = 'button';
      retry.onclick = () => void refreshModels();
      body.append(retry);
    }
  }
  // Subtask model settings live in Settings; they change rarely and would crowd the composer popover.
  window.addEventListener('desktop-settings-open', (event) => {
    const { row } = event.detail,
      modelSelect = element('select'),
      effortSelect = element('select');
    modelSelect.className = 'child-model-select';
    effortSelect.className = 'child-effort-select';
    modelSelect.setAttribute('aria-label', uiText('子任务模型'));
    effortSelect.setAttribute('aria-label', uiText('子任务思考强度'));
    const fill = () => {
      const childModel = preferences.childModel || '',
        main = catalog.find((item) => item.model === (preferences.model || runtime?.config?.model));
      const mainEffort = preferences.model
        ? preferences.effort || main?.defaultReasoningEffort
        : runtime?.config?.effort || main?.defaultReasoningEffort;
      modelSelect.replaceChildren(
        new Option(uiText('跟随主任务'), ''),
        ...catalog
          .filter((item) => !item.hidden || item.model === childModel)
          .map((item) => new Option(item.displayName || item.model, item.model)),
      );
      if (childModel && !catalog.some((item) => item.model === childModel))
        modelSelect.append(new Option(childModel, childModel));
      modelSelect.value = childModel;
      const child = catalog.find((item) => item.model === childModel),
        levels = [
          ...new Set((child?.supportedReasoningEfforts || []).map((x) => x.reasoningEffort)),
        ];
      const follow =
        uiText('跟随主任务') + (mainEffort ? ` · ${effortNames()[mainEffort] || mainEffort}` : '');
      effortSelect.replaceChildren(
        new Option(childModel ? uiText('模型默认') : follow, ''),
        ...levels.map((value) => new Option(effortNames()[value] || value, value)),
      );
      effortSelect.value =
        childModel && levels.includes(preferences.childEffort) ? preferences.childEffort : '';
      modelSelect.disabled = !connected || saving;
      effortSelect.disabled = !connected || saving || !childModel || !levels.length;
    };
    const apply = async (patch) => {
      saving = true;
      fill();
      try {
        preferences = await window.desktop.chat('configure', patch);
      } catch (e) {
        modelError = e.message;
      } finally {
        saving = false;
        label();
        fill();
      }
    };
    modelSelect.onchange = () => void apply({ childModel: modelSelect.value, childEffort: '' });
    effortSelect.onchange = () =>
      void apply({ childModel: modelSelect.value, childEffort: effortSelect.value });
    settingsViews.add(fill);
    event.detail.signal?.addEventListener('abort', () => settingsViews.delete(fill));
    fill();
    if (!catalog.length) void refreshModels();
    row('ai', '子任务模型', 'AI 拆分出子任务时使用的模型和思考强度，默认跟随主任务。', [
      modelSelect,
      effortSelect,
    ]);
  });
  const settingsViews = new Set();
  function render() {
    label();
    if (active === 'quota') renderQuota();
    else if (active) renderModel();
    for (const refresh of settingsViews) refresh();
  }
  function renderQuotaState() {
    label();
    if (active === 'quota') renderQuota();
  }
  async function refreshModels() {
    if (modelsLoading || !connected || provider !== 'codex') return;
    const generation = epoch;
    modelsLoading = true;
    render();
    try {
      const [models, saved, connection] = await Promise.all([
        window.desktop.chat('models'),
        window.desktop.chat('preferences'),
        window.desktop.chat('runtime'),
      ]);
      if (generation !== epoch) return;
      catalog = Array.isArray(models) ? models : [];
      preferences = saved;
      runtime = connection;
      modelError = '';
    } catch (cause) {
      if (generation !== epoch) return;
      modelError = cause.message;
    } finally {
      if (generation === epoch) {
        modelsLoading = false;
        render();
      }
    }
  }
  async function refreshQuota(force = false) {
    if (
      provider !== 'codex' ||
      !connected ||
      loading ||
      (!force && Date.now() - lastAttempt < 60000)
    )
      return;
    const generation = epoch,
      startRevision = revision;
    loading = true;
    lastAttempt = Date.now();
    renderQuotaState();
    const [identity, rates] = await Promise.allSettled([
      window.desktop.chat('account'),
      window.desktop.chat('rates'),
    ]);
    if (generation !== epoch) return;
    loading = false;
    if (identity.status === 'fulfilled') account = identity.value.account;
    if (startRevision === revision) {
      if (rates.status === 'fulfilled') {
        const value = rates.value,
          map = value.rateLimitsByLimitId;
        buckets =
          map && Object.keys(map).length
            ? Object.fromEntries(Object.entries(map).filter(([, entry]) => entry))
            : value.rateLimits
              ? { [value.rateLimits.limitId || 'codex']: value.rateLimits }
              : {};
        resetCredits = value.rateLimitResetCredits;
        loadedAt = Date.now();
        error = '';
      } else
        error = uiText('额度读取失败：{0}', { 0: rates.reason?.message || uiText('请稍后刷新') });
      if (identity.status === 'fulfilled' && !account) {
        buckets = {};
        resetCredits = null;
        error = uiText('尚未登录 Codex，请在设置中登录。');
      }
    }
    renderQuotaState();
  }
  function reset() {
    epoch++;
    revision++;
    loading = false;
    buckets = {};
    resetCredits = null;
    account = null;
    loadedAt = 0;
    lastAttempt = 0;
    error = '';
    usage = null;
    catalog = [];
    runtime = null;
    modelsLoading = false;
    modelError = '';
  }
  modelButton.onclick = () => {
    show('model');
    void refreshModels();
  };
  window.addEventListener('desktop-show-model', () => {
    show('model');
    void refreshModels();
  });
  window.addEventListener('desktop-show-quota', () => {
    show('quota');
    void refreshQuota(true);
  });
  window.addEventListener('focus', () => {
    if (!state().threadId?.startsWith('local-draft-')) void refreshQuota();
  });
  window.desktop.onEvent(({ type, payload }) =>
    queueMicrotask(() => {
      if (type === 'ready') {
        reset();
        connected = true;
        render();
        void refreshModels();
      } else if (type === 'provider') {
        if (provider !== payload.id) {
          provider = payload.id;
          epoch++;
          loading = false;
          modelsLoading = false;
          if (provider !== 'codex') popup.close();
        }
      } else if (type === 'connecting' || type === 'connection-error') {
        epoch++;
        revision++;
        loading = false;
        modelsLoading = false;
        connected = false;
        render();
      } else if (type === 'account') {
        reset();
        render();
        if (connected) {
          void refreshQuota(true);
          void refreshModels();
        }
      } else if (type === 'rates' && connected) {
        revision++;
        const map = payload?.rateLimitsByLimitId;
        if (map) {
          for (const [id, value] of Object.entries(map))
            if (value) buckets[id] = { ...buckets[id], ...value };
        } else if (payload?.rateLimits) {
          const value = payload.rateLimits,
            id = value.limitId || 'codex';
          buckets[id] = { ...buckets[id], ...value };
        }
        if (payload?.rateLimitResetCredits !== undefined)
          resetCredits = payload.rateLimitResetCredits;
        loadedAt = Date.now();
        error = '';
        renderQuotaState();
      } else if (type === 'preferences') {
        preferences = payload;
        render();
      } else if (type === 'usage') {
        usage = payload;
        if (active === 'quota') renderQuota();
      } else if (type === 'thread-switched') {
        usage = null;
        render();
      } else if (type === 'completed') {
        if (active && active !== 'quota') renderModel();
        void refreshQuota();
      } else if (type === 'started' && active && active !== 'quota') renderModel();
    }),
  );
  subscribeUiLanguage(() => {
    render();
    title.textContent = active === 'quota' ? uiText('Codex 额度') : uiText('模型与思考强度');
    bindUiLabel(popup, 'aria-label', '对话选项');
    bindUiLabel(close, 'aria-label', '关闭');
  });
  label();
  void window.desktop
    .chat('preferences')
    .then((value) => {
      preferences = value;
      label();
    })
    .catch(() => {});
  return { snapshot: () => structuredClone(preferences) };
}
