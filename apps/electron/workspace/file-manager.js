import { bindUiLabel } from '../ui/ui-labels.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
export function createFileManager({ status, frame }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'desktop-settings file-manager';
  document.body.append(dialog);
  const button = (label, handler) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.onclick = async () => {
      element.disabled = true;
      try {
        await handler();
      } catch (error) {
        notice.textContent = error.message;
      } finally {
        element.disabled = false;
      }
    };
    return element;
  };
  const notice = document.createElement('p');
  notice.setAttribute('role', 'status');
  const open = (title) => {
    dialog.replaceChildren();
    const head = document.createElement('header'),
      h = document.createElement('h2');
    h.textContent = title;
    head.append(
      h,
      button(uiText('关闭'), () => dialog.close()),
    );
    dialog.append(head, notice);
    notice.textContent = '';
    if (!dialog.open) dialog.showModal();
  };
  async function sync(objectId) {
    open(uiText('文件同步'));
    const list = await window.desktop.files('sync_list');
    const select = document.createElement('select');
    bindUiLabel(select, 'aria-label', '选择关联文件');
    select.append(new Option(uiText('选择文件'), ''));
    for (const file of list.files)
      select.append(
        new Option(
          `${file.title}${file.source?.syncError ? uiText(' · 需要处理') : file.source?.syncPending ? uiText(' · 正在同步') : ''}`,
          file.id,
        ),
      );
    dialog.append(select);
    const content = document.createElement('section');
    dialog.append(content);
    let selected, comparison, pending;
    const compare = async (id, path) => {
      pending = null;
      selected = id;
      comparison = await window.desktop.files('sync_inspect', {
        objectId: id,
        ...(path ? { path } : {}),
      });
      render();
    };
    const render = () => {
      content.replaceChildren();
      const info = document.createElement('p');
      bindUiLabel(info, 'textContent', '桌面第 {0} 版\n文件位置：{1}\n{2}', {
        0: comparison.revision,
        1: comparison.path,
        2: comparison.missing
          ? uiText('原文件已移走，请重新关联')
          : comparison.desktopHash === comparison.diskHash
            ? uiText('桌面和本机文件的内容一致')
            : comparison.conflict
              ? uiText('两边都有修改，请选择要保留的内容')
              : uiText('桌面和本机文件的内容不同'),
      });
      content.append(info);
      const actions = document.createElement('div');
      actions.className = 'settings-actions';
      actions.append(
        button(uiText('重新关联'), async () => {
          const result = await window.desktop.files('relink', { objectId: selected });
          if (result) {
            comparison = result;
            render();
          }
        }),
      );
      if (!comparison.missing) {
        let merge;
        if (comparison.diskText !== undefined && comparison.desktopText !== undefined) {
          const grid = document.createElement('div');
          grid.className = 'sync-comparison';
          for (const [label, text] of [
            [uiText('桌面版本'), comparison.desktopText],
            [uiText('本机文件版本'), comparison.diskText],
          ]) {
            const column = document.createElement('div'),
              title = document.createElement('strong'),
              pre = document.createElement('pre');
            title.textContent = label;
            pre.textContent = text;
            column.append(title, pre);
            grid.append(column);
          }
          content.append(grid);
          const label = document.createElement('label');
          bindUiLabel(label, 'textContent', '合并后的内容');
          merge = document.createElement('textarea');
          merge.value = comparison.desktopText;
          merge.className = 'sync-merge';
          bindUiLabel(merge, 'aria-label', '合并后的文件内容');
          content.append(label, merge);
        }
        const resolve = async (mode) => {
          const payload = {
            objectId: selected,
            path: comparison.path,
            expectedRevision: comparison.revision,
            diskHash: comparison.diskHash,
            mode,
            ...(mode === 'merge' ? { text: merge.value } : {}),
          };
          const signature = JSON.stringify(payload);
          if (!pending || pending.signature !== signature)
            pending = { signature, request: { ...payload, requestId: crypto.randomUUID() } };
          await window.desktop.files('sync_resolve', pending.request);
          pending = null;
          notice.textContent =
            mode === 'disk'
              ? uiText('已用本机文件更新桌面，原来的内容保留在历史版本中')
              : uiText('已保存，正在后台写入本机文件');
          await compare(selected, comparison.path);
        };
        actions.append(
          button(uiText('保留桌面版本'), () => resolve('desktop')),
          button(uiText('采用本机文件版本'), () => resolve('disk')),
        );
        if (merge) actions.append(button(uiText('保存合并内容'), () => resolve('merge')));
      }
      actions.append(button(uiText('重新比较'), () => compare(selected, comparison.path)));
      content.append(actions);
    };
    select.onchange = () => {
      if (select.value)
        void compare(select.value).catch((error) => {
          notice.textContent = error.message;
        });
    };
    if (objectId && list.files.some((item) => item.id === objectId)) {
      select.value = objectId;
      await compare(objectId);
    } else if (!list.files.length)
      bindUiLabel(notice, 'textContent', '当前工作区还没有需要同步的 AI 生成文件。');
  }
  async function tasks() {
    open(uiText('任务与保存位置'));
    const data = await window.desktop.files('tasks'),
      description = document.createElement('p');
    bindUiLabel(
      description,
      'textContent',
      '新任务的文件保存在：{0}\n已有任务仍使用原来的文件夹，切换任务不会复制文件。',
      { 0: data.workspaceDirectory },
    );
    dialog.append(description);
    const list = document.createElement('section');
    for (const item of data.tasks) {
      const row = document.createElement('div');
      row.className = 'task-directory-row';
      const label = document.createElement('span');
      label.textContent = `${item.id === data.activeTaskId ? '✓ ' : ''}${item.name}`;
      label.title = item.directory;
      row.append(
        label,
        button(uiText('使用'), async () => {
          await window.desktop.files('task_select', { taskId: item.id });
          await tasks();
        }),
      );
      const name = document.createElement('input');
      name.value = item.name;
      name.maxLength = 120;
      bindUiLabel(name, 'aria-label', '任务名称');
      row.append(
        name,
        button(uiText('改名'), async () => {
          await window.desktop.files('task_rename', { taskId: item.id, name: name.value });
          await tasks();
        }),
      );
      list.append(row);
    }
    dialog.append(list);
    const actions = document.createElement('div'),
      name = document.createElement('input');
    actions.className = 'settings-actions';
    bindUiLabel(name, 'placeholder', '新任务名称');
    name.maxLength = 120;
    bindUiLabel(name, 'aria-label', '新任务名称');
    actions.append(
      name,
      button(uiText('新建并使用'), async () => {
        await window.desktop.files('task_create', { name: name.value });
        await tasks();
      }),
      button(uiText('选择保存位置'), async () => {
        await window.desktop.files('choose-root');
        await tasks();
      }),
    );
    dialog.append(actions);
    const hint = document.createElement('p');
    bindUiLabel(
      hint,
      'textContent',
      '改名只改变显示的名称，不会移动文件夹。新建任务时，会用任务名称创建文件夹。',
    );
    dialog.append(hint);
  }
  async function migration() {
    const data = await window.desktop.files('migration-choose');
    if (!data) return;
    open(uiText('重新关联移动后的文件'));
    const hint = document.createElement('p');
    bindUiLabel(
      hint,
      'textContent',
      '已检查 {0} 个文件。只有文件名、大小和内容都相同的文件才会关联，桌面上的文件和历史版本不受影响。{1}{2}',
      {
        0: data.scanned,
        1: data.truncated ? uiText('文件夹太大，部分内容没有检查，请选择更小的子文件夹。') : '',
        2: data.issues.length ? uiText('部分文件无法读取。') : '',
      },
    );
    dialog.append(hint);
    const selected = new Map();
    for (const item of data.items) {
      const row = document.createElement('label'),
        check = document.createElement('input'),
        name = document.createElement('span'),
        select = document.createElement('select');
      row.className = 'migration-row';
      check.type = 'checkbox';
      check.disabled = !item.matches.length;
      name.textContent = item.title;
      bindUiLabel(select, 'aria-label', '{0} 的新位置', { 0: item.title });
      select.append(
        new Option(
          item.state === 'missing'
            ? uiText('没有找到相同文件')
            : item.state === 'ambiguous'
              ? uiText('找到多个相同文件，请选择')
              : uiText('选择关联文件'),
          '',
        ),
      );
      for (const path of item.matches) select.append(new Option(path, path));
      const choose = () => {
        if (check.checked && select.value)
          selected.set(item.objectId, {
            objectId: item.objectId,
            revision: item.revision,
            path: select.value,
            hash: item.hash,
          });
        else selected.delete(item.objectId);
      };
      check.onchange = choose;
      select.onchange = () => {
        check.checked = !!select.value;
        choose();
      };
      if (item.state === 'matched') {
        select.value = item.matches[0];
        check.checked = true;
        choose();
      }
      row.append(check, name, select);
      dialog.append(row);
    }
    dialog.append(
      button(uiText('关联所选文件'), async () => {
        const result = await window.desktop.files('migration_apply', {
          path: data.path,
          targets: [...selected.values()],
          viewWorkspaceId: data.workspaceId,
        });
        bindUiLabel(notice, 'textContent', '已重新关联 {0} 个文件，之后的修改会保存到这些文件。', {
          0: result.linked,
        });
      }),
    );
  }
  window.addEventListener('desktop-settings-open', (event) => {
    const { modal, button: make, row } = event.detail;
    row('files', '同步状态', '查看桌面与本机的文件差异，并处理冲突。', [
      make(uiText('查看同步状态'), () => {
        modal.close();
        return sync();
      }),
    ]);
    row('files', '保存位置', '选择新任务的文件保存在电脑上的哪个文件夹。', [
      make(uiText('任务与保存位置'), () => {
        modal.close();
        return tasks();
      }),
    ]);
    row('files', '重新关联文件', '文件夹移动到新位置后，选择新文件夹，重新找回对应的文件。', [
      make(uiText('选择新文件夹'), () => {
        modal.close();
        return migration();
      }),
    ]);
  });
  return { sync, tasks };
}
