import { bindUiLabel } from '../ui/ui-labels.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
export function registerPythonSettings() {
  let activeDialog = null,
    logs = null;
  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'python-job' && activeDialog?.open && logs) {
      logs.textContent = `${payload.label} · ${payload.state}\n${payload.log}`;
      logs.dataset.jobId = payload.id;
    }
  });
  window.addEventListener('desktop-settings-open', (event) => {
    const { modal, button, row } = event.detail;
    row('extensions', 'Python 环境', '选择运行 Python 时使用的环境，并安装需要的依赖包。', [
      button(uiText('管理 Python 环境'), async () => {
        modal.close();
        if (!activeDialog) {
          activeDialog = document.createElement('dialog');
          activeDialog.className = 'desktop-settings';
          document.body.append(activeDialog);
        }
        const panel = activeDialog;
        async function render() {
          const result = await window.desktop.python('list');
          panel.replaceChildren();
          const head = document.createElement('header'),
            title = document.createElement('h2');
          bindUiLabel(title, 'textContent', 'Python 环境');
          head.append(
            title,
            button(uiText('关闭'), () => panel.close()),
          );
          panel.append(head);
          const name = document.createElement('input');
          bindUiLabel(name, 'placeholder', '环境名称');
          name.maxLength = 80;
          bindUiLabel(name, 'aria-label', '环境名称');
          const select = document.createElement('select');
          bindUiLabel(select, 'aria-label', 'Python 环境');
          select.append(new Option(uiText('系统 Python'), ''));
          for (const env of result.environments) select.append(new Option(env.name, env.id));
          select.value = result.defaultId || '';
          panel.append(name, select);
          const actions = document.createElement('div');
          actions.className = 'settings-actions';
          actions.append(
            button(uiText('添加已安装的 Python'), async () => {
              await window.desktop.python('register', { name: name.value });
              await render();
            }),
            button(uiText('设为默认'), () =>
              window.desktop.python('default', { id: select.value }),
            ),
            button(uiText('创建虚拟环境'), () =>
              window.desktop.python('create', { baseId: select.value, name: name.value }),
            ),
            button(uiText('查看已安装的包'), () =>
              window.desktop.python('packages', { id: select.value }),
            ),
            button(uiText('刷新'), render),
          );
          panel.append(actions);
          const info = document.createElement('p');
          bindUiLabel(
            info,
            'textContent',
            '运行 Python 时默认使用「设为默认」的环境。安装依赖前，先选择 requirements.txt 查看内容，确认后再安装；依赖只能装到在这里创建的虚拟环境中。',
          );
          panel.append(info);
          const preview = document.createElement('pre');
          let requirementId = null;
          const dependency = document.createElement('div');
          dependency.className = 'settings-actions';
          const install = button(uiText('安装清单中的依赖'), async () => {
            if (!requirementId) throw Error(uiText('请先选择依赖清单'));
            await window.desktop.python('install', {
              id: select.value,
              requirementsId: requirementId,
            });
          });
          install.disabled = true;
          dependency.append(
            button(uiText('选择依赖清单'), async () => {
              const result = await window.desktop.python('requirements');
              if (result) {
                requirementId = result.id;
                preview.textContent = result.text;
                install.disabled = false;
              }
            }),
            install,
          );
          panel.append(dependency, preview);
          logs = document.createElement('pre');
          panel.append(
            logs,
            button(uiText('停止当前操作'), () =>
              window.desktop.python('stop', { id: logs.dataset.jobId }),
            ),
          );
          if (!panel.open) panel.showModal();
        }
        await render();
      }),
    ]);
  });
}
