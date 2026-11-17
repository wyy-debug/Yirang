import { nodeTypes, textOf, type Draft, type CardData } from './canvas/object-card.js';
import '../electron/design-tokens.css';
import { useSettingsBridge } from './ui/use-settings-bridge.js';
import { WorkbenchFeedback, TransientNotice } from './ui/workbench-feedback.js';
import { hasVisibleOverlay } from './ui/visible-overlay.js';
import { AppWidgets } from './light-apps/app-widgets.js';
import { getUiLanguage as interfaceLocale } from '../../packages/components/ui-language.js';
import { getUiLanguage as getUiLocale } from '../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from './ui/ui-language.js';
import { t as uiText } from '../../packages/components/ui-language.js';
import { connectUiLanguage, useUiLanguage } from './ui/ui-language.js';
import { useTransientNotice } from './ui/use-transient-notice.js';
import './documents/native/native-workbench.css';
import { browserCommand } from './browser/electron-browser-bridge.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrameViewport } from './canvas/use-frame-viewport.js';
import { RenderPerformance, useDesktopCommitTiming } from './ui/render-performance.js';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  applyNodeChanges,
  useReactFlow,
  useStoreApi,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './workbench-theme.css';
import './ai-glow.css';
import './desktop-operations.css';
import './workbench-interactions.css';
import { DesktopPreview } from './documents/desktop-preview.js';
import { useDesktopDeletion, DeletionFeedback, DesktopTrash } from './workspace/desktop-delete.js';
import {
  CanvasToolbar,
  CanvasBoardLayer,
  type CanvasTool,
  type CanvasBoardHandle,
} from './canvas/canvas-board.js';
import { useCanvasHistory } from './canvas/use-canvas-history.js';
import { useCanvasBoard } from './canvas/use-canvas-board.js';
import { useScreenshotAi } from './interaction/use-screenshot-ai.js';
import { useCanvasAnalysis } from './canvas/use-canvas-analysis.js';
import { liveOutputSources, outputProvenanceLinks, shortLinkGeometry } from './canvas/canvas-links.js';
import { WorkflowEditor, hasWorkflowDraft, workflowDraftKey } from './workflows/workflow-editor.js';
import { isWorkflowObject } from './workflows/workflow-library.js';
import { DesktopToolLibrary } from './workflows/desktop-tool-library.js';
import { useDesktopToolPlacement } from './workflows/use-desktop-tool-placement.js';
import {
  DESKTOP_TOOL_MIME,
  DesktopToolDrag,
  type DesktopToolSource,
} from '../../packages/contracts/desktop-tools.js';
import { WorkflowWidgetContext, type WorkflowRunOptions } from './workflows/workflow-widget.js';
import { sendWorkflowRuns, acknowledgeWorkflowRequests } from './workflows/workflow-send.js';
import { WebWorkbench } from './browser/web-workbench.js';
import { BrowserWorkspace } from './browser/browser-workspace.js';
import { sendWebTask } from './browser/web-task-send.js';
import type { WebTaskRequestValue } from '../../packages/contracts/web-tasks.js';
import { CanvasPreviewProvider, CanvasDetailContext } from './canvas/canvas-file-preview.js';
import { CanvasNavigation, CanvasGuides, useCanvasSize } from './canvas/canvas-navigation.js';
import { useCanvasRegions } from './canvas/use-canvas-regions.js';
import { regionMemberIds } from '../../packages/components/canvas-folders.js';
import { notifyWorkspaceChange } from './workspace/workspace-refresh.js';
import { useAutomaticBackups } from './workspace/automatic-backups.js';
import { PanelErrorBoundary } from './ui/panel-error-boundary.js';
import { useOutputNavigation } from './workspace/use-output-navigation.js';
import {
  extent,
} from '../../packages/components/canvas-spatial.js';
import { DesktopLibraryView } from './workspace/desktop-library.js';
import {
  DesktopCommandPalette,
  DesktopContextMenu,
  DesktopShortcutHelp,
  type DesktopCommand,
} from './ui/desktop-actions.js';
import { BatchRenameDialog } from './ui/batch-rename.js';
import { FileTransferDialog, type FileTransfer } from './ui/file-transfer.js';
import { ActivityDrawer } from './workspace/activity-drawer.js';
import { BundleExportDialog } from './workspace/bundle-dialog.js';
import { useCardDrag, type LayoutChange } from './canvas/use-card-drag.js';
import { useWorkflowHandoff } from './workflows/use-workflow-handoff.js';
import {
  DesktopArrangeMenu,
  arrangeDesktopObjects,
  type ArrangeMode,
} from './canvas/desktop-arrange.js';
import { useDesktopDuplicate } from './canvas/use-desktop-duplicate.js';
import type { DesktopLibrary } from '../../packages/contracts/canvas-preview.js';
import { Icon, FileBadge } from './ui/icons.js';
import { DesktopMark } from './canvas/desktop-mark.js';
import {
  WorkbenchChrome,
  EmptyDesktop,
  ActionPopover,
  type CreationKind,
  type DeskDestination,
} from './ui/workbench-chrome.js';
import { DESKTOP_VERSION } from '../../packages/contracts/version.js';
import { isIntegratedDesktop } from './workspace/workspace-mode.js';
import {
  McpBridge,
  PanelActionError,
  PanelClosedError,
  SendRejectedError,
  connectionAfterError,
  attachSelection,
  type AttachedSelection,
  type ContextState,
  type LocalConnection,
} from './host.js';
import type {
  AnnotationDraft,
  Code,
  DesktopObject,
  EditableContent,
  PanelBinding,
  Table,
  Text,
  Workspace,
  WorkTask,
  MaterialRange,
  Diagram,
  Deck,
  Workbook,
} from '../../packages/contracts/index.js';
import { TextContent } from '../../packages/contracts/index.js';
import { contentText, editOperation, kindLabels } from '../../packages/components/content.js';
import { selectedObject } from '../../packages/components/selection.js';
import { CodeEditor, TableEditor, RevisionHistory } from './documents/editors.js';
import { TaskDesk } from './work/tasks.js';
import { ImageEditor } from './documents/image-editor.js';
import { AnnotationRecovery } from './interaction/annotation-recovery.js';
import { Materials } from './documents/materials.js';
import { Environment } from './work/environment.js';
import {
  useLightAppPages,
  LightAppPageDeck,
  AppNotificationBar,
  focusAppRun,
} from './light-apps/light-app-pages.js';
import { DesktopTabs } from './workspace/desktop-tabs.js';
import { useWorkspaceNavigation } from './workspace/use-workspace-navigation.js';
import { LocalRunsView, type RunSelection } from './work/local-runs.js';
import { ContextPreview } from './interaction/context-preview.js';
import { DiagramEditor, DeckEditor, WorkbookEditor } from './documents/structured-editors.js';
import { diagramSvg, annotationSvg } from '../../packages/components/structured.js';
import { ArtifactLibrary } from './documents/artifacts.js';
import { TextEditor } from './documents/text-editor.js';
import { rasterizeSvg } from './documents/rasterize.js';
import { RangeProtection } from './documents/protection.js';
import { Workspaces, type WorkspaceChange } from './workspace/workspaces.js';
import { DeskNavigator } from './workspace/desk-navigator.js';
import { ImportMaterials, type ImportMaterialsHandle } from './workspace/imports.js';
import { useFileDrop, type DropPoint } from './workspace/file-drop.js';
import { Backups } from './workspace/backups.js';
import { FileBrowser } from './workspace/file-browser.js';
import { FileDirectory } from './workspace/file-directory.js';
import { BrowserCanvas, useBrowserCanvas } from './browser/browser-canvas.js';
import { Layouts } from './workspace/layouts.js';
import { NativeFileDetails } from './documents/native/native-file.js';
import { CommentsDrawer } from './interaction/comments.js';
import {
  syncNativeDrafts,
  nativeDraftKey,
  nativeDraftKinds,
} from './documents/native/native-drafts.js';
import { scheduleDraftWrite, flushDraftStorage, writeDraftNow } from './documents/draft-storage.js';
import { useObjectActivity } from './interaction/object-activity.js';
import { mergeWorkspaceDelta } from './workspace/workspace-sync.js';
import { emptyFileTree, folderPath } from '../../packages/components/file-tree.js';
import { localCodeRuntime } from '../../packages/components/native-files.js';
import { IntentWorkbench, IntentSelection } from './interaction/intent-workbench.js';
import { useVoiceSelection } from './interaction/use-voice-selection.js';
import { useFileAiTarget, type PreviewQuote } from './interaction/use-file-ai-target.js';

const bridge = new McpBridge();
const uid = () => crypto.randomUUID();

