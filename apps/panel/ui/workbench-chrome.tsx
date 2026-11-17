import { useUiLanguage as useUiLocale } from './ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useUiLanguage } from './ui-language.js';
import React, { useEffect, useId, useRef, useState } from 'react';
import { Icon, materialAppearance, type IconName } from './icons.js';
import { DesktopMark } from '../canvas/desktop-mark.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import { useWorkbenchLayer } from './workbench-layers.js';

export type CreationKind =
  | 'text'
  | 'document'
  | 'table'
  | 'code'
  | 'diagram'
  | 'deck'
  | 'workbook'
  | 'html'
  | 'workflow';
export type DeskDestination =
  | 'canvas'
  | 'recent'
  | 'favorites'
  | 'files'
  | 'materials'
  | 'tasks'
  | 'runs'
  | 'artifacts'
  | 'tools'
  | 'history'
  | 'trash'
  | 'workflows'
  | 'comments'
  | 'web'
  | 'browser';
type Props = {
  workspaceId?: string;
  activeApp?: string;
  applications: () => void;
  desktopActions: boolean;
  createRegion: () => void;
  workspaceName?: string;
  pageTitle?: string;
  itemCount: number;
  disabled: boolean;
  ready: boolean;
  saving: boolean;
  active: DeskDestination;
  collapsed: boolean;
  toggleSidebar: () => void;
  zoom: number;
  changeZoom: (direction: number) => void;
  fit: () => void;
  navigate: (destination: DeskDestination) => void;
  search: () => void;
  workspaces: () => void;
  commands: () => void;
  shortcuts: () => void;
  directoryOpen: boolean;
  directory: () => void;
  save: () => void;
  importFiles: () => void;
  layouts: () => void;
  annotations: () => void;
  newMenu: boolean;
  setNewMenu: (open: boolean) => void;
  create: (kind: CreationKind) => void;
};

