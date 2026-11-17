import { t } from '../../../packages/components/ui-language.js';

const categories = [
  { id: 'general', label: '通用' },
  {
    id: 'tools',
    label: 'AI',
    pages: [['ai', '对话'], ['executors', '本机 AI 工具'], ['models', '模型服务']],
  },
  {
    id: 'file-management',
    label: '文件管理',
    pages: [['files', '文件同步'], ['folders', '本机文件夹'], ['resources', '网络文件']],
  },
  { id: 'storage', label: '存储与历史' },
  { id: 'extensions', label: '扩展能力' },
  { id: 'about', label: '关于' },
  { id: 'diagnostics', label: '故障排查' },
];

export function createSettingsLayout(modal, selected, onSelect) {
  const layout = document.createElement('div'),
    nav = document.createElement('nav'),
    content = document.createElement('div'),
    sections = {},
    buttons = new Map(),
    subpages = new Map(),
    recentPage = new Map();
  layout.className = 'settings-layout';
  nav.className = 'settings-nav';
  nav.setAttribute('aria-label', t('设置分类'));
  content.className = 'settings-content-area';

  function makeButton(parent, id, label, controlledId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t(label);
    button.dataset.category = id;
    button.setAttribute('aria-controls', controlledId);
    button.onclick = () => select(id);
    parent.append(button);
    return button;
  }

  for (const { id, label, pages } of categories) {
    const panel = document.createElement('section'),
      heading = document.createElement('h3');
    panel.id = `settings-${id}`;
    panel.className = 'settings-category';
    heading.id = `settings-heading-${id}`;
    heading.className = 'settings-category-title';
    heading.textContent = t(label);
    panel.setAttribute('aria-labelledby', heading.id);
    panel.append(heading);
    sections[id] = panel;
    buttons.set(id, makeButton(nav, id, label, panel.id));
    content.append(panel);

    if (!pages) continue;
    const tabs = document.createElement('nav');
    tabs.className = 'settings-subnav';
    tabs.setAttribute('aria-label', t(label));
    panel.append(tabs);
    recentPage.set(id, pages[0][0]);
    for (const [page, title] of pages) {
      const body = document.createElement('div');
      body.id = `settings-${page}`;
      body.className = 'settings-subpage';
      const button = makeButton(tabs, page, title, body.id);
      subpages.set(page, { owner: id, button, body });
      sections[page] = body;
      panel.append(body);
    }
  }

  function select(id) {
    const owner = subpages.get(id)?.owner ?? (buttons.has(id) ? id : 'general');
    if (subpages.has(id)) recentPage.set(owner, id);
    const current = recentPage.get(owner) ?? owner;
    for (const [key, button] of buttons) {
      sections[key].hidden = key !== owner;
      button.setAttribute('aria-current', key === owner ? 'page' : 'false');
    }
    for (const [key, { button, body }] of subpages) {
      body.hidden = key !== current;
      button.setAttribute('aria-current', key === current ? 'page' : 'false');
    }
    content.scrollTop = 0;
    onSelect(current);
  }

  layout.append(nav, content);
  modal.append(layout);
  select(selected);
  const row = (category, title, description, actions = []) => {
    const section = document.createElement('section'),
      copy = document.createElement('div'),
      heading = document.createElement('h4'),
      controls = document.createElement('div');
    section.className = 'settings-preference-row';
    heading.textContent = t(title);
    copy.append(heading);
    if (description) {
      const note = document.createElement('p');
      note.textContent = t(description);
      copy.append(note);
    }
    controls.className = 'settings-actions';
    controls.append(...actions);
    section.append(copy, controls);
    sections[category].append(section);
    return section;
  };
  return { sections, row, select };
}
