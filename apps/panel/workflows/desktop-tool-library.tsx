import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useState } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import {
  DESKTOP_TOOL_MIME,
  type DesktopToolSource,
} from '../../../packages/contracts/desktop-tools.js';
import { isWorkflowObject } from './workflow-library.js';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import { Icon } from '../ui/icons.js';
import './desktop-tool-library.css';

export function DesktopToolLibrary({
  workspace,
  busy,
  pending,
  error,
  place,
  resume,
  edit,
  close,
}: {
  workspace: Workspace;
  busy: boolean;
  pending: boolean;
  error: string;
  place: (source: DesktopToolSource, label: string) => void;
  resume: () => void;
  edit: (id: string) => void;
  create: () => void;
  close: () => void;
}) {
  useUiLocale();
  const [query, setQuery] = useState(''),
    [task, setTask] = useState(''),
    [preparing, setPreparing] = useState(false),
    [message, setMessage] = useState('');
  const blocked = busy || pending || preparing,
    term = query.trim().toLocaleLowerCase();
  const all = workspace.objects.filter((object) => !object.archived && isWorkflowObject(object)),
    flows = all.filter((object) => object.title.toLocaleLowerCase().includes(term));
  async function generate() {
    if (blocked || !task.trim()) return;
    setPreparing(true);
    setMessage('');
    try {
      await browserCommand('desktop-tool-task', { workspaceId: workspace.id, task: task.trim() });
      setMessage(uiText('需求已放入 AI 对话，发送后开始生成。'));
      setTask('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  }
  function drag(event: React.DragEvent, id: string) {
    if (blocked) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(
      DESKTOP_TOOL_MIME,
      JSON.stringify({ workspaceId: workspace.id, source: { kind: 'flow', id } }),
    );
    event.dataTransfer.effectAllowed = 'move';
  }
  return (
    <aside
      className="desktop-tool-library"
      aria-label={uiText('我的工具箱')}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <header>
        <span className="tool-library-mark">
          <Icon name="workflow" size={20} />
        </span>
        <div>
          <strong>{uiText('我的工具')}</strong>
        </div>
        <button aria-label={uiText('关闭工具箱')} onClick={close}>
          <Icon name="close" size={17} />
        </button>
      </header>
      <div className="tool-library-generator">
        <label htmlFor="desktop-tool-request">{uiText('你想做什么工具？')}</label>
        <textarea
          id="desktop-tool-request"
          value={task}
          maxLength={6000}
          onChange={(event) => setTask(event.target.value)}
          placeholder={uiText('描述输入材料、处理方式和期望结果…')}
        />
        <button
          className="primary"
          disabled={blocked || !task.trim() || !isIntegratedDesktop}
          onClick={() => void generate()}
        >
          {preparing ? uiText('正在准备…') : uiText('交给 AI 生成')}
        </button>
        <small>
          {isIntegratedDesktop
            ? uiText('生成后自动出现在这里，可拖到桌面使用。')
            : uiText('请在一壤桌面应用中生成工具，或在原对话中描述需求。')}
        </small>
        {message && <p role="status">{message}</p>}
      </div>
      {!!all.length && (
        <div className="tool-library-search">
          <Icon name="search" size={16} />
          <input
            aria-label={uiText('搜索我的工具')}
            placeholder={uiText('搜索我的工具…')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      <div className="tool-library-scroll">
        {pending && (
          <div className="tool-library-pending" role="status">
            <strong>{uiText('上次添加结果待确认')}</strong>
            <button disabled={busy} onClick={resume}>
              {uiText('继续上次添加')}
            </button>
          </div>
        )}
        {error && (
          <p className="tool-library-error" role="alert">
            {error}
          </p>
        )}
        {flows.map((item) => (
          <article
            key={item.id}
            draggable={!blocked}
            onDragStart={(event) => drag(event, item.id)}
            className="desktop-tool-catalog-card"
          >
            <div>
              <Icon name="box" size={20} />
              <span aria-hidden>⠿</span>
            </div>
            <h3>{item.title.replace(/\.flow\.json$/i, '')}</h3>
            <footer>
              <button disabled={blocked} onClick={() => edit(item.id)}>
                {uiText('编辑工具')}
              </button>
              <button
                disabled={blocked}
                onClick={() => place({ kind: 'flow', id: item.id }, item.title)}
              >
                {uiText('定位到桌面')}
                <Icon name="arrow" size={13} />
              </button>
            </footer>
          </article>
        ))}
        {!flows.length && (
          <div className="tool-library-empty">
            <Icon name="box" size={24} />
            <p>
              {all.length
                ? uiText('没有匹配的工具。')
                : uiText('还没有工具。描述一个需求，让 AI 为你创建。')}
            </p>
          </div>
        )}
      </div>
      <footer>
        <small>{uiText('已有工具保留原文件，运行时再选择材料。')}</small>
      </footer>
    </aside>
  );
}
