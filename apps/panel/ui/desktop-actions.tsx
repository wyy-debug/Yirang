import {
  getUiLanguage as getUiLocale,
  subscribeUiLanguage as onUiLocale,
} from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from './ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopObject } from '../../../packages/contracts/index.js';
import { Icon, materialAppearance, type IconName } from './icons.js';
import './desktop-actions.css';
import {
  defaultFileAiShortcut,
  fileAiShortcutLabel,
  validFileAiShortcut,
} from '../../../packages/components/file-ai-shortcut.js';

export type DesktopCommand = {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
  group?: string;
  run: () => void;
};
export type DesktopCommandPaletteProps = {
  commands: DesktopCommand[];
  objects: DesktopObject[];
  recentIds: string[];
  openObject: (id: string) => void;
  close: () => void;
};
export type DesktopContextMenuProps = {
  x: number;
  y: number;
  items: DesktopCommand[];
  close: () => void;
};

const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const fileName = (object: DesktopObject) =>
  'fileName' in object.content ? object.content.fileName : (object.sourceFileName ?? '');
const focusable = (element: HTMLElement) =>
  Array.from(
    element.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
    ),
  ).filter(
    (node) => node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0,
  );
function trapFocus(event: React.KeyboardEvent, element: HTMLElement) {
  if (event.key !== 'Tab') return;
  const nodes = focusable(element),
    first = nodes[0],
    last = nodes[nodes.length - 1];
  if (!first) {
    event.preventDefault();
    element.focus();
    return;
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || !element.contains(document.activeElement))
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || !element.contains(document.activeElement))
  ) {
    event.preventDefault();
    first.focus();
  }
}
function useFocusReturn() {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
}
function Shortcut({ value }: { value: string }) {
  useUiLocale();
  return <kbd className="desktop-action-key">{value}</kbd>;
}

