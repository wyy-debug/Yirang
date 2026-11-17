import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useWorkspaceRefresh, retainEqual } from '../workspace/workspace-refresh.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import { WorkflowToolSchema } from './workflow-tool-schema.js';
import { WorkflowNestedFields } from './workflow-nested-fields.js';
import { WorkflowPythonEnvironment } from './workflow-python-environment.js';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  useReactFlow,
  type NodeChange,
  type NodePositionChange,
  type Connection,
  type Edge,
} from '@xyflow/react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import {
  WorkflowDocumentSchema,
  WorkflowNodeSchema,
  workflowPorts,
  workflowPortCompatible,
  planWorkflow,
  type WorkflowDocument,
  type WorkflowNode,
  type WorkflowRun,
} from '../../../packages/contracts/workflows.js';
import { WORKFLOW_PRESETS, WORKFLOW_CATEGORIES, type WorkflowPreset } from './workflow-catalog.js';
import { Icon } from '../ui/icons.js';
import {
  scheduleDraftWrite,
  flushDraftStorage,
  writeDraftNow,
} from '../documents/draft-storage.js';
import { PanelActionError } from '../host.js';
import { acknowledgeWorkflowRequests } from './workflow-send.js';
import {
  WorkflowCustomFields,
  WorkflowPortEditor,
  WorkflowParameterForm,
  WorkflowRunValues,
} from './workflow-component-fields.js';
import {
  WorkflowFieldBindings,
  WorkflowParameterDefinition,
  WorkflowExecutionFields,
  WorkflowPublishSettings,
  WorkflowSourceManager,
  WorkflowComponentVersion,
  WorkflowBundleDialog,
} from './workflow-advanced-controls.js';
import {
  expandComponent,
  type WorkflowComponentDefinition,
} from '../../../packages/contracts/workflow-composites.js';
import './workflow-editor.css';
import './workflow-advanced-controls.css';
import {
  argumentError,
  components,
  matchesSearch,
  message,
  nodeTypes,
  presetPorts,
  stateLabels,
} from './workflow-node-parts.js';
import type { FlowNode, NodeKind } from './workflow-node-parts.js';

type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export type WorkflowEditorProps = {
  workspace: Workspace;
  object: DesktopObject;
  action: Action;
  updated: () => Promise<void>;
  close: () => void;
  handoff: (
    objectId: string,
    expectedRevision: number,
    options?: { fromRunId: string; nodeIds: string[]; includeDownstream: boolean },
  ) => Promise<boolean>;
  canHandoff: boolean;
  canSend?: boolean;
  dirtyChanged?: (dirty: boolean) => void;
  openObject?: (id: string) => void;
  recover?: (runId: string) => Promise<boolean>;
  sendRuns?: (runIds: string[]) => Promise<boolean>;
};
export const workflowDraftKey = (id: string) => `ai-desktop:workflow-draft:${id}`;
export function hasWorkflowDraft(id: string) {
  try {
    return !!localStorage.getItem(workflowDraftKey(id));
  } catch {
    return false;
  }
}
type Catalog = {
  skills: { id: string; name: string; description: string; path: string }[];
  tools: {
    name: string;
    description: string;
    server: string;
    available?: boolean;
    inputSchema?: any;
  }[];
  capturedAt?: string;
  source?: string;
};
type LibraryComponent = { object: DesktopObject; definition: WorkflowComponentDefinition };
type PendingSave = { requestId: string; expectedRevision: number; document: unknown };
type PendingInstantiation = {
  operation: 'instantiate';
  requestId: string;
  presetId: string;
  position: { x: number; y: number };
};
type Draft = {
  baseRevision: number;
  document: WorkflowDocument;
  argumentDrafts?: Record<string, string>;
  pendingSave?: PendingSave;
  pendingInstantiation?: PendingInstantiation;
};
export function WorkflowEditor(props: WorkflowEditorProps) {
  useUiLocale();
  const content = (
    <ReactFlowProvider>
      <WorkflowEditorBody {...props} />
    </ReactFlowProvider>
  );
  return isIntegratedDesktop ? content : createPortal(content, document.body);
}