function Desktop({
  initialState,
  hostReady,
  hostError,
  openState,
}: {
  initialState: any;
  hostReady: boolean;
  hostError: string;
  openState: (value: any) => void;
}) {
  useUiLocale();
  useDesktopCommitTiming();
  const flow = useReactFlow<Node<CardData>>();
  const flowStore = useStoreApi();
  const canvasViewport = useFrameViewport();
  const canvasBoardRef = useRef<CanvasBoardHandle>(null);
  const [canvasTool, setCanvasTool] = useState<CanvasTool>('select');
  const [canvasStroke, setCanvasStroke] = useState('#374151'),
    [canvasFill, setCanvasFill] = useState('transparent'),
    [canvasStrokeWidth, setCanvasStrokeWidth] = useState(2);
  const [initial, setInitial] = useState<any>(null);
  const [binding, setBinding] = useState<PanelBinding | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  useEffect(() => {
    if (!workspace || !binding || !document.documentElement.classList.contains('electron-mode'))
      return;
    let painted = 0;
    const frame = requestAnimationFrame(() => {
      painted = requestAnimationFrame(() =>
        window.parent.postMessage({ type: 'ai-desktop:canvas-painted' }, '*'),
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(painted);
    };
  }, [workspace?.id, !!binding]);
  const [nodes, setNodes] = useState<Node<CardData>[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [attached, setAttached] = useState<AttachedSelection | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useTransientNotice();
  const [full, setFullValue] = useState<string | null>(null);
  const [fileActionsOpen, setFileActionsOpen] = useState(false);
  useEffect(() => setFileActionsOpen(false), [full]);
  const [workflowLibrary, setWorkflowLibrary] = useState(false),
    [workflowDirty, setWorkflowDirty] = useState(false);
  const [webOpen, setWebOpen] = useState(false),
    [webDirty, setWebDirty] = useState(false),
    webDirtyRef = useRef(false),
    webSending = useRef(false);
  const webDirtyChanged = useCallback((value: boolean) => {
    webDirtyRef.current = value;
    setWebDirty(value);
  }, []);
  const [browserOpen, setBrowserOpen] = useState(false),
    [browserUrl, setBrowserUrl] = useState<{ id: string; url: string }>(),
    browserWorking = useRef(false);
  const [browserFloating, setBrowserFloating] = useState(true);
  const browserDirtyChanged = useCallback((value: boolean) => {
    browserWorking.current = value;
  }, []);
  const [workflowReturn, setWorkflowReturn] = useState<{ flowId: string; fileId: string } | null>(
    null,
  );
  const [commentsTarget, setCommentsTarget] = useState<{
    objectId?: string;
    range?: MaterialRange;
    threadId?: string;
  } | null>(null);
  const commentSendActive = useRef(false);
  const workflowSendActive = useRef(false),
    widgetDrafts = useRef(new Set<string>()),
    widgetImportTarget = useRef<{ objectId: string; fieldKey: string } | null>(null);
  const setFull = useCallback<React.Dispatch<React.SetStateAction<string | null>>>((value) => {
    if (typeof value === 'string' && widgetDrafts.current.has(value)) {
      setNotice(uiText('请先保存或放弃小工具的参数草稿，再打开流程编辑器。'));
      return;
    }
    setFullValue(value);
  }, []);
  const [widgetDraftCount, setWidgetDraftCount] = useState(0);
  const workflowDirtyRef = useRef(false);
  function workflowDirtyChanged(value: boolean) {
    workflowDirtyRef.current = value;
    setWorkflowDirty(value);
  }
  const [previewIds, setPreviewIds] = useState<string[]>([]),
    [previewIndex, setPreviewIndex] = useState(0),
    [trashOpen, setTrashOpen] = useState(false);
  const [imageDirty, setImageDirty] = useState(false);
  const [fileDirty, setFileDirty] = useState(false);
  const [materials, setMaterials] = useState(false);
  const [environment, setEnvironment] = useState(false);
  const [runSelection, setRunSelection] = useState<RunSelection | null>(null);
  const [contextPreview, setContextPreview] = useState(false);
  const [artifacts, setArtifacts] = useState(false),
    [newMenu, setNewMenu] = useState(false);
  const [regionMenu, setRegionMenu] = useState(false);
  const [selectionTools, setSelectionTools] = useState(false),
    [selectionList, setSelectionList] = useState(false),
    [selectionArrange, setSelectionArrange] = useState(false);
  useEffect(() => setSelectionArrange(false), [selected]);
  const [commandsOpen, setCommandsOpen] = useState(false),
    [shortcutsOpen, setShortcutsOpen] = useState(false),
    [renameIds, setRenameIds] = useState<string[]>([]);
  const [fileTransfer, setFileTransfer] = useState<FileTransfer | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; ids: string[] } | null>(
    null,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('desktop:sidebar-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [library, setLibrary] = useState<DesktopLibrary>({ favoriteIds: [], recentIds: [] });
  const [libraryView, setLibraryView] = useState<'recent' | 'favorites' | null>(null);
  const [ranges, setRanges] = useState<Record<string, MaterialRange>>({});
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<LocalConnection>('connecting');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [navigator, setNavigator] = useState<'search' | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<
    (WorkspaceChange & { requestId: string }) | null
  >(null);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [revisionObject, setRevisionObject] = useState<string | null>(null);
  const [protectionObject, setProtectionObject] = useState<string | null>(null);
  const [revisionTarget, setRevisionTarget] = useState<number | undefined>();
  const [importOpen, setImportOpen] = useState(false);
  const [exportedPath, setExportedPath] = useState('');
  const [bundlePath, setBundlePath] = useState('');
  const [taskDesk, setTaskDesk] = useState<'list' | null>(null);
  const [zoom, setZoom] = useState(100);
  const [recoverable, setRecoverable] = useState<any[]>([]);
  const [annotationRecovery, setAnnotationRecovery] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false),
    [layoutsOpen, setLayoutsOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const navigating = useRef(false);
  const activeDestination: DeskDestination = browserOpen
    ? 'browser'
    : webOpen
      ? 'web'
      : commentsTarget && !commentsTarget.objectId
        ? 'comments'
        : workflowLibrary
          ? 'workflows'
          : trashOpen
            ? 'trash'
            : (libraryView ??
              (filesOpen
                ? 'files'
                : materials
                  ? 'materials'
                  : taskDesk
                    ? 'tasks'
                    : runSelection
                      ? 'runs'
                      : artifacts
                        ? 'artifacts'
                        : environment
                          ? 'tools'
                          : showHistory
                            ? 'history'
                            : 'canvas'));
  const appPages = useLightAppPages(isIntegratedDesktop ? workspace?.id : undefined, (id) => {
    void navigateDesktop('canvas', id);
  });
  const pendingAppOpen = useRef<{ workspaceId: string; instanceId: string } | null>(null);
  useEffect(() => {
    const pending = pendingAppOpen.current;
    if (pending && workspace?.id === pending.workspaceId) {
      pendingAppOpen.current = null;
      void navigateDesktop('canvas', pending.instanceId);
    }
  }, [workspace?.id]);
  useEffect(() => {
    const receive = (e: MessageEvent) => {
      if (
        e.source === window.parent &&
        e.data?.type === 'yirang:open-light-app' &&
        typeof e.data.instanceId === 'string'
      ) {
        if (typeof e.data.runId === 'string') focusAppRun(e.data.instanceId, e.data.runId);
        void openCatalogApp({
          workspaceId: e.data.workspaceId,
          instanceId: e.data.instanceId,
        }).catch((error) => setNotice(String(error?.message || error)));
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  });
  async function openCatalogApp(app: any) {
    if (app.workspaceId && app.workspaceId !== workspace?.id) {
      pendingAppOpen.current = {
        workspaceId: app.workspaceId,
        instanceId: app.instanceId || app.id,
      };
      try {
        await changeWorkspace({ operation: 'switch', targetId: app.workspaceId });
      } catch (e) {
        pendingAppOpen.current = null;
        throw e;
      }
    } else await navigateDesktop('canvas', app.instanceId || app.id);
  }
  const canvasVisible =
    !appPages.active &&
    !(full && workspace?.objects.some((object) => object.id === full)) &&
    (['canvas', 'workflows', 'history'].includes(activeDestination) ||
      (activeDestination === 'browser' && browserFloating));
  const [layoutStatus, setLayoutStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const pendingLayout = useRef(new Map<string, DesktopObject['bounds']>()),
    layoutJobs = useRef(0),
    suppressView = useRef(false);
  const [arrangementBusy, setArrangementBusy] = useState(false),
    arrangementWorking = useRef(false);
  const canvasRef = useRef<HTMLElement>(null);
  const importer = useRef<ImportMaterialsHandle>(null);
  const draftRef = useRef(drafts),
    wsRef = useRef(workspace),
    bindingRef = useRef(binding);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const composing = useRef(false),
    lastInputAt = useRef(0);
  const queues = useRef<Record<string, Promise<unknown>>>({});
  const viewQueue = useRef<Promise<unknown>>(Promise.resolve());
  const viewRev = useRef(1);
  const mounted = useRef(true),
    switching = useRef(false);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  draftRef.current = drafts;
  wsRef.current = workspace;
  bindingRef.current = binding;
  function canvasImportPosition(point: DropPoint) {
    const projected = flow.screenToFlowPosition(point);
    return Number.isFinite(projected.x) && Number.isFinite(projected.y)
      ? projected
      : { x: 60, y: 80 };
  }
  const fileDrop = useFileDrop({
    scopeKey: workspace?.id ?? '',
    blocked: (source) => {
      if (source === 'paste') {
        if (!workspace || !importer.current || connectionRef.current !== 'ready')
          return uiText('桌面尚未就绪，请稍后再粘贴。');
        if (imageDirty || fileDirty || workflowDirty) return uiText('请先保存当前编辑。');
        if (busy || switching.current || pendingSwitch || importer.current.busy())
          return uiText('桌面正在处理文件，请稍后再粘贴。');
        return null;
      }
      if (!workspace || !importer.current) return uiText('请先打开一个工作区，再拖入文件。');
      if (imageDirty || fileDirty || workflowDirty) return uiText('请先保存当前编辑，再拖入文件。');
      if (busy || switching.current || pendingSwitch)
        return uiText('正在保存或切换工作区，请稍后拖入。');
      if (importer.current.busy()) return uiText('正在导入文件，请等待完成或暂停后继续拖入。');
      if (connectionRef.current !== 'ready')
        return uiText('本地连接尚未就绪，请重新连接后拖入文件。');
      return null;
    },
    rejected: (reason) => setNotice(reason),
    pasteTarget: (target) => {
      const canvas = canvasRef.current;
      if (
        !canvasVisible ||
        !canvas ||
        !(target instanceof Element) ||
        !canvas.contains(target) ||
        target.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"],.widget-file-field',
        ) ||
        hasVisibleOverlay()
      )
        return null;
      const bounds = canvas.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    },
    acceptText: (text, point) => void pasteTextNote(text, canvasImportPosition(point)),
    accept: (files, point, warning, directories) => {
      const bounds = canvasRef.current?.getBoundingClientRect();
      const onCanvas =
        bounds &&
        point.x >= bounds.left &&
        point.x <= bounds.right &&
        point.y >= bounds.top &&
        point.y <= bounds.bottom &&
        !importOpen &&
        !full;
      const screenPoint = onCanvas
        ? point
        : bounds
          ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
          : point;
      setNewMenu(false);
      setArmedCreation(null);
      setImportOpen(true);
      importer.current?.drop(files, canvasImportPosition(screenPoint), warning, directories);
    },
  });
  const report = (e: unknown) => {
    if (mounted.current && !(e instanceof PanelClosedError))
      setError(e instanceof Error ? e.message : String(e));
  };
  function requireOpen() {
    if (!mounted.current) throw new PanelClosedError();
  }
  function localReady() {
    if (mounted.current) {
      connectionRef.current = 'ready';
      setConnection('ready');
      setLastSync(new Date().toLocaleTimeString(interfaceLocale()));
    }
  }
  function localFailure(e: unknown) {
    if (mounted.current && !(e instanceof PanelClosedError)) {
      connectionRef.current = connectionAfterError(e);
      setConnection(connectionRef.current);
    }
  }
  function scoped() {
    requireOpen();
    const b = bindingRef.current;
    if (!b) throw new Error(uiText('尚未打开工作区'));
    return { workspaceId: b.workspaceId, credential: b.credential };
  }
  const action = useCallback(async (name: string, payload: Record<string, unknown> = {}) => {
    try {
      const result = await bridge.call('desktop_panel_action', {
        ...scoped(),
        action: name,
        payload,
      });
      requireOpen();
      localReady();
      return result;
    } catch (e) {
      localFailure(e);
      throw e;
    }
  }, []);
  const listFileTransferTargets = useCallback(() => action('workspace_list'), [action]);
  useSettingsBridge(workspace?.id, action);
  useAutomaticBackups(workspace?.id, action);
  useEffect(() => {
    const receive = (e: Event) => setNotice((e as CustomEvent).detail);
    window.addEventListener('ai-desktop:backup-notice', receive);
    return () => window.removeEventListener('ai-desktop:backup-notice', receive);
  }, []);
  const canvasHistory = useCanvasHistory(workspace?.id, report);
  const drawing = useCanvasBoard({
    workspace,
    action,
    notice: setNotice,
    onHistory: canvasHistory.record,
  });
  const canvasSize = useCanvasSize(canvasRef, workspace?.id);
  const visibleRect = useMemo(
    () => ({
      x: -canvasViewport.x / canvasViewport.zoom,
      y: -canvasViewport.y / canvasViewport.zoom,
      width: canvasSize.width / canvasViewport.zoom,
      height: canvasSize.height / canvasViewport.zoom,
    }),
    [canvasViewport, canvasSize, getUiLocale()],
  );
  const regions = useCanvasRegions({
    workspace,
    board: drawing.board,
    view: visibleRect,
    viewport: canvasViewport,
    selected,
    selectedMarks: () => canvasBoardRef.current?.selectedMarks() ?? [],
    ready: () => canArrange() && drawing.status === 'saved',
    action,
    updated: (value) => updateWorkspace(value),
    reload,
    previewCards: moveCanvasCards,
    onHistory: canvasHistory.record,
    fit: (bounds) => void flow.fitBounds(bounds, { padding: 0.15, duration: 220 }),
    notice: setNotice,
  });
  const canvasCards = useMemo(
    () =>
      nodes
        .filter((node) => !regions.collapsed.cards.has(node.id))
        .map((node) => ({
          id: node.id,
          title: node.data.object.title,
          x: node.position.x,
          y: node.position.y,
          width: node.measured?.width ?? node.data.object.bounds.width,
          height: node.measured?.height ?? node.data.object.bounds.height,
        })),
    [nodes, regions.collapsed.cards, getUiLocale()],
  );
  const outputLinks = useMemo(
    () => outputProvenanceLinks(workspace?.objects ?? [], regions.collapsed.cards, selected),
    [workspace?.objects, regions.collapsed.cards, selected],
  );
  const visibleNodes = useMemo(
    () =>
      nodes
        .filter(
          (node) =>
            !String((node.data.object.content as any).fileName || '').endsWith('.yirang-app.json'),
        )
        .map((node) =>
          regions.collapsed.cards.has(node.id) ? { ...node, hidden: true, selected: false } : node,
        ),
    [nodes, regions.collapsed.cards, getUiLocale()],
  );
  const navigationMarks = useMemo(
    () => drawing.board.items.filter((mark) => !regions.collapsed.marks.has(mark.id)),
    [drawing.board.items, regions.collapsed.marks],
  );
  const previewObjects = previewIds.flatMap((id) => {
      const object = workspace?.objects.find((o) => o.id === id);
      return object ? [object] : [];
    }),
    previewObject = previewObjects[Math.min(previewIndex, previewObjects.length - 1)];
  const screenshotAi = useScreenshotAi({
    workspace,
    canvas: canvasRef,
    preview: previewObject,
    enabled:
      isIntegratedDesktop &&
      (!!previewObject || (canvasVisible && activeDestination === 'canvas')) &&
      !busy &&
      !regions.busy &&
      !pendingSwitch,
    bridge,
    flush: async () => {
      await flush();
    },
    notice: setNotice,
  });
  const canvasAnalysis = useCanvasAnalysis({
    workspace,
    board: drawing.board,
    view: visibleRect,
    canvas: canvasRef,
    selected,
    selectedMarks: () => canvasBoardRef.current?.selectedMarks() ?? [],
    hiddenMarks: regions.collapsed.marks,
    cards: canvasCards,
    enabled:
      isIntegratedDesktop &&
      canvasVisible &&
      activeDestination === 'canvas' &&
      !busy &&
      !regions.busy &&
      !pendingSwitch,
    flush: async () => {
      await flush();
    },
    bridge,
    notice: setNotice,
  });
  const [snapEnabled, setSnapEnabled] = useState(true),
    [gridEnabled, setGridEnabled] = useState(false);
  const { guides, setGuides, snapCanvas, dragCard } = useCardDrag({
    snapEnabled,
    gridEnabled,
    canvasCards,
    drawing,
    regions,
    viewport: canvasViewport,
    canvasHistory,
    boardRef: canvasBoardRef,
    setNodes,
    recordCardMove,
    persistView,
  });
  const minimapPanning = useRef(false);
  const canvasBrowser = useBrowserCanvas({
    enabled: isIntegratedDesktop,
    workspace,
    view: visibleRect,
    occupied: canvasCards,
    showCanvas: () => navigateDesktop('canvas'),
    fit: (bounds) => {
      void flow.fitBounds(bounds, { padding: 0.15, duration: 220 });
    },
    notice: setNotice,
  });
  useOutputNavigation({
    workspace,
    view: visibleRect,
    visible: canvasVisible,
    reload,
    navigate: () => navigateDesktop('canvas'),
    switchWorkspace: (id) => changeWorkspace({ operation: 'switch', targetId: id }),
    locate: locateObjects,
    preview: openPreview,
    readPreview: (objectId, expectedRevision) =>
      action('native_workbench', { operation: 'preview', objectId, expectedRevision }),
    open: (id, commentId) => {
      if (commentId) setCommentsTarget({ objectId: id, threadId: commentId });
      else setFull(id);
    },
    notice: setNotice,
  });
  useWorkspaceNavigation({
    workspaceId: workspace?.id,
    navigate: () => navigateDesktop('canvas'),
    change: changeWorkspace,
    notice: setNotice,
  });
  function widgetOperationPending(id: string) {
    const key = `ai-desktop:widget:${wsRef.current?.id}:${id}`;
    flushDraftStorage(key);
    try {
      return (
        !!JSON.parse(localStorage.getItem(key) ?? 'null')?.pending ||
        !!localStorage.getItem(`${key}:batch`)
      );
    } catch {
      return true;
    }
  }
  const deletion = useDesktopDeletion({
    workspace,
    action,
    updated: reload,
    hasDraft: (id, discardWorkflowDraft) =>
      !!draftRef.current[id] ||
      widgetOperationPending(id) ||
      (!discardWorkflowDraft && hasWorkflowDraft(id)) ||
      (full === id && (fileDirty || imageDirty || workflowDirtyRef.current)),
    removed: (ids) => {
      setSelected((values) => values.filter((id) => !ids.includes(id)));
      setPreviewIds((values) => values.filter((id) => !ids.includes(id)));
      setFull((value) => (value && ids.includes(value) ? null : value));
      setRanges((values) =>
        Object.fromEntries(Object.entries(values).filter(([id]) => !ids.includes(id))),
      );
      for (const id of ids) pendingLayout.current.delete(id);
    },
  });
  function deleteDraftStatus(id: string): 'none' | 'workflow' | 'blocked' {
    if (
      !!draftRef.current[id] ||
      widgetOperationPending(id) ||
      (full === id && (fileDirty || imageDirty || workflowDirtyRef.current))
    )
      return 'blocked';
    try {
      if (nativeDraftKinds.some((kind) => !!localStorage.getItem(nativeDraftKey(id, kind))))
        return 'blocked';
      const raw = localStorage.getItem(workflowDraftKey(id));
      if (!raw) return 'none';
      const draft = JSON.parse(raw) as { pendingSave?: unknown; pendingInstantiation?: unknown };
      return draft && typeof draft === 'object' && !draft.pendingSave && !draft.pendingInstantiation
        ? 'workflow'
        : 'blocked';
    } catch {
      return 'blocked';
    }
  }
  async function deleteMaterials(ids: string[], markIds?: string[]) {
    if (!workspace || busy || deletion.busy || deletion.pendingCount || switching.current) return;
    const existing = [...new Set(ids)].filter((id) =>
      workspace.objects.some((object) => object.id === id),
    );
    if (!existing.length) return;
    if (existing.some((id) => deleteDraftStatus(id) === 'blocked')) {
      setNotice(uiText('有未保存或待确认的修改，请先保存或处理草稿再删除。'));
      return;
    }
    const discardWorkflowDraftIds = existing.filter((id) => deleteDraftStatus(id) === 'workflow');
    const workspaceId = workspace.id;
    deletion.dismiss();
    setSelectionTools(false);
    setSelectionList(false);
    const removed = await deletion.remove(existing, { discardWorkflowDraftIds });
    if (markIds?.length && wsRef.current?.id === workspaceId) {
      if (existing.every((id) => removed.includes(id)))
        canvasBoardRef.current?.removeMarks(markIds);
      else setNotice(uiText('有材料未完成删除，同一选区中的图形已保留。'));
    }
  }
  const duplication = useDesktopDuplicate({
    workspace,
    action,
    updated: reload,
    hasDraft: (id) =>
      !!draftRef.current[id] ||
      widgetDrafts.current.has(id) ||
      hasWorkflowDraft(id) ||
      (full === id && (fileDirty || imageDirty || workflowDirtyRef.current)),
    created: (id) => {
      selectObjects([id]);
      setNotice(
        uiText('已复制为新的桌面对象。流程或组件文件的副本沿用原有材料引用，可打开后调整。'),
      );
      requestAnimationFrame(() => fitObjects([id]));
    },
  });
  const [aiActivities, setAiActivities] = useState<Record<string, string>>({});
  const [workActivities, setWorkActivities] = useState<{
    workspaceId: string;
    activities: Record<string, string>;
  }>({ workspaceId: '', activities: {} });
  const combinedAiActivities = useMemo(
    () => ({
      ...(workActivities.workspaceId === workspace?.id ? workActivities.activities : {}),
      ...aiActivities,
    }),
    [workActivities, workspace?.id, aiActivities],
  );
  const objectActivities = useObjectActivity(workspace?.id, action);
  const localAction = useRef(action);
  localAction.current = action;
  const favoriteQueue = useRef<Promise<unknown>>(Promise.resolve());
  function libraryRequest(payload: Record<string, unknown>) {
    const panel = bindingRef.current?.panelInstanceId;
    favoriteQueue.current = favoriteQueue.current
      .catch(() => {})
      .then(async () => {
        if (!mounted.current || !panel || bindingRef.current?.panelInstanceId !== panel) return;
        const next = await localAction.current('native_workbench', {
          operation: 'library',
          ...payload,
        });
        if (mounted.current && bindingRef.current?.panelInstanceId === panel) setLibrary(next);
      })
      .catch((error) => {
        if (mounted.current && bindingRef.current?.panelInstanceId === panel) report(error);
      });
  }
  function setFavorite(objectId: string, favorite: boolean) {
    libraryRequest({ command: 'favorite', objectId, favorite });
  }
  useEffect(() => {
    setLibrary({ favoriteIds: [], recentIds: [] });
    setLibraryView(null);
    if (workspace?.id) libraryRequest({ command: 'get' });
  }, [workspace?.id, binding?.panelInstanceId]);
  useEffect(() => {
    if (full && workspace?.id) libraryRequest({ command: 'visit', objectId: full });
  }, [full, workspace?.id, binding?.panelInstanceId]);
  function toggleSidebar() {
    setSidebarCollapsed((previous) => {
      const next = !previous;
      try {
        localStorage.setItem('desktop:sidebar-collapsed', next ? '1' : '0');
      } catch {}
      return next;
    });
  }
  function remember(next: Record<string, Draft>) {
    if (!mounted.current) return;
    draftRef.current = next;
    setDrafts(next);
    const b = bindingRef.current;
    if (b)
      scheduleDraftWrite(
        `ai-desktop:drafts:${b.workspaceId}`,
        () => (Object.keys(next).length ? JSON.stringify(next) : null),
        (error) => {
          if (error && mounted.current)
            setNotice(uiText('浏览器草稿备份不可用，请及时保存后再关闭。'));
        },
      );
  }
  const updateWorkspace = useCallback((w: Workspace, resetCursor = false) => {
    if (!mounted.current || bindingRef.current?.workspaceId !== w.id) return;
    if (wsRef.current === w) return;
    if (!resetCursor && wsRef.current?.id === w.id && wsRef.current.cursor > w.cursor) return;
    if (wsRef.current?.id === w.id) {
      const known = new Map(wsRef.current.objects.map((object) => [object.id, object]));
      // A poll started before a local commit may finish afterwards; never roll saved text back.
      w = {
        ...w,
        objects: w.objects.map((object) => {
          const previous = known.get(object.id);
          return previous && previous.revision > object.revision
            ? {
                ...object,
                content: previous.content,
                revision: previous.revision,
                updatedAt: previous.updatedAt,
                lastActor: previous.lastActor,
                dataUrl: previous.dataUrl,
              }
            : object;
        }),
      };
    }
    if (wsRef.current?.id === w.id && w.viewRevision < viewRev.current) {
      const previous = wsRef.current;
      const knownObjects = new Map(previous.objects.map((o) => [o.id, o]));
      w = {
        ...w,
        viewRevision: viewRev.current,
        viewport: previous.viewport,
        objects: w.objects.map((object) => {
          const known = knownObjects.get(object.id);
          return known && known.bounds !== object.bounds
            ? { ...object, bounds: known.bounds, layoutRevision: known.layoutRevision }
            : object;
        }),
      };
    }
    wsRef.current = w;
    viewRev.current = Math.max(viewRev.current, w.viewRevision);
    setWorkspace(w);
  }, []);
  async function reload() {
    try {
      const value = await bridge.call('desktop_get_workspace', scoped());
      requireOpen();
      updateWorkspace(value);
      notifyWorkspaceChange(value.id);
      localReady();
    } catch (e) {
      localFailure(e);
      throw e;
    }
  }
  const save = async (objectId: string) => {
    const pending = draftRef.current[objectId];
    if (!pending) return;
    const captured = pending;
    const scope = scoped();
    const object = wsRef.current?.objects.find((o) => o.id === objectId);
    if (!object) throw new Error(uiText('对象不存在'));
    const result = await action('draft', {
      objectId,
      base: captured.base,
      content: captured.content,
    });
    if (result.conflict)
      throw new Error(uiText('REVISION_CONFLICT：草稿基于旧版本，已保留你的文字。'));
    const committed = await bridge.call('desktop_commit_changes', {
      ...scope,
      requestId: uid(),
      expectedRevisions: { [objectId]: captured.base },
      operations: [editOperation(object, captured.content)],
      summary: uiText('用户编辑{0}', { '0': kindLabels[object.kind] }),
    });
    requireOpen();
    if (
      bindingRef.current?.workspaceId !== scope.workspaceId ||
      bindingRef.current?.credential !== scope.credential
    )
      return;
    const current = draftRef.current[objectId];
    const w = wsRef.current;
    // Patch just the saved object. The poll cursor must still observe unrelated remote changes.
    if (w)
      updateWorkspace({
        ...w,
        objects: w.objects.map((o) =>
          o.id === objectId && o.revision <= committed.changed[0].revision
            ? {
                ...o,
                content: captured.content,
                revision: committed.changed[0].revision,
                lastActor: 'human',
              }
            : o,
        ),
      });
    const next = { ...draftRef.current };
    if (current && current.content === captured.content) delete next[objectId];
    else if (current)
      next[objectId] = { ...current, base: committed.changed[0].revision, error: undefined };
    remember(next);
    flushDraftStorage(`ai-desktop:drafts:${scope.workspaceId}`);
  };
  function enqueue(objectId: string, fn: () => Promise<unknown>) {
    const job = (queues.current[objectId] ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        requireOpen();
        return fn();
      });
    queues.current[objectId] = job;
    return job;
  }
  function saveSoon(objectId: string) {
    clearTimeout(timers.current[objectId]);
    timers.current[objectId] = setTimeout(() => {
      delete timers.current[objectId];
      if (composing.current) {
        saveSoon(objectId);
        return;
      }
      const scheduled = draftRef.current[objectId];
      enqueue(objectId, () =>
        composing.current || draftRef.current[objectId]?.content !== scheduled?.content
          ? Promise.resolve()
          : save(objectId),
      ).catch((e) => {
        const d = draftRef.current[objectId];
        if (d) remember({ ...draftRef.current, [objectId]: { ...d, error: String(e) } });
        report(e);
      });
    }, 2000);
  }
  const changeRef = useRef<(id: string, content: EditableContent) => void>(() => {});
  changeRef.current = (objectId, content) => {
    if (switching.current || !mounted.current) return;
    const object = wsRef.current?.objects.find((o) => o.id === objectId);
    if (!object) return;
    const previous = draftRef.current[objectId];
    const draft: Draft = { base: previous?.base ?? object.revision, content };
    remember({ ...draftRef.current, [objectId]: draft });
    if (object.kind !== 'text') {
      if (!previous)
        enqueue(objectId, () =>
          action('draft', { objectId, base: draft.base, content: draft.content }),
        ).catch(report);
      saveSoon(objectId);
    }
  };
  const saveText = useCallback((objectId: string) => {
    if (!draftRef.current[objectId]) return;
    enqueue(objectId, () => save(objectId)).catch((error) => {
      const draft = draftRef.current[objectId];
      if (draft) remember({ ...draftRef.current, [objectId]: { ...draft, error: String(error) } });
      report(error);
    });
  }, []);
  const change = useCallback(
    (id: string, content: EditableContent) => changeRef.current(id, content),
    [],
  );
  const edit = useCallback((id: string, value: string) => {
    const object = wsRef.current?.objects.find((o) => o.id === id);
    if (object?.kind === 'text')
      changeRef.current(id, {
        blocks: [{ id: (object.content as Text).blocks[0].id, text: value }],
      });
  }, []);
  const selectionChanged = useCallback(
    ({ nodes }: { nodes: Node[] }) =>
      setSelected((previous) => {
        const ids = nodes.map((n) => n.id);
        return previous.length === ids.length && previous.every((id, i) => id === ids[i])
          ? previous
          : ids;
      }),
    [],
  );
  async function flush(allowWidgetDrafts = true) {
    requireOpen();
    if (webDirtyRef.current) throw new Error(uiText('请先在 Web 工作区保存当前项目修改。'));
    if (workflowDirtyRef.current) throw new Error(uiText('请先在流程编辑器中保存当前修改。'));
    if (widgetDrafts.current.size && !allowWidgetDrafts)
      throw new Error(uiText('请先保存桌面小工具的参数草稿。'));
    flushDraftStorage();
    for (const t of Object.values(timers.current)) clearTimeout(t);
    await Promise.all(Object.values(queues.current).map((queue) => queue.catch(() => {})));
    requireOpen();
    for (const objectId of Object.keys(draftRef.current)) {
      try {
        await enqueue(objectId, () => save(objectId));
      } catch (e) {
        const draft = draftRef.current[objectId];
        if (draft) remember({ ...draftRef.current, [objectId]: { ...draft, error: String(e) } });
        throw e;
      }
    }
    if (Object.keys(draftRef.current).length)
      throw new Error(uiText('仍有未保存草稿，请完成编辑后再发送。'));
    await viewQueue.current;
    await drawing.flush();
    requireOpen();
  }
  function loadInitial(value: any) {
    setInitial(value);
    if (!value.binding) return;
    setCanvasTool('select');
    setCommandsOpen(false);
    setShortcutsOpen(false);
    setRenameIds([]);
    setFileTransfer(null);
    setContextMenu(null);
    setCommentsTarget(null);
    setWorkflowLibrary(false);
    setWorkflowReturn(null);
    workflowDirtyChanged(false);
    setBrowserOpen(false);
    setBrowserUrl(undefined);
    browserWorking.current = false;
    flushDraftStorage();
    composing.current = false;
    for (const timer of Object.values(timers.current)) clearTimeout(timer);
    const b = value.binding as PanelBinding;
    bridge.rebind();
    bindingRef.current = b;
    setBinding(b);
    viewRev.current = value.workspace.viewRevision;
    draftRef.current = {};
    setDrafts({});
    setHistory([]);
    setSelected([]);
    setFull(null);
    setWebOpen(false);
    webDirtyChanged(false);
    setPreviewIds([]);
    setTrashOpen(false);
    setRevisionObject(null);
    setRevisionTarget(undefined);
    setProtectionObject(null);
    setTaskDesk(null);
    setMaterials(false);
    setEnvironment(false);
    setContextPreview(false);
    setArtifacts(false);
    setNewMenu(false);
    setExportedPath('');
    setRanges({});
    updateWorkspace(value.workspace);
    // Legacy unsent instructions stay in their original storage, but never
    // become context or another message input in the materials desktop.
    const recovery = [...(value.drafts ?? [])];
    try {
      const local = JSON.parse(localStorage.getItem(`ai-desktop:drafts:${b.workspaceId}`) || '{}');
      for (const [objectId, d] of Object.entries(local) as [string, Draft][])
        if (!recovery.some((r) => r.objectId === objectId)) recovery.push({ objectId, ...d });
    } catch {
      /* Database drafts remain available. */
    }
    setRecoverable(recovery);
    setAnnotationRecovery(false);
    setBackupsOpen(false);
    setFilesOpen(false);
    setLayoutsOpen(false);
    pendingLayout.current.clear();
    setLayoutStatus('saved');
    localReady();
    setTimeout(() => {
      if (mounted.current) void flow.setViewport(value.workspace.viewport);
    }, 0);
  }
  useEffect(() => {
    loadInitial(initialState ?? {});
    return () => {
      flushDraftStorage();
      mounted.current = false;
      for (const t of Object.values(timers.current)) clearTimeout(t);
    };
  }, []);
  function reflectContext(value: ContextState) {
    if (value === undefined) return;
    const selection = value?.selection;
    setAttached(
      selection?.workspaceId === bindingRef.current?.workspaceId ? (selection ?? null) : null,
    );
    // Context removed by the host is never automatically reattached.
    // The host may also clear after sending, so do not revoke the model's
    // execution credential merely because the composer became empty.
  }
  useEffect(() => {
    if (!hostReady || !binding) return;
    reflectContext(bridge.contextState());
    return bridge.onContext(reflectContext);
  }, [hostReady, binding]);
  const openingFiles = useRef(new Set<string>());
  const cardEvents = useRef({
    setFavorite,
    preview: openPreview,
    activate: activateCard,
    locateOutputSources,
    remove: (id: string) => void deleteMaterials([id]),
    run: (id: string) => void openLocalRuns([id]),
    resize: (id: string, bounds: DesktopObject['bounds']) =>
      void persistView([{ objectId: id, bounds }]),
  });
  cardEvents.current = {
    setFavorite,
    preview: openPreview,
    activate: activateCard,
    locateOutputSources,
    remove: (id: string) => void deleteMaterials([id]),
    run: (id) => void openLocalRuns([id]),
    resize: (id, bounds) => void persistView([{ objectId: id, bounds }]),
  };
  const cardCallbacks = useMemo(
    () => ({
      comment: (id: string) => setCommentsTarget({ objectId: id }),
      action: (name: string, payload?: Record<string, unknown>) =>
        localAction.current(name, payload),
      setFavorite: (id: string, value: boolean) => cardEvents.current.setFavorite(id, value),
      run: (id: string) => cardEvents.current.run(id),
      resize: (id: string, bounds: DesktopObject['bounds']) =>
        cardEvents.current.resize(id, {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        }),
      expand: (id: string) => {
        setFull(id);
      },
      preview: (id: string) => cardEvents.current.preview([id]),
      activate: (id: string) => void cardEvents.current.activate(id),
      locateOutputSources: (id: string) => cardEvents.current.locateOutputSources(id),
      remove: (id: string) => cardEvents.current.remove(id),
      showActivity: (id: string) => {
        setRevisionObject(id);
        setRevisionTarget(undefined);
      },
    }),
    [getUiLocale()],
  );
  useEffect(() => {
    if (!workspace) return;
    setNodes((previous) => {
      const knownNodes = new Map(previous.map((n) => [n.id, n])),
        favorites = new Set(library.favoriteIds),
        linked = new Set(attached?.objects.map((item) => item.id));
      const next = workspace.objects.map((o) => {
        const existing = knownNodes.get(o.id);
        const pending = pendingLayout.current.get(o.id);
        const groups = workspace.groups.items.filter((g) => regionMemberIds(g).includes(o.id)),
          folder = folderPath(
            workspace.fileTree ?? emptyFileTree,
            workspace.fileTree?.locations[o.id] ?? null,
          );
        const favorite = favorites.has(o.id),
          aiLinked = linked.has(o.id);
        // A keystroke in one card must not replace every other React Flow node.
        if (
          existing &&
          !pending &&
          existing.data.object === o &&
          existing.data.activity === objectActivities[o.id] &&
          existing.data.aiActivity === combinedAiActivities[o.id] &&
          existing.data.draft === drafts[o.id] &&
          existing.data.favorite === favorite &&
          existing.data.aiLinked === aiLinked &&
          existing.data.folder === folder &&
          groups.length === existing.data.groups.length &&
          groups.every((g, i) => g === existing.data.groups[i])
        )
          return existing;
        return {
          id: o.id,
          type: 'object',
          position:
            existing?.dragging || existing?.resizing
              ? existing.position
              : pending
                ? { x: pending.x, y: pending.y }
                : { x: o.bounds.x, y: o.bounds.y },
          ...(existing?.dragging ? { dragging: true } : {}),
          ...(existing?.resizing
            ? {
                resizing: true,
                measured: existing.measured,
                width: existing.width,
                height: existing.height,
              }
            : {}),
          style: existing?.resizing
            ? existing.style
            : {
                width: pending?.width ?? o.bounds.width,
                height: pending?.height ?? o.bounds.height,
              },
          selected: existing?.selected ?? selected.includes(o.id),
          dragHandle: '.drag-handle',
          data: {
            object: o,
            activity: objectActivities[o.id],
            aiActivity: combinedAiActivities[o.id],
            draft: drafts[o.id],
            edit,
            change,
            saveText,
            ...cardCallbacks,
            favorite,
            aiLinked,
            status: drafts[o.id]?.error ? uiText('冲突 · 草稿已保留') : '',
            groups,
            folder,
          },
        };
      });
      return next.length === previous.length && next.every((node, i) => node === previous[i])
        ? previous
        : next;
    });
  }, [
    workspace,
    drafts,
    edit,
    saveText,
    library,
    cardCallbacks,
    objectActivities,
    combinedAiActivities,
    attached,
  ]);
  useEffect(() => {
    if (!binding) return;
    let stopped = false,
      running = false,
      timer: ReturnType<typeof setTimeout>,
      idle = 0,
      failures = 0,
      catchingUp = false;
    async function poll() {
      if (stopped || running) return;
      running = true;
      catchingUp = false;
      try {
        if (
          bridge.visible() &&
          !switching.current &&
          !composing.current &&
          Date.now() - lastInputAt.current > 1500 &&
          connectionRef.current !== 'reopen'
        ) {
          const result = await action('changes', {
            after: wsRef.current?.cursor ?? 0,
            incremental: true,
          });
          const apply = !stopped && !composing.current && Date.now() - lastInputAt.current > 1500;
          if (apply) {
            if (result.workspace) {
              updateWorkspace(result.workspace, !!result.reset);
              notifyWorkspaceChange(result.workspace.id);
            } else if (result.delta && wsRef.current) {
              const previous = wsRef.current,
                next = mergeWorkspaceDelta(previous, result.delta);
              updateWorkspace(next);
              if (next !== previous && wsRef.current?.cursor === next.cursor)
                notifyWorkspaceChange(next.id, result.events);
            }
          }
          catchingUp = apply && !!result.hasMore;
          if (apply) {
            const returned = (result.events ?? [])
              .slice()
              .reverse()
              .find((event: { type: string }) =>
                [
                  'local_run.collected',
                  'local_run.collection_pending',
                  'native_file.returned',
                  'native_file.pending',
                ].includes(event.type),
              );
            if (returned)
              setNotice(
                returned.type === 'native_file.returned'
                  ? uiText('原对话处理的文件已回写到原对象，历史版本已保留。')
                  : returned.type === 'native_file.pending'
                    ? uiText('文件回写尚未完成，工作副本已保留。可在文件详情中继续处理。')
                    : returned.type === 'local_run.collected'
                      ? uiText('本地执行结果已回到桌面，可在‘运行记录’中查看卡片和产物。')
                      : uiText(
                          '部分结果仍待收取。已导入的内容保留，可在‘运行记录’中查看待处理事项并继续收回。',
                        ),
              );
          }
          failures = 0;
          if (result.events?.length) {
            idle = 0;
          } else idle++;
        }
      } catch (e) {
        if (!stopped) failures++;
      } finally {
        running = false;
      }
      if (!stopped)
        timer = setTimeout(
          poll,
          failures
            ? Math.min(30000, 1000 * 2 ** Math.min(failures, 5))
            : catchingUp
              ? 150
              : idle > 20
                ? 3000
                : 1000,
        );
    }
    timer = setTimeout(poll, 1000);
    const resume = () => {
      if (bridge.visible()) {
        clearTimeout(timer);
        timer = setTimeout(poll, 0);
      }
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [binding]);
  async function loadActivity(before?: number, background = false) {
    const result = await action('activity', before ? { before } : {});
    setHistory((previous) =>
      before
        ? [...previous, ...result.events]
        : background
          ? [
              ...new Map(
                [...previous, ...result.events].map((event) => [event.seq, event]),
              ).values(),
            ].sort((a, b) => b.seq - a.seq)
          : result.events,
    );
    if (!background) setHistoryNext(result.next);
  }
  useEffect(() => {
    if (showHistory && binding) void loadActivity().catch(report);
  }, [showHistory, binding]);
  useEffect(() => {
    if (showHistory && binding) void loadActivity(undefined, true).catch(report);
  }, [workspace?.cursor]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (switching.current || connectionRef.current !== 'ready') return;
      for (const [objectId, draft] of Object.entries(draftRef.current)) {
        enqueue(objectId, () =>
          action('draft', { objectId, base: draft.base, content: draft.content }),
        ).catch(report);
      }
    }, 10000);
    return () => clearInterval(timer);
  }, [binding]);
  async function choose(actionName: 'create' | 'resume', workspaceId?: string) {
    setBusy(true);
    try {
      openState(
        await bridge.call('desktop_panel_open', {
          action: actionName,
          workspaceId,
          requestId: uid(),
        }),
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function reconnect() {
    if (busy) return;
    setBusy(true);
    setError('');
    // Reopen the host's current binding. Failed sends and edits are never replayed.
    try {
      openState(
        await bridge.call('desktop_panel_open', {
          action: 'resume',
          workspaceId: bindingRef.current?.workspaceId,
          requestId: uid(),
        }),
      );
    } catch (e) {
      localFailure(e);
      report(e);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function changeWorkspace(value: WorkspaceChange & { requestId?: string }) {
    if (regions.busy) throw new Error(uiText('正在保存画布区域，请稍后切换工作区。'));
    if (browserWorking.current)
      throw new Error(uiText('正在保存浏览器内容，请等待本次保存结束后切换工作区。'));
    if (switching.current && !pendingSwitch) throw new Error('正在切换桌面，请稍后重试');
    switching.current = true;
    setBusy(true);
    setError('');
    const payload = { ...value, requestId: value.requestId ?? uid() };
    let dispatched = false;
    try {
      if (!pendingSwitch) {
        await flush();
        if (attached) {
          await bridge.clearContext();
          await action('cancel', { snapshotId: attached.snapshotId });
          setAttached(null);
        }
      }
      requireOpen();
      setPendingSwitch(payload);
      dispatched = true;
      bridge.rebind();
      const result = await bridge.call('desktop_panel_action', {
        ...scoped(),
        action: 'workspace_switch',
        payload,
      });
      openState(result);
    } catch (e) {
      // An unknown transport outcome retains the exact request for a manual retry.
      // A received controller error has a definite outcome; editing can continue.
      if (!dispatched || e instanceof PanelActionError) {
        switching.current = false;
        setPendingSwitch(null);
      }
      localFailure(e);
      report(e);
      throw e;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function createEditable(
    kind:
      | 'text'
      | 'table'
      | 'code'
      | 'diagram'
      | 'deck'
      | 'workbook'
      | 'document'
      | 'html'
      | 'workflow',
    point?: { x: number; y: number },
  ) {
    const count = wsRef.current?.objects.length ?? 0;
    try {
      const slot = point
        ? flow.screenToFlowPosition(point)
        : { x: 90 + (count % 3) * 460, y: 80 + Math.floor(count / 3) * 440 };
      if (!Number.isFinite(slot.x) || !Number.isFinite(slot.y))
        throw Error(uiText('暂时无法确定桌面位置，请重新摆放。'));
      if (kind === 'workflow') {
        const created = await action('workflow', {
          operation: 'create',
          name: uiText('工作流程 {0}', { '0': count + 1 }),
          requestId: uid(),
          bounds: { ...slot, width: 380, height: 265 },
        });
        await reload();
        setNewMenu(false);
        setWorkflowLibrary(false);
        selectObjects([created.id]);
        setNotice(uiText('流程组件已放到桌面，点击卡片可继续编辑。'));
        return;
      }
      const format = (
        {
          text: 'md',
          table: 'xlsx',
          code: 'py',
          diagram: 'svg',
          deck: 'pptx',
          workbook: 'xlsx',
          document: 'docx',
          html: 'html',
        } as const
      )[kind];
      const dimensions =
        kind === 'document'
          ? { width: 290, height: 385 }
          : kind === 'workbook' || kind === 'table'
            ? { width: 400, height: 285 }
            : kind === 'deck'
              ? { width: 350, height: 240 }
              : kind === 'code'
                ? { width: 390, height: 280 }
                : { width: 300, height: 285 };
      const created = await action('native_workbench', {
        operation: 'create',
        format,
        title: `${kind === 'document' ? uiText('文档') : kind === 'html' ? uiText('网页') : kindLabels[kind]} ${count + 1}`,
        requestId: uid(),
        bounds: { ...slot, ...dimensions },
      });
      await reload();
      setNewMenu(false);
      selectObjects([created.id]);
      setNotice(uiText('文件已放到桌面。需要编辑时，再点击卡片打开。'));
      return;
    } catch (e) {
      report(e);
    }
  }
  function persistView(objects: { objectId: string; bounds: DesktopObject['bounds'] }[] = []) {
    if (switching.current || !mounted.current || suppressView.current) return Promise.resolve();
    for (const item of objects) pendingLayout.current.set(item.objectId, item.bounds);
    const captured = [...pendingLayout.current].map(([objectId, bounds]) => ({ objectId, bounds }));
    const viewport = flow.getViewport(),
      saved = wsRef.current?.viewport;
    if (
      !captured.length &&
      !layoutJobs.current &&
      saved &&
      Math.abs(saved.x - viewport.x) < 0.01 &&
      Math.abs(saved.y - viewport.y) < 0.01 &&
      Math.abs(saved.zoom - viewport.zoom) < 0.00001
    )
      return Promise.resolve();
    layoutJobs.current++;
    setLayoutStatus('saving');
    viewQueue.current = viewQueue.current
      .catch(() => {})
      .then(async () => {
        const result = await action('view', {
          requestId: uid(),
          expected: viewRev.current,
          viewport,
          objects: captured,
        });
        viewRev.current = result.viewRevision;
        for (const item of captured)
          if (pendingLayout.current.get(item.objectId) === item.bounds)
            pendingLayout.current.delete(item.objectId);
        const current = wsRef.current;
        if (current)
          updateWorkspace({
            ...current,
            viewRevision: result.viewRevision,
            viewport,
            groups: result.groups ?? current.groups,
            objects: current.objects.map((object) => {
              const item = captured.find((item) => item.objectId === object.id);
              return item
                ? { ...object, bounds: item.bounds, layoutRevision: object.layoutRevision + 1 }
                : object;
            }),
          });
      })
      .then(
        () => {
          layoutJobs.current--;
          if (mounted.current && !layoutJobs.current) setLayoutStatus('saved');
        },
        (error) => {
          layoutJobs.current--;
          if (mounted.current) setLayoutStatus('error');
          throw error;
        },
      );
    viewQueue.current.catch(report);
    return viewQueue.current as Promise<void>;
  }
  async function saveDesktop() {
    // Recover the latest layout revision before an explicit retry; local positions stay staged.
    if (layoutStatus === 'error') await reload();
    await persistView();
    await flush();
    setNotice(uiText('内容、连线、绘图与桌面布局已保存。'));
  }
  async function restoreLayout(w: Workspace) {
    suppressView.current = true;
    try {
      pendingLayout.current.clear();
      updateWorkspace(w);
      await flow.setViewport(w.viewport);
      setZoom(Math.round(w.viewport.zoom * 100));
      setLayoutStatus('saved');
    } finally {
      suppressView.current = false;
    }
  }
  const layoutEqual = (a: DesktopObject['bounds'], b: DesktopObject['bounds']) =>
    ['x', 'y', 'width', 'height'].every(
      (key) => Math.abs(a[key as keyof typeof a] - b[key as keyof typeof b]) < 0.01,
    );
  function canArrange() {
    return (
      !!workspace &&
      !canvasHistory.busy &&
      !busy &&
      !regions.busy &&
      !duplication.busy &&
      !deletion.busy &&
      !arrangementWorking.current &&
      !layoutJobs.current &&
      !pendingLayout.current.size &&
      connection === 'ready' &&
      !switching.current
    );
  }
  function recordCardMove(before: LayoutChange[], after: LayoutChange[]) {
    const changed = after.filter((item) => {
      const previous = before.find((value) => value.objectId === item.objectId);
      return previous && !layoutEqual(previous.bounds, item.bounds);
    });
    if (!changed.length) return;
    const ids = new Set(changed.map((item) => item.objectId)),
      original = before.filter((item) => ids.has(item.objectId));
    canvasHistory.record({
      check: (redo) => {
        const current = flow.getNodes();
        if (
          (redo ? original : changed).some((item) => {
            const node = current.find((n) => n.id === item.objectId);
            return (
              !node || !layoutEqual({ ...node.data.object.bounds, ...node.position }, item.bounds)
            );
          })
        )
          throw Error(uiText('材料已有后续移动、缩放或删除，无法撤销这次拖动。'));
      },
      apply: async (redo) => {
        await viewQueue.current;
        await applyArrangement(redo ? changed : original);
      },
    });
  }
  function applyArrangement(items: LayoutChange[]) {
    const positions = new Map(items.map((item) => [item.objectId, item.bounds]));
    setNodes((current) =>
      current.map((node) => {
        const bounds = positions.get(node.id);
        return bounds ? { ...node, position: { x: bounds.x, y: bounds.y } } : node;
      }),
    );
    return persistView(items);
  }
  async function arrangeSelection(mode: ArrangeMode, ids = selected) {
    if (!canArrange()) return;
    const items = nodes.filter((node) => ids.includes(node.id));
    if (items.length < 2) return;
    const scope = workspace!.id,
      panel = bindingRef.current?.panelInstanceId;
    try {
      const before = items.map((node) => ({
        objectId: node.id,
        bounds: { ...node.data.object.bounds, ...node.position },
      }));
      const after = arrangeDesktopObjects(
        before.map((item) => ({ id: item.objectId, bounds: item.bounds })),
        mode,
      );
      if (
        after.every((item) =>
          layoutEqual(
            item.bounds,
            before.find((previous) => previous.objectId === item.objectId)!.bounds,
          ),
        )
      )
        return;
      arrangementWorking.current = true;
      setArrangementBusy(true);
      await applyArrangement(after);
      recordCardMove(before, after);
      if (
        !mounted.current ||
        wsRef.current?.id !== scope ||
        bindingRef.current?.panelInstanceId !== panel
      )
        return;
      setNotice(uiText('已排列 {0} 份材料，可在「排列」菜单撤回。', { '0': items.length }));
    } catch (cause) {
      report(cause);
    } finally {
      arrangementWorking.current = false;
      if (mounted.current) setArrangementBusy(false);
    }
  }
  async function undoArrangement(redo = false) {
    if (redo) canvasHistory.redo();
    else canvasHistory.undo();
  }
  function selectObjects(ids: string[]) {
    const actual = wsRef.current?.objects.filter((o) => ids.includes(o.id)).map((o) => o.id) ?? [];
    setSelected(actual);
    setRanges({});
    setNodes((current) => current.map((node) => ({ ...node, selected: actual.includes(node.id) })));
    return actual;
  }
  const mixedMoveBefore = useRef<LayoutChange[] | null>(null);
  function moveCanvasCards(
    positions: { id: string; x: number; y: number }[],
    phase: 'preview' | 'commit' | 'cancel',
  ) {
    if (phase === 'preview' && !mixedMoveBefore.current) {
      const ids = new Set(positions.map((p) => p.id));
      mixedMoveBefore.current = flow
        .getNodes()
        .filter((node) => ids.has(node.id))
        .map((node) => ({
          objectId: node.id,
          bounds: { ...node.data.object.bounds, ...node.position },
        }));
    }
    const moved = new Map(positions.map((position) => [position.id, position]));
    setNodes((current) =>
      current.map((node) => {
        const next = moved.get(node.id);
        return next
          ? { ...node, dragging: phase === 'preview', position: { x: next.x, y: next.y } }
          : node;
      }),
    );
    if (phase === 'commit') {
      const after = positions.flatMap((position) => {
        const object = wsRef.current?.objects.find((item) => item.id === position.id);
        return object
          ? [{ objectId: object.id, bounds: { ...object.bounds, x: position.x, y: position.y } }]
          : [];
      });
      if (mixedMoveBefore.current) recordCardMove(mixedMoveBefore.current, after);
      void persistView(after);
    }
    if (phase !== 'preview') mixedMoveBefore.current = null;
  }
  function fitObjects(ids = selected) {
    const browserBounds = canvasBrowser.state.tabs
      .filter((tab) => tab.canvas?.workspaceId === workspace?.id)
      .map((tab) => tab.canvas!);
    const selectedMarks =
      arguments.length === 0
        ? new Set(canvasBoardRef.current?.selectedMarks() ?? [])
        : new Set<string>();
    if (selectedMarks.size) {
      const bounds = extent([
        ...canvasCards.filter((card) => ids.includes(card.id)),
        ...drawing.board.items.filter((mark) => selectedMarks.has(mark.id)),
      ]);
      if (bounds) {
        void flow.fitBounds(bounds, { padding: 0.2, duration: 180 });
        return;
      }
    }
    if (
      !ids.length &&
      (drawing.board.items.length || regions.regions.length || browserBounds.length)
    ) {
      const bounds = [
        ...canvasCards,
        ...drawing.board.items.filter((mark) => !regions.collapsed.marks.has(mark.id)),
        ...regions.regions.map((group) => group.bounds!),
        ...browserBounds,
      ];
      const x = Math.min(...bounds.map((item) => item.x)),
        y = Math.min(...bounds.map((item) => item.y));
      const right = Math.max(...bounds.map((item) => item.x + item.width)),
        bottom = Math.max(...bounds.map((item) => item.y + item.height));
      void flow.fitBounds(
        { x, y, width: Math.max(100, right - x), height: Math.max(100, bottom - y) },
        { padding: 0.2, duration: 180 },
      );
      return;
    }
    void flow.fitView({
      nodes: ids.length ? nodes.filter((node) => ids.includes(node.id)) : nodes,
      padding: 0.25,
      duration: 180,
    });
  }
  function chooseCanvasTool(tool: CanvasTool) {
    setCanvasTool(tool);
    if (tool !== 'select' && tool !== 'hand') selectObjects([]);
    setNewMenu(false);
    canvasRef.current?.focus({ preventScroll: true });
  }
  function connectSelected() {
    const cards = canvasCards.filter((card) => selected.includes(card.id));
    if (cards.length < 2) return;
    if (drawing.board.links.length + cards.length - 1 > 4000) {
      setNotice(uiText('画布连线已达到保存上限，请先删除不再需要的连线。'));
      return;
    }
    const links = [...drawing.board.links],
      remaining = cards.slice(1).map((card) => ({ card, source: cards[0].id, distance: Infinity }));
    let added = 0,
      source = cards[0];
    // Join nearby cards into one short network without making every pair a wire.
    while (remaining.length) {
      let bestIndex = 0;
      remaining.forEach((entry, index) => {
        const geometry = shortLinkGeometry(source, entry.card),
          distance = geometry?.length ?? 0;
        if (distance < entry.distance) {
          entry.distance = distance;
          entry.source = source.id;
        }
        if (entry.distance < remaining[bestIndex].distance) bestIndex = index;
      });
      const pair = remaining.splice(bestIndex, 1)[0];
      if (
        !links.some(
          (link) =>
            (link.sourceId === pair.source && link.targetId === pair.card.id) ||
            (link.sourceId === pair.card.id && link.targetId === pair.source),
        )
      ) {
        links.push({
          id: uid(),
          sourceId: pair.source,
          targetId: pair.card.id,
          label: '',
          arrow: false,
        });
        added++;
      }
      source = pair.card;
    }
    if (added) drawing.change({ items: drawing.board.items, links });
    setNotice(
      added
        ? uiText('已添加 {0} 条短连线，移动卡片时会跟随。重叠卡片分开后显示连线。', { '0': added })
        : uiText('这些材料已经相连。'),
    );
  }
  function locateOutputSources(id: string) {
    const objects = wsRef.current?.objects ?? [];
    const output = objects.find((object) => object.id === id && !object.archived);
    if (!output) return;
    const available = new Set(
      objects
        .filter((object) => !object.archived && !object.policy?.private)
        .map((object) => object.id),
    );
    const sources = liveOutputSources(output, available);
    locateObjects([id, ...sources.map((source) => source.id)]);
    if (!sources.length) setNotice(uiText('来源材料当前不可定位。'));
  }
  function locateObjects(ids: string[], focusCanvas = true) {
    const actual = selectObjects(ids);
    if (!actual.length) {
      setNotice(uiText('这些材料已归档或移出当前桌面。'));
      return;
    }
    setNavigator(null);
    setMaterials(false);
    setFilesOpen(false);
    setLibraryView(null);
    const bounds = extent(
      wsRef.current?.objects
        .filter((object) => actual.includes(object.id))
        .map((object) => object.bounds) ?? [],
    );
    void regions.unfoldFor(actual).then(() => {
      if (bounds) void flow.fitBounds(bounds, { padding: 0.25, duration: 240 });
      else fitObjects(actual);
    });
    if (focusCanvas) canvasRef.current?.focus({ preventScroll: true });
  }
  function canvasShortcut(e: React.KeyboardEvent) {
    if (
      e.defaultPrevented ||
      e.nativeEvent.isComposing ||
      busy ||
      regions.busy ||
      deletion.busy ||
      duplication.busy ||
      arrangementBusy ||
      canvasHistory.busy ||
      !workspace ||
      switching.current ||
      hasVisibleOverlay()
    )
      return;
    const target = e.target as HTMLElement;
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      e.key.toLowerCase() === 's' &&
      target.closest('.material-object')
    ) {
      e.preventDefault();
      e.stopPropagation();
      void flush().catch(report);
      return;
    }
    if (
      target.closest(
        'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="dialog"]',
      )
    )
      return;
    if (!canvasVisible) return;
    const mod = e.ctrlKey || e.metaKey,
      key = e.key.toLowerCase();
    let handled = true;
    if (mod && !e.altKey && key === 'p') {
      if (!e.repeat) openCommands();
    } else if (mod && !e.altKey && key === 'k') {
      setNewMenu(false);
      setNavigator('search');
    } else if (mod && !e.altKey && key === 'd' && selected.length === 1) {
      if (!e.repeat) void duplication.copy(selected[0]);
    } else if (!mod && !e.altKey && key === 'f2' && selected.length) {
      beginRename(selected);
    } else if (!mod && !e.altKey && key === '?') {
      setShortcutsOpen(true);
    } else if (mod && !e.altKey && key === 'z') {
      if (e.shiftKey) canvasHistory.redo();
      else canvasHistory.undo();
    } else if (mod && !e.altKey && key === 'y') {
      canvasHistory.redo();
    } else if (mod && !e.altKey && key === 's') {
      void saveDesktop().catch(report);
    } else if (mod && !e.altKey && key === 'g') {
      if (!e.repeat) regions.create();
    } else if (mod && !e.altKey && key === 'a') {
      selectObjects(workspace.objects.map((o) => o.id));
    } else if (!mod && !e.altKey && key === 'escape') {
      setNewMenu(false);
      setCanvasTool('select');
      selectObjects([]);
    } else if (
      !mod &&
      !e.altKey &&
      !target.closest('button,a') &&
      (
        {
          v: 'select',
          h: 'hand',
          r: 'rectangle',
          d: 'diamond',
          o: 'ellipse',
          a: 'arrow',
          l: 'line',
          p: 'pen',
          t: 'text',
          n: 'note',
          e: 'eraser',
        } as Record<string, CanvasTool>
      )[key]
    ) {
      chooseCanvasTool(
        (
          {
            v: 'select',
            h: 'hand',
            r: 'rectangle',
            d: 'diamond',
            o: 'ellipse',
            a: 'arrow',
            l: 'line',
            p: 'pen',
            t: 'text',
            n: 'note',
            e: 'eraser',
          } as Record<string, CanvasTool>
        )[key],
      );
    } else if (!mod && !e.altKey && !target.closest('button,a') && key === 'f') {
      fitObjects();
    } else if (!mod && !e.altKey && !target.closest('button,a') && key === ' ' && selected.length) {
      openPreview(selected);
    } else if (
      !mod &&
      !e.altKey &&
      !target.closest('button,a') &&
      key === 'delete' &&
      selected.length
    ) {
      if (!e.repeat) void deleteMaterials(selected);
    } else if (
      !mod &&
      !e.altKey &&
      !target.closest('button,a') &&
      key === 'enter' &&
      selected.length === 1
    ) {
      setFull(selected[0]);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  const {
    attachMaterials,
    handoffWorkflow,
    deliverWorkflowRuns,
    submitWorkflowRuns,
    checkWorkflowDelivery,
    sendComment,
    recoverWorkflow,
    submitWebTask,
    attachRunRecovery,
    removeAttached,
    removeAttachedRef,
  } = useWorkflowHandoff({
    bridge,
    binding,
    bindingRef,
    wsRef,
    mounted,
    busy,
    setBusy,
    setError,
    setNotice,
    selected,
    setSelected,
    ranges,
    setRanges,
    attached,
    setAttached,
    setRunSelection,
    setNodes,
    fileDirty,
    imageDirty,
    workflowDirtyRef,
    workflowSendActive,
    commentSendActive,
    webSending,
    flush,
    reload,
    scoped,
    requireOpen,
    reflectContext,
    action,
    report,
  });
  const maintenanceRef = useRef(async (_reason = 'upgrade') => ({ id: '' }));
  maintenanceRef.current = async (reason = 'upgrade') => {
    if (fileDirty || imageDirty || workflowDirtyRef.current || browserWorking.current)
      throw Error(uiText('请先保存文件、批注、流程或浏览器编辑，再升级应用。'));
    await flush();
    await syncNativeDrafts(wsRef.current?.objects ?? [], action);
    if (reason === 'close') return { id: 'saved' };
    return action('backup_create', {
      requestId: crypto.randomUUID(),
      label: reason === 'close' ? uiText('退出前备份') : uiText('应用升级前备份'),
    });
  };
  useEffect(() => {
    if (!isIntegratedDesktop) return;
    const receive = async (event: MessageEvent) => {
      if (
        event.source === window.parent &&
        event.data?.type === 'ai-desktop:work-activity' &&
        typeof event.data.workspaceId === 'string'
      ) {
        const next: Record<string, string> = {};
        for (const [id, label] of Object.entries(event.data.activities || {}))
          if (id.length <= 200 && typeof label === 'string' && label.length <= 80) next[id] = label;
        setWorkActivities((previous) =>
          previous.workspaceId === event.data.workspaceId &&
          JSON.stringify(previous.activities) === JSON.stringify(next)
            ? previous
            : { workspaceId: event.data.workspaceId, activities: next },
        );
        return;
      }
      if (
        event.source === window.parent &&
        event.data?.type === 'ai-desktop:file-activity' &&
        event.data.activities &&
        typeof event.data.activities === 'object'
      ) {
        const next: Record<string, string> = {};
        for (const [objectId, label] of Object.entries(
          event.data.activities as Record<string, unknown>,
        ))
          if (objectId.length <= 200 && typeof label === 'string' && label.length <= 80)
            next[objectId] = label;
        setAiActivities((previous) =>
          Object.keys(previous).length === Object.keys(next).length &&
          Object.entries(next).every(([id, label]) => previous[id] === label)
            ? previous
            : next,
        );
        return;
      }
      if (
        event.source === window.parent &&
        event.data?.type === 'ai-desktop:prepare-close' &&
        typeof event.data.id === 'string'
      ) {
        try {
          (document.activeElement as HTMLElement)?.blur();
          await maintenanceRef.current('close');
          window.parent.postMessage({ type: 'ai-desktop:close-result', id: event.data.id }, '*');
        } catch (error) {
          window.parent.postMessage(
            {
              type: 'ai-desktop:close-result',
              id: event.data.id,
              error: String(error).replace(uiText('再升级应用'), uiText('再退出')),
            },
            '*',
          );
        }
        return;
      }
      if (
        event.source === window.parent &&
        event.data?.type === 'ai-desktop:maintenance' &&
        typeof event.data.id === 'string' &&
        event.data.id.length < 100
      ) {
        try {
          window.parent.postMessage(
            {
              type: 'ai-desktop:maintenance-result',
              id: event.data.id,
              result: await maintenanceRef.current(),
            },
            '*',
          );
        } catch (error) {
          window.parent.postMessage(
            { type: 'ai-desktop:maintenance-result', id: event.data.id, error: String(error) },
            '*',
          );
        }
        return;
      }
      if (
        event.source !== window.parent ||
        event.data?.type !== 'ai-desktop:clear-reference' ||
        typeof event.data.id !== 'string' ||
        event.data.id.length > 100
      )
        return;
      const id = event.data.id,
        ok = await removeAttachedRef.current();
      window.parent.postMessage({ type: 'ai-desktop:clear-reference-result', id, ok }, '*');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  async function annotationSaved(draft: AnnotationDraft) {
    requireOpen();
    const revision = draft.savedRevision!,
      current = wsRef.current;
    if (current)
      updateWorkspace({
        ...current,
        objects: current.objects.map((object) =>
          object.id === draft.objectId && object.revision < revision
            ? {
                ...object,
                revision,
                lastActor: 'human',
                content: {
                  ...(object.content as {
                    assetHash: string;
                    mime: string;
                    width: number;
                    height: number;
                  }),
                  annotations: draft.annotations,
                },
              }
            : object,
        ),
      });
    // A refresh failure must not turn a confirmed commit into an unknown write.
    try {
      await reload();
    } catch (e) {
      report(e);
    }
  }
  async function prepareBackup() {
    requireOpen();
    await syncNativeDrafts(wsRef.current?.objects ?? [], action);
    for (const timer of Object.values(timers.current)) clearTimeout(timer);
    await Promise.all(Object.values(queues.current).map((queue) => queue.catch(() => {})));
    for (const [objectId, draft] of Object.entries(draftRef.current)) {
      await enqueue(objectId, () =>
        action('draft', { objectId, base: draft.base, content: draft.content }),
      );
    }
    await viewQueue.current;
    requireOpen();
  }
  async function openLocalRuns(ids: string[] = selected) {
    setBusy(true);
    try {
      await flush();
      requireOpen();
      setRunSelection({
        objects: structuredClone(
          wsRef.current!.objects.filter((object) => ids.includes(object.id)),
        ),
        ranges: structuredClone(
          Object.fromEntries(Object.entries(ranges).filter(([id]) => ids.includes(id))),
        ),
      });
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function resolveDraft(objectId: string, preserve: boolean) {
    setBusy(true);
    try {
      clearTimeout(timers.current[objectId]);
      await (queues.current[objectId] ?? Promise.resolve()).catch(() => {});
      const d = draftRef.current[objectId],
        o = wsRef.current?.objects.find((o) => o.id === objectId);
      if (!d || !o) return;
      if (preserve)
        await action('create', {
          requestId: uid(),
          object: {
            kind: o.kind,
            title: uiText('{0} · 草稿', { '0': o.title.slice(0, 110) }),
            content: d.content,
            bounds: { ...o.bounds, x: o.bounds.x + 45, y: o.bounds.y + 45 },
          },
        });
      await action('discard_draft', { objectId });
      const next = { ...draftRef.current };
      delete next[objectId];
      remember(next);
      await reload();
      setError('');
      setNotice(
        preserve ? uiText('草稿已另存为新对象，原对象保持最新版本。') : uiText('已载入最新版本。'),
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function exportSelection(ids: string[]) {
    setBusy(true);
    try {
      await flush();
      const objects = [...new Set(ids)].map((id) => {
        const object = wsRef.current!.objects.find((o) => o.id === id && !o.archived);
        if (!object) throw Error(uiText('材料已变化，请重新选择'));
        return { id, revision: object.revision };
      });
      const result = await action('export_bundle', { requestId: uid(), objects });
      setBundlePath(result.path);
      setNotice(uiText('已打包 {0} 份材料', { '0': result.count }));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function exportObject(
    objectId: string,
    original = false,
    format: 'default' | 'markdown' = 'default',
  ) {
    setBusy(true);
    try {
      await flush();
      const object = wsRef.current!.objects.find((o) => o.id === objectId)!;
      const result = await action('export_file', {
        objectId,
        requestId: uid(),
        expectedRevision: object.revision,
        original,
        format,
      });
      setExportedPath(result.path);
      setNotice(
        original
          ? uiText('原始文件已保存到本地导出目录。')
          : uiText('当前版本已保存到本地导出目录。CSV 公式前缀按文字转义。'),
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function pasteTextNote(text: string, position: DropPoint) {
    const content = { blocks: [{ id: uid(), text }] };
    if (!TextContent.safeParse(content).success) {
      setNotice(uiText('剪贴板文字超过 50,000 字符，请分段粘贴。'));
      return;
    }
    setBusy(true);
    try {
      const note = await action('create', {
        requestId: uid(),
        object: {
          kind: 'text',
          title: text.trim().split(/\r\n?|\n/, 1)[0].slice(0, 100),
          content,
          bounds: { ...position, width: 350, height: 240 },
        },
      });
      await reload();
      selectObjects([note.id]);
      setNotice(uiText('已粘贴为文字笔记。'));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function saveTaskProposal(task: WorkTask) {
    const count = wsRef.current?.objects.length ?? 0;
    await action('create', {
      requestId: uid(),
      object: {
        kind: 'text',
        title: uiText('{0} · 演示方案', { '0': task.title.slice(0, 100) }),
        content: { blocks: [{ id: uid(), text: task.proposal }] },
        bounds: {
          x: 60 + (count % 3) * 390,
          y: 80 + Math.floor(count / 3) * 350,
          width: 350,
          height: 300,
        },
      },
    });
    await reload();
  }
  async function generateArtifact(objectId: string, format: 'pptx' | 'xlsx' | 'svg' | 'png') {
    setBusy(true);
    try {
      await flush();
      const o = wsRef.current!.objects.find((o) => o.id === objectId)!;
      const dimensions = o.content as { width: number; height: number };
      const png =
        format === 'png'
          ? await rasterizeSvg(
              o.kind === 'diagram'
                ? diagramSvg(o.content as Diagram)
                : annotationSvg(o, o.dataUrl!),
              dimensions.width,
              dimensions.height,
            )
          : undefined;
      const result = await action('artifact_generate', {
        requestId: uid(),
        objectId,
        expectedRevision: o.revision,
        format,
        ...(png ? { png } : {}),
      });
      setExportedPath(result.path);
      setNotice(
        uiText('已生成 {0} 文件，来源 v{1}。可在“导出文件”中查看。', {
          '0': format.toUpperCase(),
          '1': result.sourceRevision,
        }),
      );
      await reload();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function useRange(objectId: string, range: MaterialRange, source?: string | Table) {
    try {
      await flush();
      const o = wsRef.current!.objects.find((o) => o.id === objectId)!;
      if (
        source !== undefined &&
        (typeof source === 'string'
          ? contentText(o.content) !== source
          : JSON.stringify(o.content) !== JSON.stringify(source))
      )
        throw new Error(uiText('内容在保存期间发生变化，请重新选择范围。'));
      const savedRange = { ...range, baseRevision: o.revision };
      selectedObject(o, savedRange);
      setRanges((rs) => ({ ...rs, [objectId]: savedRange }));
      setSelected((ids) => (ids.includes(objectId) ? ids : [...ids, objectId]));
      setNodes((ns) => ns.map((n) => (n.id === objectId ? { ...n, selected: true } : n)));
      setFull(null);
      setNotice(uiText('已加入局部选区；只会提交选择的范围。'));
    } catch (e) {
      report(e);
    }
  }
  const conflictControls = (o: DesktopObject) => (
    <div className="conflict-box">
      <strong>
        {uiText('草稿基于 v')}
        {drafts[o.id]?.base}
        {uiText('，当前已是 v')}
        {o.revision}
      </strong>
      <details>
        <summary>{uiText('比较当前已保存内容')}</summary>
        <pre>{contentText(o.content)}</pre>
      </details>
      <button disabled={busy} onClick={() => void resolveDraft(o.id, true)}>
        {uiText('另存草稿为新对象')}
      </button>
      <button disabled={busy} onClick={() => void resolveDraft(o.id, false)}>
        {uiText('放弃草稿并载入最新')}
      </button>
    </div>
  );
  const expanded = workspace?.objects.find((o) => o.id === full);
  async function activateCard(id: string) {
    const current = wsRef.current,
      object = current?.objects.find((item) => item.id === id && !item.archived);
    if (!current || !object) return;
    if (!isIntegratedDesktop || object.kind !== 'file') {
      openPreview([id]);
      return;
    }
    if (openingFiles.current.has(id)) return;
    if (deleteDraftStatus(id) !== 'none') {
      setNotice(uiText('请先保存这份文件的编辑草稿，再用系统应用打开。'));
      return;
    }
    openingFiles.current.add(id);
    try {
      await browserCommand('open-local-file', {
        objectId: id,
        expectedRevision: object.revision,
        viewWorkspaceId: current.id,
      });
    } catch (error) {
      report(error);
    } finally {
      openingFiles.current.delete(id);
    }
  }
  function openPreview(ids: string[]) {
    if (fileDirty || imageDirty || workflowDirty) {
      setNotice(uiText('请先保存或处理当前编辑草稿。'));
      return;
    }
    const live = wsRef.current?.objects.filter((object) => !object.archived) ?? [],
      chosen = ids.filter((id) => live.some((object) => object.id === id));
    if (!chosen.length) return;
    // One file opens at its place in the desktop sequence; a multi-selection
    // remains its own review sequence and never silently adds other files.
    const sequence = chosen.length === 1 ? live.map((object) => object.id) : chosen;
    setPreviewIds(sequence);
    setPreviewIndex(Math.max(0, sequence.indexOf(chosen[0])));
    setSelectionTools(false);
    setSelectionList(false);
    setContextMenu(null);
  }
  function openCommands() {
    if (fileDirty || imageDirty || workflowDirty) {
      setNotice(uiText('请先保存或处理当前编辑草稿，再使用快捷操作。'));
      return;
    }
    setContextMenu(null);
    setSelectionTools(false);
    setSelectionList(false);
    setNewMenu(false);
    setCommandsOpen(true);
  }
  function beginRename(ids: string[]) {
    if (busy || deletion.busy || duplication.busy || switching.current) return;
    if (ids.length > 200) {
      setNotice(uiText('一次最多重命名 200 份材料，请缩小选区。'));
      return;
    }
    setContextMenu(null);
    setCommandsOpen(false);
    setShortcutsOpen(false);
    setPreviewIds([]);
    setNewMenu(false);
    setSelectionTools(false);
    setSelectionList(false);
    setRenameIds([...new Set(ids)]);
  }
  function objectCommands(ids: string[]): DesktopCommand[] {
    const items =
        workspace?.objects.filter((object) => ids.includes(object.id) && !object.archived) ?? [],
      one = items.length === 1 ? items[0] : undefined;
    const blocked =
      busy || deletion.busy || duplication.busy || arrangementBusy || switching.current;
    return [
      {
        id: 'open',
        label: uiText('打开编辑'),
        icon: 'document',
        shortcut: 'Enter',
        group: uiText('材料'),
        disabled: blocked || !one,
        run: () => one && setFull(one.id),
      },
      {
        id: 'preview',
        label: items.length > 1 ? uiText('连续预览所选材料') : uiText('快速预览'),
        icon: 'eye',
        shortcut: 'Space',
        group: uiText('材料'),
        disabled: blocked || !items.length,
        run: () => openPreview(ids),
      },
      {
        id: 'export-bundle',
        label: uiText('打包导出 ZIP'),
        icon: 'folder',
        group: uiText('材料'),
        disabled: blocked || !items.length || items.length > 200,
        run: () => void exportSelection(ids),
      },
      {
        id: 'ask-ai',
        label: uiText('询问 AI'),
        icon: 'link',
        group: uiText('协作'),
        disabled: blocked || !items.length || items.length > 10 || connection !== 'ready',
        run: () => {
          selectObjects(ids);
          if (isIntegratedDesktop)
            window.parent.postMessage({ type: 'ai-desktop:file-ai-toggle' }, '*');
          else void attachMaterials(undefined, ids);
        },
      },
      {
        id: 'rename',
        label: items.length > 1 ? uiText('批量重命名') : uiText('重命名'),
        description: uiText('只修改桌面名称，保留原文件格式'),
        icon: 'text',
        shortcut: 'F2',
        group: uiText('材料'),
        disabled: blocked || !items.length || items.length > 200,
        run: () => beginRename(ids),
      },
      {
        id: 'duplicate',
        label: uiText('复制一份'),
        icon: 'layers',
        shortcut: 'Ctrl / ⌘ D',
        group: uiText('材料'),
        disabled:
          blocked || !one || (!!duplication.pending && duplication.pending.objectId !== one?.id),
        run: () => one && void duplication.copy(one.id),
      },
      ...(one?.kind === 'file'
        ? (['copy', 'cut'] as const).map(
            (operation): DesktopCommand => ({
              id: `file-transfer-${operation}`,
              label:
                operation === 'copy' ? uiText('复制到另一个桌面…') : uiText('剪切到另一个桌面…'),
              icon: operation === 'copy' ? 'layers' : 'desktop',
              group: uiText('材料'),
              disabled: blocked || connection !== 'ready',
              run: () => {
                setContextMenu(null);
                setCommandsOpen(false);
                setFileTransfer({
                  objectId: one.id,
                  title: one.title,
                  expectedRevision: one.revision,
                  operation,
                });
              },
            }),
          )
        : []),
      {
        id: 'comment',
        label: uiText('评论与 AI 处理'),
        icon: 'comment',
        group: uiText('协作'),
        disabled: blocked || !items.length,
        run: () => setCommentsTarget(one ? { objectId: one.id, range: ranges[one.id] } : {}),
      },
      {
        id: 'favorite',
        label:
          one && library.favoriteIds.includes(one.id) ? uiText('取消收藏') : uiText('收藏材料'),
        icon: 'star',
        group: uiText('整理'),
        disabled: blocked || !one,
        run: () => one && setFavorite(one.id, !library.favoriteIds.includes(one.id)),
      },
      {
        id: 'group',
        label: uiText('将选区创建为区域'),
        icon: 'group',
        shortcut: 'Ctrl / ⌘ G',
        group: uiText('整理'),
        disabled: blocked || !items.length,
        run: () => {
          selectObjects(ids);
          regions.create(undefined, ids);
        },
      },
      {
        id: 'grid',
        label: uiText('网格排列'),
        icon: 'grid',
        group: uiText('整理'),
        disabled: blocked || items.length < 2 || !canArrange(),
        run: () => void arrangeSelection('grid', ids),
      },
      {
        id: 'history',
        label: uiText('查看修改与来源'),
        icon: 'history',
        group: uiText('材料'),
        disabled: blocked || !one,
        run: () => {
          if (one) {
            setRevisionTarget(undefined);
            setRevisionObject(one.id);
          }
        },
      },
      {
        id: 'delete',
        label: uiText('移到回收站'),
        description: uiText('保留历史，可恢复'),
        icon: 'trash',
        shortcut: 'Delete',
        group: uiText('整理'),
        disabled: blocked || !items.length || !!deletion.pendingCount,
        run: () => void deleteMaterials(ids),
      },
    ];
  }
  const desktopCommandsBase: DesktopCommand[] = [
    ...(selected.length ? objectCommands(selected) : []),
    {
      id: 'new-note',
      label: uiText('新建文字笔记'),
      description: uiText('Markdown 原生文件'),
      keywords: [uiText('新建'), uiText('文字'), 'md'],
      icon: 'text',
      group: uiText('新建'),
      run: () => chooseCreation('text'),
    },
    {
      id: 'new-table',
      label: uiText('新建 Excel 表格'),
      keywords: ['xlsx', uiText('表格')],
      icon: 'sheet',
      group: uiText('新建'),
      run: () => chooseCreation('workbook'),
    },
    {
      id: 'new-document',
      label: uiText('新建 Word 文档'),
      keywords: ['docx', uiText('文档')],
      icon: 'document',
      group: uiText('新建'),
      run: () => chooseCreation('document'),
    },
    {
      id: 'new-code',
      label: uiText('新建 Python 脚本'),
      keywords: [uiText('代码'), 'py'],
      icon: 'code',
      group: uiText('新建'),
      run: () => chooseCreation('code'),
    },
    {
      id: 'import',
      label: uiText('导入文件与文件夹'),
      keywords: [uiText('拖入'), uiText('材料')],
      icon: 'upload',
      group: uiText('桌面'),
      run: () => {
        setNewMenu(false);
        setArmedCreation(null);
        setImportOpen(true);
      },
    },
    {
      id: 'search',
      label: uiText('搜索文件正文'),
      description: uiText('按名称、内容、类型和区域查找'),
      icon: 'search',
      shortcut: 'Ctrl / ⌘ K',
      group: uiText('桌面'),
      run: () => setNavigator('search'),
    },
    {
      id: 'files',
      label: uiText('打开文件夹'),
      icon: 'folder',
      group: uiText('桌面'),
      run: () => navigateDesktop('files'),
    },
    {
      id: 'directory',
      label: uiText('文件目录 · 跳转文档'),
      keywords: [uiText('目录'), uiText('文档'), uiText('文件'), uiText('定位')],
      icon: 'folder',
      group: uiText('桌面'),
      run: () => void showFileDirectory(),
    },
    {
      id: 'recent',
      label: uiText('最近使用的材料'),
      icon: 'history',
      group: uiText('桌面'),
      run: () => navigateDesktop('recent'),
    },
    ...(isIntegratedDesktop
      ? [
          {
            id: 'browser',
            label: uiText('打开浏览器'),
            keywords: [uiText('上网'), uiText('网站'), uiText('地址'), uiText('标签')],
            icon: 'compass' as const,
            group: uiText('工具'),
            run: () => {
              void navigateDesktop('browser');
            },
          },
        ]
      : []),
    {
      id: 'web',
      label: uiText('打开网页资料'),
      keywords: [uiText('网页'), 'HTML', 'CSS', uiText('快照'), uiText('摘录')],
      icon: 'link',
      group: uiText('工具'),
      run: () => navigateDesktop('web'),
    },
    {
      id: 'workflows',
      label: uiText('浏览组件与流程模板'),
      keywords: [uiText('组件'), uiText('模板'), uiText('自动化')],
      icon: 'workflow',
      group: uiText('工具'),
      run: () => navigateDesktop('workflows'),
    },
    {
      id: 'comments',
      label: uiText('查看全部评论与处理请求'),
      icon: 'comment',
      group: uiText('工具'),
      run: () => navigateDesktop('comments'),
    },
    {
      id: 'runs',
      label: uiText('打开运行记录'),
      icon: 'playCircle',
      group: uiText('工具'),
      run: () => navigateDesktop('runs'),
    },
    {
      id: 'fit',
      label: uiText('适合画布'),
      icon: 'expand',
      shortcut: 'F',
      group: uiText('桌面'),
      run: () => fitObjects(),
    },
    {
      id: 'undo-arrangement',
      label: uiText('撤回上一次排列'),
      icon: 'history',
      group: uiText('整理'),
      disabled: !canArrange() || !canvasHistory.canUndo,
      run: () => void undoArrangement(),
    },
    {
      id: 'redo-arrangement',
      label: uiText('重做排列'),
      icon: 'history',
      group: uiText('整理'),
      disabled: !canArrange() || !canvasHistory.canRedo,
      run: () => void undoArrangement(true),
    },
    {
      id: 'save',
      label: uiText('保存桌面'),
      icon: 'save',
      shortcut: 'Ctrl / ⌘ S',
      group: uiText('桌面'),
      run: () => void saveDesktop().catch(report),
    },
    {
      id: 'help',
      label: uiText('查看快捷键'),
      icon: 'keyboard',
      shortcut: '?',
      group: uiText('帮助'),
      run: () => setShortcutsOpen(true),
    },
  ];
  const desktopCommands = desktopCommandsBase.map((command) => ({
    ...command,
    disabled: command.disabled || busy || duplication.busy || deletion.busy || arrangementBusy,
  }));

  function closeWorkspacePages() {
    setBrowserOpen(false);
    setBrowserUrl(undefined);
    setFull(null);
    setWebOpen(false);
    setFilesOpen(false);
    setLibraryView(null);
    setTrashOpen(false);
    setMaterials(false);
    setTaskDesk(null);
    setRunSelection(null);
    setArtifacts(false);
    setEnvironment(false);
    setWorkflowLibrary(false);
    setCommentsTarget(null);
    setShowHistory(false);
    setNavigator(null);
    setNewMenu(false);
    setArmedCreation(null);
    setArmedTool(null);
    setSelectionList(false);
    setSelectionTools(false);
    setWorkspacesOpen(false);
    setBackupsOpen(false);
    setLayoutsOpen(false);
    setAnnotationRecovery(false);
    setContextPreview(false);
    setRevisionObject(null);
    setProtectionObject(null);
    setWorkflowReturn(null);
  }
  async function showFileDirectory() {
    if (!canvasVisible && !(await navigateDesktop('canvas'))) return;
    setDirectoryOpen(true);
  }
  async function navigateDesktop(destination: DeskDestination, application = '') {
    if (destination === 'tools' && isIntegratedDesktop) {
      setEnvironment(false);
      window.parent.postMessage({ type: 'ai-desktop:open-settings' }, '*');
      return true;
    }
    if (navigating.current || busy || regions.busy) return false;
    if (browserWorking.current) {
      setNotice(uiText('正在保存浏览器内容，请等待本次保存结束。'));
      return false;
    }
    if (destination === 'browser' && !isIntegratedDesktop) return false;
    if (imageDirty || fileDirty || workflowDirtyRef.current || webDirtyRef.current) {
      setNotice(uiText('当前页面还有未保存的修改，请先保存或放弃草稿再切换。'));
      return false;
    }
    navigating.current = true;
    setBusy(true);
    try {
      await flush();
      requireOpen();
      closeWorkspacePages();
      appPages.setActive(application);
      window.dispatchEvent(new Event('yirang:navigation-committed'));
      setBrowserOpen(destination === 'browser');
      setWebOpen(destination === 'web');
      setFilesOpen(destination === 'files');
      setShowHistory(destination === 'history');
      setLibraryView(destination === 'recent' || destination === 'favorites' ? destination : null);
      setTrashOpen(destination === 'trash');
      setWorkflowLibrary(destination === 'workflows');
      setCommentsTarget(destination === 'comments' ? {} : null);
      setMaterials(destination === 'materials');
      setTaskDesk(destination === 'tasks' ? 'list' : null);
      setArtifacts(destination === 'artifacts');
      setEnvironment(destination === 'tools');
      if (destination === 'runs') setRunSelection({ objects: [], ranges: {} });
      if (destination === 'canvas') canvasRef.current?.focus({ preventScroll: true });
      return true;
    } catch (problem) {
      report(problem);
      return false;
    } finally {
      navigating.current = false;
      setBusy(false);
    }
  }
  async function openSearch() {
    if (await navigateDesktop('canvas')) setNavigator('search');
  }
  async function openEmbeddedBrowser(url: string) {
    if (!isIntegratedDesktop) {
      await bridge.openWebUrl(url);
      return;
    }
    if (await navigateDesktop('browser')) setBrowserUrl({ id: uid(), url });
  }
  const widgetValue = {
    workspace,
    action,
    updated: reload,
    disabled: busy || connection !== 'ready' || !!switching.current,
    canRun:
      connection === 'ready' &&
      !!binding?.messageRouteAvailable &&
      hostReady &&
      bridge.supportsSend(),
    run: handoffWorkflow,
    resume: recoverWorkflow,
    sendRuns: submitWorkflowRuns,
    checkDelivery: isIntegratedDesktop ? checkWorkflowDelivery : undefined,
    open: (id: string) => {
      if (widgetDrafts.current.has(id) || fileDirty || imageDirty || workflowDirtyRef.current) {
        setNotice(uiText('请先保存当前组件参数或编辑草稿。'));
        return;
      }
      setFull(id);
    },
    dirty: (id: string, value: boolean) => {
      const before = widgetDrafts.current.size;
      if (value) widgetDrafts.current.add(id);
      else widgetDrafts.current.delete(id);
      if (before !== widgetDrafts.current.size) setWidgetDraftCount(widgetDrafts.current.size);
    },
    importFiles: (files: File[], objectId: string, fieldKey: string) => {
      if (busy || importer.current?.busy()) {
        setNotice(uiText('请等待当前导入完成后再添加文件。'));
        return;
      }
      widgetImportTarget.current = { objectId, fieldKey };
      setImportOpen(true);
      const object = wsRef.current?.objects.find((item) => item.id === objectId);
      importer.current?.drop(
        files,
        { x: (object?.bounds.x ?? 50) + 440, y: object?.bounds.y ?? 80 },
        '',
      );
    },
  };
  const widgetLive = useRef(widgetValue);
  widgetLive.current = widgetValue;
  const widgetCallbacks = useMemo(
    () => ({
      action: (...args: Parameters<typeof widgetValue.action>) =>
        widgetLive.current.action(...args),
      updated: () => widgetLive.current.updated(),
      run: (...args: Parameters<typeof widgetValue.run>) => widgetLive.current.run(...args),
      resume: (...args: Parameters<typeof widgetValue.resume>) =>
        widgetLive.current.resume(...args),
      sendRuns: (...args: Parameters<typeof widgetValue.sendRuns>) =>
        widgetLive.current.sendRuns(...args),
      open: (id: string) => widgetLive.current.open(id),
      dirty: (id: string, value: boolean) => widgetLive.current.dirty(id, value),
      importFiles: (files: File[], objectId: string, fieldKey: string) =>
        widgetLive.current.importFiles(files, objectId, fieldKey),
    }),
    [],
  );
  const widgetContext = useMemo(
    () => ({
      workspace,
      disabled: widgetValue.disabled,
      canRun: widgetValue.canRun,
      ...widgetCallbacks,
    }),
    [workspace, widgetValue.disabled, widgetValue.canRun, widgetCallbacks],
  );
  const [toolDragOver, setToolDragOver] = useState(false);
  const [armedTool, setArmedTool] = useState<{ source: DesktopToolSource; label: string } | null>(
    null,
  );
  const [armedCreation, setArmedCreation] = useState<{ kind: CreationKind; label: string } | null>(
    null,
  );
  async function attachPreviewQuote(
    objectId: string,
    quote: PreviewQuote,
    cancelled: () => boolean,
  ) {
    if (cancelled() || busy) return false;
    const object = wsRef.current?.objects.find((item) => item.id === objectId);
    if (!object) return false;
    if (object.revision !== quote.revision) {
      setNotice(uiText('文件已变化，请重新选择文字。'));
      return false;
    }
    let readOnlyReason: string | undefined;
    if (object.kind === 'file') {
      try {
        const result = await action('native_workbench', {
          operation: 'reference_quote',
          objectId,
          expectedRevision: quote.revision,
          quote: {
            text: quote.text,
            ...(quote.start === undefined ? {} : { start: quote.start }),
            ...(quote.spans ? { spans: quote.spans } : {}),
          },
        });
        if (cancelled()) return false;
        if (result.range)
          return attachMaterials(
            undefined,
            [objectId],
            { [objectId]: result.range },
            undefined,
            cancelled,
          );
        readOnlyReason = result.reason;
      } catch (error) {
        report(error);
        return false;
      }
    }
    // Unmappable rendered text remains a quote, never a whole-file edit grant.
    if (!(await removeAttached()) || cancelled()) return false;
    setBusy(true);
    try {
      requireOpen();
      await browserCommand('reference-preview-quote', {
        title: object.title,
        text: quote.text,
        readOnlyReason,
      });
      if (readOnlyReason) setNotice(uiText(readOnlyReason));
      if (cancelled()) {
        await bridge.clearContext();
        return false;
      }
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      setBusy(false);
    }
  }
  useVoiceSelection({
    workspaceId: workspace?.id,
    previewId: previewObject?.id || full || undefined,
    selected,
    ranges,
    revision: (id) => wsRef.current?.objects.find((o) => o.id === id)?.revision,
    prepare: async (target, cancelled) => {
      if (!binding || !hostReady || connection !== 'ready' || switching.current || busy)
        throw Error(uiText('桌面尚未就绪，请稍后重新选择'));
      if (target.ids.length > 10) throw Error(uiText('一次最多询问 10 份材料，请缩小选区。'));
      if (fileDirty || imageDirty) throw Error(uiText('请先保存当前编辑，再选择内容'));
      if (target.quote && target.quote.text.length > 24000)
        throw Error(uiText('选中文字过长，请缩小到 24000 字符以内再提问。'));
      await flush();
      requireOpen();
      if (cancelled()) return [];
      const objects = wsRef.current!.objects.filter((o) => target.ids.includes(o.id));
      if (objects.length !== target.ids.length) throw Error(uiText('引用材料已失效，请重新选择'));
      let selectedRanges = Object.fromEntries(
        Object.entries(target.ranges || {}).filter(([id]) => target.ids.includes(id)),
      );
      if (target.quote) {
        const object = objects[0],
          quote = target.quote;
        if (object.revision !== quote.revision) throw Error(uiText('文件已变化，请重新选择文字。'));
        const result =
          object.kind === 'file'
            ? await action('native_workbench', {
                operation: 'reference_quote',
                objectId: object.id,
                expectedRevision: quote.revision,
                quote: {
                  text: quote.text,
                  ...(quote.start === undefined ? {} : { start: quote.start }),
                  ...(quote.spans ? { spans: quote.spans } : {}),
                },
              })
            : null;
        if (cancelled()) return [];
        if (result?.range) selectedRanges = { [object.id]: result.range };
        else
          return [
            {
              type: 'text',
              text:
                uiText('来自《{0}》的选中文本：', { '0': object.title }) +
                '\n\n' +
                quote.text +
                '\n\n选区只读：' +
                (result?.reason || '此处无法定位原文范围') +
                '。不能扩大到整个文件或另建文件代替局部修改。',
              _meta: { 'ai-desktop/quote': { title: object.title, text: quote.text } },
            },
          ];
      }
      const prepared = await bridge.call('desktop_prepare_context', {
        ...scoped(),
        requestId: uid(),
        objectIds: target.ids,
        purpose: 'reference',
        ranges: selectedRanges,
        expectedRevisions: Object.fromEntries(objects.map((o) => [o.id, o.revision])),
      });
      // Do not attach through the regular composer: it clears canvas selection
      // and opens the file chat. Voice owns this snapshot and its lifecycle.
      return prepared.content;
    },
  });
  useFileAiTarget({
    selected: () => selected,
    attachMany: (ids, cancelled) => attachMaterials(undefined, ids, {}, undefined, cancelled),
    available:
      !!binding &&
      hostReady &&
      connection === 'ready' &&
      !busy &&
      !regions.busy &&
      !deletion.busy &&
      !duplication.busy &&
      !arrangementBusy &&
      !switching.current &&
      !armedTool &&
      !armedCreation,
    attachWidget: async (widget, cancelled) => {
      const current = wsRef.current;
      if (!current || cancelled()) return false;
      const context = await browserCommand<any>('light-apps', {
        workspaceId: current.id,
        operation: 'widget_context',
        payload: { instanceId: widget.instanceId, id: widget.id },
      });
      if (cancelled() || wsRef.current?.id !== current.id) return false;
      if (!(await removeAttached()) || cancelled()) return false;
      const text = JSON.stringify(context, null, 2);
      await browserCommand('reference-preview-quote', {
        title: context.widget.name,
        sourceKind: 'widget',
        text: text.length > 23000 ? text.slice(0, 23000) + '\n[共享状态过长，后文已截断]' : text,
      });
      if (cancelled()) {
        await bridge.clearContext();
        return false;
      }
      return true;
    },
    workspaceId: workspace?.id,
    find: (id) =>
      wsRef.current?.objects.find((object) => object.id === id) ??
      (() => {
        const group = wsRef.current?.groups.items.find((group) => group.id === id && group.bounds);
        return group ? { title: uiText('区域 · {0}', { '0': group.name }) } : undefined;
      })(),
    attach: async (id, cancelled, quote) => {
      const current = wsRef.current,
        group = current?.groups.items.find((group) => group.id === id && group.bounds);
      if (group && current) {
        const regions = new Set([id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const child of current.groups.items)
            if (child.parentId && regions.has(child.parentId) && !regions.has(child.id)) {
              regions.add(child.id);
              changed = true;
            }
        }
        const members = new Set(
          current.groups.items
            .filter((item) => regions.has(item.id))
            .flatMap(regionMemberIds),
        );
        const ids = current.objects
          .filter((object) => members.has(object.id) && !object.archived)
          .map((object) => object.id);
        if (!ids.length) {
          setNotice(uiText('此区域暂无可引用材料，请先放入文件或文字。'));
          return false;
        }
        return attachMaterials(undefined, ids, {}, undefined, cancelled);
      }
      return quote !== undefined
        ? attachPreviewQuote(id, quote, cancelled)
        : attachMaterials(undefined, [id], {}, undefined, cancelled);
    },
    notice: setNotice,
  });
  const toolPreviewRef = useRef<HTMLDivElement>(null);
  const toolPosition = useRef<{ x: number; y: number } | null>(null);
  function moveToolPreview(clientX: number, clientY: number) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (bounds && toolPreviewRef.current) {
      const x = Math.max(0, Math.min(clientX - bounds.left, Math.max(0, bounds.width - 400))),
        y = Math.max(0, Math.min(clientY - bounds.top, Math.max(0, bounds.height - 180)));
      toolPosition.current = { x: bounds.left + x, y: bounds.top + y };
      toolPreviewRef.current.style.transform = `translate3d(${x}px,${y}px,0)`;
    }
  }
  useEffect(() => {
    if (!armedTool && !armedCreation) return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (bounds) moveToolPreview(bounds.left + Math.max(380, bounds.width * 0.5), bounds.top + 120);
  }, [armedTool, armedCreation]);
  useEffect(() => {
    if (!workspace || !workflowLibrary) setArmedTool(null);
  }, [workspace?.id, workflowLibrary]);
  useEffect(() => {
    if (!armedTool && !armedCreation) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setArmedTool(null);
      setArmedCreation(null);
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [armedTool, armedCreation]);
  useEffect(() => {
    const reset = () => setToolDragOver(false);
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
      window.removeEventListener('blur', reset);
    };
  }, []);
  const toolPlacement = useDesktopToolPlacement({
    workspaceId: workspace?.id,
    action,
    updated: reload,
    busy: setBusy,
    blocked: () =>
      busy ||
      switching.current ||
      connection !== 'ready' ||
      !!pendingSwitch ||
      deletion.busy ||
      arrangementBusy,
    placed: (id) => {
      setCanvasTool('select');
      selectObjects([id]);
      setNotice(
        uiText('工具已放到桌面，可直接填写输入和参数。拖动标题可移动，高级设置编辑原流程。'),
      );
    },
  });
  async function placeDesktopTool(source: DesktopToolSource, point?: { x: number; y: number }) {
    if (busy || switching.current || connection !== 'ready' || !workspace) return;
    if (toolPlacement.pending) {
      setWorkflowLibrary(true);
      setNotice(uiText('请先继续上次添加，收回原工具。'));
      return;
    }
    try {
      if (source.kind === 'flow' && !point) {
        setCanvasTool('select');
        setWorkflowLibrary(false);
        locateObjects([source.id]);
        return;
      }
      const rectangle = canvasRef.current?.getBoundingClientRect(),
        occupied = workflowLibrary ? 370 : 0;
      const position = flow.screenToFlowPosition(
        point ?? {
          x:
            (rectangle?.left ?? 0) +
            occupied +
            Math.max(30, ((rectangle?.width ?? 1000) - occupied - 400) / 2),
          y: (rectangle?.top ?? 0) + 110,
        },
      );
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
        throw Error(uiText('暂时无法确定桌面位置，请重新拖入。'));
      setCanvasTool('select');
      if (source.kind === 'flow') {
        const object = wsRef.current?.objects.find(
          (item) => item.id === source.id && !item.archived && isWorkflowObject(item),
        );
        if (!object) throw Error(uiText('原工具已不存在或已移入回收站。'));
        await persistView([{ objectId: object.id, bounds: { ...object.bounds, ...position } }]);
        selectObjects([object.id]);
        setNotice(uiText('已移动原工具，文件和参数保持在同一对象。'));
      } else await toolPlacement.place(source, { ...position, width: 400, height: 420 });
    } catch (problem) {
      report(problem);
    }
  }
  function chooseDesktopTool(source: DesktopToolSource, label: string) {
    if (source.kind === 'flow') {
      void placeDesktopTool(source);
      return;
    }
    if (busy || toolPlacement.pending || connection !== 'ready') return;
    setCanvasTool('select');
    setArmedCreation(null);
    setArmedTool({ source, label });
    setNotice(uiText('移动组件到桌面合适的位置，单击放下；按 Esc 取消。'));
  }
  async function chooseCreation(kind: CreationKind) {
    if (!workspace || busy || connection !== 'ready') return;
    if (!(await navigateDesktop('canvas'))) return;
    const labels: Record<CreationKind, string> = {
      text: uiText('文字笔记'),
      document: uiText('Word 文档'),
      table: uiText('Excel 表格'),
      code: uiText('代码文件'),
      diagram: uiText('矢量图形'),
      deck: uiText('演示文稿'),
      workbook: uiText('Excel 表格'),
      html: uiText('网页文件'),
      workflow: uiText('流程组件'),
    };
    setCanvasTool('select');
    setNewMenu(false);
    setWorkflowLibrary(false);
    setArmedTool(null);
    setArmedCreation({ kind, label: labels[kind] });
  }
  return (
    <WorkflowWidgetContext.Provider value={widgetContext}>
      <CanvasPreviewProvider key={binding?.panelInstanceId ?? 'unbound'}>
        <CanvasDetailContext.Provider
          value={
            canvasViewport.zoom < 0.36
              ? 'overview'
              : canvasViewport.zoom < 0.8
                ? 'preview'
                : 'detail'
          }
        >
          <main
            className={`desktop-shell apple-workbench ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${canvasVisible ? '' : 'has-workspace-page'} ${expanded ? 'has-active-editor' : ''}`}
            onKeyDown={canvasShortcut}
            onInputCapture={() => {
              lastInputAt.current = Date.now();
            }}
            onCompositionStartCapture={() => {
              composing.current = true;
            }}
            onCompositionEndCapture={() => {
              composing.current = false;
              lastInputAt.current = Date.now();
              for (const id of Object.keys(draftRef.current))
                if (wsRef.current?.objects.find((object) => object.id === id)?.kind !== 'text')
                  saveSoon(id);
            }}
          >
            {fileDrop && (
              <div
                className={`file-drop-overlay${fileDrop.blocked ? ' is-blocked' : ''}`}
                role="status"
                aria-live="polite"
              >
                <div>
                  <span aria-hidden="true">{fileDrop.blocked ? '…' : '＋'}</span>
                  <strong>
                    {fileDrop.blocked ? uiText('暂时无法放入') : uiText('松开，把文件放到桌面')}
                  </strong>
                  <p>
                    {fileDrop.blocked ?? uiText('支持多个文件和文件夹，保留原生文件与目录结构。')}
                  </p>
                </div>
              </div>
            )}
            <WorkbenchChrome
              activeApp={appPages.active}
              applications={() => void navigateDesktop('canvas', 'dashboard')}
              desktopActions={canvasVisible && activeDestination === 'canvas' && !expanded}
              createRegion={() => {
                setNewMenu(false);
                regions.create();
              }}
              workspaceId={workspace?.id}
              workspaceName={workspace?.name}
              pageTitle={
                expanded?.title ??
                (appPages.active
                  ? appPages.active === 'dashboard'
                    ? '应用与组件'
                    : appPages.active === 'manage'
                      ? '应用管理'
                      : (appPages.items.find((app) => app.id === appPages.active)?.name ?? '轻应用')
                  : undefined) ??
                (workspacesOpen
                  ? uiText('工作区')
                  : backupsOpen
                    ? uiText('备份与恢复')
                    : layoutsOpen
                      ? uiText('布局与视图')
                      : annotationRecovery
                        ? uiText('批注草稿')
                        : revisionObject
                          ? uiText('修改与来源')
                          : contextPreview
                            ? uiText('引用预览')
                            : undefined)
              }
              itemCount={workspace?.objects.length ?? 0}
              collapsed={sidebarCollapsed}
              toggleSidebar={toggleSidebar}
              zoom={zoom}
              changeZoom={(direction) =>
                void (direction > 0
                  ? flow.zoomIn({ duration: 180 })
                  : flow.zoomOut({ duration: 180 }))
              }
              fit={() => fitObjects()}
              disabled={!workspace || busy || deletion.busy || duplication.busy || arrangementBusy}
              ready={connection === 'ready'}
              commands={openCommands}
              shortcuts={() => setShortcutsOpen(true)}
              directoryOpen={directoryOpen && canvasVisible}
              directory={() => {
                if (directoryOpen && canvasVisible) setDirectoryOpen(false);
                else void showFileDirectory();
              }}
              saving={
                fileDirty ||
                imageDirty ||
                webDirty ||
                Object.keys(drafts).length > 0 ||
                layoutStatus !== 'saved' ||
                drawing.status !== 'saved' ||
                workflowDirty ||
                widgetDraftCount > 0
              }
              active={activeDestination}
              navigate={navigateDesktop}
              search={() => void openSearch()}
              workspaces={() => setWorkspacesOpen(true)}
              save={() => void saveDesktop().catch(report)}
              importFiles={() => {
                setNewMenu(false);
                setArmedCreation(null);
                setImportOpen(true);
              }}
              layouts={() => setLayoutsOpen(true)}
              annotations={() => setAnnotationRecovery(true)}
              newMenu={newMenu}
              setNewMenu={setNewMenu}
              create={chooseCreation}
            />
            {workspace && (canvasVisible || !!appPages.active) && (
              <DesktopTabs
                appActive={!!appPages.active}
                showDesktop={() => void navigateDesktop('canvas')}
                workspace={workspace}
                disabled={
                  busy ||
                  !!pendingSwitch ||
                  regions.busy ||
                  fileDirty ||
                  imageDirty ||
                  workflowDirty ||
                  webDirty ||
                  widgetDraftCount > 0
                }
                busyChanged={setBusy}
                action={action}
                change={changeWorkspace}
                manage={() => setWorkspacesOpen(true)}
                prepare={async () => {
                  await drawing.flush();
                  await prepareBackup();
                }}
                updated={reload}
              >
                <button
                  aria-current={appPages.active === 'dashboard' ? 'page' : undefined}
                  onClick={() => void navigateDesktop('canvas', 'dashboard')}
                >
                  应用与组件
                </button>
                {appPages.items.map((app) => (
                  <button
                    key={app.id}
                    draggable={app.workspaceId === workspace.id}
                    title={`${app.workspaceName} · 单击打开应用`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData(
                        'application/x-yirang-app-widget',
                        JSON.stringify({ workspaceId: workspace.id, instanceId: app.id }),
                      );
                      window.dispatchEvent(new Event('yirang:widget-drag-start'));
                      setTimeout(() => void navigateDesktop('canvas'), 0);
                    }}
                    onDragEnd={() => window.dispatchEvent(new Event('yirang:widget-drag-end'))}
                    aria-current={appPages.active === app.id ? 'page' : undefined}
                    onClick={() => void openCatalogApp(app).catch((e) => setError(String(e)))}
                  >
                    {app.name}
                    {app.unread ? ` · ${app.unread}` : ''}
                  </button>
                ))}
                <div className="desktop-notification-actions">
                <AppNotificationBar
                  clear={appPages.clearNotifications}
                  items={appPages.notifications}
                  error={appPages.catalogError}
                  open={(item) =>
                    void (async () => {
                      await browserCommand('light-apps', {
                        workspaceId: workspace.id,
                        operation: 'desktop_notification_read',
                        payload: {
                          ownerWorkspaceId: item.workspaceId,
                          instanceId: item.instanceId,
                          id: item.id,
                        },
                      });
                      window.dispatchEvent(new Event('yirang:apps-changed'));
                      await openCatalogApp(item);
                    })().catch((e) => setError(String(e)))
                  }
                />
                </div>
              </DesktopTabs>
            )}
            <WorkbenchFeedback>
              {error && (
                <div className="banner error" role="alert">
                  <span>{error}</span>
                  <button onClick={() => setError('')} aria-label={uiText('关闭错误')}>
                    ×
                  </button>
                </div>
              )}
              {initial?.serverVersion && initial.serverVersion !== DESKTOP_VERSION && (
                <div className="banner version-notice" role="status">
                  {uiText('界面 v')}
                  {DESKTOP_VERSION} {uiText('· 服务 v')}
                  {initial.serverVersion}
                  {uiText('。请重新加载插件或重启 Codex，以使用同一版本。')}
                </div>
              )}
              {hostError && (
                <div className="banner error" role="alert">
                  {hostError}
                </div>
              )}
              {notice && <TransientNotice message={notice} dismiss={() => setNotice('')} />}
              {workspace && (connection === 'unavailable' || connection === 'reopen') && (
                <div className="connection-recovery" role="status">
                  <div>
                    <strong>
                      {connection === 'reopen'
                        ? uiText('需要重新连接当前工作区')
                        : uiText('暂时无法连接本地服务')}
                    </strong>
                    <span>
                      {connection === 'reopen'
                        ? uiText('工作区关联或凭据已变化，请重新连接以读取材料。')
                        : uiText('文字编辑仍保留在面板草稿中；连接恢复后可点击保存。')}
                    </span>
                  </div>
                  <button disabled={busy || !!pendingSwitch} onClick={() => void reconnect()}>
                    {uiText('重新连接')}
                  </button>
                </div>
              )}
              {!full &&
                workspace?.objects
                  .filter((o) => drafts[o.id]?.error)
                  .map((o) => <React.Fragment key={o.id}>{conflictControls(o)}</React.Fragment>)}
              {recoverable.length > 0 && (
                <div className="banner">
                  {uiText('有')}
                  {recoverable.length} {uiText('份未完成草稿。')}
                  <button
                    onClick={() => {
                      const recovered: Record<string, Draft> = {};
                      for (const r of recoverable)
                        recovered[r.objectId] = { base: r.base, content: r.content };
                      remember({ ...recovered, ...draftRef.current });
                      setRecoverable([]);
                      setNotice(uiText('草稿已恢复，请比较并点击保存。'));
                    }}
                  >
                    {uiText('恢复草稿')}
                  </button>
                  <button onClick={() => setRecoverable([])}>{uiText('稍后处理')}</button>
                </div>
              )}
            </WorkbenchFeedback>
            {!workspace ? (
              <section className="welcome">
                <div className="welcome-symbol">
                  <DesktopMark />
                </div>
                <p className="eyebrow">{uiText('你的材料，共同的工作空间')}</p>
                <h1>{uiText('把想法放到桌面上')}</h1>
                <p>
                  {uiText('保存文字、图片、表格与代码。')}
                  <br />
                  {uiText('在同一份内容上继续编辑。')}
                </p>
                {initial?.needsWorkspaceChoice ? (
                  <>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void choose('create')}
                    >
                      {uiText('创建本地工作区')}
                    </button>
                    {initial.workspaces?.length > 0 && (
                      <div className="workspace-list">
                        <span>{uiText('恢复已有工作区')}</span>
                        {initial.workspaces.map((w: any) => (
                          <button key={w.id} onClick={() => void choose('resume', w.id)}>
                            {w.name}
                            <small>{w.id.slice(-8)}</small>
                          </button>
                        ))}
                      </div>
                    )}
                    <small>{uiText('选择一个本地工作区，继续整理材料。')}</small>
                  </>
                ) : (
                  <span className="loading">{uiText('正在连接本地插件…')}</span>
                )}
              </section>
            ) : (
              <>
                <div
                  id="desktop-widget-dock"
                  className="desktop-widget-dock"
                  hidden={!canvasVisible}
                  aria-label="顶部固定小组件"
                />
                <div className={`canvas-workspace ${appPages.active ? 'showing-light-app' : ''}`}>
                  {workspace && (
                    <LightAppPageDeck
                      key={workspace.id}
                      workspaceId={workspace.id}
                      active={appPages.active}
                      items={appPages.items.filter((app) => app.workspaceId === workspace.id)}
                      setActive={(id) => void navigateDesktop('canvas', id)}
                    />
                  )}
                  {directoryOpen && canvasVisible && (
                    <FileDirectory
                      rename={(id) => beginRename([id])}
                      action={action}
                      updated={reload}
                      key={'FileDirectory:' + workspace.id}
                      browserTabs={canvasBrowser.state.tabs.filter(
                        (tab) => tab.canvas?.workspaceId === workspace.id,
                      )}
                      locateBrowser={(id) => {
                        const bounds = canvasBrowser.state.tabs.find(
                          (tab) => tab.id === id,
                        )?.canvas;
                        if (bounds) void flow.fitBounds(bounds, { padding: 0.15, duration: 220 });
                      }}
                      workspace={workspace}
                      selected={selected}
                      locate={(ids) => locateObjects(ids, false)}
                      preview={(id) => openPreview([id])}
                      activate={(id) => void activateCard(id)}
                      close={() => setDirectoryOpen(false)}
                      manage={() => void navigateDesktop('files')}
                      disabled={
                        canvasHistory.busy ||
                        busy ||
                        regions.busy ||
                        deletion.busy ||
                        duplication.busy ||
                        arrangementBusy
                      }
                    />
                  )}
                  <section
                    ref={canvasRef}
                    style={
                      {
                        '--card-edge-size': `${18 / canvasViewport.zoom}px`,
                        '--card-edge-gap': `${5 / canvasViewport.zoom}px`,
                      } as React.CSSProperties
                    }
                    className={`canvas ${gridEnabled ? 'has-grid' : ''} ${toolDragOver ? 'tool-drop-active' : ''} ${armedTool || armedCreation ? 'tool-placement-active' : ''}`}
                    aria-label={uiText('无限工作空间')}
                    tabIndex={0}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(DESKTOP_TOOL_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect =
                        busy || toolPlacement.pending ? 'none' : 'copy';
                      setToolDragOver(!busy && !toolPlacement.pending);
                    }}
                    onDragLeave={(event) => {
                      if (
                        !event.relatedTarget ||
                        !event.currentTarget.contains(event.relatedTarget as globalThis.Node)
                      )
                        setToolDragOver(false);
                    }}
                    onDrop={(event) => {
                      const raw = event.dataTransfer.getData(DESKTOP_TOOL_MIME);
                      if (!raw) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setToolDragOver(false);
                      setArmedTool(null);
                      setArmedCreation(null);
                      try {
                        const drop = DesktopToolDrag.parse(JSON.parse(raw));
                        if (drop.workspaceId !== workspace.id)
                          throw Error(uiText('工作区已变化，请从当前组件库重新拖入。'));
                        void placeDesktopTool(drop.source, { x: event.clientX, y: event.clientY });
                      } catch (problem) {
                        report(problem);
                      }
                    }}
                    onPointerDownCapture={(event) => {
                      // Editors stop key propagation. Read modifiers from the pointer itself
                      // so Shift/Ctrl selection still works after editing a text card.
                      if (
                        event.button === 0 &&
                        (event.target as HTMLElement).closest('.react-flow')
                      )
                        flowStore.setState({
                          multiSelectionActive: event.shiftKey || event.ctrlKey || event.metaKey,
                        });
                    }}
                    onPointerDown={(e) => {
                      if (
                        !(e.target as HTMLElement).closest(
                          'input,textarea,select,button,a,[contenteditable="true"],[role="dialog"]',
                        )
                      )
                        canvasRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    {regions.layer}
                    {isIntegratedDesktop && (
                      <AppWidgets
                        key={workspace.id}
                        workspaceId={workspace.id}
                        viewport={canvasViewport}
                        visible={canvasVisible}
                        canvas={canvasRef}
                        notice={setNotice}
                        locate={(bounds) =>
                          void flow.fitBounds(bounds, { padding: 0.15, duration: 220 })
                        }
                      />
                    )}
                    <ReactFlow
                      nodes={visibleNodes}
                      nodeTypes={nodeTypes}
                      onNodesChange={(changes) => setNodes((ns) => applyNodeChanges(changes, ns))}
                      onPaneClick={() => {
                        if (isIntegratedDesktop)
                          window.parent.postMessage({ type: 'ai-desktop:file-ai-close' }, '*');
                      }}
                      onSelectionChange={selectionChanged}
                      onSelectionContextMenu={(event, nodes) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (busy || deletion.busy || duplication.busy || arrangementBusy) return;
                        const ids = nodes
                          .map((node) => node.id)
                          .filter((id) =>
                            workspace.objects.some((o) => o.id === id && !o.archived),
                          );
                        if (!ids.length) return;
                        setSelectionTools(false);
                        setSelectionList(false);
                        setContextMenu({ x: event.clientX, y: event.clientY, ids });
                      }}
                      onNodeContextMenu={(event, node) => {
                        if (
                          (event.target as HTMLElement).closest(
                            'input,textarea,select,[contenteditable="true"]',
                          ) ||
                          busy ||
                          deletion.busy ||
                          duplication.busy ||
                          arrangementBusy
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        const ids = selected.includes(node.id) ? selected : [node.id];
                        if (!selected.includes(node.id)) selectObjects(ids);
                        setSelectionTools(false);
                        setSelectionList(false);
                        setContextMenu({ x: event.clientX, y: event.clientY, ids });
                      }}
                      onPaneContextMenu={(event) => {
                        if (busy || deletion.busy || duplication.busy || arrangementBusy) return;
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectionTools(false);
                        setSelectionList(false);
                        setContextMenu({ x: event.clientX, y: event.clientY, ids: [] });
                      }}
                      onNodeDragStart={(event, node, dragged) =>
                        dragCard(event, node, dragged, 'start')
                      }
                      onNodeDrag={(event, node, dragged) => dragCard(event, node, dragged, 'move')}
                      onNodeDragStop={(event, node, dragged) =>
                        dragCard(event, node, dragged, 'end')
                      }
                      onMoveEnd={(_, v) => {
                        setZoom(Math.round(v.zoom * 100));
                        if (!minimapPanning.current && !regions.busy) void persistView();
                      }}
                      minZoom={0.1}
                      maxZoom={4}
                      selectionOnDrag={
                        canvasTool === 'select' &&
                        !canvasHistory.busy &&
                        !arrangementBusy &&
                        !regions.busy
                      }
                      nodesDraggable={
                        canvasTool === 'select' &&
                        !canvasHistory.busy &&
                        !arrangementBusy &&
                        !regions.busy
                      }
                      panOnDrag={regions.busy ? false : canvasTool === 'hand' ? true : [1, 2]}
                      selectionKeyCode={null}
                      deleteKeyCode={null}
                      multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
                      defaultViewport={workspace.viewport}
                      zoomOnDoubleClick={false}
                      proOptions={{ hideAttribution: true }}
                    >
                      <Background color="var(--canvas-dot)" gap={24} size={0.7} />
                    </ReactFlow>
                    {toolDragOver && (
                      <div className="canvas-tool-drop-hint">
                        {uiText('松开放到这里 · 直接使用桌面工具')}
                      </div>
                    )}
                    {(armedTool || armedCreation) && (
                      <div
                        className="canvas-tool-placement"
                        role="button"
                        tabIndex={0}
                        aria-label={uiText('摆放 {0}', {
                          '0': armedTool?.label ?? armedCreation?.label,
                        })}
                        onPointerMove={(event) => moveToolPreview(event.clientX, event.clientY)}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.preventDefault();
                          event.stopPropagation();
                          const source = armedTool?.source,
                            kind = armedCreation?.kind,
                            point = toolPosition.current ?? { x: event.clientX, y: event.clientY };
                          setArmedTool(null);
                          setArmedCreation(null);
                          if (source) void placeDesktopTool(source, point);
                          else if (kind) void createEditable(kind, point);
                        }}
                      >
                        <div ref={toolPreviewRef} className="canvas-tool-placement-preview">
                          <div>
                            <Icon name={armedCreation ? 'document' : 'workflow'} size={17} />
                            <strong>{armedTool?.label ?? armedCreation?.label}</strong>
                          </div>
                          <p>
                            {armedCreation
                              ? uiText('新文件 · 放下后留在桌面，点击卡片再编辑')
                              : uiText('桌面组件 · 放下后可填写参数')}
                          </p>
                          <span>{uiText('单击放置')}</span>
                        </div>
                        <div className="canvas-tool-placement-help" role="status">
                          {uiText('移动鼠标摆放')}
                          {armedCreation ? uiText('新文件') : uiText('组件')}{' '}
                          {uiText('· 单击确认 · Esc 取消')}
                        </div>
                      </div>
                    )}
                    <CanvasBoardLayer
                      ref={canvasBoardRef}
                      key={'CanvasBoardLayer:' + workspace.id}
                      board={drawing.board}
                      viewport={canvasViewport}
                      cards={canvasCards}
                      outputLinks={outputLinks}
                      tool={canvasTool}
                      setTool={chooseCanvasTool}
                      stroke={canvasStroke}
                      fill={canvasFill}
                      strokeWidth={canvasStrokeWidth}
                      disabled={
                        canvasHistory.busy ||
                        busy ||
                        regions.busy ||
                        deletion.busy ||
                        duplication.busy ||
                        arrangementBusy ||
                        !!pendingSwitch ||
                        !canvasVisible
                      }
                      onChange={drawing.change}
                      onNotice={setNotice}
                      selectedCardIds={selected}
                      onSelectCards={selectObjects}
                      onMoveCards={moveCanvasCards}
                      onDeleteMixed={deleteMaterials}
                      hiddenMarks={regions.collapsed.marks}
                      presentationMarks={regions.presentationMarks}
                      visibleRect={visibleRect}
                      snap={snapCanvas}
                      clearGuides={() => setGuides((previous) => (previous.length ? [] : previous))}
                    />
                    <CanvasGuides guides={guides} viewport={canvasViewport} />
                    {isIntegratedDesktop && (
                      <BrowserCanvas
                        key={'BrowserCanvas:' + workspace.id}
                        state={canvasBrowser.state}
                        workspaceId={workspace.id}
                        viewport={canvasViewport}
                        canvas={canvasRef}
                        visible={canvasVisible && !browserOpen}
                        interactive={
                          canvasTool === 'select' &&
                          !busy &&
                          !regions.busy &&
                          !deletion.busy &&
                          !duplication.busy &&
                          !arrangementBusy
                        }
                        notice={setNotice}
                        locate={(bounds) =>
                          void flow.fitBounds(bounds, { padding: 0.15, duration: 220 })
                        }
                        open={(id) => {
                          void navigateDesktop('browser').then((opened) => {
                            if (opened) void browserCommand('switch', { id }).catch(report);
                          });
                        }}
                      />
                    )}
                    <CanvasNavigation
                      cards={canvasCards}
                      marks={navigationMarks}
                      regions={regions.regions}
                      view={visibleRect}
                      selected={selected}
                      pan={(point) =>
                        void flow.setCenter(point.x, point.y, { zoom: canvasViewport.zoom })
                      }
                      panState={(active) => {
                        minimapPanning.current = active;
                        if (!active) void persistView();
                      }}
                      fit={() => fitObjects([])}
                      fitSelection={() => fitObjects()}
                      createRegion={regions.create}
                      grid={gridEnabled}
                      setGrid={setGridEnabled}
                      snap={snapEnabled}
                      setSnap={setSnapEnabled}
                      disabled={!canArrange() || drawing.status !== 'saved'}
                      zoomControls={
                        <div className="canvas-view-controls">
                          <button
                            aria-label={uiText('缩小画布')}
                            onClick={() => void flow.zoomOut({ duration: 180 })}
                          >
                            <Icon name="minus" size={14} />
                          </button>
                          <button title={uiText('适合画布 · F')} onClick={() => fitObjects()}>
                            {zoom}%
                          </button>
                          <button
                            aria-label={uiText('放大画布')}
                            onClick={() => void flow.zoomIn({ duration: 180 })}
                          >
                            <Icon name="plus" size={14} />
                          </button>
                        </div>
                      }
                    />
                    <CanvasToolbar
                      screenshotLabel={screenshotAi.shortcutLabel}
                      screenshot={isIntegratedDesktop ? screenshotAi.begin : undefined}
                      tool={canvasTool}
                      setTool={chooseCanvasTool}
                      disabled={
                        canvasHistory.busy ||
                        busy ||
                        regions.busy ||
                        deletion.busy ||
                        !!pendingSwitch
                      }
                      stroke={canvasStroke}
                      setStroke={setCanvasStroke}
                      fill={canvasFill}
                      setFill={setCanvasFill}
                      strokeWidth={canvasStrokeWidth}
                      setStrokeWidth={setCanvasStrokeWidth}
                      undo={canvasHistory.undo}
                      redo={canvasHistory.redo}
                      canUndo={canvasHistory.canUndo}
                      canRedo={canvasHistory.canRedo}
                      analyze={
                        isIntegratedDesktop ? () => void canvasAnalysis.analyze() : undefined
                      }
                      analyzing={canvasAnalysis.busy}
                    />
                    {drawing.status === 'error' && (
                      <div className="canvas-save-error" role="alert">
                        <span>
                          {uiText('绘图未保存：')}
                          {drawing.error} {uiText('· 草稿已保留')}
                        </span>
                        <button onClick={() => void drawing.flush().catch(report)}>
                          {uiText('重试保存')}
                        </button>
                      </div>
                    )}
                    {filesOpen && (
                      <FileBrowser
                        workspace={workspace}
                        selected={selected}
                        action={action}
                        updated={reload}
                        select={selectObjects}
                        locate={locateObjects}
                        open={(id) => setFull(id)}
                        close={() => setFilesOpen(false)}
                      />
                    )}
                    {libraryView && (
                      <DesktopLibraryView
                        mode={libraryView}
                        objects={workspace.objects}
                        library={library}
                        open={(id) => setFull(id)}
                        locate={(ids) => {
                          setLibraryView(null);
                          locateObjects(ids);
                        }}
                        favorite={setFavorite}
                        close={() => setLibraryView(null)}
                      />
                    )}
                    {workspace.objects.length === 0 &&
                      !workspace.groups.items.some((group) => group.bounds) &&
                      !canvasBrowser.state.tabs.some(
                        (tab) => tab.canvas?.workspaceId === workspace.id,
                      ) &&
                      drawing.board.items.length === 0 &&
                      canvasTool === 'select' && (
                        <EmptyDesktop
                          create={chooseCreation}
                          importFiles={() => {
                            setNewMenu(false);
                            setImportOpen(true);
                          }}
                          disabled={busy}
                        />
                      )}
                    <div className="canvas-meta">
                      <span
                        className={`layout-status ${layoutStatus === 'error' ? 'error-text' : ''}${connection === 'ready' && layoutStatus === 'saved' ? ' is-idle' : ''}`}
                        title={lastSync ? uiText('上次本地同步 {0}', { '0': lastSync }) : undefined}
                      >
                        <Icon name="drive" size={13} />
                        {connection !== 'ready'
                          ? uiText('等待本地连接')
                          : layoutStatus === 'saved'
                            ? uiText('本地保存')
                            : layoutStatus === 'saving'
                              ? uiText('保存布局…')
                              : uiText('布局待重试')}
                      </span>
                    </div>
                    {workspace.groups.items.length > 0 && (
                      <div className="canvas-group-strip" data-canvas-toolbar>
                        <ActionPopover
                          label="定位区域"
                          className="region-navigator"
                          open={regionMenu}
                          setOpen={setRegionMenu}
                          closeOnAction
                          trigger={
                            <>
                              <Icon name="folder" size={14} />
                              <span>{uiText('区域')}</span>
                              <small>{workspace.groups.items.length}</small>
                              <Icon name="chevron" size={12} />
                            </>
                          }
                        >
                          {workspace.groups.items.map((group) => (
                            <button
                              className={`color-${group.color}`}
                              key={group.id}
                              onClick={() => {
                                selectObjects(regionMemberIds(group));
                                regions.locate(group);
                              }}
                            >
                              <i />
                              <span>{group.name}</span>
                              <small>{regionMemberIds(group).length}</small>
                            </button>
                          ))}
                        </ActionPopover>
                      </div>
                    )}
                    {navigator && (
                      <DeskNavigator
                        key={navigator}
                        workspace={workspace}
                        action={action}
                        updated={reload}
                        close={() => {
                          setNavigator(null);
                          canvasRef.current?.focus({ preventScroll: true });
                        }}
                        locate={locateObjects}
                        openObject={(id) => {
                          setNavigator(null);
                          setFull(id);
                        }}
                      />
                    )}
                  </section>
                </div>
                {canvasVisible && (selected.length > 0 || (!isIntegratedDesktop && attached)) && (
                  <IntentSelection integrated={isIntegratedDesktop}>
                    <section className="material-dock" aria-label={uiText('材料操作')}>
                      <ActionPopover
                        label={uiText('查看所选材料')}
                        className="selection-list-popover"
                        open={selectionList}
                        setOpen={setSelectionList}
                        trigger={
                          <>
                            <Icon name="check" size={16} />
                            <strong
                              title={
                                selected.length === 1
                                  ? workspace.objects.find((o) => o.id === selected[0])?.title
                                  : undefined
                              }
                            >
                              {selected.length === 1
                                ? workspace.objects.find((o) => o.id === selected[0])?.title
                                : selected.length
                                  ? uiText('已选择 {0} 项', { '0': selected.length })
                                  : uiText('已引用材料')}
                            </strong>
                            <Icon name="chevron" size={12} />
                          </>
                        }
                      >
                        <div className="selection-details">
                          <div className="selection-details-heading">
                            <strong>{uiText('所选材料')}</strong>
                            {selected.length > 0 && (
                              <button
                                onClick={() => {
                                  selectObjects([]);
                                  setSelectionList(false);
                                }}
                              >
                                {uiText('取消选择')}
                              </button>
                            )}
                          </div>
                          <div className="selection-chips">
                            {workspace.objects
                              .filter((o) => selected.includes(o.id))
                              .map((o) => (
                                <button
                                  title={uiText('取消选择 {0}（不删除文件）', { '0': o.title })}
                                  key={o.id}
                                  className={
                                    ranges[o.id]?.baseRevision !== undefined &&
                                    ranges[o.id].baseRevision !== o.revision
                                      ? 'stale-range'
                                      : ''
                                  }
                                  onClick={() => {
                                    setSelected((s) => s.filter((x) => x !== o.id));
                                    setRanges((rs) => {
                                      const next = { ...rs };
                                      delete next[o.id];
                                      return next;
                                    });
                                    setNodes((ns) =>
                                      ns.map((n) =>
                                        n.id === o.id ? { ...n, selected: false } : n,
                                      ),
                                    );
                                  }}
                                >
                                  <FileBadge
                                    kind={o.kind}
                                    fileName={
                                      o.kind === 'file'
                                        ? (o.content as { fileName: string }).fileName
                                        : ''
                                    }
                                  />
                                  <span className="chip-title">
                                    {o.title}
                                    {ranges[o.id]
                                      ? ranges[o.id].baseRevision !== o.revision
                                        ? uiText(' · 选区已过期')
                                        : ranges[o.id].type === 'cells'
                                          ? uiText(' · 单元格范围')
                                          : uiText(' · 文字片段')
                                      : ''}
                                  </span>
                                  <Icon name="close" size={12} />
                                </button>
                              ))}
                          </div>
                          {!binding?.messageRouteAvailable && (
                            <p className="selection-hint">{bridge.connectionMessage(binding)}</p>
                          )}
                          {selected.length > 10 && (
                            <p className="selection-limit">
                              {uiText('可以将选区创建为区域。每次最多引用 10 份材料。')}
                            </p>
                          )}
                          {attached && (
                            <div className="attached-materials">
                              <span>{attached.objects.map((o) => o.title).join('、')}</span>
                              <button disabled={busy} onClick={() => void removeAttached()}>
                                {uiText('移除引用')}
                              </button>
                              {attached.runRecovery ? (
                                <small>{uiText('继续回收原运行的结果，不会重新执行代码。')}</small>
                              ) : (
                                attached.objects.some(
                                  (source) =>
                                    workspace.objects.find((o) => o.id === source.id)?.revision !==
                                    source.revision,
                                ) && <small>{uiText('桌面内容已有更新，可重新选中并引用。')}</small>
                              )}
                            </div>
                          )}
                        </div>
                      </ActionPopover>
                      {selected.length > 0 && (
                        <>
                          <button
                            title={
                              selected.length > 10
                                ? uiText('一次最多引用 10 份材料，请缩小选区')
                                : bridge.connectionMessage(binding)
                            }
                            className="primary reference-button"
                            onClick={() => {
                              if (isIntegratedDesktop)
                                window.parent.postMessage(
                                  { type: 'ai-desktop:file-ai-toggle' },
                                  '*',
                                );
                              else void attachMaterials();
                            }}
                            disabled={
                              busy ||
                              selected.length > 10 ||
                              connection !== 'ready' ||
                              !binding?.messageRouteAvailable ||
                              !hostReady ||
                              !bridge.supportsAttachments()
                            }
                          >
                            <Icon name="link" size={15} />
                            {uiText('问 AI')}
                          </button>
                          <button
                            className="selection-preview"
                            aria-label={uiText('预览')}
                            title={uiText('大预览 · 空格')}
                            onClick={() => openPreview(selected)}
                            disabled={busy}
                          >
                            <Icon name="eye" size={17} />
                            <span>{uiText('预览')}</span>
                          </button>
                          {selected.length === 1 ? (
                            <button
                              className="selection-rename"
                              aria-label={uiText('改名')}
                              disabled={
                                busy || deletion.busy || duplication.busy || selected.length > 200
                              }
                              title={uiText('重命名所选材料 · F2')}
                              onClick={() => beginRename(selected)}
                            >
                              <Icon name="text" size={16} />
                              <span>{uiText('改名')}</span>
                            </button>
                          ) : (
                            <button
                              className="selection-group"
                              aria-label={uiText('创建区域')}
                              disabled={busy || workspace.groups.items.length >= 40}
                              title={uiText('将选区创建为区域')}
                              onClick={() => regions.create()}
                            >
                              <Icon name="group" size={16} />
                              <span>{uiText('区域')}</span>
                            </button>
                          )}
                          {selected.length > 1 && (
                            <ActionPopover
                              label={uiText('排列')}
                              className="selection-popover selection-arrange"
                              open={selectionArrange}
                              setOpen={setSelectionArrange}
                              disabled={busy || arrangementBusy}
                              closeOnAction
                              trigger={
                                <>
                                  <Icon name="grid" size={16} />
                                  <span>{uiText('排列')}</span>
                                  <Icon name="chevron" size={12} />
                                </>
                              }
                            >
                              <DesktopArrangeMenu
                                count={selected.length}
                                disabled={!canArrange()}
                                arrange={(mode) => {
                                  setSelectionArrange(false);
                                  void arrangeSelection(mode);
                                }}
                                canUndo={canvasHistory.canUndo}
                                undo={() => {
                                  setSelectionArrange(false);
                                  void undoArrangement();
                                }}
                                canRedo={canvasHistory.canRedo}
                                redo={() => {
                                  setSelectionArrange(false);
                                  void undoArrangement(true);
                                }}
                              />
                            </ActionPopover>
                          )}
                          {workspace.objects.some(
                            (object) => selected.includes(object.id) && localCodeRuntime(object),
                          ) && (
                            <button
                              title={uiText('交给 Codex 原对话运行')}
                              disabled={busy || selected.length > 10}
                              onClick={() => void openLocalRuns()}
                            >
                              <Icon name="play" size={14} />
                              <span>{uiText('运行')}</span>
                            </button>
                          )}
                          <button
                            className="delete-materials"
                            aria-label={uiText('删除所选材料')}
                            title={uiText('删除所选材料到回收站 · Delete')}
                            onClick={() => void deleteMaterials(selected)}
                            disabled={busy || deletion.busy || !!deletion.pendingCount}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                          <ActionPopover
                            label={uiText('更多文件操作')}
                            className="selection-popover selection-more"
                            open={selectionTools}
                            setOpen={setSelectionTools}
                            disabled={busy || arrangementBusy}
                            closeOnAction
                            trigger={<Icon name="more" size={18} />}
                          >
                            {selected.length > 1 && (
                              <button
                                className="selection-rename"
                                aria-label={uiText('改名')}
                                disabled={
                                  busy || deletion.busy || duplication.busy || selected.length > 200
                                }
                                title={uiText('重命名所选材料 · F2')}
                                onClick={() => beginRename(selected)}
                              >
                                <Icon name="text" size={16} />
                                <span>{uiText('改名')}</span>
                              </button>
                            )}
                            {selected.length === 1 && (
                              <button
                                className="selection-group"
                                aria-label={uiText('创建区域')}
                                disabled={busy || workspace.groups.items.length >= 40}
                                title={uiText('将选区创建为区域')}
                                onClick={() => regions.create()}
                              >
                                <Icon name="group" size={16} />
                                <span>{uiText('区域')}</span>
                              </button>
                            )}
                            <button
                              disabled={busy}
                              title={
                                selected.length === 1
                                  ? uiText('评论此对象或选中范围')
                                  : uiText('查看所选对象的评论')
                              }
                              onClick={() =>
                                setCommentsTarget(
                                  selected.length === 1
                                    ? { objectId: selected[0], range: ranges[selected[0]] }
                                    : {},
                                )
                              }
                            >
                              <Icon name="comment" size={16} />
                              <span>{uiText('评论')}</span>
                            </button>
                            {selected.length > 1 && (
                              <button
                                disabled={busy}
                                title={uiText('用短线连接所选文件，自动选择临近卡片')}
                                onClick={connectSelected}
                              >
                                <Icon name="link" size={16} />
                                <span>{uiText('短连线')}</span>
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setSelectionTools(false);
                                setFilesOpen(true);
                              }}
                            >
                              <Icon name="folder" />
                              {uiText('移入文件夹')}
                            </button>

                            <button
                              onClick={() => {
                                setSelectionTools(false);
                                void flush()
                                  .then(() => setContextPreview(true))
                                  .catch(report);
                              }}
                            >
                              <Icon name="eye" />
                              {uiText('查看引用范围')}
                            </button>
                            {selected.some((id) => ranges[id]) && (
                              <button
                                onClick={() => {
                                  setSelectionTools(false);
                                  setProtectionObject(selected.find((id) => ranges[id])!);
                                }}
                              >
                                <Icon name="lock" />
                                {uiText('保留局部范围')}
                              </button>
                            )}
                          </ActionPopover>
                        </>
                      )}
                    </section>
                  </IntentSelection>
                )}
              </>
            )}
            {isIntegratedDesktop && workspace && (
              <IntentWorkbench
                workspaceId={workspace.id}
                visible={canvasVisible}
              />
            )}
            <footer className="app-footer">
              {connection !== 'ready' && (
                <span title={lastSync ? uiText('上次本地同步 {0}', { '0': lastSync }) : undefined}>
                  {connection === 'connecting' ? uiText('连接中') : uiText('等待重新连接')}
                </span>
              )}
            </footer>
            {showHistory && (
              <ActivityDrawer
                events={history}
                next={historyNext}
                objects={workspace?.objects}
                onClose={() => setShowHistory(false)}
                onLoadMore={() => {
                  if (historyNext) void loadActivity(historyNext).catch(report);
                }}
                onInspect={(objectId, revision) => {
                  setRevisionObject(objectId);
                  setRevisionTarget(revision);
                  setShowHistory(false);
                }}
              />
            )}
            {expanded && isWorkflowObject(expanded) && workspace && (
              <WorkflowEditor
                key={expanded.id}
                workspace={workspace}
                object={expanded}
                action={action}
                updated={reload}
                close={() => {
                  setFull(null);
                  workflowDirtyChanged(false);
                }}
                handoff={handoffWorkflow}
                recover={recoverWorkflow}
                sendRuns={submitWorkflowRuns}
                openObject={(id) => {
                  setWorkflowReturn({ flowId: expanded.id, fileId: id });
                  workflowDirtyChanged(false);
                  setFull(id);
                }}
                canHandoff={
                  !busy &&
                  connection === 'ready' &&
                  !!binding?.messageRouteAvailable &&
                  hostReady &&
                  (bridge.supportsSend() || bridge.supportsAttachments())
                }
                canSend={
                  !busy &&
                  connection === 'ready' &&
                  !!binding?.messageRouteAvailable &&
                  hostReady &&
                  bridge.supportsSend()
                }
                dirtyChanged={workflowDirtyChanged}
              />
            )}
            {expanded && !isWorkflowObject(expanded) && (
              <section
                className="full-view"
                data-file-ai-object={expanded.id}
                data-file-ai-revision={expanded.revision}
                role="dialog"
                aria-label={expanded.title}
              >
                <header>
                  <button
                    disabled={imageDirty || fileDirty}
                    title={imageDirty || fileDirty ? uiText('请先保存或处理编辑草稿') : undefined}
                    onClick={() =>
                      expanded.kind === 'file' || expanded.kind === 'image'
                        ? setFull(null)
                        : void flush()
                            .then(() => setFull(null))
                            .catch(report)
                    }
                  >
                    {uiText('← 返回')}
                  </button>
                  <strong>{expanded.title}</strong>
                  <span>
                    v{expanded.revision} {uiText('· 同一对象')}
                  </span>
                  {workflowReturn?.fileId === expanded.id &&
                    workspace?.objects.some((o) => o.id === workflowReturn.flowId) && (
                      <button
                        disabled={fileDirty || imageDirty}
                        onClick={() => {
                          setFull(workflowReturn.flowId);
                          setWorkflowReturn(null);
                        }}
                      >
                        {uiText('返回流程编辑')}
                      </button>
                    )}
                  <button
                    onClick={() =>
                      setCommentsTarget({ objectId: expanded.id, range: ranges[expanded.id] })
                    }
                  >
                    <Icon name="comment" size={15} />
                    {uiText('评论与处理')}
                  </button>
                  {expanded.kind !== 'image' && expanded.kind !== 'file' && (
                    <button onClick={() => void flush().catch(report)}>{uiText('保存')}</button>
                  )}
                  <button
                    className="file-export-primary"
                    disabled={busy || imageDirty || fileDirty}
                    onClick={() =>
                      void (expanded.kind === 'deck'
                        ? generateArtifact(expanded.id, 'pptx')
                        : expanded.kind === 'table' || expanded.kind === 'workbook'
                          ? generateArtifact(expanded.id, 'xlsx')
                          : expanded.kind === 'diagram'
                            ? generateArtifact(expanded.id, 'png')
                            : exportObject(expanded.id))
                    }
                  >
                    <Icon name="download" size={15} />
                    {uiText('导出')}
                  </button>
                  <ActionPopover
                    label={uiText('文件操作')}
                    className="file-actions-popover"
                    open={fileActionsOpen}
                    setOpen={setFileActionsOpen}
                    closeOnAction
                    trigger={<Icon name="more" size={19} />}
                  >
                    <p className="popover-caption">{uiText('文件操作')}</p>
                    <button
                      disabled={imageDirty || fileDirty}
                      onClick={() => {
                        setRevisionTarget(undefined);
                        setRevisionObject(expanded.id);
                      }}
                    >
                      {uiText('修改与来源')}
                    </button>

                    {['text', 'code', 'table', 'diagram', 'deck', 'workbook'].includes(
                      expanded.kind,
                    ) && (
                      <button onClick={() => setProtectionObject(expanded.id)}>
                        {uiText('保留范围')}
                        {expanded.policy?.protectedRanges.length
                          ? ` · ${expanded.policy.protectedRanges.length}`
                          : ''}
                      </button>
                    )}
                    {['diagram', 'deck', 'workbook', 'table'].includes(expanded.kind) && (
                      <button
                        disabled={busy || imageDirty || fileDirty}
                        onClick={() => void exportObject(expanded.id)}
                      >
                        {uiText('导出结构源')}
                      </button>
                    )}

                    {expanded.kind === 'text' && (
                      <button
                        disabled={busy}
                        onClick={() => void exportObject(expanded.id, false, 'markdown')}
                      >
                        {uiText('导出 Markdown')}
                      </button>
                    )}

                    {(expanded.kind === 'diagram' || expanded.kind === 'image') && (
                      <button
                        disabled={busy || imageDirty}
                        onClick={() => void generateArtifact(expanded.id, 'svg')}
                      >
                        {expanded.kind === 'image' ? uiText('导出带批注 SVG') : uiText('导出 SVG')}
                      </button>
                    )}
                    {expanded.kind === 'image' && (
                      <button
                        disabled={busy || imageDirty}
                        onClick={() => void generateArtifact(expanded.id, 'png')}
                      >
                        {uiText('导出 PNG')}
                      </button>
                    )}
                    {expanded.kind !== 'image' && expanded.kind !== 'file' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action('native_workbench', {
                            operation: 'convert',
                            objectId: expanded.id,
                            expectedRevision: expanded.revision,
                            requestId: uid(),
                          })
                            .then(() => reload())
                            .catch(report)
                        }
                      >
                        {uiText('转为原生文件')}
                      </button>
                    )}
                    <button
                      disabled={busy || deletion.busy || !!deletion.pendingCount}
                      title={uiText('移到回收站，保留历史并可恢复')}
                      onClick={() => void deleteMaterials([expanded.id])}
                    >
                      <Icon name="trash" size={14} />
                      {uiText('删除')}
                    </button>
                  </ActionPopover>
                </header>
                {drafts[expanded.id]?.error && conflictControls(expanded)}
                {expanded.kind === 'text' ? (
                  <TextEditor
                    key={expanded.id}
                    save={() => void flush().catch(report)}
                    blur={() => saveText(expanded.id)}
                    value={textOf((drafts[expanded.id]?.content ?? expanded.content) as Text)}
                    change={(text) => edit(expanded.id, text)}
                    selectRange={(start, end, source) =>
                      void useRange(
                        expanded.id,
                        { type: 'text', start, end, baseRevision: expanded.revision },
                        source,
                      )
                    }
                  />
                ) : expanded.kind === 'code' ? (
                  <CodeEditor
                    value={(drafts[expanded.id]?.content ?? expanded.content) as Code}
                    change={(c) => change(expanded.id, c)}
                    selectRange={(start, end, source) =>
                      void useRange(
                        expanded.id,
                        { type: 'code', start, end, baseRevision: expanded.revision },
                        source,
                      )
                    }
                  />
                ) : expanded.kind === 'table' ? (
                  <TableEditor
                    key={expanded.id}
                    value={(drafts[expanded.id]?.content ?? expanded.content) as Table}
                    change={(c) => change(expanded.id, c)}
                    selectRange={(rowIds, columnIds, source) =>
                      void useRange(
                        expanded.id,
                        { type: 'cells', rowIds, columnIds, baseRevision: expanded.revision },
                        source,
                      )
                    }
                  />
                ) : expanded.kind === 'diagram' ? (
                  <DiagramEditor
                    value={(drafts[expanded.id]?.content ?? expanded.content) as Diagram}
                    change={(c) => change(expanded.id, c)}
                  />
                ) : expanded.kind === 'deck' ? (
                  <DeckEditor
                    value={(drafts[expanded.id]?.content ?? expanded.content) as Deck}
                    change={(c) => change(expanded.id, c)}
                  />
                ) : expanded.kind === 'workbook' ? (
                  <WorkbookEditor
                    value={(drafts[expanded.id]?.content ?? expanded.content) as Workbook}
                    change={(c) => change(expanded.id, c)}
                  />
                ) : expanded.kind === 'file' ? (
                  <NativeFileDetails
                    comment={(range) => setCommentsTarget({ objectId: expanded.id, range })}
                    history={(revision) => {
                      setRevisionObject(expanded.id);
                      setRevisionTarget(revision);
                    }}
                    key={expanded.id}
                    object={expanded}
                    action={action}
                    updated={reload}
                    exportFile={() => void exportObject(expanded.id, false)}
                    reference={(range) =>
                      attachMaterials(
                        undefined,
                        [expanded.id],
                        range ? { [expanded.id]: range } : {},
                      )
                    }
                    canReference={
                      !busy &&
                      connection === 'ready' &&
                      !!binding?.messageRouteAvailable &&
                      hostReady &&
                      bridge.supportsAttachments()
                    }
                    dirtyChanged={setFileDirty}
                  />
                ) : (
                  <ImageEditor
                    key={expanded.id}
                    object={expanded}
                    action={action}
                    saved={annotationSaved}
                    leave={() => setFull(null)}
                    dirtyChanged={setImageDirty}
                  />
                )}
                <footer>
                  {uiText('对象')}
                  {expanded.id.slice(-12)} ·{' '}
                  {fileDirty
                    ? uiText('文件有未保存或待确认的修改')
                    : imageDirty
                      ? uiText('有未保存或待确认的批注')
                      : (drafts[expanded.id]?.error ??
                        (drafts[expanded.id]
                          ? expanded.kind === 'text'
                            ? uiText('编辑草稿 · 点击编辑区外保存')
                            : uiText('编辑草稿 · 停止输入 2 秒后自动保存')
                          : uiText('已保存到本地')))}
                  {expanded.sourceFileName && (
                    <button
                      disabled={busy || imageDirty || fileDirty}
                      onClick={() => void exportObject(expanded.id, true)}
                    >
                      {uiText('导出原文件')}
                    </button>
                  )}
                </footer>
                {exportedPath && (
                  <div className="export-result">
                    <label>
                      {uiText('已导出文件')}
                      <input readOnly aria-label={uiText('已导出文件路径')} value={exportedPath} />
                    </label>
                    <button onClick={() => setExportedPath('')}>{uiText('关闭')}</button>
                  </div>
                )}
              </section>
            )}
            <DeletionFeedback deletion={deletion} openTrash={() => void navigateDesktop('trash')} />
            {trashOpen && workspace && (
              <DesktopTrash
                key={'DesktopTrash:' + workspace.id}
                workspace={workspace}
                action={action}
                deletion={deletion}
                close={() => setTrashOpen(false)}
              />
            )}
            {screenshotAi.layer}
            {previewObject && (
              <DesktopPreview
                ask={
                  isIntegratedDesktop
                    ? () => window.parent.postMessage({ type: 'ai-desktop:file-ai-toggle' }, '*')
                    : undefined
                }
                askDisabled={
                  busy || connection !== 'ready' || !binding?.messageRouteAvailable || !hostReady
                }
                object={
                  drafts[previewObject.id]
                    ? { ...previewObject, content: drafts[previewObject.id].content }
                    : previewObject
                }
                draft={!!drafts[previewObject.id]}
                action={action}
                close={() => setPreviewIds([])}
                edit={() => {
                  setFull(previewObject.id);
                  setPreviewIds([]);
                }}
                position={{
                  index: Math.min(previewIndex, previewObjects.length - 1),
                  total: previewObjects.length,
                  previous: () => setPreviewIndex((i) => Math.max(0, i - 1)),
                  next: () => setPreviewIndex((i) => Math.min(previewObjects.length - 1, i + 1)),
                }}
              />
            )}
            {workspace && commandsOpen && (
              <DesktopCommandPalette
                commands={desktopCommands}
                objects={workspace.objects}
                recentIds={library.recentIds}
                openObject={(id) => {
                  if (fileDirty || imageDirty || workflowDirty) {
                    setNotice(uiText('请先保存当前编辑。'));
                    return;
                  }
                  setFull(id);
                }}
                close={() => setCommandsOpen(false)}
              />
            )}
            {bundlePath && (
              <BundleExportDialog
                path={bundlePath}
                report={report}
                onClose={() => setBundlePath('')}
              />
            )}
            {contextMenu && workspace && (
              <DesktopContextMenu
                x={contextMenu.x}
                y={contextMenu.y}
                items={
                  contextMenu.ids.length
                    ? objectCommands(contextMenu.ids)
                    : desktopCommands.filter((command) =>
                        [
                          'new-note',
                          'new-table',
                          'new-document',
                          'new-code',
                          'import',
                          'workflows',
                          'fit',
                          'undo-arrangement',
                          'redo-arrangement',
                          'help',
                        ].includes(command.id),
                      )
                }
                close={() => setContextMenu(null)}
              />
            )}
            {shortcutsOpen && <DesktopShortcutHelp close={() => setShortcutsOpen(false)} />}
            {fileTransfer && workspace && (
              <FileTransferDialog
                key={workspace.id}
                file={fileTransfer}
                workspaceId={workspace.id}
                list={listFileTransferTargets}
                close={() => setFileTransfer(null)}
                transfer={(targetWorkspaceId, requestId) => {
                  if (switching.current || bindingRef.current?.workspaceId !== workspace.id)
                    throw new PanelActionError(
                      'WORKSPACE_SWITCHED',
                      uiText('桌面正在切换，请稍后重试。'),
                    );
                  flushDraftStorage();
                  if (deleteDraftStatus(fileTransfer.objectId) !== 'none')
                    throw new PanelActionError(
                      'DRAFT_ACTIVE',
                      uiText('请先保存文件编辑，再转移到其他桌面。'),
                    );
                  const { title, ...payload } = fileTransfer;
                  return action('file_transfer', { ...payload, targetWorkspaceId, requestId });
                }}
                done={(targetName) => {
                  setFileTransfer(null);
                  window.dispatchEvent(new Event('yirang:workspaces-changed'));
                  if (bindingRef.current?.workspaceId !== workspace.id) return;
                  if (fileTransfer.operation === 'cut') {
                    setSelected((ids) => ids.filter((id) => id !== fileTransfer.objectId));
                    void reload().catch(report);
                  }
                  setNotice(
                    uiText(
                      fileTransfer.operation === 'copy'
                        ? '文件已复制到「{0}」。'
                        : '文件已剪切到「{0}」。',
                      { '0': targetName },
                    ),
                  );
                }}
              />
            )}
            {renameIds.length > 0 && workspace && (
              <BatchRenameDialog
                key={'BatchRenameDialog:' + workspace.id}
                workspaceId={workspace.id}
                objects={workspace.objects.filter((object) => renameIds.includes(object.id))}
                action={action}
                updated={reload}
                close={() => setRenameIds([])}
                renamed={(ids) =>
                  setNotice(
                    uiText('已重命名 {0} 份材料，原文件名和内容保持不变。', { '0': ids.length }),
                  )
                }
              />
            )}
            {(duplication.pending || duplication.error) && (
              <div className="desktop-operation-feedback" role="status">
                <span>
                  {duplication.error || uiText('复制响应待确认，继续原请求不会生成第二份副本。')}
                </span>
                {duplication.pending ? (
                  <button
                    disabled={duplication.busy || busy}
                    onClick={() => void duplication.copy()}
                  >
                    {duplication.busy
                      ? uiText('处理中…')
                      : duplication.pending.resultId
                        ? uiText('打开已有副本')
                        : uiText('继续复制')}
                  </button>
                ) : (
                  <button onClick={duplication.dismiss}>{uiText('知道了')}</button>
                )}
              </div>
            )}
            {revisionObject && workspace?.objects.find((o) => o.id === revisionObject) && (
              <RevisionHistory
                key={`${revisionObject}:${revisionTarget ?? 'latest'}`}
                initialRevision={revisionTarget}
                workspace={workspace}
                openRevision={(id, revision) => {
                  setRevisionObject(id);
                  setRevisionTarget(revision);
                }}
                object={workspace.objects.find((o) => o.id === revisionObject)!}
                action={action}
                hasDraft={
                  !!drafts[revisionObject] ||
                  (expanded?.id === revisionObject && (fileDirty || imageDirty))
                }
                close={() => setRevisionObject(null)}
                restored={async () => {
                  await reload();
                  setNotice(uiText('已保存为新版本，原有记录保留。'));
                }}
                report={report}
              />
            )}
            {protectionObject && workspace?.objects.find((o) => o.id === protectionObject) && (
              <RangeProtection
                key={protectionObject}
                object={workspace.objects.find((o) => o.id === protectionObject)!}
                range={ranges[protectionObject]}
                hasDraft={!!drafts[protectionObject]}
                action={action}
                updated={reload}
                close={() => setProtectionObject(null)}
                select={() => {
                  setFull(protectionObject);
                  setProtectionObject(null);
                }}
              />
            )}
            {workspace && (
              <ImportMaterials
                key={'ImportMaterials:' + workspace.id}
                ref={importer}
                open={importOpen}
                workspace={workspace}
                action={action}
                prepare={() => flush(true)}
                updated={reload}
                importedObjects={(ids) => {
                  const target = widgetImportTarget.current;
                  if (target) {
                    window.dispatchEvent(
                      new CustomEvent('ai-desktop:widget-files', { detail: { ...target, ids } }),
                    );
                    widgetImportTarget.current = null;
                  }
                }}
                close={() => setImportOpen(false)}
                locate={locateObjects}
                imported={(count, folders) => {
                  setNotice(
                    uiText('已保存 {0} 个原生文件{1}。', {
                      '0': count,
                      '1': folders ? uiText('和 {0} 个目录路径', { '0': folders }) : '',
                    }),
                  );
                  if (folders) setFilesOpen(true);
                }}
              />
            )}
            {layoutsOpen && workspace && (
              <Layouts
                key={'Layouts:' + workspace.id}
                workspace={workspace}
                action={action}
                flush={flush}
                current={() => wsRef.current!}
                updated={reload}
                restore={restoreLayout}
                close={() => setLayoutsOpen(false)}
              />
            )}
            {annotationRecovery && workspace && (
              <AnnotationRecovery
                key={'AnnotationRecovery:' + workspace.id}
                workspace={workspace}
                action={action}
                close={() => setAnnotationRecovery(false)}
                open={(id) => {
                  setAnnotationRecovery(false);
                  setFull(id);
                }}
              />
            )}
            {commentsTarget && workspace && (
              <CommentsDrawer
                key={`${workspace.id}:${commentsTarget.threadId ?? ''}`}
                initialThreadId={commentsTarget.threadId}
                workspace={workspace}
                objectId={commentsTarget.objectId}
                range={commentsTarget.range}
                action={action}
                send={sendComment}
                canSend={
                  !busy &&
                  !fileDirty &&
                  !imageDirty &&
                  !workflowDirty &&
                  connection === 'ready' &&
                  !!binding?.messageRouteAvailable &&
                  hostReady &&
                  bridge.supportsSend()
                }
                connectionMessage={
                  fileDirty || imageDirty || workflowDirty
                    ? uiText('请先保存当前编辑，再让 AI 处理。')
                    : !bridge.supportsSend()
                      ? uiText('当前宿主未开放直接发送，评论可以先保存在桌面。')
                      : connection !== 'ready'
                        ? uiText('等待本地连接恢复。')
                        : undefined
                }
                close={() => setCommentsTarget(null)}
                openObject={(id) => {
                  if (fileDirty || imageDirty || workflowDirty) {
                    setNotice(uiText('请先保存当前编辑再查看结果。'));
                    return;
                  }
                  if (commentsTarget.objectId || !isIntegratedDesktop) {
                    setCommentsTarget(null);
                    locateObjects([id]);
                  }
                  setFull(id);
                }}
                history={(id, revision) => {
                  setCommentsTarget(null);
                  setRevisionObject(id);
                  setRevisionTarget(revision);
                }}
              />
            )}
            {taskDesk && workspace && (
              <TaskDesk
                key={'TaskDesk:' + workspace.id}
                workspace={workspace}
                action={action}
                close={() => setTaskDesk(null)}
                openObject={(id) => setFull(id)}
                saveProposal={saveTaskProposal}
              />
            )}
            {materials && workspace && (
              <Materials
                workspace={workspace}
                action={action}
                close={() => setMaterials(false)}
                openObject={(id) => setFull(id)}
                updated={reload}
                deletion={deletion}
                openTrash={() => {
                  setMaterials(false);
                  setTrashOpen(true);
                }}
              />
            )}
            {environment && workspace && (
              <Environment
                key={'Environment:' + workspace.id}
                workspace={workspace}
                action={action}
                close={() => setEnvironment(false)}
              />
            )}
            {browserOpen && isIntegratedDesktop && workspace && (
              <BrowserWorkspace
                key={'BrowserWorkspace:' + workspace.id}
                pinTabs={canvasBrowser.pinTabs}
                floating={browserFloating}
                toggleFloating={() => setBrowserFloating((value) => !value)}
                close={() => void navigateDesktop('canvas')}
                locate={(id) => {
                  void navigateDesktop('canvas').then((opened) => {
                    if (opened) locateObjects([id]);
                  });
                }}
                visibleRect={() => visibleRect}
                workspace={workspace}
                currentWorkspace={() => wsRef.current!}
                initialUrl={browserUrl}
                action={action}
                updated={reload}
                dirtyChanged={browserDirtyChanged}
                openLibrary={() => void navigateDesktop('web')}
                reference={(id) => attachMaterials(undefined, [id], {})}
                canReference={
                  !busy &&
                  connection === 'ready' &&
                  !!binding?.messageRouteAvailable &&
                  hostReady &&
                  bridge.supportsAttachments()
                }
              />
            )}
            {webOpen && workspace && (
              <WebWorkbench
                key={'WebWorkbench:' + workspace.id}
                workspace={workspace}
                action={action}
                updated={reload}
                dirtyChanged={webDirtyChanged}
                close={() => {
                  if (webDirtyRef.current) {
                    setNotice(uiText('请先保存或放弃当前网页项目修改。'));
                    return;
                  }
                  setWebOpen(false);
                }}
                openObject={(id) => {
                  if (webDirtyRef.current) {
                    setNotice(uiText('请先保存当前网页项目。'));
                    return;
                  }
                  if (!isIntegratedDesktop) setWebOpen(false);
                  setFull(id);
                }}
                openUrl={openEmbeddedBrowser}
                runTask={(request) => submitWebTask(request)}
                continueTask={(taskId) => submitWebTask(taskId)}
                canSend={
                  !busy &&
                  connection === 'ready' &&
                  !!binding?.messageRouteAvailable &&
                  hostReady &&
                  bridge.supportsSend()
                }
              />
            )}
            {workflowLibrary && workspace && (
              <DesktopToolLibrary
                key={'DesktopToolLibrary:' + workspace.id}
                workspace={workspace}
                busy={busy}
                pending={toolPlacement.pending}
                error={toolPlacement.error}
                place={chooseDesktopTool}
                resume={toolPlacement.resume}
                create={() => chooseCreation('workflow')}
                edit={(id) => {
                  if (widgetDrafts.current.has(id)) {
                    setNotice(uiText('请先保存此工具的参数草稿。'));
                    return;
                  }
                  setWorkflowLibrary(false);
                  setFull(id);
                }}
                close={() => {
                  setArmedTool(null);
                  setWorkflowLibrary(false);
                }}
              />
            )}
            {runSelection && workspace && (
              <LocalRunsView
                key={'LocalRunsView:' + workspace.id}
                workspaceId={workspace.id}
                selection={runSelection}
                action={action}
                updated={reload}
                close={() => setRunSelection(null)}
                canAttach={
                  connection === 'ready' &&
                  !!binding?.messageRouteAvailable &&
                  hostReady &&
                  bridge.supportsAttachments()
                }
                authorize={(codeObjectId) =>
                  attachMaterials({ selection: runSelection, codeObjectId })
                }
                recover={attachRunRecovery}
                locate={(id) => {
                  setRunSelection(null);
                  locateObjects([id]);
                  setFull(id);
                }}
              />
            )}
            {contextPreview && workspace && (
              <ContextPreview
                objects={workspace.objects.filter((o) => selected.includes(o.id))}
                ranges={ranges}
                close={() => setContextPreview(false)}
              />
            )}
            {artifacts && workspace && (
              <ArtifactLibrary
                workspace={workspace}
                action={action}
                close={() => setArtifacts(false)}
                openSource={(id) => setFull(id)}
              />
            )}
            {workspacesOpen && workspace && (
              <Workspaces
                workspace={workspace}
                action={action}
                updated={reload}
                change={changeWorkspace}
                close={() => setWorkspacesOpen(false)}
                backups={() => {
                  setWorkspacesOpen(false);
                  setBackupsOpen(true);
                }}
              />
            )}
            {backupsOpen && workspace && (
              <Backups
                key={'Backups:' + workspace.id}
                workspace={workspace}
                action={action}
                prepare={prepareBackup}
                close={() => setBackupsOpen(false)}
                openRestored={(targetId) => changeWorkspace({ operation: 'switch', targetId })}
              />
            )}
            {pendingSwitch && (
              <section
                className="workspace-transfer"
                role="dialog"
                aria-modal="true"
                aria-label={uiText('工作区切换')}
              >
                <div>
                  <span className="workspace-transfer-icon">
                    <DesktopMark />
                  </span>
                  <h2>{busy ? uiText('正在切换工作区') : uiText('正在等待切换结果')}</h2>
                  <p>
                    {busy
                      ? uiText('已保存当前材料。')
                      : uiText('服务回包尚未确认。可以重试同一次切换，或重新读取工作区。')}
                    {uiText('旧选区不会自动附加。')}
                  </p>
                  {!busy && (
                    <>
                      <p className="error-text">{error}</p>
                      <div>
                        <button onClick={() => void reconnect()}>{uiText('重新读取工作区')}</button>
                        <button
                          className="primary"
                          onClick={() => void changeWorkspace(pendingSwitch).catch(() => {})}
                        >
                          {uiText('重试此次切换')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </section>
            )}
            <RenderPerformance />
          </main>
        </CanvasDetailContext.Provider>
      </CanvasPreviewProvider>
    </WorkflowWidgetContext.Provider>
  );
}
function DesktopHost() {
  useUiLanguage();
  const [state, setState] = useState<{ value: any; serial: number }>({ value: null, serial: 0 });
  const [hostReady, setHostReady] = useState(false),
    [hostError, setHostError] = useState('');
  const current = useRef(state);
  function receive(value: any, expected?: number) {
    if (expected !== undefined && current.current.serial !== expected) return;
    if (!value?.binding && !value?.needsWorkspaceChoice) return;
    if (value.binding && current.current.value?.binding?.credential === value.binding.credential)
      return;
    bridge.rebind();
    const next = { value, serial: current.current.serial + 1 };
    current.current = next;
    setState(next);
  }
  useEffect(() => {
    bridge.onInitial(receive);
    bridge
      .connect()
      .then(() => setHostReady(true))
      .catch((e) => setHostError(String(e)));
  }, []);
  // Each credential owns its React state and queues. Late old callbacks cannot
  // reach the new workspace, including after an unsolicited host tool result.
  return (
    <ReactFlowProvider key={state.serial}>
      <Desktop
        initialState={state.value}
        hostReady={hostReady}
        hostError={hostError}
        openState={(value) => receive(value, state.serial)}
      />
    </ReactFlowProvider>
  );
}
connectUiLanguage();
createRoot(document.getElementById('root')!).render(
  <PanelErrorBoundary>
    <DesktopHost />
  </PanelErrorBoundary>,
);
