import { t } from '../../../packages/components/ui-language.js';
const el = (tag, text) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};
export function registerAiTools() {
  const style = el('style');
  style.textContent =
    '.acp-options{display:flex;gap:6px;align-items:center;font-size:11px;color:#788398;padding:6px 0}.acp-options select{max-width:180px;border:1px solid #e7eaf0;border-radius:7px;padding:5px}';
  document.head.append(style);
  const options = el('div');
  options.className = 'acp-options';
  options.hidden = true;
  document.querySelector('.composer-tools').before(options);
  function paint(value) {
    document.documentElement.dataset.cliProvider = value.id;
    const heading = document.querySelector('.chat-heading strong');
    if (heading) heading.textContent = value.id === 'codex' ? 'Codex' : value.name;
    if (heading) heading.title = '执行工具：' + value.name;
    const connection = document.getElementById('connection-label');
    if (connection) connection.textContent = value.name + ' · ' + value.status;
    const native = document.querySelector('.composer-preferences');
    if (native) native.hidden = value.id !== 'codex';
    const review = document.querySelector('.review-mode');
    if (review) review.hidden = value.id !== 'codex';
    const project = document.querySelector('.codex-context');
    if (project) project.hidden = value.id !== 'codex';
    options.hidden = value.id === 'codex';
    options.replaceChildren();
    if (options.hidden) return;
    const note = el(
      'span',
      value.status + (value.capabilities?.resume ? ' · 可恢复' : ' · 恢复能力待确认'),
    );
    options.append(note);
    const addSelect = (name, choices, selected, save) => {
      const select = el('select');
      select.title = name;
      for (const c of choices) {
        const item = el('option', c.name);
        item.value = c.id;
        select.append(item);
      }
      select.value = selected || '';
      select.onchange = async () => {
        select.disabled = true;
        try {
          await window.desktop.aiTools('option', save(select.value));
        } catch (e) {
          note.textContent = e.message;
        } finally {
          select.disabled = false;
        }
      };
      options.append(select);
    };
    if (value.models?.availableModels?.length)
      addSelect(
        '模型',
        value.models.availableModels.map((m) => ({ id: m.modelId, name: m.name })),
        value.models.currentModelId,
        (id) => ({ modelId: id }),
      );
    if (value.modes?.availableModes?.length)
      addSelect(
        '工具模式',
        value.modes.availableModes.map((m) => ({ id: m.id, name: m.name })),
        value.modes.currentModeId,
        (id) => ({ modeId: id }),
      );
    for (const c of value.configOptions || [])
      if (c.type === 'select')
        addSelect(
          c.name,
          (c.options || [])
            .flatMap((o) => o.options || [o])
            .map((o) => ({ id: o.value, name: o.name })),
          c.currentValue,
          (value) => ({ configId: c.id, value }),
        );
  }
  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'provider') {
      paint(payload);
    }
  });
  window.addEventListener('desktop-settings-open', async (event) => {
    const { sections, button, signal } = event.detail,
      container = sections.executors || sections.tools;
    const note = el('p');
    note.setAttribute('role', 'alert');
    const toolbar = el('div');
    toolbar.className = 'settings-tool-toolbar';
    toolbar.append(button('重新检测', () => load()));
    const list = el('div');
    list.className = 'settings-tool-list';
    container.append(toolbar, note, list);
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      note.textContent = '';
      try {
      const tools = await window.desktop.aiTools('list');
      if (signal.aborted) return;
      list.replaceChildren();
      sections.models?.querySelector('.ai-model-service')?.remove();
      for (const tool of tools.filter(({ supported }) => supported)) {
        const card = el('section');
        card.className = 'ai-tool-card';
        card.append(
          el('strong', tool.name + (tool.id !== 'codex' && tool.version ? ' · ' + tool.version : '')),
          el('small', tool.status),
        );
        const path = el('input');
        path.value = tool.path;
        path.placeholder = t('程序的完整路径（.exe 或 .js 文件）');
        path.setAttribute('aria-label', t('{0} 路径', { 0: tool.name }));
        const args = el('input');
        args.value = JSON.stringify(tool.args);
        args.setAttribute('aria-label', t('启动参数（JSON 数组）'));
        const actions = el('div');
        actions.className = 'ai-tool-actions';
        const feedback = el('small');
        if (tool.id === 'codex') {
          const version = el('small', t('正在读取 Codex CLI 版本…')),
            location = el('small');
          location.style.overflowWrap = 'anywhere';
          card.append(version);
          const details = el('details'),
            summary = el('summary', t('安装位置与其他选项'));
          details.append(summary, location);
          card.append(details);
          const paintVersion = (v) => {
            version.textContent = [
              t('当前版本 {0}', { 0: v.version }),
              v.latest
                ? v.updateAvailable
                  ? t('可更新到 {0}', { 0: v.latest })
                  : t('已是最新版本')
                : t('尚未检查更新'),
            ].join(' · ');
            location.textContent = v.source + ' · ' + v.path;
            feedback.textContent = [
              v.bundled ? t('这是 Codex 桌面版自带的 CLI，也可以在 Codex 桌面版中更新。') : '',
              v.checkedAt
                ? t('上次检查：{0}', { 0: new Date(v.checkedAt).toLocaleString() })
                : '',
            ]
              .filter(Boolean)
              .join(' ');
            copy.hidden = v.bundled;
          };
          const copy = button('复制更新命令', async () => {
            try {
              await navigator.clipboard.writeText('npm install -g @openai/codex@latest');
              feedback.textContent = t('已复制。在命令行中运行这条命令，完成后重启一壤即可使用新版本。');
            } catch (e) {
              feedback.textContent = e.message;
            }
          });
          copy.hidden = true;
          const check = button('检查更新', async () => {
            check.disabled = true;
            version.textContent = t('正在检查更新…');
            try {
              const v = await window.desktop.aiTools('codex-update-check');
              if (!signal.aborted) paintVersion(v);
            } catch (e) {
              version.textContent = t('检查更新失败：{0}', { 0: e.message });
            } finally {
              check.disabled = false;
            }
          });
          const install = button(tool.installed ? '更新 Codex CLI' : '安装 Codex CLI', async () => {
            install.disabled = true;
            feedback.textContent = t('正在从 Codex 官方下载并校验，请稍候…');
            try {
              const result = await window.desktop.aiTools('codex-install');
              feedback.textContent = t('已安装 {0}。点击「重新连接」后生效。', { 0: result.version });
              install.textContent = t('更新 Codex CLI');
            } catch (e) {
              feedback.textContent = t('安装失败：{0}', { 0: e.message });
            } finally {
              install.disabled = false;
            }
          });
          actions.append(
            install,
            button('重新连接', async () => {
              feedback.textContent = t('正在连接…');
              try { await window.desktop.reconnect(); feedback.textContent = t('已重新连接。'); }
              catch (e) { feedback.textContent = t('连接失败：{0}', { 0: e.message }); }
            }),
            check,
          );
          const advancedActions = el('div');
          advancedActions.className = 'ai-tool-actions';
          advancedActions.append(
            button('手动选择 Codex CLI', async () => {
              await window.desktop.chat('choose-cli');
              await load();
            }),
            button('恢复自动识别', async () => {
              await window.desktop.chat('auto-cli');
              await load();
            }),
            copy,
          );
          details.append(advancedActions);
          const gateway = el('section'),
            gatewayTitle = el('strong', t('第三方模型接口')),
            gatewayNote = el(
              'small',
              t('接口需要兼容 OpenAI Responses API，地址通常以 /v1 结尾。填好地址和 API Key 后可以获取模型列表，保存并重新连接后生效。'),
            ),
            gatewayUrl = el('input'),
            gatewayModel = el('input'),
            gatewayKey = el('input'),
            gatewayEnabled = el('input'),
            gatewayStatus = el('small');
          gatewayUrl.placeholder = t('接口地址，例如 https://example.com/v1');
          gatewayUrl.setAttribute('aria-label', t('接口地址'));
          gatewayModel.placeholder = t('模型名称');
          gatewayModel.setAttribute('aria-label', t('模型名称'));
          gatewayKey.type = 'password';
          gatewayKey.placeholder = t('API Key（已保存过可以留空）');
          gatewayKey.setAttribute('aria-label', 'API Key');
          gatewayEnabled.type = 'checkbox';
          gatewayEnabled.style.width = 'auto';
          const toggle = el('label');
          toggle.append(gatewayEnabled, document.createTextNode(' ' + t('启用第三方接口')));
          const modelList = el('datalist');
          modelList.id = 'codex-gateway-models';
          gatewayModel.setAttribute('list', modelList.id);
          const fetchModels = button('获取模型列表', async () => {
            fetchModels.disabled = true;
            gatewayStatus.textContent = t('正在获取模型列表…');
            try {
              const models = await window.desktop.aiTools('codex-gateway-models', {
                url: gatewayUrl.value.trim(),
                key: gatewayKey.value,
              });
              modelList.replaceChildren(
                ...models.map((id) => {
                  const option = el('option');
                  option.value = id;
                  return option;
                }),
              );
              gatewayStatus.textContent = models.length
                ? t('已获取 {0} 个模型，可以在「模型名称」中选择。', { 0: models.length })
                : t('接口没有返回模型，请手动填写模型名称。');
              if (models.length === 1 && !gatewayModel.value) gatewayModel.value = models[0];
            } catch (e) {
              gatewayStatus.textContent = e.message + t('；可以手动填写模型名称。');
            } finally {
              fetchModels.disabled = false;
            }
          });
          const saveGateway = button('保存接口配置', async () => {
            saveGateway.disabled = true;
            try {
              await window.desktop.aiTools('codex-gateway-save', {
                enabled: gatewayEnabled.checked,
                url: gatewayUrl.value.trim(),
                model: gatewayModel.value.trim(),
                key: gatewayKey.value,
              });
              gatewayKey.value = '';
              gatewayStatus.textContent = t('已保存。点击「重新连接并应用」后生效。');
            } catch (e) {
              gatewayStatus.textContent = e.message;
            } finally {
              saveGateway.disabled = false;
            }
          });
          const gatewayFields = el('div');
          gatewayFields.className = 'settings-gateway-fields';
          gatewayFields.append(gatewayUrl, gatewayKey, gatewayModel, fetchModels, modelList);
          const gatewayActions = el('div');
          gatewayActions.className = 'ai-tool-actions';
          gatewayActions.append(saveGateway,
            button('重新连接并应用', async () => {
              gatewayStatus.textContent = t('正在重新连接…');
              try {
                await window.desktop.reconnect();
                gatewayStatus.textContent = t('已重新连接。如果模型无法使用，请检查接口地址、API Key 和模型名称。');
              } catch (e) {
                gatewayStatus.textContent = t('连接失败：{0}', { 0: e.message });
              }
            }),
          );
          gatewayStatus.setAttribute('role', 'status');
          gateway.append(gatewayTitle, gatewayNote, toggle, gatewayFields, gatewayActions, gatewayStatus);
          gateway.className = 'ai-tool-card ai-model-service';
          (sections.models || container).append(gateway);
          void window.desktop
            .aiTools('codex-gateway-read')
            .then((value) => {
              if (!signal.aborted) {
                gatewayEnabled.checked = value.enabled;
                gatewayUrl.value = value.url;
                gatewayModel.value = value.model;
                gatewayKey.placeholder = value.hasKey ? t('已保存 API Key，留空则继续使用') : 'API Key';
              }
            })
            .catch((e) => {
              gatewayStatus.textContent = e.message;
            });
          void window.desktop
            .aiTools('codex-version')
            .then((v) => {
              if (!signal.aborted && card.isConnected) paintVersion(v);
            })
            .catch((e) => {
              version.textContent = t('无法读取 Codex CLI 版本：{0}', { 0: e.message });
            });
        } else {
          const details = el('details');
          const advancedActions = el('div');
          advancedActions.className = 'ai-tool-actions';
          advancedActions.append(
            button('选择程序位置', async () => {
              const p = await window.desktop.aiTools('pick');
              if (p) path.value = p;
            }),
            button('保存设置', async () => {
              try {
                await window.desktop.aiTools('configure', {
                  id: tool.id,
                  path: path.value.trim(),
                  args: JSON.parse(args.value),
                });
                await load();
              } catch (e) {
                feedback.textContent = e.message;
              }
            }),
          );
          details.append(el('summary', t('连接设置')), path, args, advancedActions);
          card.append(details);
        }
        if (tool.installed)
          actions.append(
            button('使用此工具开始新对话', async () => {
              await window.desktop.aiTools('new', { provider: tool.id });
              event.detail.modal.close();
            }),
          );
        if (tool.error) feedback.textContent = tool.error;
        if (actions.childElementCount) card.append(actions);
        if (!feedback.textContent) feedback.setAttribute('role', 'status');
        card.append(feedback);
        list.append(card);
      }
      } finally { loading = false; }
    }
    try {
      await load();
    } catch (e) {
      note.textContent = e.message;
    }
  });
}
