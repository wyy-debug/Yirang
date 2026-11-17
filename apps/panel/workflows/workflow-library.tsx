import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import type { WorkflowDocument } from '../../../packages/contracts/workflows.js';
import { WORKFLOW_PRESETS, WORKFLOW_RECIPES } from './workflow-catalog.js';
import { writeDraftNow } from '../documents/draft-storage.js';
import { Icon } from '../ui/icons.js';
import './workflow-library.css';

export function isWorkflowObject(object: DesktopObject) {
  return (
    object.kind === 'file' &&
    /\.flow\.json$/i.test((object.content as { fileName?: string }).fileName ?? '')
  );
}
const previewCache = new Map<string, WorkflowDocument>();
export function WorkflowThumbnail({
  object,
  action,
}: {
  object: DesktopObject;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
}) {
  useUiLocale();
  const cacheKey = `${object.id}:${object.revision}`;
  const [document, setDocument] = useState<WorkflowDocument | undefined>(() =>
    previewCache.get(cacheKey),
  );
  const [failed, setFailed] = useState(false),
    actions = useRef(action);
  actions.current = action;
  useEffect(() => {
    let live = true;
    const cached = previewCache.get(cacheKey);
    setDocument(cached);
    setFailed(false);
    if (cached) return;
    void actions
      .current('workflow', { operation: 'read', objectId: object.id })
      .then((result) => {
        if (!live) return;
        const doc = result.document as WorkflowDocument;
        setDocument(doc);
        if (result.object.revision === object.revision) {
          previewCache.set(cacheKey, doc);
          if (previewCache.size > 30) previewCache.delete(previewCache.keys().next().value!);
        }
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [cacheKey]);
  const nodes = document?.nodes ?? [],
    xs = nodes.map((n) => n.position.x),
    ys = nodes.map((n) => n.position.y);
  const minX = xs.length ? Math.min(...xs) : 0,
    minY = ys.length ? Math.min(...ys) : 0,
    width = Math.max(400, ...xs.map((x) => x - minX + 180)),
    height = Math.max(220, ...ys.map((y) => y - minY + 100));
  const colors: Record<string, string> = {
    input: '#3a988c',
    skill: '#8871c2',
    mcp: '#488ec8',
    prompt: '#b18a4b',
    python: '#cf9950',
    browser: '#4d9ca9',
    output: '#6a9b64',
  };
  return (
    <div className="workflow-thumbnail">
      <div>
        <Icon name="workflow" size={14} />
        <strong>{uiText('可编辑流程')}</strong>
        <small>
          {nodes.length} {uiText('个组件')}
        </small>
      </div>
      {nodes.length ? (
        <svg
          viewBox={`${minX - 30} ${minY - 25} ${width + 60} ${height + 50}`}
          aria-label={uiText('流程组件预览')}
        >
          {document!.edges.map((edge) => {
            const a = nodes.find((n) => n.id === edge.source),
              b = nodes.find((n) => n.id === edge.target);
            return a && b ? (
              <path
                key={edge.id}
                d={`M ${a.position.x + 150} ${a.position.y + 30} L ${b.position.x} ${b.position.y + 30}`}
                stroke="#bbc2d2"
                fill="none"
                strokeWidth="2"
              />
            ) : null;
          })}
          {nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.position.x} ${node.position.y})`}>
              <rect width="150" height="60" rx="9" fill="var(--paper,#fff)" stroke="#dde2eb" />
              <rect width="4" height="30" x="0" y="15" rx="2" fill={colors[node.type]} />
              <text x="15" y="25" fill={colors[node.type]} fontSize="10">
                {node.type.toUpperCase()}
              </text>
              <text x="15" y="43" fill="var(--ink,#384054)" fontSize="12">
                {node.label.length > 11 ? node.label.slice(0, 11) + '…' : node.label}
              </text>
            </g>
          ))}
        </svg>
      ) : (
        <p>
          {failed
            ? uiText('打开流程编辑器查看此文件')
            : document
              ? uiText('添加组件，连接你的工作步骤')
              : uiText('正在读取流程…')}
        </p>
      )}
      <span>{document?.description || uiText('展开编辑流程')}</span>
    </div>
  );
}
type TemplateRequest = {
  operation: 'template';
  requestId: string;
  recipeId: string;
  bounds: { x: number; y: number; width: number; height: number };
  objectId?: string;
};
export function WorkflowLibrary({
  workspace,
  open,
  create,
  close,
  busy,
  action,
  created,
}: {
  workspace: Workspace;
  open: (id: string) => void;
  create: () => void;
  close: () => void;
  busy: boolean;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  created: (id: string) => Promise<void>;
}) {
  useUiLocale();
  const [tab, setTab] = useState<'templates' | 'flows'>('templates'),
    [query, setQuery] = useState(''),
    [working, setWorking] = useState(false),
    [error, setError] = useState('');
  const pendingKey = `ai-desktop:workflow-template:${workspace.id}`;
  const [pending, setPending] = useState<TemplateRequest | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(pendingKey) ?? 'null');
      return value?.operation === 'template' &&
        typeof value.requestId === 'string' &&
        WORKFLOW_RECIPES.some((recipe) => recipe.id === value.recipeId) &&
        value.bounds &&
        [value.bounds.x, value.bounds.y, value.bounds.width, value.bounds.height].every(
          Number.isFinite,
        )
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const pendingRef = useRef(pending),
    workingRef = useRef(false),
    mounted = useRef(true);
  pendingRef.current = pending;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const flows = workspace.objects.filter((object) => !object.archived && isWorkflowObject(object)),
    needle = query.trim().toLocaleLowerCase();
  const visibleFlows = flows.filter((flow) => flow.title.toLocaleLowerCase().includes(needle));
  const recipes = WORKFLOW_RECIPES.filter((recipe) =>
    [recipe.name, recipe.description, ...recipe.tags]
      .join(' ')
      .toLocaleLowerCase()
      .includes(needle),
  );
  const blocked = busy || working || !!pending;
  const createTemplate = async (recipeId: string) => {
    if (busy || workingRef.current) return;
    const count = workspace.objects.length,
      request = pendingRef.current ?? {
        operation: 'template' as const,
        requestId: crypto.randomUUID(),
        recipeId,
        bounds: {
          x: 90 + (count % 3) * 460,
          y: 80 + Math.floor(count / 3) * 440,
          width: 380,
          height: 265,
        },
      };
    workingRef.current = true;
    setWorking(true);
    setError('');
    let dispatched = false;
    try {
      writeDraftNow(pendingKey, JSON.stringify(request));
      pendingRef.current = request;
      setPending(request);
      let id = request.objectId;
      if (!id) {
        dispatched = true;
        const { objectId: _, ...payload } = request;
        const result = await action('workflow_component', payload);
        id = result.object.id;
        const received = { ...request, objectId: id };
        pendingRef.current = received;
        setPending(received);
        writeDraftNow(pendingKey, JSON.stringify(received));
      }
      if (!mounted.current) return;
      await created(id!);
      writeDraftNow(pendingKey, null);
      pendingRef.current = null;
      setPending(null);
    } catch (cause) {
      // Keep the exact request after any server call, even a partial rejection:
      // a template can already own source files before its last import failed.
      if (!dispatched && !pendingRef.current) {
        setPending(null);
      }
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(
        `${detail}${dispatched || pendingRef.current ? uiText('；创建记录已保留，请继续同一请求。') : ''}`,
      );
    } finally {
      workingRef.current = false;
      setWorking(false);
    }
  };
  return (
    <section className="workflow-library" role="dialog" aria-label={uiText('流程组件')}>
      <header>
        <button disabled={working} onClick={close} aria-label={uiText('返回桌面')}>
          <Icon name="arrow" />
        </button>
        <div>
          <strong>{uiText('流程组件')}</strong>
        </div>
        <button className="primary" disabled={blocked} onClick={create}>
          <Icon name="plus" size={16} />
          {uiText('空白流程')}
        </button>
      </header>
      <div className="workflow-library-body">
        <div className="workflow-library-intro">
          <span>{uiText('从一个好用的组件开始')}</span>
          <h2>{uiText('把重复的工作，交给流程。')}</h2>
          <p>
            {WORKFLOW_PRESETS.length} {uiText('个内置组件，')}
            {WORKFLOW_RECIPES.length}{' '}
            {uiText('个可编辑模板。整理文本、处理数据、采集网页，把结果留在桌面。')}
          </p>
          <div className="workflow-library-chain">
            <span>
              <Icon name="folder" size={15} />
              {uiText('输入材料')}
            </span>
            <b>→</b>
            <span>
              <Icon name="code" size={15} />
              {uiText('组合组件')}
            </span>
            <b>→</b>
            <span>
              <Icon name="save" size={15} />
              {uiText('原文件回写')}
            </span>
          </div>
        </div>
        {pending && (
          <div className="workflow-template-pending" role="status">
            <div>
              <strong>
                {pending.objectId
                  ? uiText('模板已创建，等待打开')
                  : uiText('有一份模板正在等待创建结果')}
              </strong>
              <p>
                {WORKFLOW_RECIPES.find((recipe) => recipe.id === pending.recipeId)?.name}{' '}
                {uiText('· 继续原请求不会重新生成已有素材。')}
              </p>
            </div>
            <button
              disabled={busy || working}
              onClick={() => void createTemplate(pending.recipeId)}
            >
              {working
                ? uiText('处理中…')
                : pending.objectId
                  ? uiText('打开已创建流程')
                  : uiText('继续创建')}
            </button>
          </div>
        )}
        {error && (
          <p className="workflow-template-error" role="alert">
            {error}
          </p>
        )}
        <div className="workflow-library-controls">
          <div role="tablist" aria-label={uiText('流程库分类')}>
            <button
              role="tab"
              aria-selected={tab === 'templates'}
              onClick={() => setTab('templates')}
            >
              {uiText('推荐模板')}
              <span>{WORKFLOW_RECIPES.length}</span>
            </button>
            <button role="tab" aria-selected={tab === 'flows'} onClick={() => setTab('flows')}>
              {uiText('我的流程')}
              <span>{flows.length}</span>
            </button>
          </div>
          <label>
            <Icon name="search" size={15} />
            <input
              aria-label={uiText('搜索流程或模板')}
              placeholder={uiText('搜索名称、用途…')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {tab === 'templates' ? (
          <div className="workflow-template-grid">
            {recipes.map((recipe) => (
              <article key={recipe.id}>
                <div className="workflow-template-heading">
                  <span className="workflow-library-symbol">
                    <Icon
                      name={
                        recipe.id.includes('csv')
                          ? 'sheet'
                          : recipe.id.includes('web')
                            ? 'desktop'
                            : recipe.id.includes('meeting')
                              ? 'tasks'
                              : 'workflow'
                      }
                      size={24}
                    />
                  </span>
                  <small>
                    {recipe.nodes.length} {uiText('个步骤')}
                  </small>
                </div>
                <h3>{recipe.name}</h3>
                <p>{recipe.description}</p>
                <div className="workflow-template-tags">
                  {recipe.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <div className="workflow-template-steps">
                  {recipe.nodes.map((node, index) => (
                    <React.Fragment key={node.key}>
                      {index > 0 && <Icon name="chevron" size={12} />}
                      <span>
                        {WORKFLOW_PRESETS.find((preset) => preset.id === node.presetId)?.name ??
                          node.presetId}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
                <button disabled={blocked} onClick={() => void createTemplate(recipe.id)}>
                  <Icon name="plus" size={14} />
                  {uiText('使用模板')}
                  <Icon name="arrow" size={14} />
                </button>
              </article>
            ))}
            {!recipes.length && (
              <p className="workflow-library-no-results">
                {uiText('没有匹配的模板，试试「文本」「CSV」或「网页」。')}
              </p>
            )}
          </div>
        ) : visibleFlows.length ? (
          <div className="workflow-library-grid">
            {visibleFlows.map((flow) => (
              <button key={flow.id} disabled={busy || working} onClick={() => open(flow.id)}>
                <span className="workflow-library-symbol">
                  <Icon name="workflow" size={24} />
                </span>
                <strong>{flow.title}</strong>
                <small>
                  v{flow.revision} {uiText('· 本地流程文件')}
                </small>
                <span>
                  {uiText('打开流程编辑器')}
                  <Icon name="arrow" size={14} />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="workflow-library-empty">
            <Icon name="workflow" size={36} />
            <h3>{needle ? uiText('没有找到匹配流程') : uiText('还没有工作流程')}</h3>
            <p>
              {needle
                ? uiText('换个关键词试试。')
                : uiText('从推荐模板开始，或自由组合你需要的组件。')}
            </p>
            <button
              disabled={blocked}
              onClick={() => (needle ? setQuery('') : setTab('templates'))}
            >
              {needle ? uiText('清除搜索') : uiText('浏览模板')}
            </button>
          </div>
        )}
        <p className="workflow-library-footnote">
          {uiText(
            '模板创建 .flow.json、可编辑 Python 源码和结果文件；使用前请填写材料和参数。添加、编辑和保存不会启动执行。',
          )}
        </p>
      </div>
    </section>
  );
}
