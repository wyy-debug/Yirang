import { bindUiLabel } from '../ui/ui-labels.js';
import { subscribeUiLanguage } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
export function createProjectNavigation({ thread, threadList, status, state, beforeSwitch }) {
  let current = null,
    scope = null,
    projects = [],
    projectCursor = null,
    epoch = 0,
    currentEpoch = 0,
    searchTimer,
    navigating = false;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const busy = () => !state().ready || state().running || navigating;
  const button = (text, action, className = '') => {
    const node = element('button', text, className);
    node.type = 'button';
    node.onclick = async () => {
      node.disabled = true;
      try {
        await action(node);
      } catch (error) {
        status.textContent = error.message;
      } finally {
        node.disabled = false;
      }
    };
    return node;
  };
  const transition = async (action) => {
    if (busy()) throw Error(uiText('请先等待当前回合完成'));
    await beforeSwitch();
    return action();
  };
  const context = button(uiText('项目与对话'), () => toggle(), 'codex-context');
  bindUiLabel(context, 'aria-label', '打开 Codex 项目与对话');
  document.querySelector('.chat-header').after(context);
  bindUiLabel(thread, 'title', '项目与对话');
  bindUiLabel(thread, 'aria-label', '项目与对话');
  threadList.classList.add('project-navigator');
  bindUiLabel(threadList, 'aria-label', 'Codex 项目与对话');
  const close = () => {
    threadList.hidden = true;
    epoch++;
    thread.setAttribute('aria-expanded', 'false');
    context.setAttribute('aria-expanded', 'false');
  };
  async function refreshCurrent(follow = false, observed = false) {
    const serial = ++currentEpoch,
      value = await window.desktop.projects('current', { observed });
    if (serial !== currentEpoch) return;
    current = value;
    if (follow) scope = value.projectId || null;
    paintCurrent(value);
  }
  function paintCurrent(value) {
    context.replaceChildren(
      element(
        'span',
        value.project?.name || (value.projectId ? uiText('项目暂不可用') : uiText('未归属项目')),
        'codex-context-project',
      ),
      element('span', '/', 'codex-context-separator'),
      element('span', value.name || uiText('新对话'), 'codex-context-thread'),
      element('span', '', 'codex-context-chevron ui-chevron'),
    );
    context.title =
      value.error ||
      `${value.project?.roots?.map((root) => root.path).join('\n') || value.cwd || ''}\n${value.name || uiText('新对话')}`;
  }
  async function loadProjects(cursor = null) {
    const result = await window.desktop.projects('list', { cursor });
    projects = cursor
      ? [
          ...projects,
          ...result.data.filter((item) => !projects.some((existing) => existing.id === item.id)),
        ]
      : result.data;
    projectCursor = result.nextCursor || null;
  }
  async function open() {
    threadList.hidden = false;
    thread.setAttribute('aria-expanded', 'true');
    context.setAttribute('aria-expanded', 'true');
    await refreshCurrent(true);
    if (threadList.hidden) return;
    await render();
  }
  function toggle() {
    if (threadList.hidden) return open();
    close();
  }
  thread.onclick = () =>
    void Promise.resolve(toggle()).catch((error) => {
      status.textContent = error.message;
    });
  document.addEventListener('pointerdown', (event) => {
    if (
      !threadList.hidden &&
      !threadList.contains(event.target) &&
      !thread.contains(event.target) &&
      !context.contains(event.target) &&
      !document.querySelector('dialog[open]')
    )
      close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !threadList.hidden && !document.querySelector('dialog[open]')) {
      close();
      thread.focus();
    }
  });

  function formDialog(title) {
    const modal = element('dialog', undefined, 'codex-project-dialog'),
      form = element('form'),
      heading = element('header'),
      notice = element('p', '', 'project-form-notice');
    let working = false;
    form.onsubmit = (event) => event.preventDefault();
    heading.append(
      element('h2', title),
      button(
        '×',
        () => {
          if (!working) modal.close();
        },
        'project-dialog-close',
      ),
    );
    form.append(heading);
    modal.append(form);
    document.body.append(modal);
    modal.addEventListener('cancel', (event) => {
      if (working) event.preventDefault();
    });
    modal.addEventListener('close', () => {
      modal.remove();
      context.focus();
    });
    modal.showModal();
    return {
      modal,
      form,
      notice,
      working: (value) => {
        working = value;
        for (const node of form.querySelectorAll('button,input,select')) node.disabled = value;
      },
    };
  }
  function field(form, label, input) {
    const row = element('label', undefined, 'project-field');
    row.append(element('span', label), input);
    form.append(row);
  }
  function createProject() {
    const dialog = formDialog(uiText('新建 Codex 项目')),
      name = element('input'),
      folder = element('input'),
      choose = button(uiText('选择文件夹'), async () => {
        const path = await window.desktop.projects('choose-root');
        if (path) {
          folder.value = path;
          if (!name.value) name.value = path.split(/[\\/]/).filter(Boolean).at(-1);
        }
      }),
      submit = element('button', uiText('创建项目'), 'project-primary');
    name.maxLength = 120;
    name.required = true;
    bindUiLabel(name, 'placeholder', '例如：产品设计');
    folder.readOnly = true;
    bindUiLabel(folder, 'placeholder', '选择这个项目的工作目录');
    submit.type = 'submit';
    field(dialog.form, uiText('项目名称'), name);
    field(dialog.form, uiText('工作目录'), folder);
    dialog.form.append(
      choose,
      element(
        'p',
        uiText('项目与对话保存在 Codex 中。项目目录用于运行代码，桌面材料不会被移动。'),
        'project-form-help',
      ),
      dialog.notice,
      submit,
    );
    const requestId = crypto.randomUUID();
    let submitted = null;
    dialog.form.onsubmit = async (event) => {
      event.preventDefault();
      if (!folder.value) {
        bindUiLabel(dialog.notice, 'textContent', '请先选择项目目录');
        return;
      }
      dialog.working(true);
      bindUiLabel(dialog.notice, 'textContent', '正在创建…');
      try {
        submitted ??= { name: name.value, path: folder.value, requestId };
        const result = await transition(() => window.desktop.projects('create', submitted));
        dialog.modal.close();
        scope = result.project.id;
        try {
          await transition(() => window.desktop.projects('select', { projectId: scope }));
        } catch (error) {
          bindUiLabel(status, 'textContent', '项目已创建，打开对话失败：{0}', { 0: error.message });
        }
        await refreshCurrent();
        if (!threadList.hidden) await render();
      } catch (error) {
        bindUiLabel(
          dialog.notice,
          'textContent',
          '{0}。可用相同请求重试；也可关闭后刷新项目列表。',
          { 0: error.message },
        );
      } finally {
        dialog.working(false);
        if (submitted) {
          name.disabled = true;
          choose.disabled = true;
        }
      }
    };
    name.focus();
  }
  function renameProject(project) {
    const dialog = formDialog(uiText('重命名项目')),
      input = element('input'),
      submit = element('button', uiText('保存'), 'project-primary');
    input.value = project.name;
    input.required = true;
    input.maxLength = 120;
    submit.type = 'submit';
    field(dialog.form, uiText('项目名称'), input);
    dialog.form.append(dialog.notice, submit);
    dialog.form.onsubmit = async (event) => {
      event.preventDefault();
      dialog.working(true);
      try {
        await transition(() =>
          window.desktop.projects('rename', { projectId: project.id, name: input.value }),
        );
        dialog.modal.close();
        await refreshCurrent();
        if (!threadList.hidden) await render();
      } catch (error) {
        dialog.notice.textContent = error.message;
      } finally {
        dialog.working(false);
      }
    };
    input.select();
  }
  function editThread(item) {
    const dialog = formDialog(uiText('管理对话')),
      input = element('input'),
      select = element('select'),
      saveName = button(uiText('保存名称'), async () => {
        dialog.working(true);
        try {
          await transition(() =>
            window.desktop.chat('rename', { threadId: item.id, name: input.value }),
          );
          dialog.modal.close();
          await refreshCurrent();
          if (!threadList.hidden) await render();
        } catch (error) {
          dialog.notice.textContent = error.message;
        } finally {
          dialog.working(false);
        }
      }),
      move = button(uiText('移动到此项目'), async () => {
        dialog.working(true);
        try {
          await transition(() =>
            window.desktop.projects('assign', {
              threadId: item.id,
              projectId: select.value || null,
            }),
          );
          dialog.modal.close();
          await refreshCurrent();
          if (!threadList.hidden) await render();
        } catch (error) {
          dialog.notice.textContent = error.message;
        } finally {
          dialog.working(false);
        }
      });
    input.value = item.name || item.preview?.slice(0, 120) || '';
    input.maxLength = 120;
    field(dialog.form, uiText('对话名称'), input);
    dialog.form.append(saveName);
    select.append(new Option(uiText('未归属项目'), ''));
    for (const project of projects) select.append(new Option(project.name, project.id));
    if (item.projectId && !projects.some((project) => project.id === item.projectId))
      select.append(new Option(uiText('当前项目（尚未载入列表）'), item.projectId));
    select.value = item.projectId || '';
    field(dialog.form, uiText('所属项目'), select);
    dialog.form.append(
      element(
        'p',
        uiText('只调整对话归属，不移动文件。下一次运行会使用项目目录。'),
        'project-form-help',
      ),
      move,
      dialog.notice,
    );
    input.focus();
  }
  async function render() {
    const serial = ++epoch;
    threadList.replaceChildren();
    const heading = element('div', undefined, 'project-nav-heading'),
      body = element('div', undefined, 'project-nav-body'),
      sidebar = element('nav', undefined, 'project-nav-list'),
      content = element('section', undefined, 'project-nav-threads');
    heading.append(
      element('strong', uiText('Codex 项目')),
      button('＋', () => createProject(), 'project-icon-button'),
      button('×', close, 'project-icon-button'),
    );
    bindUiLabel(heading.children[1], 'title', '新建项目');
    body.append(sidebar, content);
    threadList.append(heading, body);
    function addProject(label, projectId) {
      const row = element('div', undefined, 'project-nav-row'),
        select = button(label, async () => {
          if (projectId === 'all') {
            scope = 'all';
            await render();
            return;
          }
          await transition(() => window.desktop.projects('select', { projectId }));
          scope = projectId;
          await refreshCurrent();
          if (!threadList.hidden) await render();
        });
      select.classList.toggle('is-selected', scope === projectId);
      select.title = label;
      row.append(select);
      sidebar.append(row);
      return row;
    }
    addProject(uiText('全部对话'), 'all');
    addProject(uiText('未归属项目'), null);
    sidebar.append(element('small', uiText('项目'), 'project-nav-section'));
    try {
      await loadProjects();
      if (serial !== epoch) return;
      const appendProjects = (items) => {
        for (const project of items) {
          const row = addProject(project.name, project.id),
            rename = button('⋯', () => renameProject(project), 'project-icon-button');
          bindUiLabel(rename, 'title', '重命名项目');
          row.append(rename);
        }
      };
      appendProjects(projects);
      if (projectCursor)
        sidebar.append(
          button(uiText('更多项目'), async (b) => {
            const count = projects.length;
            await loadProjects(projectCursor);
            if (serial !== epoch) return;
            appendProjects(projects.slice(count));
            if (!projectCursor) b.remove();
            else sidebar.append(b);
          }),
        );
      if (!projects.length) sidebar.append(element('p', uiText('还没有项目'), 'project-nav-empty'));
    } catch (error) {
      if (serial !== epoch) return;
      sidebar.append(
        element('p', error.message, 'project-nav-error'),
        button(uiText('刷新项目'), () => render()),
      );
    }
    if (serial !== epoch) return;
    const top = element('div', undefined, 'project-thread-heading'),
      title =
        scope === 'all'
          ? uiText('全部对话')
          : scope === null
            ? uiText('未归属项目')
            : projects.find((item) => item.id === scope)?.name || uiText('项目对话');
    top.append(
      element('strong', title),
      button(uiText('＋ 新对话'), async () => {
        await transition(() =>
          window.desktop.projects('new-thread', {
            projectId: scope === 'all' ? current?.projectId || null : scope,
          }),
        );
        close();
      }),
    );
    const search = element('input'),
      list = element('div', undefined, 'project-thread-list');
    search.type = 'search';
    bindUiLabel(search, 'placeholder', '搜索对话');
    bindUiLabel(search, 'aria-label', '搜索项目内的对话');
    content.append(top, search, list);
    let searchSerial = 0;
    async function loadThreads(cursor = null, token = ++searchSerial) {
      if (!cursor) list.replaceChildren(element('p', uiText('正在读取…'), 'project-nav-empty'));
      try {
        const result = await window.desktop.projects('threads', {
          scope,
          search: search.value,
          cursor,
        });
        if (serial !== epoch || token !== searchSerial) return;
        if (!cursor) list.replaceChildren();
        for (const item of result.data) {
          const row = element('div', undefined, 'project-thread-row'),
            open = button(item.name || item.preview?.slice(0, 80) || uiText('新对话'), async () => {
              await transition(() => window.desktop.switchThread(item.id));
              close();
            }),
            more = button('⋯', () => editThread(item), 'project-icon-button');
          open.classList.toggle('is-current', item.id === state().threadId);
          open.title = `${item.name || item.preview || uiText('新对话')}\n${item.cwd || ''}`;
          open.setAttribute('aria-current', item.id === state().threadId ? 'true' : 'false');
          bindUiLabel(more, 'title', '重命名或移动对话');
          row.append(open, more);
          list.append(row);
        }
        if (result.nextCursor)
          list.append(
            button(uiText('更多对话'), async (b) => {
              b.disabled = true;
              try {
                await loadThreads(result.nextCursor, token);
                b.remove();
              } catch (error) {
                b.disabled = false;
                throw error;
              }
            }),
          );
        if (!list.children.length)
          list.append(
            element(
              'p',
              search.value ? uiText('没有匹配的对话') : uiText('还没有对话，点击上方新建。'),
              'project-nav-empty',
            ),
          );
      } catch (error) {
        if (serial !== epoch || token !== searchSerial) return;
        list.replaceChildren(
          element('p', error.message, 'project-nav-error'),
          button(uiText('重试'), () => loadThreads()),
        );
      }
    }
    search.oninput = () => {
      clearTimeout(searchTimer);
      const token = ++searchSerial;
      searchTimer = setTimeout(() => void loadThreads(null, token), 220);
    };
    await loadThreads();
  }
  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'thread-switched' && payload.fresh) close();
    if (type === 'thread-navigation') {
      navigating = payload;
      context.disabled = payload;
      return;
    }
    if (['ready', 'thread-switched', 'thread-created', 'projects-changed'].includes(type))
      void refreshCurrent(
        type !== 'projects-changed',
        type === 'thread-switched' || type === 'thread-created',
      )
        .then(() => {
          if (!threadList.hidden) return render();
        })
        .catch((error) => {
          status.textContent = error.message;
        });
    if (type === 'connecting' || type === 'connection-error') {
      close();
      bindUiLabel(context, 'textContent', 'Codex 正在连接…');
    }
  });
  subscribeUiLanguage(() => {
    if (current) paintCurrent(current);
    else bindUiLabel(context, 'textContent', '项目与对话');
    bindUiLabel(context, 'aria-label', '打开 Codex 项目与对话');
    bindUiLabel(thread, 'aria-label', '项目与对话');
    bindUiLabel(threadList, 'aria-label', 'Codex 项目与对话');
  });
  return { open, close };
}