/** Native buttons stay keyboard reachable; Escape closes a popover before canvas shortcuts. */
export function ActionPopover({
  open,
  setOpen,
  label,
  trigger,
  triggerRef,
  children,
  className = '',
  disabled = false,
  primary = false,
  closeOnAction = false,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  label: string;
  trigger: React.ReactNode;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  primary?: boolean;
  closeOnAction?: boolean;
}) {
  useUiLocale();
  const root = useRef<HTMLDivElement>(null),
    localButton = useRef<HTMLButtonElement>(null),
    id = useId();
  const button = triggerRef ?? localButton;
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open, setOpen]);
  useWorkbenchLayer(open, root, () => setOpen(false), 'menu', button);
  return (
    <div
      className={`desk-popover ${className}`}
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node))
          setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className={primary ? 'primary' : ''}
        aria-label={label}
        title={label}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          className="desk-popover-panel"
          role="group"
          aria-label={label}
          onClick={(event) => {
            if (closeOnAction && (event.target as Element).closest('button:not(:disabled)'))
              setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const workspaceItems = (): { id: DeskDestination; icon: IconName; label: string }[] => [
  { id: 'canvas', icon: 'desktop', label: uiText('我的桌面') },
  { id: 'recent', icon: 'history', label: uiText('最近使用') },
  { id: 'favorites', icon: 'star', label: uiText('收藏') },
  { id: 'trash', icon: 'trash', label: uiText('回收站') },
];
const toolItems = (): { id: DeskDestination; icon: IconName; label: string }[] => [
  { id: 'web', icon: 'link', label: isIntegratedDesktop ? uiText('网页资料') : uiText('网页') },
  { id: 'comments', icon: 'comment', label: uiText('评论') },
  { id: 'workflows', icon: 'workflow', label: uiText('工具箱') },
  { id: 'runs', icon: 'playCircle', label: uiText('代码运行') },
  { id: 'artifacts', icon: 'box', label: uiText('导出文件') },
];
export function WorkbenchChrome(p: Props) {
  useUiLanguage();
  const [more, setMore] = useState(false);
  const pageLabel =
    p.pageTitle ??
    [...workspaceItems(), ...toolItems()].find((item) => item.id === p.active)?.label ??
    (
      {
        files: uiText('文件与区域'),
        browser: uiText('浏览器'),
        materials: uiText('材料管理'),
        tools: uiText('设置'),
        history: uiText('活动记录'),
      } as Partial<Record<DeskDestination, string>>
    )[p.active] ??
    uiText('桌面');
  const entries: { kind: CreationKind; title: string; description: string }[] = [
    { kind: 'text', title: uiText('文字笔记'), description: 'Markdown' },
    { kind: 'document', title: uiText('Word 文档'), description: 'DOCX' },
    { kind: 'workbook', title: uiText('Excel 表格'), description: 'XLSX' },
    { kind: 'deck', title: uiText('演示文稿'), description: 'PPTX' },
    { kind: 'code', title: uiText('代码文件'), description: 'Python' },
    { kind: 'diagram', title: uiText('矢量图形'), description: 'SVG' },
    { kind: 'html', title: uiText('网页文件'), description: 'HTML' },
    { kind: 'workflow', title: uiText('流程组件'), description: 'Python · Skill · MCP' },
  ];
  const navigate = (id: DeskDestination) => {
    p.setNewMenu(false);
    setMore(false);
    p.navigate(id);
  };
  const row = (item: ReturnType<typeof workspaceItems>[number]) => (
    <button
      key={item.id}
      className={!p.directoryOpen && !p.activeApp && p.active === item.id ? 'is-current' : ''}
      aria-current={!p.directoryOpen && !p.activeApp && p.active === item.id ? 'page' : undefined}
      title={item.label}
      disabled={p.disabled}
      onClick={() => navigate(item.id)}
    >
      <Icon name={item.icon} size={19} />
      <span>{item.label}</span>
    </button>
  );
  return (
    <>
      <aside className="desk-rail" aria-label={uiText('工作桌面导航')}>
        {isIntegratedDesktop ? (
          <button
            type="button"
            className="sidebar-brand workspace-switcher"
            onClick={p.workspaces}
            disabled={p.disabled}
            title={uiText('切换工作区 · {0}', { '0': p.workspaceName ?? uiText('工作桌面') })}
            aria-label={uiText('切换工作区，当前为{0}', {
              '0': p.workspaceName ?? uiText('工作桌面'),
            })}
          >
            <span className="desk-logo">
              <DesktopMark size={28} />
            </span>
            <strong>{p.workspaceName ?? uiText('工作桌面')}</strong>
            <Icon name="chevron" size={12} />
          </button>
        ) : (
          <div className="sidebar-brand">
            <span className="desk-logo">
              <DesktopMark size={32} />
            </span>
            <strong>{uiText('一壤 · Yirang')}</strong>
          </div>
        )}
        <button
          className="sidebar-search"
          onClick={p.search}
          disabled={p.disabled}
          title={uiText('搜索材料 · Ctrl / ⌘ K')}
          aria-label={uiText('搜索材料')}
        >
          <Icon name="search" size={17} />
          <span>{uiText('搜索')}</span>
        </button>
        <button
          className="sidebar-command"
          onClick={p.commands}
          disabled={p.disabled}
          title={uiText('快捷操作 · Ctrl / ⌘ P')}
        >
          <Icon name="grid" size={17} />
          <span>{uiText('快捷操作')}</span>
        </button>
        <nav>
          <div className="sidebar-section">
            <small>{uiText('工作区')}</small>
            {workspaceItems()
              .filter((item) => item.id !== 'trash')
              .map(row)}
            {isIntegratedDesktop && (
              <>
                <button
                  className={!p.directoryOpen && p.activeApp ? 'is-current' : ''}
                  aria-current={!p.directoryOpen && p.activeApp ? 'page' : undefined}
                  disabled={p.disabled}
                  onClick={p.applications}
                >
                  <Icon name="box" size={19} />
                  <span>应用与组件</span>
                </button>
                {row({ id: 'browser', icon: 'compass', label: uiText('浏览器') })}
              </>
            )}
            <button
              className={p.directoryOpen ? 'is-current' : ''}
              aria-pressed={p.directoryOpen}
              title={uiText('文件与区域目录 · 点击定位到画布')}
              disabled={p.disabled}
              onClick={p.directory}
            >
              <Icon name="folder" size={19} />
              <span>{uiText('文件目录')}</span>
            </button>
          </div>
          <details className="sidebar-section sidebar-more-tools" aria-label={uiText('更多工具')}>
            <summary title={uiText('更多工具')}>
              <Icon name="more" size={19} />
              <span>{uiText('更多工具')}</span>
            </summary>
            {toolItems()
              .filter((item) => ['workflows', 'artifacts'].includes(item.id))
              .map(row)}
            {workspaceItems()
              .filter((item) => item.id === 'trash')
              .map(row)}
          </details>
        </nav>
        <div className="rail-bottom">
          <button
            title={uiText('快捷键 · ?')}
            aria-label={uiText('查看快捷键')}
            onClick={p.shortcuts}
          >
            <Icon name="keyboard" size={19} />
            <span>{uiText('快捷键')}</span>
          </button>
          <button
            title={uiText('设置')}
            aria-label={uiText('设置')}
            disabled={p.disabled}
            onClick={() => navigate('tools')}
          >
            <Icon name="settings" size={19} />
            <span>{uiText('设置')}</span>
          </button>
        </div>
      </aside>
      <header className="desk-toolbar">
        <button
          className="sidebar-toggle"
          title={p.collapsed ? uiText('展开侧栏') : uiText('收起侧栏')}
          aria-label={p.collapsed ? uiText('展开侧栏') : uiText('收起侧栏')}
          aria-expanded={!p.collapsed}
          onClick={p.toggleSidebar}
        >
          <Icon name="layout" size={19} />
        </button>
        {isIntegratedDesktop ? (
          <div className="desk-current-page">
            <h1
              title={
                !p.pageTitle && p.active === 'canvas'
                  ? uiText('桌面上共有 {0} 份材料', { '0': p.itemCount })
                  : pageLabel
              }
            >
              {!p.pageTitle && p.active === 'canvas' ? uiText('桌面') : pageLabel}
            </h1>
            {p.saving && (
              <span
                className="desk-save-indicator"
                role="status"
                title={uiText('有待保存的修改')}
                aria-label={uiText('有待保存的修改')}
              />
            )}
          </div>
        ) : (
          <>
            <div className="desk-heading">
              <button className="workspace-title" disabled={p.disabled} onClick={p.workspaces}>
                <strong>{p.workspaceName ?? uiText('工作桌面')}</strong>
                <Icon name="chevron" size={13} />
              </button>
            </div>
            <div className="desk-page-location" aria-label={uiText('当前位置')}>
              <span aria-hidden="true">/</span>
              <strong title={pageLabel}>{pageLabel}</strong>
              {p.saving && (
                <i title={uiText('有待保存的修改')} aria-label={uiText('有待保存的修改')} />
              )}
            </div>
          </>
        )}
        {p.desktopActions && (
          <div className="desk-toolbar-actions">
            <div className="desk-zoom">
              <button
                disabled={p.disabled}
                aria-label={uiText('缩小画布')}
                onClick={() => p.changeZoom(-1)}
              >
                <Icon name="minus" size={15} />
              </button>
              <button
                className="zoom-label"
                disabled={p.disabled}
                title={uiText('适合画布')}
                onClick={p.fit}
              >
                {p.zoom}%
              </button>
              <button
                disabled={p.disabled}
                aria-label={uiText('放大画布')}
                onClick={() => p.changeZoom(1)}
              >
                <Icon name="plus" size={15} />
              </button>
            </div>
            <span className="toolbar-separator" />
            <button
              className="desk-import"
              onClick={() => {
                p.setNewMenu(false);
                setMore(false);
                p.importFiles();
              }}
              disabled={p.disabled}
              title={uiText('导入本地文件或文件夹')}
            >
              <Icon name="upload" size={18} />
              <span>{isIntegratedDesktop ? uiText('导入') : uiText('导入文件')}</span>
            </button>
            <ActionPopover
              label={uiText('新建文件')}
              className="creation-popover"
              open={p.newMenu}
              setOpen={p.setNewMenu}
              disabled={p.disabled}
              trigger={
                <>
                  <Icon name="plus" size={20} />
                  <span>{uiText('新建')}</span>
                </>
              }
            >
              <p className="popover-caption">{uiText('新建')}</p>
              <button
                className="creation-option"
                onClick={() => {
                  p.setNewMenu(false);
                  p.createRegion();
                }}
              >
                <span className="material-glyph tone-blue">
                  <Icon name="folder" size={18} />
                </span>
                <span>
                  <strong>区域</strong>
                  <small>在画布上摆放，整理文件</small>
                </span>
              </button>
              {entries.map((entry) => {
                const look = materialAppearance(entry.kind === 'html' ? 'code' : entry.kind);
                return (
                  <button
                    key={entry.kind}
                    className="creation-option"
                    onClick={() => {
                      p.setNewMenu(false);
                      p.create(entry.kind);
                    }}
                  >
                    <span className={`material-glyph tone-${look.tone}`}>
                      <Icon name={look.icon} size={18} />
                    </span>
                    <span>
                      <strong>{entry.title}</strong>
                      <small>{entry.description}</small>
                    </span>
                  </button>
                );
              })}
            </ActionPopover>
            <ActionPopover
              label={uiText('更多桌面工具')}
              className="toolbar-more"
              open={more}
              setOpen={setMore}
              disabled={p.disabled}
              trigger={<Icon name="more" size={21} />}
            >
              <p className="popover-caption">{uiText('桌面工具')}</p>
              <button
                onClick={() => {
                  setMore(false);
                  p.layouts();
                }}
              >
                <Icon name="layout" />
                {uiText('布局与视图')}
              </button>
              <button onClick={() => navigate('materials')}>
                <Icon name="layers" />
                {uiText('材料管理')}
              </button>
              <button onClick={() => navigate('history')}>
                <Icon name="history" />
                {uiText('活动记录')}
              </button>
              <button
                onClick={() => {
                  setMore(false);
                  p.annotations();
                }}
              >
                <Icon name="pen" />
                {uiText('批注草稿')}
              </button>
              <button
                onClick={() => {
                  setMore(false);
                  p.workspaces();
                }}
              >
                <Icon name="folder" />
                {uiText('工作区与备份')}
              </button>
              <button
                onClick={() => {
                  setMore(false);
                  p.save();
                }}
              >
                <Icon name="save" />
                {uiText('立即保存')}
              </button>
              <div className="popover-version">
                {p.ready ? uiText('本地已连接') : uiText('等待连接')}
              </div>
            </ActionPopover>
          </div>
        )}
      </header>
    </>
  );
}

export function EmptyDesktop({
  create,
  importFiles,
  disabled,
}: {
  create: (kind: CreationKind) => void;
  importFiles: () => void;
  disabled: boolean;
}) {
  useUiLocale();
  return (
    <div className="empty-canvas desk-empty">
      <div className="empty-art" aria-hidden="true">
        <span className="empty-sheet">
          <Icon name="sheet" size={32} />
          <i />
          <i />
        </span>
        <span className="empty-doc">
          <Icon name="document" size={36} />
          <i />
          <i />
          <i />
        </span>
        <span className="empty-picture">
          <Icon name="image" size={31} />
        </span>
      </div>
      <span className="empty-eyebrow">{uiText('想法，在这里展开')}</span>
      <h2>{uiText('给下一件事，一点空间。')}</h2>
      <p>
        {uiText('拖入文件，整理灵感，或从一份新文档开始。')}
        <br />
        {uiText('选中材料，直接问 AI。')}
      </p>
      <div className="empty-actions">
        <button className="primary" disabled={disabled} onClick={importFiles}>
          <Icon name="upload" size={17} />
          {uiText('导入文件')}
        </button>
        <button disabled={disabled} onClick={() => create('text')}>
          <Icon name="plus" size={17} />
          {uiText('新建笔记')}
        </button>
      </div>
      <div className="empty-types">
        <span>DOCX</span>
        <span>XLSX</span>
        <span>PPTX</span>
        <span>PDF</span>
        <span>{uiText('图片与代码')}</span>
      </div>
    </div>
  );
}