type PaletteEntry = {
  key: string;
  label: string;
  description?: string;
  group: string;
  icon: IconName;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
  search: string;
  rank: number;
};
export function DesktopCommandPalette({
  commands,
  objects,
  recentIds,
  openObject,
  close,
}: DesktopCommandPaletteProps) {
  useUiLocale();
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState(0),
    input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDivElement>(null),
    listId = useId(),
    titleId = useId();
  useFocusReturn();
  useEffect(() => {
    input.current?.focus();
  }, []);
  const entries = useMemo(() => {
    const words = normalized(query).split(/\s+/).filter(Boolean),
      recent = new Map(recentIds.map((id, index) => [id, index]));
    const commandEntries: PaletteEntry[] = commands.map((command, index) => ({
      key: `action:${command.id}`,
      label: command.label,
      description: command.description,
      group: command.group ?? uiText('快捷操作'),
      icon: command.icon ?? 'grid',
      shortcut: command.shortcut,
      disabled: command.disabled,
      run: command.run,
      search: normalized(
        [command.label, command.description, ...(command.keywords ?? [])].filter(Boolean).join(' '),
      ),
      rank: index,
    }));
    const objectEntries: PaletteEntry[] = objects
      .filter((object) => !object.archived)
      .map((object, index) => {
        const name = fileName(object),
          look = materialAppearance(object.kind, name),
          isRecent = recent.has(object.id);
        return {
          key: `object:${object.id}`,
          label: object.title || name || uiText('未命名材料'),
          description: name && name !== object.title ? name : look.label,
          group: isRecent ? uiText('最近打开') : uiText('桌面材料'),
          icon: look.icon,
          run: () => openObject(object.id),
          search: normalized([object.title, name, look.label].join(' ')),
          rank: isRecent ? 1000 + recent.get(object.id)! : 2000 + index,
        };
      });
    const matches = [...commandEntries, ...objectEntries].filter((entry) =>
      words.every((word) => entry.search.includes(word)),
    );
    if (words.length) {
      const full = normalized(query);
      matches.sort(
        (a, b) =>
          Number(normalized(b.label) === full) - Number(normalized(a.label) === full) ||
          Number(normalized(b.label).startsWith(full)) -
            Number(normalized(a.label).startsWith(full)) ||
          a.rank - b.rank ||
          a.key.localeCompare(b.key),
      );
    } else matches.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
    return matches.slice(0, 60);
  }, [commands, objects, recentIds, openObject, query, getUiLocale()]);
  const active = Math.min(selected, Math.max(0, entries.length - 1));
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-result-index="${active}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, entries.length]);
  function choose(entry: PaletteEntry | undefined) {
    if (!entry || entry.disabled) return;
    close();
    entry.run();
  }
  function move(delta: number) {
    if (!entries.length) return;
    let next = active;
    for (let count = 0; count < entries.length; count++) {
      next = (next + delta + entries.length) % entries.length;
      if (!entries[next].disabled) {
        setSelected(next);
        return;
      }
    }
  }
  return createPortal(
    <div
      className="desktop-action-overlay"
      data-desktop-overlay="palette"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        className="desktop-command-palette"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            move(event.key === 'ArrowDown' ? 1 : -1);
            return;
          }
          if (event.key === 'Enter' && event.target === input.current) {
            event.preventDefault();
            choose(entries[active]);
            return;
          }
          trapFocus(event, event.currentTarget);
        }}
      >
        <header className="desktop-palette-search">
          <Icon name="search" size={22} />
          <h2 id={titleId} className="desktop-action-sr">
            {uiText('搜索操作和材料')}
          </h2>
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={uiText('搜索操作、材料或文件名…')}
            role="combobox"
            aria-label={uiText('搜索操作和材料')}
            aria-controls={listId}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={entries.length ? `${listId}-${active}` : undefined}
          />
          <button
            type="button"
            className="desktop-action-close"
            onClick={close}
            aria-label={uiText('关闭操作搜索')}
          >
            <Shortcut value="Esc" />
          </button>
        </header>
        <div
          className="desktop-palette-results"
          ref={list}
          id={listId}
          role="listbox"
          aria-label={uiText('搜索结果')}
        >
          {entries.map((entry, index) => (
            <React.Fragment key={entry.key}>
              {(index === 0 || entries[index - 1].group !== entry.group) && (
                <div className="desktop-action-group" role="presentation">
                  {entry.group}
                </div>
              )}
              <button
                type="button"
                id={`${listId}-${index}`}
                data-result-index={index}
                className="desktop-palette-row"
                role="option"
                aria-selected={index === active}
                aria-disabled={!!entry.disabled}
                tabIndex={-1}
                onMouseEnter={() => {
                  if (!entry.disabled) setSelected(index);
                }}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(entry)}
              >
                <span className="desktop-palette-symbol">
                  <Icon name={entry.icon} size={19} />
                </span>
                <span className="desktop-palette-label">
                  <strong>{entry.label}</strong>
                  {entry.description && <small>{entry.description}</small>}
                </span>
                {entry.disabled ? (
                  <span className="desktop-action-unavailable">{uiText('暂不可用')}</span>
                ) : entry.shortcut ? (
                  <Shortcut value={entry.shortcut} />
                ) : index === active ? (
                  <span className="desktop-action-return" aria-hidden="true">
                    ↵
                  </span>
                ) : null}
              </button>
            </React.Fragment>
          ))}
          {!entries.length && (
            <div className="desktop-action-empty">
              <Icon name="search" size={28} />
              <strong>{uiText('没有找到对应操作或材料')}</strong>
              <p>{uiText('试试更短的关键词，或输入文件名。')}</p>
            </div>
          )}
        </div>
        <footer className="desktop-palette-footer">
          <span>
            <Shortcut value="↑ ↓" /> {uiText('选择')}
            <Shortcut value="↵" /> {uiText('打开')}
          </span>
          <span aria-live="polite">
            {entries.length === 60
              ? uiText('显示前 60 项')
              : uiText('{0} 项', { '0': entries.length })}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export function DesktopContextMenu({ x, y, items, close }: DesktopContextMenuProps) {
  useUiLocale();
  const menu = useRef<HTMLDivElement>(null),
    [position, setPosition] = useState({ left: Math.max(8, x), top: Math.max(8, y) }),
    [active, setActive] = useState(() =>
      Math.max(
        0,
        items.findIndex((item) => !item.disabled),
      ),
    ),
    closeRef = useRef(close);
  closeRef.current = close;
  useFocusReturn();
  useLayoutEffect(() => {
    const place = () => {
      const bounds = menu.current?.getBoundingClientRect();
      if (bounds)
        setPosition({
          left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
          top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
        });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [x, y, items.length]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) closeRef.current();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scroll, true);
    };
  }, []);
  useEffect(() => {
    const index =
      items[active] && !items[active].disabled ? active : items.findIndex((item) => !item.disabled);
    if (index !== active && index >= 0) setActive(index);
    const target = menu.current?.querySelector<HTMLButtonElement>(
      `[data-command-index="${index}"]`,
    );
    (target ?? menu.current)?.focus();
  }, [active, items]);
  function move(delta: number) {
    if (!items.length) return;
    let next = active;
    for (let count = 0; count < items.length; count++) {
      next = (next + delta + items.length) % items.length;
      if (!items[next].disabled) {
        setActive(next);
        return;
      }
    }
  }
  return createPortal(
    <div
      className="desktop-context-menu"
      data-desktop-overlay="context"
      ref={menu}
      role="menu"
      aria-label={uiText('桌面操作')}
      tabIndex={-1}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const indices = items.flatMap((item, index) => (item.disabled ? [] : [index]));
          if (indices.length)
            setActive(event.key === 'Home' ? indices[0] : indices[indices.length - 1]);
        }
      }}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {index > 0 && item.group !== items[index - 1].group && (
            <div className="desktop-context-separator" role="separator" />
          )}
          <button
            type="button"
            role="menuitem"
            className="desktop-context-item"
            data-command-index={index}
            tabIndex={index === active && !item.disabled ? 0 : -1}
            aria-disabled={!!item.disabled}
            title={item.description}
            onFocus={() => {
              if (!item.disabled) setActive(index);
            }}
            onMouseEnter={() => {
              if (!item.disabled) setActive(index);
            }}
            onClick={() => {
              if (item.disabled) return;
              close();
              item.run();
            }}
          >
            <Icon name={item.icon ?? 'grid'} size={16} />
            <span>{item.label}</span>
            {item.shortcut && <Shortcut value={item.shortcut} />}
          </button>
        </React.Fragment>
      ))}
      {!items.length && <div className="desktop-context-empty">{uiText('暂无可用操作')}</div>}
    </div>,
    document.body,
  );
}

