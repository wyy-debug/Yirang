import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { subscribeUiLanguage as onUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import {
  workflowField,
  safeWorkflowPath,
  type WorkflowDocument,
  type WorkflowRun,
} from '../../../packages/contracts/workflows.js';
import { desktopToolDocument } from '../../../packages/contracts/desktop-tools.js';
import { WorkflowRunValues } from './workflow-component-fields.js';
import { Icon } from '../ui/icons.js';
import {
  writeDraftNow,
  scheduleDraftWrite,
  flushDraftStorage,
} from '../documents/draft-storage.js';
import { PanelActionError } from '../host.js';
import { acknowledgeWorkflowRequests } from './workflow-send.js';
import './workflow-widget.css';

export type WorkflowRunOptions = {
  fromRunId: string;
  nodeIds: string[];
  includeDownstream: boolean;
};
type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
type WidgetContext = {
  workspace: Workspace | null;
  disabled: boolean;
  canRun: boolean;
  action: Action;
  updated: () => Promise<void>;
  open: (id: string) => void;
  run: (id: string, revision: number, options?: WorkflowRunOptions) => Promise<boolean>;
  resume: (runId: string) => Promise<boolean>;
  sendRuns: (runIds: string[], continuing?: boolean) => Promise<boolean>;
  checkDelivery?: (dispatchId: string, objectId: string, runIds: string[]) => Promise<void>;
  importFiles: (files: File[], objectId: string, fieldKey: string) => void;
  dirty: (id: string, value: boolean) => void;
};
export const WorkflowWidgetContext = createContext<WidgetContext | null>(null);
type Field = NonNullable<WorkflowDocument['widget']>['fields'][number];
type PendingBatch = { request: Record<string, unknown>; runIds?: string[] };
type Draft = {
  base: number;
  values: Record<string, unknown>;
  pending?: {
    operation: 'save';
    objectId: string;
    expectedRevision: number;
    requestId: string;
    document: WorkflowDocument;
  };
};
const cache = new Map<string, WorkflowDocument>(),
  uid = () => crypto.randomUUID(),
  message = (e: unknown) => (e instanceof Error ? e.message : String(e));
let labels: Record<string, string> = {
  prepared: uiText('已准备'),
  running: uiText('运行中'),
  waiting: uiText('等待处理'),
  succeeded: uiText('已完成'),
  failed: uiText('未完成'),
  pending: uiText('待执行'),
  skipped: uiText('已跳过'),
};
function readDraft(key: string): Draft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
    return raw && Number.isInteger(raw.base) && raw.values && typeof raw.values === 'object'
      ? raw
      : null;
  } catch {
    return null;
  }
}
function fieldValue(document: WorkflowDocument, field: Field) {
  const node = document.nodes.find((node) => node.id === field.nodeId);
  if (!node) return undefined;
  if (field.target === 'value' && (field.type === 'file' || field.type === 'files'))
    return node.config.objectIds ?? [];
  return workflowField(node.config[field.target], field.path);
}
function writePath(source: unknown, path: string | undefined, value: unknown): unknown {
  if (!path) return value;
  if (!safeWorkflowPath(path)) throw new Error(uiText('参数路径无效，请打开组件编辑器调整。'));
  const result = source && typeof source === 'object' ? structuredClone(source) : {},
    parts = path.split('.');
  let current = result as Record<string, unknown>;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) current[part] = value;
    else {
      if (!current[part] || typeof current[part] !== 'object') current[part] = {};
      current = current[part] as Record<string, unknown>;
    }
  });
  return result;
}
function documentWithValues(document: WorkflowDocument, values: Record<string, unknown>) {
  const next = structuredClone(document);
  for (const field of document.widget?.fields ?? []) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const node = next.nodes.find((node) => node.id === field.nodeId);
    if (!node) throw new Error(uiText('参数 {0} 的组件已不存在。', { '0': field.label }));
    const value = values[field.key];
    if (field.target === 'value' && (field.type === 'file' || field.type === 'files')) {
      node.config.objectIds = Array.isArray(value)
        ? value.map(String)
        : value
          ? [String(value)]
          : [];
    } else
      (node.config as Record<string, unknown>)[field.target] = writePath(
        node.config[field.target],
        field.path,
        node.type === 'input' &&
          node.config.inputMode === 'json' &&
          field.target === 'value' &&
          typeof value === 'string'
          ? JSON.parse(value)
          : value,
      );
  }
  return next;
}
function Diagram({
  document,
  open,
  disabled = false,
}: {
  document: WorkflowDocument;
  open: () => void;
  disabled?: boolean;
}) {
  useUiLocale();
  const xs = document.nodes.map((n) => n.position.x),
    ys = document.nodes.map((n) => n.position.y),
    x = Math.min(0, ...xs),
    y = Math.min(0, ...ys),
    width = Math.max(400, ...xs.map((value) => value - x + 180)),
    height = Math.max(220, ...ys.map((value) => value - y + 80));
  return (
    <div className="workflow-widget-unpublished">
      <header>
        <Icon name="workflow" size={17} />
        <strong>{uiText('可编辑流程')}</strong>
        <span>
          {document.nodes.length} {uiText('个组件')}
        </span>
      </header>
      {document.nodes.length ? (
        <svg
          viewBox={`${x - 20} ${y - 20} ${width + 40} ${height + 40}`}
          aria-label={uiText('流程预览')}
        >
          {document.edges.map((edge) => {
            const a = document.nodes.find((n) => n.id === edge.source),
              b = document.nodes.find((n) => n.id === edge.target);
            return a && b ? (
              <path
                key={edge.id}
                d={`M${a.position.x + 150} ${a.position.y + 23} L${b.position.x} ${b.position.y + 23}`}
                stroke="#96adc5"
                strokeWidth="3"
              />
            ) : null;
          })}
          {document.nodes.map((node) => (
            <g key={node.id} transform={`translate(${node.position.x},${node.position.y})`}>
              <rect
                width="150"
                height="46"
                rx="10"
                fill={
                  node.type === 'input' ? '#e1f1eb' : node.type === 'output' ? '#e3ebfa' : '#f0eff7'
                }
                stroke="#d9e0e8"
              />
              <text x="12" y="28" fontSize="14" fill="#344255">
                {node.label.slice(0, 9)}
              </text>
            </g>
          ))}
        </svg>
      ) : (
        <p>{uiText('添加输入、处理和输出，组成自己的小工具。')}</p>
      )}
      <button className="nodrag nopan" disabled={disabled} onClick={open}>
        <Icon name="settings" size={14} />
        {uiText('设计工具流程')}
      </button>
    </div>
  );
}