function WorkflowEditorBody(props: WorkflowEditorProps) {
  useUiLocale();
  const { workspace, object, canHandoff } = props,
    callbacks = useRef(props);
  callbacks.current = props;
  const [document, setDocument] = useState<WorkflowDocument | null>(null),
    documentRef = useRef<WorkflowDocument | null>(null);
  const [revision, setRevision] = useState(object.revision),
    revisionRef = useRef(object.revision),
    [savedSignature, setSavedSignature] = useState('');
  const [selected, setSelected] = useState<string | null>(null),
    [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const batchKey = `ai-desktop:workflow-batch-pending:${workspace.id}:${object.id}`;
  const [batchPending, setBatchPending] = useState<{
    request: Record<string, unknown>;
    runIds?: string[];
  } | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(batchKey) ?? 'null');
      return value?.request?.operation === 'prepare_batch' &&
        typeof value.request.requestId === 'string'
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]),
    [bundleDialog, setBundleDialog] = useState<{ entry?: LibraryComponent } | null>(null);
  const history = useRef<{ past: WorkflowDocument[]; future: WorkflowDocument[]; lastAt: number }>({
      past: [],
      future: [],
      lastAt: 0,
    }),
    [, setHistoryTick] = useState(0);
  const [argumentDrafts, setArgumentDrafts] = useState<Record<string, string>>({}),
    argumentRef = useRef(argumentDrafts);
  argumentRef.current = argumentDrafts;
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null),
    pendingSaveRef = useRef<PendingSave | null>(null),
    creationRequests = useRef<Record<string, Record<string, unknown>>>({});
  const [pendingInstantiation, setPendingInstantiation] = useState<PendingInstantiation | null>(
    null,
  );
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false),
    [sourceBusy, setSourceBusy] = useState(false),
    sourceBusyRef = useRef(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false),
    [recoveryBlocked, setRecoveryBlocked] = useState(false),
    [leaseBlocked, setLeaseBlocked] = useState(false),
    [attempt, setAttempt] = useState(0),
    [runs, setRuns] = useState<WorkflowRun[]>([]),
    [runId, setRunId] = useState('');
  const [catalog, setCatalog] = useState<Catalog>({ skills: [], tools: [] }),
    [catalogError, setCatalogError] = useState(''),
    [catalogBusy, setCatalogBusy] = useState(false),
    [search, setSearch] = useState(''),
    [materialSearch, setMaterialSearch] = useState('');
  const [personalComponents, setPersonalComponents] = useState<LibraryComponent[]>([]),
    [libraryError, setLibraryError] = useState(''),
    [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryTab, setLibraryTab] = useState<'presets' | 'basic' | 'personal' | 'installed'>(
      'personal',
    ),
    [category, setCategory] = useState<'all' | WorkflowPreset['category']>('all');
  const [showRuns, setShowRuns] = useState(false),
    dialog = useRef<HTMLElement>(null),
    closeButton = useRef<HTMLButtonElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    flowRoot = useRef<HTMLDivElement>(null);
  const flow = useReactFlow(),
    dirtyRef = useRef(false),
    mounted = useRef(true),
    draftKey = workflowDraftKey(object.id);
  const invalidArguments = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(argumentDrafts)
          .filter(
            ([id, value]) =>
              document?.nodes.some(
                (node) =>
                  id === node.id ||
                  ['value', 'parameters', 'arguments', 'argumentBindings'].some(
                    (field) => id === `${field}:${node.id}`,
                  ),
              ) && argumentError(value, !id.startsWith('value:')),
          )
          .map(([id, value]) => [id, argumentError(value, !id.startsWith('value:'))]),
      ),
    [argumentDrafts, document, getUiLocale()],
  );
  const dirty =
    !!document &&
    (JSON.stringify(document) !== savedSignature ||
      Object.keys(invalidArguments).length > 0 ||
      !!pendingSave ||
      !!pendingInstantiation);
  dirtyRef.current = dirty;
  const plan = useMemo(() => (document ? planWorkflow(document) : null), [document, getUiLocale()]);
  const unavailableIds = useMemo(
    () =>
      plan?.objectIds.filter((id) => !workspace.objects.some((material) => material.id === id)) ??
      [],
    [plan, workspace.objects, getUiLocale()],
  );
  const activeRun = runs.find((run) => run.id === runId) ?? runs[0],
    selectedNode = document?.nodes.find((node) => node.id === selected),
    selectedConnection = document?.edges.find((edge) => edge.id === selectedEdge);
  const canSubmit = document?.batch || batchPending ? !!props.canSend : canHandoff;
  const editable =
      !loading &&
      !busy &&
      !sourceBusy &&
      !leaseBlocked &&
      !stale &&
      !recoveryBlocked &&
      !pendingSave &&
      !pendingInstantiation &&
      !batchPending,
    editableRef = useRef(editable);
  editableRef.current = editable;
  const update = useCallback((change: (document: WorkflowDocument) => WorkflowDocument) => {
    if (busyRef.current || !documentRef.current) return;
    const before = documentRef.current,
      next = change(before);
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    const now = Date.now();
    if (now - history.current.lastAt > 500 || history.current.future.length)
      history.current.past = [...history.current.past, before].slice(-60);
    history.current.future = [];
    history.current.lastAt = now;
    setHistoryTick((value) => value + 1);
    documentRef.current = next;
    setDocument(next);
    setNotice('');
  }, []);
  const undo = (redo = false) => {
    if (!editableRef.current || !documentRef.current) return;
    const h = history.current,
      list = redo ? h.future : h.past,
      target = list.at(-1);
    if (!target) return;
    if (redo) {
      h.future = h.future.slice(0, -1);
      h.past = [...h.past, documentRef.current].slice(-60);
    } else {
      h.past = h.past.slice(0, -1);
      h.future = [...h.future, documentRef.current].slice(-60);
    }
    h.lastAt = 0;
    documentRef.current = target;
    setDocument(target);
    setArgumentDrafts({});
    setSelected(null);
    setSelectedIds([]);
    setSelectedEdge(null);
    setHistoryTick((value) => value + 1);
    setNotice(
      redo
        ? uiText('已重做流程修改，保存后回写文件。')
        : uiText('已撤销流程修改，保存后回写文件。文件内容和已执行的操作不会随流程撤销。'),
    );
  };
  const changeNode = (id: string, change: Partial<WorkflowNode>) =>
    update((value) => ({
      ...value,
      nodes: value.nodes.map((node) => (node.id === id ? { ...node, ...change } : node)),
    }));
  const config = (change: Partial<WorkflowNode['config']>) => {
    if (selectedNode)
      changeNode(selectedNode.id, { config: { ...selectedNode.config, ...change } });
  };

  useEffect(() => {
    callbacks.current.dirtyChanged?.(dirty || busy || sourceBusy);
  }, [dirty, busy, sourceBusy]);
  useEffect(() => {
    if (!document || loading || stale || recoveryBlocked) return;
    const draft: Draft = {
      baseRevision: revisionRef.current,
      document,
      argumentDrafts,
      pendingSave: pendingSave ?? undefined,
      pendingInstantiation: pendingInstantiation ?? undefined,
    };
    scheduleDraftWrite(
      draftKey,
      () => (dirty ? JSON.stringify(draft) : null),
      (cause) => {
        if (cause && mounted.current)
          setError(
            uiText('本地草稿保存失败：{0}。请导出 JSON 保留修改。', { '0': message(cause) }),
          );
      },
    );
  }, [
    document,
    argumentDrafts,
    dirty,
    loading,
    stale,
    recoveryBlocked,
    draftKey,
    pendingSave,
    pendingInstantiation,
  ]);
  useEffect(() => {
    let live = true;
    mounted.current = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const lease = await callbacks.current.action('native_workbench', {
          operation: 'editor_lease',
          command: 'acquire',
          objectId: object.id,
          dirty: hasWorkflowDraft(object.id),
        });
        if (!lease.acquired) {
          setLeaseBlocked(true);
          throw Error(uiText('此文件正在另一个面板编辑，请关闭那里的编辑页后重试。'));
        }
        if (!live) return;
        setLeaseBlocked(false);
        const result = await callbacks.current.action('workflow', {
          operation: 'read',
          objectId: object.id,
        });
        if (!live) return;
        const fileDocument = WorkflowDocumentSchema.parse(result.document);
        let current = fileDocument,
          base = result.object.revision,
          draftArgs: Record<string, string> = {},
          pending: PendingSave | null = null;
        try {
          const raw = localStorage.getItem(draftKey);
          delete creationRequests.current.preset;
          setPendingInstantiation(null);
          if (raw) {
            const draft = JSON.parse(raw) as Draft;
            current = WorkflowDocumentSchema.parse(draft.document);
            if (!Number.isInteger(draft.baseRevision) || draft.baseRevision < 1)
              throw Error(uiText('草稿版本无效'));
            base = draft.baseRevision;
            draftArgs = Object.fromEntries(
              Object.entries(draft.argumentDrafts ?? {})
                .filter(([, value]) => typeof value === 'string')
                .map(([key, value]) => [
                  current.nodes.some((node) => node.id === key && node.type === 'mcp')
                    ? `arguments:${key}`
                    : key,
                  value,
                ]),
            );
            if (draft.pendingSave) {
              if (
                typeof draft.pendingSave.requestId !== 'string' ||
                !Number.isInteger(draft.pendingSave.expectedRevision)
              )
                throw Error(uiText('待确认保存信息无效'));
              WorkflowDocumentSchema.parse(draft.pendingSave.document);
              pending = { ...draft.pendingSave };
            }
            if (draft.pendingInstantiation) {
              const request = draft.pendingInstantiation;
              if (
                request.operation !== 'instantiate' ||
                typeof request.requestId !== 'string' ||
                !request.requestId ||
                !WORKFLOW_PRESETS.some((item) => item.id === request.presetId) ||
                !Number.isFinite(request.position?.x) ||
                !Number.isFinite(request.position?.y) ||
                pending
              )
                throw Error(uiText('待确认组件信息无效'));
              creationRequests.current.preset = request;
              setPendingInstantiation(request);
            }
            setNotice(
              pending
                ? uiText('上次保存的响应未确认，请点击「重试保存」收回同一请求的结果。')
                : draft.pendingInstantiation
                  ? uiText('上次组件添加的响应未确认，请恢复同一请求以收回节点和源码。')
                  : uiText('已恢复本地未保存草稿。'),
            );
          }
          setRecoveryBlocked(false);
        } catch (cause) {
          setRecoveryBlocked(true);
          setError(
            uiText('无法恢复本地草稿：{0}。原草稿仍保留在浏览器中。', { '0': message(cause) }),
          );
        }
        pendingSaveRef.current = pending;
        setPendingSave(pending);
        setStale(base !== result.object.revision && !pending);
        revisionRef.current = base;
        setRevision(base);
        setSavedSignature(JSON.stringify(fileDocument));
        documentRef.current = current;
        setDocument(current);
        setArgumentDrafts(draftArgs);
        setSelected(null);
        setSelectedIds([]);
        history.current = { past: [], future: [], lastAt: 0 };
        setHistoryTick((value) => value + 1);
        requestAnimationFrame(() => {
          if (live) void flow.fitView({ padding: 0.24, duration: 0 });
        });
      } catch (cause) {
        if (live) setError(message(cause));
      } finally {
        if (live) setLoading(false);
      }
    })();
    const heartbeat = setInterval(() => {
      void callbacks.current
        .action('native_workbench', {
          operation: 'editor_lease',
          command: 'acquire',
          objectId: object.id,
          dirty: dirtyRef.current,
        })
        .then((result) => {
          if (live && !result.acquired) {
            setLeaseBlocked(true);
            setError(uiText('编辑权已被另一个面板占用。当前草稿已保留，重新取得编辑权后再保存。'));
          }
        })
        .catch((cause) => {
          if (live) {
            setLeaseBlocked(true);
            setError(uiText('暂时无法续期编辑状态：{0}', { '0': message(cause) }));
          }
        });
    }, 20000);
    return () => {
      live = false;
      mounted.current = false;
      clearInterval(heartbeat);
      flushDraftStorage(draftKey);
      void callbacks.current
        .action('native_workbench', {
          operation: 'editor_lease',
          command: 'release',
          objectId: object.id,
        })
        .catch(() => {});
    };
  }, [object.id, attempt]);

  const loadRuns = useCallback(async () => {
    try {
      const result = await callbacks.current.action('workflow', {
        operation: 'runs',
        objectId: object.id,
      });
      if (mounted.current) {
        const received: WorkflowRun[] = result.runs ?? [];
        setRuns(received);
        acknowledgeWorkflowRequests(workspace.id, object.id, received);
        try {
          const pending = JSON.parse(localStorage.getItem(batchKey) ?? 'null');
          if (
            pending?.runIds?.some((id: string) =>
              received.some((run) => run.id === id && run.reportedAt),
            )
          ) {
            writeDraftNow(batchKey, null);
            setBatchPending(null);
          }
        } catch {}
      }
    } catch (cause) {
      if (mounted.current) setError(uiText('运行记录读取失败：{0}', { '0': message(cause) }));
    }
  }, [object.id, workspace.id, batchKey]);
  useEffect(() => {
    void loadRuns();
    const timer = setInterval(() => {
      if (!window.document.hidden) void loadRuns();
    }, 6000);
    return () => clearInterval(timer);
  }, [loadRuns]);
  const loadCatalog = async () => {
    setCatalogBusy(true);
    setCatalogError('');
    try {
      const result = await callbacks.current.action('workflow_catalog');
      if (mounted.current)
        setCatalog({
          skills: result.skills ?? [],
          tools: result.tools ?? [],
          capturedAt: result.capturedAt,
          source: result.source,
        });
    } catch (cause) {
      if (mounted.current) setCatalogError(message(cause));
    } finally {
      if (mounted.current) setCatalogBusy(false);
    }
  };
  useEffect(() => {
    void loadCatalog();
  }, []);

  const save = async (): Promise<number | null> => {
    if (
      !documentRef.current ||
      busyRef.current ||
      sourceBusyRef.current ||
      leaseBlocked ||
      stale ||
      recoveryBlocked
    )
      return null;
    if (creationRequests.current.preset) {
      setError(uiText('请先恢复待确认的组件添加请求，再保存工作流。'));
      return null;
    }
    if (Object.keys(invalidArguments).length) {
      setError(uiText('请先修正组件参数或输入中的 JSON 格式。'));
      return null;
    }
    if (!dirtyRef.current) return revisionRef.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const request = pendingSaveRef.current ?? {
      requestId: crypto.randomUUID(),
      expectedRevision: revisionRef.current,
      document: documentRef.current,
    };
    pendingSaveRef.current = request;
    setPendingSave(request);
    try {
      writeDraftNow(
        draftKey,
        JSON.stringify({
          baseRevision: revisionRef.current,
          document: documentRef.current,
          argumentDrafts: argumentRef.current,
          pendingSave: request,
        } satisfies Draft),
      );
      const result = await callbacks.current.action('workflow', {
        operation: 'save',
        objectId: object.id,
        ...request,
      });
      const next = WorkflowDocumentSchema.parse(result.document);
      documentRef.current = next;
      setDocument(next);
      revisionRef.current = result.object.revision;
      setRevision(result.object.revision);
      setSavedSignature(JSON.stringify(next));
      setArgumentDrafts({});
      pendingSaveRef.current = null;
      setPendingSave(null);
      dirtyRef.current = false;
      callbacks.current.dirtyChanged?.(false);
      writeDraftNow(draftKey, null);
      setNotice(uiText('已保存回原工作流文件。'));
      try {
        await callbacks.current.updated();
      } catch (cause) {
        setError(uiText('工作流已保存，但桌面刷新失败：{0}', { '0': message(cause) }));
      }
      return result.object.revision;
    } catch (cause) {
      if (cause instanceof PanelActionError) {
        pendingSaveRef.current = null;
        setPendingSave(null);
        try {
          writeDraftNow(
            draftKey,
            JSON.stringify({
              baseRevision: revisionRef.current,
              document: documentRef.current,
              argumentDrafts: argumentRef.current,
            }),
          );
        } catch {}
        if (cause.code.includes('REVISION') || cause.code.includes('CONFLICT')) setStale(true);
        setError(uiText('保存未完成：{0}。草稿仍保留，可导出 JSON。', { '0': message(cause) }));
      } else
        setError(
          uiText('保存响应未确认：{0}。请点击「重试保存」，继续同一请求；也可导出 JSON。', {
            '0': message(cause),
          }),
        );
      flushDraftStorage(draftKey);
      return null;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const deliverBatch = async (saved: number) => {
    if (!callbacks.current.canSend || !callbacks.current.sendRuns)
      throw Error(uiText('当前面板无法发送批处理运行，请重新打开工作桌面。'));
    let pending = batchPending ?? {
      request: {
        operation: 'prepare_batch',
        objectId: object.id,
        expectedRevision: saved,
        requestId: crypto.randomUUID(),
      },
    };
    writeDraftNow(batchKey, JSON.stringify(pending));
    setBatchPending(pending);
    if (!pending.runIds) {
      const result = await callbacks.current.action('workflow', pending.request);
      pending = { ...pending, runIds: result.runs.map((run: WorkflowRun) => run.id) };
      writeDraftNow(batchKey, JSON.stringify(pending));
      setBatchPending(pending);
    }
    try {
      await callbacks.current.updated();
    } catch {
      setNotice(uiText('批次已准备，桌面列表暂未刷新。'));
    }
    if (await callbacks.current.sendRuns(pending.runIds!)) {
      writeDraftNow(batchKey, null);
      setBatchPending(null);
      return true;
    }
    return false;
  };
  const send = async (options?: {
    fromRunId: string;
    nodeIds: string[];
    includeDownstream: boolean;
  }) => {
    const saved = batchPending && !options ? revisionRef.current : await save();
    if (saved === null || !documentRef.current) return;
    const check = planWorkflow(documentRef.current);
    if (!check.valid && !batchPending) {
      setError(check.issues.join('；'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const sent =
        !options && (documentRef.current.batch || batchPending)
          ? await deliverBatch(saved)
          : await callbacks.current.handoff(object.id, saved, options);
      if (sent) {
        setNotice(uiText('已交给 Codex 原对话处理，可在桌面继续查看状态和结果。'));
        setShowRuns(true);
        await loadRuns();
      }
    } catch (cause) {
      if (cause instanceof PanelActionError && batchPending && !batchPending.runIds) {
        writeDraftNow(batchKey, null);
        setBatchPending(null);
      }
      setError(message(cause));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const decide = async (nodeId: string, decision: 'approve' | 'reject') => {
    if (!activeRun || busyRef.current) return;
    const key = `ai-desktop:workflow-approval:${activeRun.id}:${nodeId}`;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      let request: Record<string, unknown>;
      const raw = localStorage.getItem(key);
      request = raw
        ? JSON.parse(raw)
        : {
            operation: 'approve',
            runId: activeRun.id,
            nodeId,
            decision,
            requestId: crypto.randomUUID(),
          };
      writeDraftNow(key, JSON.stringify(request));
      await callbacks.current.action('workflow', request);
      writeDraftNow(key, null);
      await loadRuns();
      setNotice(
        request.decision === 'approve'
          ? uiText('已批准此步骤。点击「交回原对话继续」继续已有运行。')
          : uiText('已拒绝此步骤，后续处理停止。'),
      );
    } catch (cause) {
      if (cause instanceof PanelActionError) writeDraftNow(key, null);
      setError(message(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const download = () => {
    if (!documentRef.current) return;
    const blob = new Blob([JSON.stringify(documentRef.current, null, 2) + '\n'], {
        type: 'application/json',
      }),
      url = URL.createObjectURL(blob),
      anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${(documentRef.current.name || 'workflow').replace(/[\\/:*?"<>|]/g, '_')}.flow.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importJson = async (file: File) => {
    if (file.size > 1024 * 1024) {
      setError(uiText('工作流 JSON 最大支持 1 MiB。'));
      return;
    }
    try {
      const parsed = WorkflowDocumentSchema.parse(JSON.parse(await file.text()));
      update(() => parsed);
      setArgumentDrafts({});
      setSelected(null);
      setSelectedIds([]);
      setSelectedEdge(null);
      setNotice(uiText('已导入为当前文件的草稿，保存后回写当前对象。'));
      requestAnimationFrame(() => void flow.fitView({ padding: 0.25 }));
    } catch (cause) {
      setError(
        uiText('无法导入：{0}。请选择 Yirang 的 .flow.json 文件。', { '0': message(cause) }),
      );
    }
  };
  const addNode = (type: NodeKind, at?: { x: number; y: number }) => {
    if (!editableRef.current) return;
    if ((documentRef.current?.nodes.length ?? 0) >= 80) {
      setError(uiText('一个工作流最多包含 80 个组件。'));
      return;
    }
    const bounds = flowRoot.current?.getBoundingClientRect(),
      position = flow.screenToFlowPosition(
        at ?? {
          x: (bounds?.left ?? 0) + (bounds?.width ?? 700) / 2 - 100,
          y: (bounds?.top ?? 0) + (bounds?.height ?? 500) / 2 - 60,
        },
      ),
      spec = components.find((item) => item.type === type)!,
      id = crypto.randomUUID();
    update((value) => ({
      ...value,
      nodes: [
        ...value.nodes,
        {
          id,
          type,
          label: spec.name,
          position,
          config:
            type === 'mcp'
              ? { arguments: {} }
              : type === 'python'
                ? { entryFunction: 'run', parameters: {} }
                : type === 'browser'
                  ? { browserAction: 'open' }
                  : type === 'output'
                    ? { outputName: uiText('工作流结果.md') }
                    : type === 'condition'
                      ? { condition: { inputPort: 'input', operator: 'truthy' } }
                      : type === 'extract'
                        ? {
                            parameters: {
                              format: 'auto',
                              worksheet: '',
                              range: '',
                              header_row: true,
                              paragraphs: '',
                              pages: '',
                              include_empty: false,
                            },
                          }
                        : type === 'chart'
                          ? {
                              parameters: {
                                chart_type: 'bar',
                                x_column: '',
                                y_columns: [],
                                title: '',
                                width: 900,
                                height: 520,
                                aggregate: 'first',
                              },
                            }
                          : {},
        },
      ],
    }));
    setSelected(id);
    setSelectedIds([id]);
    setSelectedEdge(null);
  };
  const removeSelection = () => {
    if (!editableRef.current) return;
    const ids = selectedIds.length ? selectedIds : selected ? [selected] : [];
    if (ids.length) {
      const removed = new Set(ids);
      update((value) => ({
        ...value,
        nodes: value.nodes.filter((node) => !removed.has(node.id)),
        edges: value.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)),
        widget: value.widget
          ? {
              ...value.widget,
              fields: value.widget.fields.filter((field) => !removed.has(field.nodeId)),
            }
          : undefined,
        batch: value.batch && removed.has(value.batch.inputNodeId) ? undefined : value.batch,
      }));
      setArgumentDrafts((value) =>
        Object.fromEntries(
          Object.entries(value).filter(
            ([key]) => !ids.some((id) => key === id || key.endsWith(`:${id}`)),
          ),
        ),
      );
      setSelected(null);
      setSelectedIds([]);
    } else if (selectedEdge) {
      update((value) => ({
        ...value,
        edges: value.edges.filter((edge) => edge.id !== selectedEdge),
      }));
      setSelectedEdge(null);
    }
  };
  const duplicate = () => {
    if (!editableRef.current || !documentRef.current) return;
    const ids = selectedIds.length ? selectedIds : selected ? [selected] : [],
      sources = documentRef.current.nodes.filter((node) => ids.includes(node.id));
    if (!sources.length) return;
    if (documentRef.current.nodes.length + sources.length > 80) {
      setError(uiText('一个工作流最多包含 80 个组件。'));
      return;
    }
    const mapping = new Map(sources.map((node) => [node.id, crypto.randomUUID()]));
    update((value) => ({
      ...value,
      nodes: [
        ...value.nodes,
        ...sources.map((node) => ({
          ...structuredClone(node),
          id: mapping.get(node.id)!,
          label: uiText('{0} 副本', { '0': node.label.slice(0, 116) }),
          position: {
            x: Math.min(100000, node.position.x + 42),
            y: Math.min(100000, node.position.y + 72),
          },
        })),
      ],
      edges: [
        ...value.edges,
        ...value.edges
          .filter((edge) => mapping.has(edge.source) && mapping.has(edge.target))
          .map((edge) => ({
            ...edge,
            id: crypto.randomUUID(),
            source: mapping.get(edge.source)!,
            target: mapping.get(edge.target)!,
          })),
      ],
    }));
    setSelectedIds([...mapping.values()]);
    setSelected([...mapping.values()].at(-1)!);
    setSelectedEdge(null);
    setNotice(uiText('已复制选中组件及内部连线；源码和材料引用保持，可在源码设置中独立复制。'));
  };
  const arrange = () => {
    if (!editableRef.current || !documentRef.current?.nodes.length) return;
    const current = documentRef.current,
      order = new Map(current.nodes.map((node, index) => [node.id, index])),
      remaining = new Map(current.nodes.map((node) => [node.id, 0])),
      levels = new Map(current.nodes.map((node) => [node.id, 0])),
      outgoing = new Map(current.nodes.map((node) => [node.id, [] as string[]]));
    for (const edge of current.edges)
      if (remaining.has(edge.source) && remaining.has(edge.target)) {
        remaining.set(edge.target, remaining.get(edge.target)! + 1);
        outgoing.get(edge.source)!.push(edge.target);
      }
    const queue = current.nodes
        .filter((node) => remaining.get(node.id) === 0)
        .map((node) => node.id),
      seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      seen.add(id);
      for (const target of outgoing.get(id) ?? []) {
        levels.set(target, Math.max(levels.get(target)!, levels.get(id)! + 1));
        remaining.set(target, remaining.get(target)! - 1);
        if (remaining.get(target) === 0) queue.push(target);
      }
    }
    if (seen.size !== current.nodes.length) {
      setError(uiText('存在循环连接，暂时无法按流程整理布局，请先调整连线。'));
      return;
    }
    const columns = new Map<number, WorkflowNode[]>();
    for (const node of current.nodes) {
      const level = levels.get(node.id)!;
      columns.set(level, [...(columns.get(level) ?? []), node]);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [level, nodes] of columns) {
      let y = 60;
      nodes.sort((a, b) => a.position.y - b.position.y || order.get(a.id)! - order.get(b.id)!);
      for (const node of nodes) {
        positions.set(node.id, { x: 60 + level * 340, y });
        const ports = workflowPorts(node);
        y += 186 + Math.max(ports.inputs.length, ports.outputs.length) * 30;
      }
    }
    update((value) => ({
      ...value,
      nodes: value.nodes.map((node) => ({ ...node, position: positions.get(node.id)! })),
    }));
    setNotice(uiText('已按连接顺序整理布局，保存后保留新的位置。'));
    requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 240 }));
  };
  const addPreset = async (preset: WorkflowPreset, at?: { x: number; y: number }) => {
    const existing = creationRequests.current.preset as PendingInstantiation | undefined;
    if (
      !documentRef.current ||
      busyRef.current ||
      loading ||
      leaseBlocked ||
      stale ||
      recoveryBlocked ||
      pendingSaveRef.current ||
      (!existing && !editableRef.current)
    )
      return;
    if (documentRef.current.nodes.length >= 80) {
      setError(uiText('一个工作流最多包含 80 个组件。'));
      return;
    }
    const bounds = flowRoot.current?.getBoundingClientRect(),
      request: PendingInstantiation = existing ?? {
        operation: 'instantiate',
        requestId: crypto.randomUUID(),
        presetId: preset.id,
        position: flow.screenToFlowPosition(
          at ?? {
            x: (bounds?.left ?? 0) + (bounds?.width ?? 700) / 2 - 129,
            y: (bounds?.top ?? 0) + (bounds?.height ?? 500) / 2 - 70,
          },
        ),
      };
    creationRequests.current.preset = request;
    setPendingInstantiation(request);
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      writeDraftNow(
        draftKey,
        JSON.stringify({
          baseRevision: revisionRef.current,
          document: documentRef.current,
          argumentDrafts: argumentRef.current,
          pendingInstantiation: request,
        } satisfies Draft),
      );
      const result = await callbacks.current.action('workflow_component', request),
        node = WorkflowNodeSchema.parse(result.node);
      if (!mounted.current || !documentRef.current) return;
      const current = documentRef.current,
        next: WorkflowDocument = {
          ...current,
          nodes: current.nodes.some((item) => item.id === node.id)
            ? current.nodes
            : [...current.nodes, node],
        };
      writeDraftNow(
        draftKey,
        JSON.stringify({
          baseRevision: revisionRef.current,
          document: next,
          argumentDrafts: argumentRef.current,
        } satisfies Draft),
      );
      history.current.past = [...history.current.past, current].slice(-60);
      history.current.future = [];
      history.current.lastAt = 0;
      setHistoryTick((value) => value + 1);
      documentRef.current = next;
      setDocument(next);
      delete creationRequests.current.preset;
      setPendingInstantiation(null);
      setSelected(node.id);
      setSelectedIds([node.id]);
      setSelectedEdge(null);
      setNotice(
        result.object
          ? node.type === 'python'
            ? uiText('已加入「{0}」，并创建可编辑的 Python 源文件。添加组件不会执行代码。', {
                '0': node.label,
              })
            : uiText('已加入「{0}」，并创建原生结果文件作为回写位置。', { '0': node.label })
          : uiText('已加入「{0}」，选中组件可继续调整参数。', { '0': node.label }),
      );
      try {
        await callbacks.current.updated();
      } catch (cause) {
        setError(uiText('组件已加入，桌面刷新暂未完成：{0}', { '0': message(cause) }));
      }
    } catch (cause) {
      setError(
        uiText(
          '组件添加未完成：{0}。请求已保留，请点击「恢复添加」继续收回同一组件和已创建的文件。',
          { '0': message(cause) },
        ),
      );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const addInstalled = (
    type: 'skill' | 'mcp',
    entry: Catalog['skills'][number] | Catalog['tools'][number],
  ) => {
    if (!editableRef.current || !documentRef.current) return;
    if (documentRef.current.nodes.length >= 80) {
      setError(uiText('一个工作流最多包含 80 个组件。'));
      return;
    }
    const bounds = flowRoot.current?.getBoundingClientRect(),
      position = flow.screenToFlowPosition({
        x: (bounds?.left ?? 0) + (bounds?.width ?? 700) / 2 - 129,
        y: (bounds?.top ?? 0) + (bounds?.height ?? 500) / 2 - 70,
      }),
      id = crypto.randomUUID(),
      config: WorkflowNode['config'] =
        'path' in entry
          ? { skillPath: entry.path }
          : { server: entry.server, toolName: entry.name, arguments: {} };
    update((value) => ({
      ...value,
      nodes: [...value.nodes, { id, type, label: entry.name.slice(0, 120), position, config }],
    }));
    setSelected(id);
    setSelectedIds([id]);
    setSelectedEdge(null);
  };
  const createOutput = async () => {
    if (!selectedNode || !editableRef.current) return;
    const nodeId = selectedNode.id,
      title = (selectedNode.config.outputName || uiText('工作流结果'))
        .replace(/\.md$/i, '')
        .slice(0, 80);
    busyRef.current = true;
    setBusy(true);
    setError('');
    const request = creationRequests.current[nodeId] ?? {
      operation: 'create',
      format: 'md',
      title,
      requestId: crypto.randomUUID(),
      bounds: {
        x: object.bounds.x + object.bounds.width + 80,
        y: object.bounds.y,
        width: 300,
        height: 285,
      },
    };
    creationRequests.current[nodeId] = request;
    try {
      const created = await callbacks.current.action('native_workbench', request);
      busyRef.current = false;
      update((value) => ({
        ...value,
        nodes: value.nodes.map((node) =>
          node.id === nodeId
            ? { ...node, config: { ...node.config, targetObjectId: created.id } }
            : node,
        ),
      }));
      delete creationRequests.current[nodeId];
      await callbacks.current.updated();
      setNotice(uiText('已创建结果文件并设为此组件的回写位置。'));
    } catch (cause) {
      if (cause instanceof PanelActionError) delete creationRequests.current[nodeId];
      setError(
        uiText('结果文件创建或刷新未完成：{0}。可重试当前创建请求。', { '0': message(cause) }),
      );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const jsonField = (field: string, label: string, value: unknown, objectOnly = true) => {
    if (!selectedNode) return null;
    const id = selectedNode.id,
      key = `${field}:${id}`,
      raw = argumentDrafts[key] ?? JSON.stringify(value, null, 2),
      invalid = argumentError(raw, objectOnly);
    const commit = (next: unknown) => {
      setArgumentDrafts((drafts) => ({ ...drafts, [key]: JSON.stringify(next, null, 2) }));
      config({ [field]: next });
    };
    const source = (
      <label>
        {label}
        <textarea
          className="workflow-json-input"
          rows={field === 'value' ? 8 : 6}
          spellCheck={false}
          value={raw}
          onChange={(event) => {
            const next = event.target.value;
            setArgumentDrafts((drafts) => ({ ...drafts, [key]: next }));
            if (!argumentError(next, objectOnly)) config({ [field]: JSON.parse(next) });
          }}
        />
      </label>
    );
    if (field === 'parameters' || field === 'arguments')
      return (
        <div className="workflow-json-field">
          <strong className="workflow-parameter-title">{label}</strong>
          {!invalid && (
            <WorkflowParameterForm
              key={id}
              value={value as Record<string, unknown>}
              change={commit}
              schema={selectedNode.config.parameterSchema}
              workspace={workspace}
              columns={
                document?.edges
                  .filter((edge) => edge.target === id)
                  .flatMap((edge) => {
                    const output = activeRun?.nodes[edge.source]?.outputs?.[edge.sourcePort];
                    return output?.type === 'table' ? output.value.columns : [];
                  }) ?? []
              }
            />
          )}
          <details key={`${id}:${invalid ? 'invalid' : 'valid'}`} open={invalid ? true : undefined}>
            <summary>{uiText('高级参数 · JSON')}</summary>
            {source}
            <small>{uiText('数组、嵌套数据及新增字段在这里编辑。')}</small>
          </details>
          {invalid && <div className="workflow-field-error">{invalid}</div>}
        </div>
      );
    return (
      <div className="workflow-json-field">
        {source}
        {invalid && <div className="workflow-field-error">{invalid}</div>}
        {objectOnly && !invalid && field !== 'argumentBindings' && (
          <details>
            <summary>{uiText('参数表单')}</summary>
            <WorkflowParameterForm
              key={id}
              value={value as Record<string, unknown>}
              change={commit}
              schema={selectedNode.config.parameterSchema}
              workspace={workspace}
              columns={
                document?.edges
                  .filter((edge) => edge.target === id)
                  .flatMap((edge) => {
                    const output = activeRun?.nodes[edge.source]?.outputs?.[edge.sourcePort];
                    return output?.type === 'table' ? output.value.columns : [];
                  }) ?? []
              }
            />
            <small>{uiText('新增参数或嵌套数据可在上方 JSON 中编辑。')}</small>
          </details>
        )}
      </div>
    );
  };
  const openFile = async (id: string) => {
    if (!callbacks.current.openObject) return;
    const saved = await save();
    if (saved !== null) callbacks.current.openObject(id);
  };
  const createPython = async () => {
    if (!selectedNode || !editableRef.current) return;
    const nodeId = selectedNode.id,
      key = `python:${nodeId}`;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const ports = workflowPorts(selectedNode),
      inputKey = JSON.stringify(ports.inputs[0]?.name ?? 'input'),
      outputFields = ports.outputs
        .map((port) => `        ${JSON.stringify(port.name)}: inputs.get(${inputKey}),`)
        .join('\n');
    const code = `# Yirang Python component\n# inputs is keyed by the named input ports.\n# Replace the starter values below with your processing logic.\n# context["parameters"] contains the configured component parameters.\n# context["input_files"][object_id_or_artifact_id] is a frozen local path.\n# Write generated files under context["output_dir"].\n# Return {"$file": "result.csv"} as the value of a file output port.\n\ndef run(inputs, context):\n    return {\n${outputFields}\n    }\n`;
    const bytes = new TextEncoder().encode(code);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const request = creationRequests.current[key] ?? {
      requestId: crypto.randomUUID(),
      fileName: `${selectedNode.label.replace(/[\\/:*?"<>|]/g, '_').slice(0, 70) || 'component'}.py`,
      data: btoa(binary),
      bounds: {
        x: object.bounds.x + object.bounds.width + 80,
        y: object.bounds.y,
        width: 350,
        height: 320,
      },
    };
    creationRequests.current[key] = request;
    try {
      const created = await callbacks.current.action('import_attachment', request);
      busyRef.current = false;
      update((value) => ({
        ...value,
        nodes: value.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                config: { ...node.config, codeObjectId: created.id, entryFunction: 'run' },
              }
            : node,
        ),
      }));
      delete creationRequests.current[key];
      await callbacks.current.updated();
      setNotice(uiText('已创建 Python 源文件并绑定此组件；点击「编辑源码」继续编写。'));
    } catch (cause) {
      if (cause instanceof PanelActionError) delete creationRequests.current[key];
      setError(uiText('源码创建或刷新未完成：{0}。可重试同一创建请求。', { '0': message(cause) }));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const componentsRevision = useWorkspaceRefresh(workspace.id, 'components');
  const loadComponents = useCallback(async () => {
    setLibraryBusy(true);
    try {
      const result = await callbacks.current.action('workflow_component', { operation: 'list' });
      if (mounted.current) {
        setPersonalComponents((previous) => retainEqual(previous, result.components ?? []));
        setLibraryError(
          result.issues?.length
            ? uiText('{0} 个组件文件暂时无法读取。', { '0': result.issues.length })
            : '',
        );
      }
    } catch (cause) {
      if (mounted.current) setLibraryError(message(cause));
    } finally {
      if (mounted.current) setLibraryBusy(false);
    }
  }, []);
  useEffect(() => {
    void loadComponents();
  }, [loadComponents, workspace.id, componentsRevision]);
  const insertComponent = (entry: LibraryComponent, definition = entry.definition) => {
    if (!editableRef.current || !documentRef.current) return;
    const count = definition.schemaVersion === 1 ? 1 : definition.document.nodes.length;
    if (documentRef.current.nodes.length + count > 80) {
      setError(uiText('一个工作流最多包含 80 个组件。'));
      return;
    }
    const bounds = flowRoot.current?.getBoundingClientRect(),
      position = flow.screenToFlowPosition({
        x: (bounds?.left ?? 0) + (bounds?.width ?? 700) / 2 - 110,
        y: (bounds?.top ?? 0) + (bounds?.height ?? 500) / 2 - 60,
      }),
      expanded = expandComponent(definition, position, {
        objectId: entry.object.id,
        revision: entry.object.revision,
      });
    if (documentRef.current.edges.length + expanded.edges.length > 160) {
      setError(uiText('工作流连线最多 160 条。'));
      return;
    }
    update((value) => ({
      ...value,
      nodes: [...value.nodes, ...expanded.nodes],
      edges: [...value.edges, ...expanded.edges],
    }));
    setSelectedIds(expanded.nodes.map((node) => node.id));
    setSelected(expanded.nodes.at(-1)?.id ?? null);
    setSelectedEdge(null);
    setBundleDialog(null);
    setNotice(
      uiText('已加入「{0}」v{1}，可独立调整配置；源码与材料引用保留。', {
        '0': definition.name,
        '1': entry.object.revision,
      }),
    );
  };
  const addComponent = (entry: LibraryComponent) => {
    if (entry.definition.schemaVersion === 2) setBundleDialog({ entry });
    else insertComponent(entry);
  };
  const storeBundle = async (definition: WorkflowComponentDefinition) => {
    const key = `ai-desktop:workflow-bundle-save:${workspace.id}:${object.id}`;
    let request: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (raw?.operation === 'create_bundle' && typeof raw.requestId === 'string') request = raw;
    } catch {
      throw Error(uiText('组合组件待确认请求无法读取，请保留当前文件后处理本地记录。'));
    }
    request ??= {
      operation: 'create_bundle',
      requestId: crypto.randomUUID(),
      definition,
      bounds: {
        x: object.bounds.x + object.bounds.width + 80,
        y: object.bounds.y + 360,
        width: 340,
        height: 270,
      },
    };
    writeDraftNow(key, JSON.stringify(request));
    let received = false;
    try {
      const result = await callbacks.current.action('workflow_component', request);
      received = true;
      await callbacks.current.updated();
      await loadComponents();
      writeDraftNow(key, null);
      setNotice(
        uiText('已保存组合组件「{0}」。在个人组件库中可填写常用参数并重新加入。', {
          '0': result.definition.name,
        }),
      );
    } catch (cause) {
      if (!received && cause instanceof PanelActionError) writeDraftNow(key, null);
      throw cause;
    }
  };
  const storeComponent = async (replace = false) => {
    if (!selectedNode || !editableRef.current) return;
    if (Object.keys(invalidArguments).length) {
      setError(uiText('请先修正 JSON 参数后再保存组件。'));
      return;
    }
    const node = structuredClone(selectedNode),
      key = `component:${replace ? node.origin?.objectId : node.id}`,
      request = creationRequests.current[key] ?? {
        operation: replace ? 'save' : 'create',
        requestId: crypto.randomUUID(),
        name: node.label,
        node,
        ...(replace && node.origin
          ? { objectId: node.origin.objectId, expectedRevision: node.origin.revision }
          : {}),
        ...(!replace
          ? {
              bounds: {
                x: object.bounds.x + object.bounds.width + 80,
                y: object.bounds.y + 360,
                width: 320,
                height: 270,
              },
            }
          : {}),
      };
    creationRequests.current[key] = request;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await callbacks.current.action('workflow_component', request);
      busyRef.current = false;
      update((value) => ({
        ...value,
        nodes: value.nodes.map((item) =>
          item.id === node.id
            ? { ...item, origin: { objectId: result.object.id, revision: result.object.revision } }
            : item,
        ),
      }));
      delete creationRequests.current[key];
      await callbacks.current.updated();
      await loadComponents();
      setNotice(
        uiText('已{0}个人组件库，原生文件：{1}。其他流程中的实例保持原配置。', {
          '0': replace ? uiText('更新') : uiText('保存到'),
          '1': result.object.title,
        }),
      );
    } catch (cause) {
      if (cause instanceof PanelActionError) delete creationRequests.current[key];
      setError(uiText('组件保存未完成：{0}。可重试同一请求。', { '0': message(cause) }));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const recover = async () => {
    if (!activeRun || !callbacks.current.recover || busyRef.current) return;
    const saved = await save();
    if (saved === null) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (await callbacks.current.recover(activeRun.id)) {
        setNotice(uiText('已将原运行记录交回原对话。请继续旧执行会话，不要重新运行已完成步骤。'));
        await loadRuns();
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    if (!editable) return;
    const selections = changes.filter((change) => change.type === 'select');
    if (selections.length) {
      const next = new Set(selectedIds);
      for (const change of selections)
        if (change.type === 'select') {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
      setSelectedIds([...next]);
      setSelected([...next].at(-1) ?? null);
    }
    const positions = changes.filter(
      (change): change is NodePositionChange => change.type === 'position' && !!change.position,
    );
    if (positions.length)
      update((value) => ({
        ...value,
        nodes: value.nodes.map((node) => {
          const change = positions.find((item) => item.id === node.id);
          return change?.type === 'position' && change.position
            ? { ...node, position: change.position }
            : node;
        }),
      }));
  };
  const canConnect = (connection: Connection | Edge) => {
    const value = documentRef.current;
    if (
      !value ||
      !connection.source ||
      !connection.target ||
      connection.source === connection.target
    )
      return false;
    const source = value.nodes.find((node) => node.id === connection.source),
      target = value.nodes.find((node) => node.id === connection.target);
    if (!source || !target) return false;
    const output = workflowPorts(source).outputs.find(
        (port) => port.name === connection.sourceHandle,
      ),
      input = workflowPorts(target).inputs.find((port) => port.name === connection.targetHandle);
    if (!output || !input || !workflowPortCompatible(output.type, input.type)) return false;
    if (
      value.edges.some(
        (edge) => edge.target === connection.target && edge.targetPort === connection.targetHandle,
      )
    )
      return false;
    const queue = [connection.target],
      seen = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      if (id === connection.source) return false;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...value.edges.filter((edge) => edge.source === id).map((edge) => edge.target));
    }
    return true;
  };
  const connect = (connection: Connection) => {
    if (!editable || !canConnect(connection)) {
      setError(uiText('请选择兼容的数据端口；一个输入端口只能连接一条上游连线，且不能形成循环。'));
      return;
    }
    update((value) => ({
      ...value,
      edges: [
        ...value.edges,
        {
          id: crypto.randomUUID(),
          source: connection.source!,
          target: connection.target!,
          sourcePort: connection.sourceHandle!,
          targetPort: connection.targetHandle!,
        },
      ],
    }));
    setError('');
  };
  const latestHandlers = useRef({ save, removeSelection, duplicate, undo });
  latestHandlers.current = { save, removeSelection, duplicate, undo };
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (window.document.querySelector('[data-desktop-overlay=bundle]')) return;
      const target = event.target as HTMLElement,
        input = !!target.closest('input,textarea,select,[contenteditable=true]');
      const integrated = window.document.documentElement.classList.contains('electron-mode');
      if (integrated && !dialog.current?.contains(target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopImmediatePropagation();
        void latestHandlers.current.save();
        return;
      }
      if (
        !input &&
        (event.ctrlKey || event.metaKey) &&
        ['z', 'y'].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        latestHandlers.current.undo(event.shiftKey || event.key.toLowerCase() === 'y');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busyRef.current && !sourceBusyRef.current) {
          flushDraftStorage(draftKey);
          callbacks.current.close();
        }
        return;
      }
      if (!input && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        latestHandlers.current.removeSelection();
        return;
      }
      if (!input && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        event.stopImmediatePropagation();
        latestHandlers.current.duplicate();
        return;
      }
      if (integrated || event.key !== 'Tab' || !dialog.current) return;
      const focusables = Array.from(
          dialog.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0),
        first = focusables[0],
        last = focusables.at(-1);
      if (
        event.shiftKey &&
        (window.document.activeElement === first ||
          !dialog.current.contains(window.document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (window.document.activeElement === last ||
          !dialog.current.contains(window.document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      flushDraftStorage(draftKey);
      callbacks.current.dirtyChanged?.(false);
      if (previous?.isConnected) previous.focus();
    };
  }, [draftKey]);
  const nodes: FlowNode[] = useMemo(
    () =>
      document?.nodes.map((node) => ({
        id: node.id,
        type: 'workflow',
        position: node.position,
        selected: selectedIds.includes(node.id),
        data: {
          node,
          state:
            !dirty && activeRun?.flowRevision === revision
              ? activeRun.nodes[node.id]?.state
              : undefined,
          summary:
            !dirty && activeRun?.flowRevision === revision
              ? activeRun.nodes[node.id]?.summary
              : undefined,
        },
      })) ?? [],
    [document, selected, selectedIds, activeRun, dirty, revision, getUiLocale()],
  );
  const edges = useMemo(
    () =>
      document?.edges.map((edge) => ({
        ...edge,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        label: `${edge.sourcePort} → ${edge.targetPort}`,
        labelStyle: { fontSize: 9, fill: '#8290a3' },
        type: 'smoothstep',
        selected: selectedEdge === edge.id,
        style: { stroke: selectedEdge === edge.id ? '#1675ff' : '#a7b4c9', strokeWidth: 1.8 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: selectedEdge === edge.id ? '#1675ff' : '#a7b4c9',
        },
      })) ?? [],
    [document, selectedEdge, getUiLocale()],
  );
  const materials = workspace.objects.filter(
    (item) =>
      item.id !== object.id &&
      `${item.title} ${item.kind}`.toLowerCase().includes(materialSearch.toLowerCase()),
  );
  const visiblePresets = WORKFLOW_PRESETS.filter(
      (item) =>
        (category === 'all' || item.category === category) &&
        matchesSearch(search, item.name, item.description, ...item.tags),
    ),
    visibleComponents = components.filter((item) =>
      matchesSearch(search, item.name, item.description, item.tag),
    ),
    visiblePersonal = personalComponents.filter((entry) =>
      matchesSearch(
        search,
        entry.definition.name,
        entry.definition.schemaVersion === 1 ? entry.definition.node.type : uiText('组合'),
      ),
    ),
    visibleSkills = catalog.skills.filter((entry) =>
      matchesSearch(search, entry.name, entry.description),
    ),
    visibleTools = catalog.tools.filter((entry) =>
      matchesSearch(search, entry.name, entry.description, entry.server),
    );

  return (
    <div className="workflow-editor-backdrop">
      <section
        className="workflow-editor"
        ref={dialog}
        role="dialog"
        aria-modal={
          window.document.documentElement.classList.contains('electron-mode') ? undefined : true
        }
        aria-label={uiText('可视化工作流编辑器')}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="workflow-header">
          <span className="workflow-brand">
            <Icon name="diagram" size={22} />
          </span>
          <div className="workflow-heading">
            <strong>{uiText('工作流')}</strong>
            <span>
              {document?.name ?? object.title}
              <i>·</i>
              {dirty ? uiText('草稿未保存') : uiText('v{0} · 已保存', { '0': revision })}
            </span>
          </div>
          <div className="workflow-header-actions">
            <button
              disabled={!editable}
              onClick={() => fileInput.current?.click()}
              title={uiText('导入 Yirang 工作流 JSON')}
            >
              <Icon name="upload" />
              {uiText('导入')}
            </button>
            <button disabled={!document} onClick={download}>
              <Icon name="code" />
              {uiText('导出 JSON')}
            </button>
            <button
              disabled={
                loading ||
                busy ||
                sourceBusy ||
                leaseBlocked ||
                recoveryBlocked ||
                !dirty ||
                stale ||
                !!pendingInstantiation ||
                !!Object.keys(invalidArguments).length
              }
              onClick={() => void save()}
            >
              <Icon name="save" />
              {pendingSave ? uiText('重试保存') : uiText('保存')}
            </button>
            <button
              className="primary"
              disabled={
                !editable ||
                !canSubmit ||
                stale ||
                !plan?.valid ||
                unavailableIds.length > 0 ||
                !!Object.keys(invalidArguments).length
              }
              title={
                canSubmit
                  ? uiText('保存流程并交给 Codex 原对话处理')
                  : document?.batch
                    ? uiText('批处理需要宿主提供直接发送能力')
                    : uiText('请在支持发送或引用的 Codex 原对话中打开工作桌面')
              }
              onClick={() => void send()}
            >
              <Icon name="play" size={16} />
              {uiText('交给原对话')}
            </button>
            <button
              className="workflow-close"
              disabled={busy || sourceBusy}
              ref={closeButton}
              aria-label={uiText('关闭工作流编辑器')}
              onClick={() => {
                flushDraftStorage(draftKey);
                props.close();
              }}
            >
              <Icon name="close" />
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".json,.flow.json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importJson(file);
            }}
          />
        </header>
        {(error || notice || stale || leaseBlocked || recoveryBlocked) && (
          <div
            className={`workflow-message ${error || stale || leaseBlocked || recoveryBlocked ? 'is-error' : ''}`}
            role="status"
          >
            <span>
              {stale
                ? uiText('原文件已更新，本地草稿基于旧版本。请先导出草稿，再载入最新版进行合并。')
                : error || notice}
            </span>
            {(stale || recoveryBlocked || leaseBlocked || !document) && (
              <button
                disabled={busy}
                onClick={() => {
                  if (stale || recoveryBlocked) {
                    writeDraftNow(draftKey, null);
                    setStale(false);
                    setRecoveryBlocked(false);
                  }
                  setAttempt((value) => value + 1);
                }}
              >
                {stale || recoveryBlocked ? uiText('放弃草稿并载入最新版') : uiText('重新载入')}
              </button>
            )}
            <button
              aria-label={uiText('收起提示')}
              onClick={() => {
                setError('');
                setNotice('');
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <div className="workflow-body">
          <aside className="workflow-palette">
            <div className="workflow-library-heading">
              <span className="workflow-library-symbol">
                <Icon name="box" size={20} />
              </span>
              <div>
                <strong>{uiText('组件库')}</strong>
              </div>
              <span>{WORKFLOW_PRESETS.length}</span>
            </div>
            <label className="workflow-search">
              <Icon name="search" size={15} />
              <input
                aria-label={uiText('搜索组件')}
                placeholder={uiText('搜索名称、用途或关键词')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button aria-label={uiText('清空搜索')} onClick={() => setSearch('')}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </label>
            <div className="workflow-library-tabs" role="tablist" aria-label={uiText('组件来源')}>
              {(
                [
                  { id: 'basic', label: uiText('基础') },
                  { id: 'personal', label: uiText('个人') },
                  { id: 'installed', label: uiText('已安装') },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={libraryTab === tab.id}
                  aria-controls={`workflow-library-${tab.id}`}
                  className={libraryTab === tab.id ? 'is-active' : ''}
                  onClick={() => setLibraryTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div
              className="workflow-library-content"
              role="tabpanel"
              id={`workflow-library-${libraryTab}`}
              aria-label={
                {
                  presets: uiText('精选组件'),
                  basic: uiText('基础组件'),
                  personal: uiText('个人组件'),
                  installed: uiText('已安装组件'),
                }[libraryTab]
              }
            >
              {libraryTab === 'presets' && (
                <>
                  <div className="workflow-library-categories" aria-label={uiText('按用途筛选')}>
                    <button
                      className={category === 'all' ? 'is-active' : ''}
                      aria-pressed={category === 'all'}
                      onClick={() => setCategory('all')}
                    >
                      {uiText('全部')}
                    </button>
                    {WORKFLOW_CATEGORIES.map((item) => (
                      <button
                        key={item.id}
                        className={category === item.id ? 'is-active' : ''}
                        aria-pressed={category === item.id}
                        onClick={() => setCategory(item.id)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="workflow-library-caption">
                    <span>
                      {search
                        ? uiText('找到 {0} 个组件', { '0': visiblePresets.length })
                        : uiText('{0} 个可编辑组件', { '0': visiblePresets.length })}
                    </span>
                    <small>{uiText('点击或拖入画布')}</small>
                  </div>
                  <div className="workflow-preset-list">
                    {visiblePresets.map((preset) => {
                      const ports = presetPorts(preset),
                        spec = components.find((item) => item.type === preset.node.type)!;
                      return (
                        <button
                          key={preset.id}
                          className={`workflow-preset-card type-${preset.node.type}`}
                          disabled={!editable}
                          draggable={editable}
                          onDragStart={(event) => {
                            event.dataTransfer.setData(
                              'application/x-ai-workflow-preset',
                              preset.id,
                            );
                            event.dataTransfer.effectAllowed = 'copy';
                          }}
                          onClick={() => void addPreset(preset)}
                          title={`${preset.description}\n${ports.inputs
                            .map((port) =>
                              uiText('输入 {0} · {1}', { '0': port.name, '1': port.type }),
                            )
                            .concat(
                              ports.outputs.map((port) =>
                                uiText('输出 {0} · {1}', { '0': port.name, '1': port.type }),
                              ),
                            )
                            .join('\n')}`}
                        >
                          <span className="workflow-preset-top">
                            <span className="workflow-node-icon">
                              <Icon name={spec.icon} size={16} />
                            </span>
                            <strong>{preset.name}</strong>
                            <Icon name="plus" size={13} />
                          </span>
                          <span className="workflow-preset-description">{preset.description}</span>
                          <span className="workflow-preset-ports">
                            <span>
                              {ports.inputs.length
                                ? ports.inputs
                                    .map((port) => port.type)
                                    .filter((type, index, list) => list.indexOf(type) === index)
                                    .join(' + ')
                                : uiText('起点')}
                            </span>
                            <Icon name="arrow" size={11} />
                            <span>
                              {ports.outputs.length
                                ? ports.outputs
                                    .map((port) => port.type)
                                    .filter((type, index, list) => list.indexOf(type) === index)
                                    .join(' + ')
                                : uiText('桌面文件')}
                            </span>
                            {preset.pythonSource && <small>.py</small>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {!visiblePresets.length && (
                    <div className="workflow-library-empty">
                      <Icon name="search" size={25} />
                      <strong>{uiText('没有匹配的组件')}</strong>
                      <p>{uiText('换个关键词，或清除分类后再找。')}</p>
                      <button
                        onClick={() => {
                          setSearch('');
                          setCategory('all');
                        }}
                      >
                        {uiText('显示全部组件')}
                      </button>
                    </div>
                  )}
                  <p className="workflow-library-footnote">
                    {uiText(
                      'Python 组件会创建可编辑的 .py 源文件。添加组件只准备流程，执行仍由原对话完成。',
                    )}
                  </p>
                </>
              )}
              {libraryTab === 'basic' && (
                <>
                  <div className="workflow-library-caption">
                    <span>
                      {components.length} {uiText('种基础能力')}
                    </span>
                    <small>{uiText('从空白配置开始')}</small>
                  </div>
                  <div className="workflow-component-list">
                    {visibleComponents.map((item) => (
                      <button
                        key={item.type}
                        className={`workflow-component type-${item.type}`}
                        disabled={!editable}
                        draggable={editable}
                        onDragStart={(event) => {
                          event.dataTransfer.setData('application/x-ai-workflow-node', item.type);
                          event.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={() => addNode(item.type)}
                      >
                        <span className="workflow-node-icon">
                          <Icon name={item.icon} />
                        </span>
                        <span>
                          <strong>{item.name}</strong>
                          <small>{item.description}</small>
                        </span>
                        <Icon name="plus" size={14} />
                      </button>
                    ))}
                  </div>
                  {!visibleComponents.length && (
                    <p className="workflow-library-footnote">{uiText('没有匹配的基础组件。')}</p>
                  )}
                  <div className="workflow-palette-note">
                    <Icon name="link" size={19} />
                    <strong>{uiText('把能力连接起来')}</strong>
                    <p>
                      {uiText('从输入出发，串联 Python、Skill、MCP 与浏览器，将结果送回桌面。')}
                    </p>
                    <small>
                      {uiText('拖动端口连接 · Delete 删除')}
                      <br />
                      {uiText('Ctrl / ⌘ + D 复制选中组件')}
                    </small>
                  </div>
                </>
              )}
              {libraryTab === 'personal' && (
                <section className="workflow-personal-library">
                  <header>
                    <strong>{uiText('我的可复用组件')}</strong>
                    <button
                      disabled={libraryBusy}
                      onClick={() => void loadComponents()}
                      title={uiText('刷新个人组件')}
                    >
                      <Icon name="history" size={13} />
                    </button>
                  </header>
                  {visiblePersonal.map((entry) => (
                    <button
                      key={entry.object.id}
                      className="workflow-personal-item"
                      disabled={!editable}
                      onClick={() => addComponent(entry)}
                    >
                      <Icon
                        name={
                          components.find(
                            (item) =>
                              item.type ===
                              (entry.definition.schemaVersion === 1
                                ? entry.definition.node.type
                                : '组合'),
                          )?.icon ?? 'box'
                        }
                        size={16}
                      />
                      <span>
                        {entry.definition.name}
                        <small>
                          {entry.definition.schemaVersion === 1
                            ? entry.definition.node.type
                            : uiText('组合')}{' '}
                          · v{entry.object.revision}
                        </small>
                      </span>
                      <Icon name="plus" size={12} />
                    </button>
                  ))}
                  {!visiblePersonal.length && (
                    <div className="workflow-library-empty">
                      <Icon name="box" size={25} />
                      <strong>
                        {personalComponents.length
                          ? uiText('没有匹配的个人组件')
                          : uiText('留下常用的处理方法')}
                      </strong>
                      <p>
                        {uiText(
                          '选中画布组件，点击「存为个人组件」，下次可带着参数和源码引用继续使用。',
                        )}
                      </p>
                    </div>
                  )}
                  {libraryError && <small className="workflow-field-error">{libraryError}</small>}
                </section>
              )}
              {libraryTab === 'installed' && (
                <section className="workflow-installed-library">
                  <div className="workflow-library-caption">
                    <span>{uiText('Skill 与 MCP')}</span>
                    <button
                      disabled={catalogBusy}
                      onClick={() => void loadCatalog()}
                      title={uiText('刷新已安装目录')}
                    >
                      <Icon name="history" size={13} />
                    </button>
                  </div>
                  {visibleSkills.length > 0 && (
                    <h3>
                      Skill <span>{visibleSkills.length}</span>
                    </h3>
                  )}
                  {visibleSkills.map((entry) => (
                    <button
                      key={entry.id}
                      className="workflow-installed-item type-skill"
                      disabled={!editable}
                      onClick={() => addInstalled('skill', entry)}
                      title={entry.description}
                    >
                      <span className="workflow-node-icon">
                        <Icon name="layers" size={16} />
                      </span>
                      <span>
                        <strong>{entry.name}</strong>
                        <small>{entry.description || uiText('使用已有 Skill 的方法和指令')}</small>
                      </span>
                      <Icon name="plus" size={12} />
                    </button>
                  ))}
                  {visibleTools.length > 0 && (
                    <h3>
                      {uiText('MCP 工具')}
                      <span>{visibleTools.length}</span>
                    </h3>
                  )}
                  {visibleTools.map((entry, index) => (
                    <button
                      key={`${entry.server}:${entry.name}:${index}`}
                      className="workflow-installed-item type-mcp"
                      disabled={!editable}
                      onClick={() => addInstalled('mcp', entry)}
                      title={entry.description}
                    >
                      <span className="workflow-node-icon">
                        <Icon name="settings" size={16} />
                      </span>
                      <span>
                        <strong>{entry.name}</strong>
                        <small>
                          {entry.server}
                          {entry.description ? ` · ${entry.description}` : ''}
                        </small>
                      </span>
                      <Icon name="plus" size={12} />
                    </button>
                  ))}
                  {!visibleSkills.length && !visibleTools.length && (
                    <div className="workflow-library-empty">
                      <Icon name="layers" size={25} />
                      <strong>
                        {catalogBusy ? uiText('正在读取目录…') : uiText('暂未找到匹配的能力')}
                      </strong>
                      <p>
                        {uiText('也可以从基础组件添加 Skill 或 MCP，手动填写本地路径和工具参数。')}
                      </p>
                    </div>
                  )}
                  <p className="workflow-library-footnote">
                    {uiText('目录展示已配置的能力；实际调用与权限以原对话为准。')}
                  </p>
                  {catalogError && (
                    <small className="workflow-field-error">
                      {catalogError}
                      {uiText('，仍可手动填写。')}
                    </small>
                  )}
                </section>
              )}
            </div>
            <div className="workflow-library-footer">
              <Icon name="link" size={13} />
              <span>{uiText('命名端口连接 · 配置可编辑')}</span>
            </div>
          </aside>
          <main className="workflow-center">
            {batchPending && (
              <div className="workflow-pending-component">
                <span>
                  <strong>{uiText('批处理等待交回原对话')}</strong>
                  <small>{uiText('准备期间的请求已保留；继续原批次不会重复创建结果文件。')}</small>
                </span>
                <button disabled={busy || !props.canSend} onClick={() => void send()}>
                  {uiText('继续此批次')}
                </button>
              </div>
            )}
            {pendingInstantiation && (
              <div className="workflow-pending-component" role="status">
                <Icon name="history" size={17} />
                <span>
                  <strong>{busy ? uiText('正在加入组件…') : uiText('有一项组件添加待确认')}</strong>
                  <small>
                    {
                      WORKFLOW_PRESETS.find((item) => item.id === pendingInstantiation.presetId)
                        ?.name
                    }{' '}
                    {uiText('· 使用同一请求恢复，保留已创建的文件')}
                  </small>
                </span>
                <button
                  disabled={
                    loading ||
                    busy ||
                    sourceBusy ||
                    leaseBlocked ||
                    stale ||
                    recoveryBlocked ||
                    !!pendingSave
                  }
                  onClick={() => {
                    const preset = WORKFLOW_PRESETS.find(
                      (item) => item.id === pendingInstantiation.presetId,
                    );
                    if (preset) void addPreset(preset);
                  }}
                >
                  {uiText('恢复添加')}
                </button>
              </div>
            )}
            <div
              className="workflow-canvas"
              ref={flowRoot}
              onDragOver={(event) => {
                if (
                  editable &&
                  event.dataTransfer.types.some(
                    (type) =>
                      type === 'application/x-ai-workflow-node' ||
                      type === 'application/x-ai-workflow-preset',
                  )
                ) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }
              }}
              onDrop={(event) => {
                const presetId = event.dataTransfer.getData('application/x-ai-workflow-preset'),
                  preset = WORKFLOW_PRESETS.find((item) => item.id === presetId),
                  type = event.dataTransfer.getData('application/x-ai-workflow-node') as NodeKind;
                if (preset || components.some((item) => item.type === type)) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!editable) return;
                  if (preset)
                    void addPreset(preset, { x: event.clientX - 129, y: event.clientY - 40 });
                  else addNode(type, { x: event.clientX - 129, y: event.clientY - 40 });
                }
              }}
            >
              <div className="workflow-canvas-tools" aria-label={uiText('画布工具')}>
                <button
                  disabled={!editable || !document?.nodes.length}
                  onClick={arrange}
                  title={uiText('按连线顺序从左到右整理，不改变连接和配置')}
                >
                  <Icon name="diagram" size={14} />
                  {uiText('整理布局')}
                </button>
                <button
                  disabled={!editable || !(selectedNode || selectedIds.length)}
                  onClick={duplicate}
                  title={uiText('复制选中组件 · Ctrl / ⌘ + D')}
                >
                  <Icon name="layers" size={14} />
                  {uiText('复制')}
                </button>
                <button
                  disabled={!editable || !(selectedIds.length > 1)}
                  onClick={() => setBundleDialog({})}
                >
                  <Icon name="box" size={14} />
                  {uiText('封装')}
                  {selectedIds.length > 1 ? selectedIds.length : ''}
                </button>
                <button
                  disabled={!editable || !history.current.past.length}
                  onClick={() => undo()}
                  title={uiText('撤销流程修改 · Ctrl / ⌘ Z')}
                >
                  {uiText('撤销')}
                </button>
                <button
                  disabled={!editable || !history.current.future.length}
                  onClick={() => undo(true)}
                  title={uiText('重做流程修改 · Ctrl / ⌘ Shift Z')}
                >
                  {uiText('重做')}
                </button>
                <span />
                <button
                  disabled={!document?.nodes.length}
                  onClick={() => void flow.fitView({ padding: 0.2, duration: 200 })}
                  title={uiText('显示全部组件')}
                >
                  <Icon name="desktop" size={14} />
                  <span>{uiText('适合画布')}</span>
                </button>
              </div>
              <ReactFlow<FlowNode>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onConnect={connect}
                isValidConnection={canConnect}
                onNodeClick={(event, node) => {
                  setSelected(node.id);
                  if (!event.shiftKey && !event.ctrlKey && !event.metaKey)
                    setSelectedIds([node.id]);
                  setSelectedEdge(null);
                }}
                onEdgeClick={(_, edge) => {
                  setSelectedEdge(edge.id);
                  setSelected(null);
                  setSelectedIds([]);
                }}
                onPaneClick={() => {
                  setSelected(null);
                  setSelectedIds([]);
                  setSelectedEdge(null);
                }}
                nodesDraggable={editable}
                nodesConnectable={editable}
                deleteKeyCode={null}
                selectionKeyCode="Shift"
                multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
                selectionOnDrag
                panOnDrag={[1, 2]}
                minZoom={0.25}
                maxZoom={2}
                fitView
                fitViewOptions={{ padding: 0.25 }}
                connectionRadius={28}
              >
                <Background gap={22} size={1} color="#d7dfea" />
                <Controls showInteractive={false} />
              </ReactFlow>
              {loading && (
                <div className="workflow-canvas-empty">
                  <Icon name="diagram" size={34} />
                  <strong>{uiText('正在打开工作流…')}</strong>
                </div>
              )}
              {!loading && document?.nodes.length === 0 && (
                <div className="workflow-canvas-empty">
                  <span>
                    <Icon name="diagram" size={36} />
                  </span>
                  <h2>{uiText('从一个想法开始')}</h2>
                  <p>{uiText('从左侧选一个组件，连接输入、处理和输出。')}</p>
                  <button disabled={!editable} onClick={() => addNode('input')}>
                    <Icon name="plus" />
                    {uiText('添加文件输入')}
                  </button>
                </div>
              )}
              <div className="workflow-canvas-caption">
                {document?.nodes.length ?? 0} {uiText('个组件 ·')}
                {document?.edges.length ?? 0} {uiText('条连接')}
                <span>
                  {uiText('滚轮缩放 · Shift 框选 · 中键平移 · ⌘ / Ctrl + D 复制 · Z 撤销')}
                </span>
              </div>
            </div>
            <div className={`workflow-run-panel${showRuns ? ' is-expanded' : ''}`}>
              <button
                className="workflow-run-toggle"
                onClick={() => setShowRuns((value) => !value)}
              >
                <Icon name="playCircle" size={17} />
                <strong>{uiText('运行记录')}</strong>
                <span>
                  {activeRun
                    ? `${stateLabels[activeRun.status] ?? activeRun.status} · ${new Date(activeRun.createdAt).toLocaleString(interfaceLocale())}`
                    : uiText('等待原对话回报')}
                </span>
                <Icon name="chevron" size={15} />
              </button>
              {showRuns && (
                <div className="workflow-run-content">
                  <div className="workflow-run-controls">
                    <select
                      aria-label={uiText('选择运行记录')}
                      value={activeRun?.id ?? ''}
                      onChange={(event) => setRunId(event.target.value)}
                    >
                      {!runs.length && <option value="">{uiText('暂无运行记录')}</option>}
                      {runs.map((run) => (
                        <option key={run.id} value={run.id}>
                          {new Date(run.createdAt).toLocaleString(interfaceLocale())} ·{' '}
                          {stateLabels[run.status] ?? run.status} · v{run.flowRevision}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => void loadRuns()}>
                      <Icon name="history" size={14} />
                      {uiText('刷新')}
                    </button>
                    {activeRun &&
                      !activeRun.restoredAt &&
                      ['prepared', 'running', 'waiting'].includes(activeRun.status) && (
                        <button
                          disabled={busy || !props.recover || !canHandoff}
                          onClick={() => void recover()}
                          title={uiText('引用同一个运行记录，继续已有会话')}
                        >
                          <Icon name="play" size={14} />
                          {uiText('交回原对话继续')}
                        </button>
                      )}
                  </div>
                  {activeRun ? (
                    <>
                      {(dirty || activeRun.flowRevision !== revision) && (
                        <p className="workflow-run-stale">
                          {uiText(
                            '流程配置已修改，以下是旧运行结果。局部重跑会重新检查依赖与文件版本，过期结果不会自动复用。',
                          )}
                        </p>
                      )}
                      <p className="workflow-run-explanation">
                        {uiText('以下状态来自原对话的执行回报。当前查看的是工作流 v')}
                        {activeRun.flowRevision} {uiText('的记录。')}
                      </p>
                      <div className="workflow-run-nodes">
                        {Object.entries(activeRun.nodes).map(([id, report]) => (
                          <div key={id}>
                            <span className={`workflow-state-dot state-${report.state}`} />
                            <strong>
                              {activeRun.document.nodes.find((node) => node.id === id)?.label ?? id}
                            </strong>
                            <span>{stateLabels[report.state] ?? report.state}</span>
                            <p>{report.summary || uiText('尚未收到这一步的结果。')}</p>
                            {!activeRun.restoredAt && report.approval?.state === 'pending' && (
                              <div className="workflow-run-approval">
                                <button disabled={busy} onClick={() => void decide(id, 'reject')}>
                                  {uiText('拒绝')}
                                </button>
                                <button disabled={busy} onClick={() => void decide(id, 'approve')}>
                                  {uiText('确认通过')}
                                </button>
                              </div>
                            )}
                            {report.reusedFromRunId && (
                              <small>{uiText('复用了未变化的上游结果')}</small>
                            )}
                            {report.skipReason && (
                              <small>
                                {uiText('跳过原因：')}
                                {
                                  (
                                    {
                                      branch: uiText('未选择的分支'),
                                      scope: uiText('本次运行范围之外'),
                                      dependency: uiText('依赖不可用'),
                                    } as Record<string, string>
                                  )[report.skipReason]
                                }
                              </small>
                            )}
                            <WorkflowRunValues
                              report={report}
                              openFile={props.openObject ? (id) => void openFile(id) : undefined}
                            />
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="workflow-run-explanation">
                      {uiText(
                        '点击「交给原对话」准备流程；实际执行、工具授权和中断恢复都在 Codex 原对话中完成。',
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          </main>
          <aside className="workflow-inspector">
            <div className="workflow-section-title">
              <strong>
                {selectedNode
                  ? uiText('组件设置')
                  : selectedConnection
                    ? uiText('连接设置')
                    : uiText('工作流设置')}
              </strong>
              <span>
                {selectedNode
                  ? components.find((item) => item.type === selectedNode.type)?.tag
                  : 'FLOW'}
              </span>
            </div>
            {selectedNode ? (
              <fieldset disabled={!editable}>
                <label>
                  {uiText('组件名称')}
                  <input
                    maxLength={120}
                    value={selectedNode.label}
                    onChange={(event) => changeNode(selectedNode.id, { label: event.target.value })}
                  />
                </label>
                {selectedNode.type === 'input' && (
                  <>
                    <label>
                      {uiText('输入类型')}
                      <select
                        value={selectedNode.config.inputMode ?? 'files'}
                        onChange={(event) => {
                          const inputMode = event.target.value as 'files' | 'text' | 'json';
                          config({
                            inputMode,
                            value:
                              inputMode === 'text' ? '' : inputMode === 'json' ? {} : undefined,
                            inputPorts: undefined,
                            outputPorts: undefined,
                          });
                          setArgumentDrafts((drafts) => {
                            const next = { ...drafts };
                            delete next[`value:${selectedNode.id}`];
                            return next;
                          });
                        }}
                      >
                        <option value="files">{uiText('桌面文件与材料')}</option>
                        <option value="text">{uiText('直接输入文本')}</option>
                        <option value="json">{uiText('结构化 JSON')}</option>
                      </select>
                    </label>
                    {selectedNode.config.inputMode === 'text' ? (
                      <label>
                        {uiText('输入文本')}
                        <textarea
                          rows={12}
                          maxLength={24000}
                          value={String(selectedNode.config.value ?? '')}
                          onChange={(event) => config({ value: event.target.value })}
                        />
                      </label>
                    ) : selectedNode.config.inputMode === 'json' ? (
                      jsonField(
                        'value',
                        uiText('输入 JSON'),
                        selectedNode.config.value ?? {},
                        false,
                      )
                    ) : (
                      <>
                        <label>
                          {uiText('桌面材料')}
                          <input
                            placeholder={uiText('搜索文件与材料')}
                            value={materialSearch}
                            onChange={(event) => setMaterialSearch(event.target.value)}
                          />
                        </label>
                        <div className="workflow-material-list">
                          {materials.map((item) => (
                            <label key={item.id}>
                              <input
                                type="checkbox"
                                checked={selectedNode.config.objectIds?.includes(item.id) ?? false}
                                disabled={
                                  !selectedNode.config.objectIds?.includes(item.id) &&
                                  (selectedNode.config.objectIds?.length ?? 0) >= 9
                                }
                                onChange={(event) =>
                                  config({
                                    objectIds: event.target.checked
                                      ? [...(selectedNode.config.objectIds ?? []), item.id]
                                      : (selectedNode.config.objectIds?.filter(
                                          (id) => id !== item.id,
                                        ) ?? []),
                                  })
                                }
                              />
                              <span>
                                {item.title}
                                <small>
                                  {item.kind === 'file'
                                    ? (item.content as { fileName: string }).fileName
                                    : item.kind}
                                </small>
                              </span>
                            </label>
                          ))}
                          {!materials.length && <p>{uiText('没有匹配的材料。')}</p>}
                        </div>
                        {selectedNode.config.objectIds?.some(
                          (id) => !workspace.objects.some((item) => item.id === id),
                        ) && (
                          <div className="workflow-field-error">
                            {uiText('部分材料已不存在，请重新选择。')}
                          </div>
                        )}
                        <small className="workflow-field-help">
                          {uiText('原对话只引用这里明确选中的材料。')}
                        </small>
                      </>
                    )}
                  </>
                )}
                <WorkflowExecutionFields node={selectedNode} change={config} />
                {selectedNode.type === 'python' && (
                  <WorkflowPythonEnvironment node={selectedNode} change={config} />
                )}
                {(selectedNode.type === 'subflow' || selectedNode.type === 'repeat') && (
                  <WorkflowNestedFields
                    node={selectedNode}
                    workspace={workspace}
                    config={config}
                    action={props.action}
                  />
                )}
                {(selectedNode.type === 'extract' || selectedNode.type === 'chart') &&
                  jsonField(
                    'parameters',
                    uiText('组件参数'),
                    selectedNode.config.parameters ?? {},
                    true,
                  )}
                <WorkflowCustomFields
                  node={selectedNode}
                  workspace={workspace}
                  config={config}
                  json={jsonField}
                  createPython={() => void createPython()}
                  openFile={(id) => void openFile(id)}
                  canOpen={!!props.openObject}
                />
                {selectedNode.type === 'skill' && (
                  <>
                    <label>
                      {uiText('从已安装目录选择')}
                      <select
                        value={
                          catalog.skills.some(
                            (skill) => skill.path === selectedNode.config.skillPath,
                          )
                            ? selectedNode.config.skillPath
                            : ''
                        }
                        onChange={(event) => {
                          const skill = catalog.skills.find(
                            (item) => item.path === event.target.value,
                          );
                          if (skill)
                            changeNode(selectedNode.id, {
                              label: skill.name,
                              config: { ...selectedNode.config, skillPath: skill.path },
                            });
                        }}
                      >
                        <option value="">{uiText('选择 Skill…')}</option>
                        {catalog.skills.map((skill) => (
                          <option key={skill.id} value={skill.path}>
                            {skill.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {uiText('SKILL.md 路径')}
                      <input
                        maxLength={2048}
                        placeholder={uiText('本地 Skill 路径（可选）')}
                        value={selectedNode.config.skillPath ?? ''}
                        onChange={(event) => config({ skillPath: event.target.value })}
                      />
                    </label>
                    <label>
                      {uiText('补充指令')}
                      <textarea
                        maxLength={24000}
                        rows={9}
                        placeholder={uiText('这一步采用的方法、输入要求和交付标准…')}
                        value={selectedNode.config.instructions ?? ''}
                        onChange={(event) => config({ instructions: event.target.value })}
                      />
                    </label>
                    <small className="workflow-field-help">
                      {uiText(
                        '可以选择 Skill，也可以直接编写可复用的指令。原对话执行时读取对应 Skill。',
                      )}
                    </small>
                  </>
                )}
                {selectedNode.type === 'prompt' && (
                  <label>
                    {uiText('处理指令')}
                    <textarea
                      maxLength={24000}
                      rows={14}
                      placeholder={uiText('基于上游结果，完成什么工作？希望得到怎样的输出？')}
                      value={selectedNode.config.instructions ?? ''}
                      onChange={(event) => config({ instructions: event.target.value })}
                    />
                  </label>
                )}
                {selectedNode.type === 'mcp' && (
                  <>
                    <WorkflowToolSchema
                      tool={catalog.tools.find(
                        (tool) =>
                          tool.server === selectedNode.config.server &&
                          tool.name === selectedNode.config.toolName,
                      )}
                    />
                    <label>
                      {uiText('从组件目录选择')}
                      <select
                        value={
                          catalog.tools.some(
                            (tool) =>
                              tool.server === selectedNode.config.server &&
                              tool.name === selectedNode.config.toolName,
                          )
                            ? JSON.stringify([
                                selectedNode.config.server,
                                selectedNode.config.toolName,
                              ])
                            : ''
                        }
                        onChange={(event) => {
                          const tool = catalog.tools.find(
                            (item) =>
                              JSON.stringify([item.server, item.name]) === event.target.value,
                          );
                          if (tool)
                            changeNode(selectedNode.id, {
                              label: tool.name,
                              config: {
                                ...selectedNode.config,
                                server: tool.server,
                                toolName: tool.name,
                              },
                            });
                        }}
                      >
                        <option value="">{uiText('选择 MCP 工具…')}</option>
                        {catalog.tools.map((tool, index) => (
                          <option
                            disabled={tool.available === false}
                            key={`${tool.server}-${tool.name}-${index}`}
                            value={JSON.stringify([tool.server, tool.name])}
                          >
                            {tool.server} / {tool.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {uiText('MCP 服务')}
                      <input
                        maxLength={200}
                        placeholder={uiText('服务名称')}
                        value={selectedNode.config.server ?? ''}
                        onChange={(event) => config({ server: event.target.value })}
                      />
                    </label>
                    <label>
                      {uiText('工具名称')}
                      <input
                        maxLength={200}
                        placeholder={uiText('准确的工具名')}
                        value={selectedNode.config.toolName ?? ''}
                        onChange={(event) => config({ toolName: event.target.value })}
                      />
                    </label>
                    {jsonField(
                      'arguments',
                      uiText('常量参数 · JSON'),
                      selectedNode.config.arguments ?? {},
                      true,
                    )}
                    <label>
                      {uiText('调用说明')}
                      <textarea
                        maxLength={24000}
                        rows={4}
                        placeholder={uiText('参数如何使用上游结果，失败时如何处理…')}
                        value={selectedNode.config.instructions ?? ''}
                        onChange={(event) => config({ instructions: event.target.value })}
                      />
                    </label>
                    <small className="workflow-field-help">
                      {uiText(
                        '目录提供组件元数据。工具是否可用、实际调用与权限，以 Codex 原对话为准。',
                      )}
                    </small>
                  </>
                )}
                {selectedNode.type === 'output' && (
                  <>
                    <label>
                      {uiText('结果位置')}
                      <select
                        value={selectedNode.config.targetObjectId ?? ''}
                        onChange={(event) =>
                          config({ targetObjectId: event.target.value || undefined })
                        }
                      >
                        <option value="">{uiText('请选择结果文件…')}</option>
                        {workspace.objects
                          .filter((item) => item.id !== object.id)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {uiText('回写：')}
                              {item.title}
                            </option>
                          ))}
                      </select>
                    </label>
                    {!selectedNode.config.targetObjectId && (
                      <>
                        <label>
                          {uiText('新建结果名称')}
                          <input
                            maxLength={120}
                            placeholder={uiText('例如：分析报告.md')}
                            value={selectedNode.config.outputName ?? ''}
                            onChange={(event) => config({ outputName: event.target.value })}
                          />
                        </label>
                        <button onClick={() => void createOutput()}>
                          <Icon name="plus" size={15} />
                          {uiText('新建 Markdown 结果文件')}
                        </button>
                      </>
                    )}
                    <label>
                      {uiText('交付要求')}
                      <textarea
                        maxLength={24000}
                        rows={8}
                        placeholder={uiText('结果内容、格式、保留哪些已有信息…')}
                        value={selectedNode.config.instructions ?? ''}
                        onChange={(event) => config({ instructions: event.target.value })}
                      />
                    </label>
                    <small className="workflow-field-help">
                      {uiText('选择已有材料时，结果回到同一个桌面对象，保留文件与版本关系。')}
                    </small>
                  </>
                )}
                {['python', 'mcp', 'extract', 'chart'].includes(selectedNode.type) && (
                  <>
                    <WorkflowParameterDefinition
                      key={`schema:${selectedNode.id}`}
                      node={selectedNode}
                      change={config}
                    />
                    <WorkflowFieldBindings
                      key={`bindings:${selectedNode.id}`}
                      node={selectedNode}
                      document={document!}
                      run={activeRun}
                      change={config}
                    />
                  </>
                )}
                {selectedNode.type === 'python' && (
                  <WorkflowSourceManager
                    key={`source:${selectedNode.id}`}
                    node={selectedNode}
                    workspace={workspace}
                    action={props.action}
                    updated={props.updated}
                    busyChanged={(value) => {
                      sourceBusyRef.current = value;
                      setSourceBusy(value);
                    }}
                    change={config}
                    openFile={(id) => void openFile(id)}
                  />
                )}
                <WorkflowComponentVersion
                  key={`version:${selectedNode.id}`}
                  node={selectedNode}
                  action={props.action}
                  apply={(node) => {
                    changeNode(node.id, node);
                    setArgumentDrafts((values) =>
                      Object.fromEntries(
                        Object.entries(values).filter(([key]) => !key.endsWith(`:${node.id}`)),
                      ),
                    );
                  }}
                />
                {activeRun && !activeRun.restoredAt && (
                  <div className="workflow-inline-actions">
                    <button
                      disabled={!canHandoff || !plan?.valid}
                      onClick={() =>
                        void send({
                          fromRunId: activeRun.id,
                          nodeIds: [selectedNode.id],
                          includeDownstream: false,
                        })
                      }
                    >
                      {uiText('仅运行此组件')}
                    </button>
                    <button
                      disabled={!canHandoff || !plan?.valid}
                      onClick={() =>
                        void send({
                          fromRunId: activeRun.id,
                          nodeIds: selectedIds.length ? selectedIds : [selectedNode.id],
                          includeDownstream: true,
                        })
                      }
                    >
                      {uiText('重跑选中及下游')}
                    </button>
                    <small>
                      {uiText(
                        '仅复用配置和输入版本均未变化的祖先结果；已失效结果会要求重新选择上游步骤。',
                      )}
                    </small>
                  </div>
                )}
                <WorkflowPortEditor node={selectedNode} change={config} />
                <section className="workflow-save-component">
                  <strong>{uiText('复用这个组件')}</strong>
                  {selectedNode.origin && <small>{uiText('来自个人库 · 当前为独立实例')}</small>}
                  <button onClick={() => void storeComponent()}>
                    <Icon name="box" size={15} />
                    {uiText('存为个人组件')}
                  </button>
                  {selectedNode.origin && (
                    <button onClick={() => void storeComponent(true)}>
                      <Icon name="save" size={15} />
                      {uiText('更新原组件文件')}
                    </button>
                  )}
                  <small>
                    {uiText('保存配置、端口与脚本引用。其他流程中的实例不会自动变化。')}
                  </small>
                </section>
                <div className="workflow-node-actions">
                  <button onClick={duplicate}>
                    <Icon name="layers" size={15} />
                    {uiText('复制组件')}
                  </button>
                  <button className="is-danger" onClick={removeSelection}>
                    <Icon name="trash" size={15} />
                    {uiText('删除')}
                  </button>
                </div>
              </fieldset>
            ) : selectedConnection ? (
              <div className="workflow-connection-info">
                <Icon name="link" size={28} />
                <strong>
                  {document?.nodes.find((node) => node.id === selectedConnection.source)?.label}
                </strong>
                <code>{selectedConnection.sourcePort}</code>
                <Icon name="arrow" />
                <strong>
                  {document?.nodes.find((node) => node.id === selectedConnection.target)?.label}
                </strong>
                <code>{selectedConnection.targetPort}</code>
                <p>
                  {uiText('上游命名端口的值将传给下游指定输入。JSON 输入可接收其他可序列化类型。')}
                </p>
                <fieldset disabled={!editable}>
                  <label>
                    {uiText('上游输出')}
                    <select
                      value={selectedConnection.sourcePort}
                      onChange={(event) =>
                        update((value) => ({
                          ...value,
                          edges: value.edges.map((edge) =>
                            edge.id === selectedConnection.id
                              ? { ...edge, sourcePort: event.target.value }
                              : edge,
                          ),
                        }))
                      }
                    >
                      {workflowPorts(
                        document!.nodes.find((node) => node.id === selectedConnection.source)!,
                      ).outputs.map((port) => (
                        <option key={port.name} value={port.name}>
                          {port.name} · {port.type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {uiText('下游输入')}
                    <select
                      value={selectedConnection.targetPort}
                      onChange={(event) =>
                        update((value) => ({
                          ...value,
                          edges: value.edges.map((edge) =>
                            edge.id === selectedConnection.id
                              ? { ...edge, targetPort: event.target.value }
                              : edge,
                          ),
                        }))
                      }
                    >
                      {workflowPorts(
                        document!.nodes.find((node) => node.id === selectedConnection.target)!,
                      ).inputs.map((port) => (
                        <option key={port.name} value={port.name}>
                          {port.name} · {port.type}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>
                <button className="is-danger" disabled={!editable} onClick={removeSelection}>
                  <Icon name="trash" size={15} />
                  {uiText('删除连接')}
                </button>
              </div>
            ) : document ? (
              <fieldset disabled={!editable}>
                <label>
                  {uiText('工作流名称')}
                  <input
                    maxLength={100}
                    value={document.name}
                    onChange={(event) =>
                      update((value) => ({ ...value, name: event.target.value }))
                    }
                  />
                </label>
                <label>
                  {uiText('工作流说明')}
                  <textarea
                    maxLength={6000}
                    rows={5}
                    placeholder={uiText('描述目标、适用场景和预期结果…')}
                    value={document.description}
                    onChange={(event) =>
                      update((value) => ({ ...value, description: event.target.value }))
                    }
                  />
                </label>
                <WorkflowPublishSettings
                  document={document}
                  change={(next) => update(() => next)}
                />
                <div className="workflow-edit-hint">
                  <Icon name="settings" size={22} />
                  <strong>{uiText('选择组件，编辑细节')}</strong>
                  <p>
                    {uiText('为每一步选择材料、配置 Skill 或 MCP 参数，再用连线定义处理顺序。')}
                  </p>
                </div>
              </fieldset>
            ) : null}
            <div className="workflow-validation">
              <strong>
                <span
                  className={`workflow-state-dot state-${plan?.valid && !unavailableIds.length && !Object.keys(invalidArguments).length ? 'succeeded' : 'waiting'}`}
                />
                {plan?.valid && !unavailableIds.length && !Object.keys(invalidArguments).length
                  ? uiText('流程已就绪')
                  : uiText('待完善')}
              </strong>
              <ul>
                {plan?.issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
                {unavailableIds.length > 0 && (
                  <li>
                    {unavailableIds.length} {uiText('份引用材料不存在，请重新选择。')}
                  </li>
                )}
                {Object.keys(invalidArguments).length > 0 && (
                  <li>{uiText('组件参数或输入 JSON 尚未完整。')}</li>
                )}
              </ul>
              {plan?.valid && !unavailableIds.length && !Object.keys(invalidArguments).length && (
                <p>
                  {uiText('共')}
                  {plan.order.length} {uiText('步，交给原对话后按连接顺序执行。')}
                </p>
              )}
            </div>
          </aside>
        </div>
      </section>
      {bundleDialog && document && (
        <WorkflowBundleDialog
          key={bundleDialog.entry?.object.id ?? 'new'}
          document={document}
          flowObjectId={object.id}
          selectedIds={selectedIds}
          workspace={workspace}
          entry={
            bundleDialog.entry
              ? {
                  definition: bundleDialog.entry.definition,
                  objectId: bundleDialog.entry.object.id,
                  revision: bundleDialog.entry.object.revision,
                }
              : undefined
          }
          close={() => setBundleDialog(null)}
          save={storeBundle}
          insert={(definition) =>
            bundleDialog.entry && insertComponent(bundleDialog.entry, definition)
          }
        />
      )}
    </div>
  );
}