let shortcutSections = [
  {
    title: uiText('随时找到操作'),
    icon: 'search' as IconName,
    rows: [
      ['Ctrl / ⌘ P', uiText('打开操作搜索')],
      ['Ctrl / ⌘ K', uiText('查找材料')],
      ['?', uiText('查看快捷键')],
    ],
  },
  {
    title: uiText('桌面与选区'),
    icon: 'desktop' as IconName,
    rows: [
      ['H / V', uiText('抓手平移 / 选择')],
      [uiText('Alt + 拖动'), uiText('临时关闭吸附')],
      [uiText('空白处拖动'), uiText('框选图形与材料')],
      [uiText('Shift + 单击 / 框选'), uiText('追加到选区')],
      ['Ctrl / ⌘ A', uiText('全选图形与材料')],
      ['F2', uiText('重命名所选材料')],
      ['Ctrl / ⌘ D', uiText('复制所选材料')],
      ['Ctrl / ⌘ G', uiText('创建区域')],
      ['Delete', uiText('删除所选内容；材料先确认')],
      ['F', uiText('适合选区')],
      [uiText('空格'), uiText('快速预览所选材料')],
    ],
  },
  {
    title: uiText('快速预览'),
    icon: 'eye' as IconName,
    rows: [
      ['← / →', uiText('上一份 / 下一份材料')],
      ['Enter', uiText('打开编辑器')],
      [uiText('空格 / Esc'), uiText('关闭快速预览')],
    ],
  },
  {
    title: uiText('绘图编辑'),
    icon: 'pen' as IconName,
    rows: [
      ['Ctrl / ⌘ Z', uiText('撤销绘图操作')],
      ['Ctrl / ⌘ Y', uiText('重做绘图操作')],
    ],
  },
];
export function DesktopShortcutHelp({ close }: { close: () => void }) {
  useUiLocale();
  const dialog = useRef<HTMLDivElement>(null),
    titleId = useId();
  useFocusReturn();
  const [aiShortcut, setAiShortcut] = useState(defaultFileAiShortcut);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source === window.parent &&
        event.data?.type === 'ai-desktop:file-ai-config' &&
        validFileAiShortcut(event.data.shortcut)
      )
        setAiShortcut(event.data.shortcut);
    };
    window.addEventListener('message', receive);
    window.parent.postMessage({ type: 'ai-desktop:file-ai-config-request' }, '*');
    return () => window.removeEventListener('message', receive);
  }, []);
  const sections = document.documentElement.classList.contains('electron-mode')
    ? [
        {
          title: uiText('文件 AI'),
          icon: 'comment' as IconName,
          rows: [
            [fileAiShortcutLabel(aiShortcut), uiText('激活后点击文件提问（可在设置中修改）')],
            ['Esc', uiText('退出选取或收起浮窗')],
          ],
        },
        ...shortcutSections,
      ]
    : shortcutSections;
  useEffect(() => {
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  return createPortal(
    <div
      className="desktop-action-overlay desktop-help-overlay"
      data-desktop-overlay="shortcuts"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        className="desktop-shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
          }
          trapFocus(event, event.currentTarget);
        }}
      >
        <header>
          <div>
            <span className="desktop-help-eyebrow">{uiText('工作桌面')}</span>
            <h2 id={titleId}>{uiText('让操作更顺手')}</h2>
            <p>{uiText('常用动作，不必反复寻找按钮。')}</p>
          </div>
          <button
            type="button"
            className="desktop-action-close"
            onClick={close}
            aria-label={uiText('关闭快捷键说明')}
          >
            <Icon name="close" size={19} />
          </button>
        </header>
        <div className="desktop-shortcut-grid">
          {sections.map((section) => (
            <section key={section.title}>
              <h3>
                <Icon name={section.icon} size={16} />
                {section.title}
              </h3>
              <dl>
                {section.rows.map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>
                      <Shortcut value={key} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer>
          {uiText(
            '输入文字或编辑文件时，快捷键优先交给编辑器。绘图撤销只作用于绘图，不撤销文件保存或 AI 修改。',
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  shortcutSections = [
    {
      title: uiText('随时找到操作'),
      icon: 'search' as IconName,
      rows: [
        ['Ctrl / ⌘ P', uiText('打开操作搜索')],
        ['Ctrl / ⌘ K', uiText('查找材料')],
        ['?', uiText('查看快捷键')],
      ],
    },
    {
      title: uiText('桌面与选区'),
      icon: 'desktop' as IconName,
      rows: [
        ['H / V', uiText('抓手平移 / 选择')],
        [uiText('Alt + 拖动'), uiText('临时关闭吸附')],
        [uiText('空白处拖动'), uiText('框选图形与材料')],
        [uiText('Shift + 单击 / 框选'), uiText('追加到选区')],
        ['Ctrl / ⌘ A', uiText('全选图形与材料')],
        ['F2', uiText('重命名所选材料')],
        ['Ctrl / ⌘ D', uiText('复制所选材料')],
        ['Ctrl / ⌘ G', uiText('创建区域')],
        ['Delete', uiText('删除所选内容；材料先确认')],
        ['F', uiText('适合选区')],
        [uiText('空格'), uiText('快速预览所选材料')],
      ],
    },
    {
      title: uiText('快速预览'),
      icon: 'eye' as IconName,
      rows: [
        ['← / →', uiText('上一份 / 下一份材料')],
        ['Enter', uiText('打开编辑器')],
        [uiText('空格 / Esc'), uiText('关闭快速预览')],
      ],
    },
    {
      title: uiText('绘图编辑'),
      icon: 'pen' as IconName,
      rows: [
        ['Ctrl / ⌘ Z', uiText('撤销绘图操作')],
        ['Ctrl / ⌘ Y', uiText('重做绘图操作')],
      ],
    },
  ];
});