export function WorkflowWidget({ object }: { object: DesktopObject }) {
  useUiLocale();
  const context = useContext(WorkflowWidgetContext);
  if (!context) return null;
  return <Widget key={`${context.workspace?.id}:${object.id}`} object={object} context={context} />;
}
function Widget({ object, context }: { object: DesktopObject; context: WidgetContext }) {
  useUiLocale();
  const key = `ai-desktop:widget:${context.workspace?.id}:${object.id}`,
    cacheKey = `${object.id}:${object.revision}`;
  const [document, setDocument] = useState<WorkflowDocument | undefined>(() => cache.get(cacheKey)),
    [draft, setDraft] = useState<Draft | null>(() => readDraft(key)),
    [error, setError] = useState('');
  const [working, setWorking] = useState(false),
    [runs, setRuns] = useState<WorkflowRun[]>([]),
    [batches, setBatches] = useState<any[]>([]),
    [showResults, setShowResults] = useState(false),
    [storageError, setStorageError] = useState(''),
    [refreshWarning, setRefreshWarning] = useState('');
  const confirmedRevisionRef = useRef(object.revision),
    [confirmedRevision, setConfirmedRevision] = useState(object.revision);
  const batchKey = `${key}:batch`;
  const [dispatches, setDispatches] = useState<any[]>([]),
    [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(() => {
      try {
        const value = JSON.parse(localStorage.getItem(batchKey) ?? 'null');
        return value &&
          ['prepare_batch', 'retry_batch'].includes(value.request?.operation) &&
          typeof value.request.requestId === 'string' &&
          (!value.runIds ||
            (Array.isArray(value.runIds) &&
              value.runIds.length > 0 &&
              value.runIds.every((id: unknown) => typeof id === 'string')))
          ? value
          : null;
      } catch {
        return null;
      }
    });
  const pendingBatchRef = useRef(pendingBatch);
  pendingBatchRef.current = pendingBatch;
  const current = useRef(context);
  current.current = context;
  const data = useRef(draft);
  data.current = draft;
  const doc = useRef(document);
  doc.current = document;
  const alive = useRef(true),
    active = useRef(false);
  const busy = working || context.disabled,
    fields = document?.widget?.fields ?? [],
    published = !!document?.widget?.enabled && document.nodes.length > 0,
    documentOutdated = object.revision > confirmedRevision,
    stale = !!draft && draft.base !== Math.max(object.revision, confirmedRevision);
  function persist(next: Draft | null, immediate = false) {
    data.current = next;
    setDraft(next);
    current.current.dirty(object.id, !!next);
    try {
      if (immediate) {
        writeDraftNow(key, next ? JSON.stringify(next) : null);
        setStorageError('');
      } else
        scheduleDraftWrite(
          key,
          () => (data.current ? JSON.stringify(data.current) : null),
          (problem) => {
            if (alive.current)
              setStorageError(problem ? uiText('本机草稿未保存，请保留当前页面。') : '');
          },
          900,
        );
    } catch (problem) {
      setStorageError(message(problem));
      throw problem;
    }
  }
  const change = (field: Field, value: unknown) => {
    if (data.current?.pending || active.current || pendingBatch) return;
    const next =
      field.type === 'file' && field.target !== 'value' && Array.isArray(value)
        ? (value[0] ?? '')
        : value;
    persist({
      base: data.current?.base ?? confirmedRevisionRef.current,
      values: { ...data.current?.values, [field.key]: next },
    });
    setError('');
  };
  useEffect(() => {
    alive.current = true;
    current.current.dirty(object.id, !!data.current);
    return () => {
      alive.current = false;
      flushDraftStorage(key);
      current.current.dirty(object.id, false);
    };
  }, []);
  useEffect(() => {
    let live = true;
    const cached = cache.get(cacheKey);
    if (cached && object.revision >= confirmedRevisionRef.current) {
      confirmedRevisionRef.current = object.revision;
      setConfirmedRevision(object.revision);
      doc.current = cached;
      setDocument(cached);
    }
    void current.current
      .action('workflow', { operation: 'read', objectId: object.id })
      .then((result) => {
        if (!live || result.object.revision < confirmedRevisionRef.current) return;
        confirmedRevisionRef.current = result.object.revision;
        setConfirmedRevision(result.object.revision);
        const effective = desktopToolDocument(result.document);
        doc.current = effective;
        setDocument(effective);
        cache.set(`${object.id}:${result.object.revision}`, effective);
        if (cache.size > 60) cache.delete(cache.keys().next().value!);
      })
      .catch((problem) => {
        if (live) setError(message(problem));
      });
    return () => {
      live = false;
    };
  }, [cacheKey]);
  async function loadRuns() {
    const ctx = current.current;
    const [recent, batch, delivery] = await Promise.all([
      ctx.action('workflow', { operation: 'runs', objectId: object.id }),
      ctx.action('workflow', { operation: 'batches', objectId: object.id }),
      ctx.action('workflow_dispatch', { operation: 'list', objectId: object.id }),
    ]);
    if (alive.current) {
      setRuns(recent.runs ?? []);
      setBatches(batch.batches ?? []);
      setDispatches(delivery.dispatches ?? []);
      const pending = pendingBatchRef.current;
      if (
        pending?.runIds?.length &&
        pending.runIds.every(
          (id) =>
            (delivery.dispatches ?? []).some(
              (record: any) =>
                record.state === 'sent' &&
                Array.isArray(record.runIds) &&
                record.runIds.includes(id),
            ) ||
            (recent.runs ?? []).some(
              (run: WorkflowRun) => run.id === id && !run.restoredAt && !!run.reportedAt,
            ),
        )
      ) {
        batchPending(null);
        setShowResults(true);
      }
      if (ctx.workspace)
        acknowledgeWorkflowRequests(ctx.workspace.id, object.id, recent.runs ?? [], delivery.dispatches ?? []);
    }
  }
  useEffect(() => {
    if (!published && !pendingBatch) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (window.document.visibilityState === 'visible' && !active.current) await loadRuns();
      } catch {
      } finally {
        if (!stopped) timer = setTimeout(poll, 4000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [published, !!pendingBatch]);
  useEffect(() => {
    const imported = (event: Event) => {
      const result = (event as CustomEvent).detail;
      if (result?.objectId !== object.id) return;
      const field = doc.current?.widget?.fields.find((field) => field.key === result.fieldKey);
      if (field) {
        const previous =
          data.current?.values[field.key] ?? (doc.current ? fieldValue(doc.current, field) : []);
        change(
          field,
          field.type === 'file'
            ? result.ids.slice(0, 1)
            : [...new Set([...(Array.isArray(previous) ? previous : []), ...result.ids])].slice(
                0,
                10,
              ),
        );
      }
    };
    window.addEventListener('ai-desktop:widget-files', imported);
    return () => window.removeEventListener('ai-desktop:widget-files', imported);
  }, [object.revision, pendingBatch]);
  function validate(document: WorkflowDocument) {
    for (const field of document.widget?.fields ?? []) {
      const value = fieldValue(document, field);
      if (
        field.required &&
        (value === undefined ||
          value === null ||
          value === '' ||
          (Array.isArray(value) && !value.length))
      )
        throw new Error(uiText('请填写 {0}。', { '0': field.label }));
      if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new Error(uiText('{0} 需要有效数字。', { '0': field.label }));
    }
  }
  async function save() {
    if (!doc.current) throw new Error(uiText('小工具尚未加载。'));
    if (object.revision > confirmedRevisionRef.current && !data.current?.pending)
      throw new Error(uiText('正在载入流程最新版本，请稍后再保存或运行。'));
    if (!data.current) return confirmedRevisionRef.current;
    if (!data.current.pending && data.current.base !== confirmedRevisionRef.current)
      throw new Error(uiText('流程已有新版本，当前参数草稿已保留，请先处理版本冲突。'));
    const request = data.current.pending ?? {
      operation: 'save' as const,
      objectId: object.id,
      expectedRevision: confirmedRevisionRef.current,
      requestId: uid(),
      document: documentWithValues(doc.current, data.current.values),
    };
    validate(request.document);
    persist({ ...data.current, pending: request }, true);
    try {
      const result = await current.current.action('workflow', request);
      if (!alive.current) return result.object.revision;
      if (result.object.revision < confirmedRevisionRef.current) {
        persist(null, true);
        await refreshWorkspace(uiText('已确认先前保存 v{0}', { '0': result.object.revision }));
        throw new Error(uiText('先前保存已确认，但流程已有更新版本。请检查当前参数后再运行。'));
      }
      confirmedRevisionRef.current = result.object.revision;
      setConfirmedRevision(result.object.revision);
      setDocument(result.document);
      doc.current = result.document;
      cache.set(`${object.id}:${result.object.revision}`, result.document);
      persist(null, true);
      await refreshWorkspace(uiText('参数已保存'));
      return result.object.revision;
    } catch (problem) {
      if (
        problem instanceof PanelActionError &&
        !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(problem.code) &&
        data.current
      )
        persist({ ...data.current, pending: undefined }, true);
      throw problem;
    }
  }
  async function task(fn: () => Promise<unknown>) {
    if (active.current || current.current.disabled) return;
    active.current = true;
    setWorking(true);
    setError('');
    try {
      await fn();
    } catch (problem) {
      if (alive.current) setError(message(problem));
    } finally {
      active.current = false;
      if (alive.current) {
        setWorking(false);
        void loadRuns().catch(() => {});
      }
    }
  }
  async function refreshWorkspace(successMessage: string) {
    try {
      await current.current.updated();
      if (alive.current) setRefreshWarning('');
    } catch (problem) {
      if (alive.current)
        setRefreshWarning(
          uiText('{0}，桌面刷新暂未完成：{1}。已保留服务器确认的版本和运行记录。', {
            '0': successMessage,
            '1': message(problem),
          }),
        );
    }
  }
  function batchPending(value: PendingBatch | null) {
    writeDraftNow(batchKey, value ? JSON.stringify(value) : null);
    pendingBatchRef.current = value;
    setPendingBatch(value);
  }
  async function resumePendingBatch() {
    let pending = pendingBatchRef.current;
    if (!pending) return;
    // First reconcile delivery evidence. Restoring a UI receipt never starts a new batch.
    await loadRuns().catch(() => {});
    if (!alive.current) return;
    pending = pendingBatchRef.current;
    if (!pending) {
      setShowResults(true);
      return;
    }
    if (!pending.runIds) {
      try {
        const result = await current.current.action('workflow', pending.request);
        pending = { ...pending, runIds: result.runs.map((run: WorkflowRun) => run.id) };
        batchPending(pending);
      } catch (problem) {
        if (
          problem instanceof PanelActionError &&
          !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(problem.code)
        )
          batchPending(null);
        throw problem;
      }
    }
    await loadRuns().catch(() => {});
    if (!alive.current) return;
    pending = pendingBatchRef.current;
    if (!pending) {
      setShowResults(true);
      return;
    }
    await refreshWorkspace(uiText('批次已准备'));
    if (!alive.current) return;
    if (await current.current.sendRuns(pending.runIds!)) batchPending(null);
    setShowResults(true);
  }
  async function retryBatch(batchId: string, itemId: string) {
    if (pendingBatchRef.current) {
      await resumePendingBatch();
      return;
    }
    batchPending({
      request: { operation: 'retry_batch', batchId, itemIds: [itemId], requestId: uid() },
    });
    await resumePendingBatch();
  }
  async function start() {
    if (pendingBatchRef.current) {
      await resumePendingBatch();
      return;
    }
    const revision = await save();
    if (!alive.current || !doc.current) return;
    validate(doc.current);
    if (doc.current.batch) {
      batchPending({
        request: {
          operation: 'prepare_batch',
          objectId: object.id,
          expectedRevision: revision,
          requestId: uid(),
        },
      });
      await resumePendingBatch();
    } else await current.current.run(object.id, revision);
    setShowResults(true);
  }
  const recent = runs[0],
    unknown = dispatches.find(
      (dispatch) =>
        ['claimed', 'unknown'].includes(dispatch.state) &&
        !dispatch.runIds.some((id: string) => {
          const run = runs.find((run) => run.id === id);
          return run?.reportedAt && run.reportedAt > dispatch.createdAt;
        }),
    );
  const recoverableDelivery = unknown?.threadId
    ? unknown
    : !unknown && dispatches.find((dispatch) => dispatch.state === 'prepared');
  const running = dispatches.some(
    (dispatch) =>
      ['claimed', 'unknown', 'sent'].includes(dispatch.state) &&
      dispatch.runIds.some((id: string) =>
        runs.some(
          (run) => run.id === id && !run.restoredAt && ['prepared', 'running'].includes(run.status),
        ),
      ),
  );
  function dropFiles(event: React.DragEvent, field: Field) {
    if (
      !event.dataTransfer.types.some(
        (type) => type === 'Files' || type === 'application/x-ai-desktop-objects',
      )
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (busy || draft?.pending || pendingBatch || documentOutdated) return;
    try {
      const raw = event.dataTransfer.getData('application/x-ai-desktop-objects');
      if (raw) {
        const ids = JSON.parse(raw),
          valid = Array.isArray(ids)
            ? ids.filter((id) =>
                context.workspace?.objects.some(
                  (object) => object.id === id && !object.archived && object.kind === 'file',
                ),
              )
            : [];
        if (!valid.length) throw new Error(uiText('请拖入桌面上的原生文件。'));
        const previous = draft?.values[field.key] ?? fieldValue(document!, field);
        change(
          field,
          field.type === 'file'
            ? valid.slice(0, 1)
            : [...new Set([...(Array.isArray(previous) ? previous : []), ...valid])].slice(0, 10),
        );
      } else if (event.dataTransfer.files.length)
        current.current.importFiles(Array.from(event.dataTransfer.files), object.id, field.key);
    } catch (problem) {
      setError(message(problem));
    }
  }
  const pendingRecovery = pendingBatch && (
    <section className="widget-pending-batch nodrag nopan" role="status">
      <div>
        <strong>{uiText('有一批运行等待确认')}</strong>
        <p>
          {pendingBatch.runIds
            ? uiText('已准备 {0} 项，继续收回投递结果。', { '0': pendingBatch.runIds.length })
            : uiText('沿用上次固定请求收回已准备的批次。')}
          {uiText('不会因当前参数变化而创建新批次。')}
        </p>
      </div>
      <button disabled={busy || !context.canRun} onClick={() => void task(resumePendingBatch)}>
        {working ? uiText('正在恢复…') : uiText('继续上次批次')}
      </button>
      <button disabled={busy} onClick={() => void task(loadRuns)}>
        {uiText('刷新回报')}
      </button>
    </section>
  );
  if (!document)
    return (
      <div
        className="workflow-widget widget-recovery-shell nopan nowheel"
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {pendingRecovery}
        <div className="workflow-widget-placeholder">{error || uiText('正在加载组件…')}</div>
      </div>
    );
  if (!published)
    return (
      <div
        className="workflow-widget widget-recovery-shell nopan nowheel"
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {pendingRecovery}
        {error && (
          <p className="widget-error" role="alert">
            {error}
          </p>
        )}
        <Diagram
          document={document}
          disabled={busy || !!pendingBatch}
          open={() => context.open(object.id)}
        />
      </div>
    );
  return (
    <section
      className="workflow-widget nopan nowheel"
      aria-label={uiText('{0}小工具', { '0': document.widget?.title || document.name })}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="widget-drag-handle" title={uiText('拖动标题移动工具')}>
        <span className="widget-mark">
          <Icon name="box" size={18} />
        </span>
        <div>
          <strong>{document.widget?.title || document.name}</strong>
          <small>
            {document.widget?.description ||
              uiText('{0} 个组件 · v{1}', { '0': document.nodes.length, '1': confirmedRevision })}
          </small>
        </div>
        <button
          className="nodrag nopan"
          title={uiText('高级设置：编辑此工具的原流程')}
          disabled={busy || !!draft || !!pendingBatch || documentOutdated}
          onClick={() => context.open(object.id)}
        >
          <Icon name="settings" size={15} />
        </button>
      </header>
      <div className="widget-body nodrag nopan nowheel">
        {pendingRecovery}
        <fieldset disabled={busy || !!draft?.pending || !!pendingBatch || documentOutdated}>
          {fields.map((field) => {
            const value = Object.prototype.hasOwnProperty.call(draft?.values ?? {}, field.key)
                ? draft?.values[field.key]
                : fieldValue(document, field),
              isFiles = field.type === 'file' || field.type === 'files';
            return (
              <label
                key={field.key}
                className={`widget-field ${isFiles ? 'widget-file-field' : ''}`}
                onDragOver={
                  isFiles
                    ? (event) => {
                        if (
                          !event.dataTransfer.types.some(
                            (type) =>
                              type === 'Files' || type === 'application/x-ai-desktop-objects',
                          )
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = 'copy';
                      }
                    : undefined
                }
                onDrop={isFiles ? (event) => dropFiles(event, field) : undefined}
              >
                <span>
                  {field.label}
                  {field.required && <b> *</b>}
                </span>
                {isFiles ? (
                  <>
                    <select
                      multiple={field.type === 'files'}
                      size={3}
                      value={
                        field.type === 'files'
                          ? Array.isArray(value)
                            ? value.map(String)
                            : value
                              ? [String(value)]
                              : []
                          : Array.isArray(value)
                            ? String(value[0] ?? '')
                            : String(value ?? '')
                      }
                      onChange={(event) =>
                        change(
                          field,
                          Array.from(event.target.selectedOptions, (option) => option.value),
                        )
                      }
                    >
                      {context.workspace?.objects
                        .filter(
                          (item) => item.kind === 'file' && item.id !== object.id && !item.archived,
                        )
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                    </select>
                    <span className="widget-file-drop">
                      {uiText('拖入文件，或从桌面选择')}
                      <input
                        type="file"
                        multiple={field.type === 'files'}
                        aria-label={uiText('导入{0}', { '0': field.label })}
                        onChange={(event) => {
                          const files = Array.from(event.target.files ?? []);
                          if (files.length) context.importFiles(files, object.id, field.key);
                          event.target.value = '';
                        }}
                      />
                    </span>
                  </>
                ) : field.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={!!value}
                    onChange={(event) => change(field, event.target.checked)}
                  />
                ) : field.type === 'select' ? (
                  <select
                    value={String(value ?? '')}
                    onChange={(event) => change(field, event.target.value)}
                  >
                    <option value="">{uiText('请选择…')}</option>
                    {field.options?.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    value={typeof value === 'number' ? value : String(value ?? '')}
                    onChange={(event) =>
                      change(field, event.target.value === '' ? '' : Number(event.target.value))
                    }
                  />
                ) : (
                  <textarea
                    rows={2}
                    value={
                      typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
                    }
                    onChange={(event) => change(field, event.target.value)}
                  />
                )}
              </label>
            );
          })}
        </fieldset>
        {!fields.length && (
          <p className="widget-muted">
            {uiText('此工具使用流程中保存的参数，可在编辑器中选择要展示的字段。')}
          </p>
        )}
        {stale && !draft?.pending && (
          <p className="widget-error">
            {uiText('流程版本已变化，参数草稿保留。')}
            <button onClick={() => persist(null, true)}>{uiText('放弃草稿，采用当前版本')}</button>
          </p>
        )}
        {refreshWarning && (
          <p className="widget-save-warning" role="status">
            {refreshWarning}
          </p>
        )}
        {documentOutdated && <p className="widget-muted">{uiText('正在载入流程新版本…')}</p>}
        {(error || storageError) && (
          <p className="widget-error" role="alert">
            {error || storageError}
          </p>
        )}
        {unknown && (
          <p className="widget-muted">
            {uiText('上次发送结果尚未确认，暂不重复运行。收到原会话回报后更新。')}
          </p>
        )}
        {context.checkDelivery && recoverableDelivery && (
          <button
            disabled={busy || !context.canRun}
            onClick={() => void task(() =>
              context.checkDelivery!(recoverableDelivery.id, object.id, recoverableDelivery.runIds),
            )}
          >
            {recoverableDelivery.state === 'prepared' ? uiText('继续投递') : uiText('核对投递')}
          </button>
        )}
        <div className="widget-actions">
          <button
            disabled={busy || !draft || !!pendingBatch || (documentOutdated && !draft?.pending)}
            onClick={() => void task(save)}
          >
            {draft?.pending ? uiText('确认上次保存') : uiText('保存参数')}
          </button>
          <button
            className="widget-run"
            disabled={
              busy ||
              !context.canRun ||
              (!pendingBatch &&
                (!!unknown ||
                  running ||
                  (stale && !draft?.pending) ||
                  !!storageError ||
                  documentOutdated))
            }
            onClick={() => void task(start)}
          >
            <Icon name="play" size={13} />
            {working
              ? uiText('处理中…')
              : pendingBatch
                ? uiText('继续上次批次')
                : document.batch
                  ? uiText('运行批处理')
                  : uiText('运行')}
          </button>
        </div>
        <button className="widget-results-toggle" onClick={() => setShowResults((value) => !value)}>
          <span className={`widget-state state-${recent?.status ?? 'pending'}`} />
          {recent ? labels[recent.status] : uiText('尚未运行')}
          <span>{showResults ? uiText('收起结果') : uiText('查看结果')}</span>
        </button>
        {showResults && (
          <div className="widget-results">
            <button onClick={() => void task(loadRuns)}>{uiText('刷新结果')}</button>
            {recent && (
              <>
                <p className="widget-muted">
                  {new Date(recent.createdAt).toLocaleString(interfaceLocale())}{' '}
                  {uiText('· 流程 v')}
                  {recent.flowRevision}
                </p>
                {Object.entries(recent.nodes).map(([id, report]) => (
                  <div className="widget-step" key={id}>
                    <strong>{recent.document.nodes.find((node) => node.id === id)?.label}</strong>
                    <span>{labels[report.state]}</span>
                    {report.summary && <p>{report.summary}</p>}
                    {!recent.restoredAt &&
                      report.state === 'waiting' &&
                      recent.document.nodes.find((node) => node.id === id)?.type === 'approval' && (
                        <div className="widget-actions">
                          <button
                            disabled={busy}
                            onClick={() =>
                              void task(async () => {
                                await context.action('workflow', {
                                  operation: 'approve',
                                  runId: recent.id,
                                  nodeId: id,
                                  decision: 'reject',
                                  requestId: uid(),
                                });
                              })
                            }
                          >
                            {uiText('拒绝')}
                          </button>
                          <button
                            disabled={busy || !context.canRun}
                            onClick={() =>
                              void task(async () => {
                                await context.action('workflow', {
                                  operation: 'approve',
                                  runId: recent.id,
                                  nodeId: id,
                                  decision: 'approve',
                                  requestId: uid(),
                                });
                                await context.resume(recent.id);
                              })
                            }
                          >
                            {uiText('确认并继续')}
                          </button>
                        </div>
                      )}
                    <WorkflowRunValues report={report} openFile={context.open} />
                  </div>
                ))}
                {!recent.restoredAt &&
                  ['prepared', 'running', 'waiting'].includes(recent.status) && (
                    <button
                      disabled={busy || !context.canRun || !!unknown}
                      onClick={() =>
                        void task(async () => {
                          await context.resume(recent.id);
                        })
                      }
                    >
                      {uiText('继续原运行')}
                    </button>
                  )}
              </>
            )}
            {batches.map((batch) => (
              <details key={batch.id}>
                <summary>
                  {uiText('批处理 ·')}
                  {batch.items?.length ?? 0} {uiText('个文件')}
                </summary>
                {!batch.restoredAt &&
                  batch.items?.some((item: any) =>
                    ['prepared', 'waiting', 'running'].includes(item.status),
                  ) && (
                    <button
                      disabled={busy || !context.canRun || !!unknown}
                      onClick={() =>
                        void task(async () => {
                          await context.sendRuns(
                            batch.items
                              .filter((item: any) =>
                                ['prepared', 'waiting', 'running'].includes(item.status),
                              )
                              .map((item: any) => item.runId),
                            true,
                          );
                        })
                      }
                    >
                      {uiText('继续未完成项')}
                    </button>
                  )}
                {batch.items?.map((item: any) => (
                  <div className="widget-batch-item" key={item.id}>
                    <span>{item.fileName}</span>
                    <small>{labels[item.status ?? item.run?.status] ?? uiText('已准备')}</small>
                    {!batch.restoredAt && item.status === 'failed' && (
                      <button
                        disabled={busy || !context.canRun}
                        onClick={() => void task(() => retryBatch(batch.id, item.id))}
                      >
                        {uiText('重新执行此项')}
                      </button>
                    )}
                  </div>
                ))}
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  labels = {
    prepared: uiText('已准备'),
    running: uiText('运行中'),
    waiting: uiText('等待处理'),
    succeeded: uiText('已完成'),
    failed: uiText('未完成'),
    pending: uiText('待执行'),
    skipped: uiText('已跳过'),
  };
});
