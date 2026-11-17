import { useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Node } from '@xyflow/react';
import type { CardData } from '../canvas/object-card.js';
import {
  McpBridge,
  PanelActionError,
  SendRejectedError,
  attachSelection,
  type AttachedSelection,
  type ContextState,
} from '../host.js';
import { sendWorkflowRuns, acknowledgeWorkflowRequests, deliverDesktopWorkflow } from './workflow-send.js';
import type { WorkflowRunOptions } from './workflow-widget.js';
import { sendWebTask } from '../browser/web-task-send.js';
import { writeDraftNow } from '../documents/draft-storage.js';
import type { RunSelection } from '../work/local-runs.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import type { MaterialRange, PanelBinding, Workspace } from '../../../packages/contracts/index.js';
import type { WebTaskRequestValue } from '../../../packages/contracts/web-tasks.js';

const uid = () => crypto.randomUUID();

/**
 * Everything the desktop hands off to the original Codex conversation:
 * material references, workflow runs, local-run recovery, comments and web
 * tasks. Pure state plumbing lives in the container; this hook owns the
 * submission protocols and their busy/dirty guards.
 */
export function useWorkflowHandoff(deps: {
  bridge: McpBridge;
  binding: PanelBinding | null;
  bindingRef: { current: PanelBinding | null };
  wsRef: { current: Workspace | null };
  mounted: { current: boolean };
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
  selected: string[];
  setSelected: (value: string[]) => void;
  ranges: Record<string, MaterialRange>;
  setRanges: (value: Record<string, MaterialRange>) => void;
  attached: AttachedSelection | null;
  setAttached: (value: AttachedSelection | null) => void;
  setRunSelection: (value: RunSelection | null) => void;
  setNodes: Dispatch<SetStateAction<Node<CardData>[]>>;
  fileDirty: boolean;
  imageDirty: boolean;
  workflowDirtyRef: { current: boolean };
  workflowSendActive: { current: boolean };
  commentSendActive: { current: boolean };
  webSending: { current: boolean };
  flush: () => Promise<void>;
  reload: () => Promise<unknown>;
  scoped: () => Record<string, unknown>;
  requireOpen: () => void;
  reflectContext: (state: ContextState) => void;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  report: (error: unknown) => void;
}) {
  const {
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
  } = deps;
  async function attachMaterials(
    run?: { selection: RunSelection; codeObjectId: string },
    explicitIds?: string[],
    explicitRanges?: Record<string, MaterialRange>,
    workflowRunId?: string,
    cancelled?: () => boolean,
  ) {
    const ids = run ? run.selection.objects.map((object) => object.id) : (explicitIds ?? selected);
    if (!binding || busy || !ids.length) return false;
    setBusy(true);
    setError('');
    try {
      const contextEpoch = bridge.contextEpoch();
      const result = await attachSelection(bridge, binding, flush, async () => {
        const w = wsRef.current!;
        const objects = run ? run.selection.objects : w.objects.filter((o) => ids.includes(o.id));
        const prepared = await bridge.call('desktop_prepare_context', {
          ...scoped(),
          requestId: uid(),
          objectIds: ids,
          purpose: 'reference',
          ranges:
            explicitRanges ??
            (run
              ? run.selection.ranges
              : explicitIds
                ? {}
                : Object.fromEntries(Object.entries(ranges).filter(([id]) => ids.includes(id)))),
          expectedRevisions: Object.fromEntries(objects.map((o) => [o.id, o.revision])),
          ...(run ? { run: { codeObjectId: run.codeObjectId } } : {}),
          ...(workflowRunId ? { workflowRunId } : {}),
        });
        return {
          ...prepared,
          objects: objects.map(({ id, title, revision }) => ({
            id,
            title:
              explicitRanges?.[id]?.type === 'native'
                ? uiText('{0} · 选中文本', { '0': title })
                : title,
            revision,
          })),
        };
      });
      requireOpen();
      if (cancelled?.()) {
        await bridge.clearContext();
        setAttached(null);
        await action('cancel', { snapshotId: result.selection.snapshotId });
        return false;
      }
      if (result.mode === 'context') {
        if (bridge.contextEpoch() !== contextEpoch && bridge.contextState() !== undefined)
          reflectContext(bridge.contextState());
        else setAttached(result.selection);
      }
      setSelected([]);
      setRanges({});
      setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
      setNotice(
        workflowRunId
          ? uiText(
              '流程和所需材料已引用到原对话。在原消息框输入执行要求后，节点回报和结果会回到桌面。',
            )
          : run
            ? uiText(
                '已将代码和材料交给 Codex 原消息框。输入运行要求后，Codex 会在本地执行并将结果收回桌面。',
              )
            : uiText('已引用所选材料。'),
      );
      await action('delivery', {
        snapshotId: result.selection.snapshotId,
        outcome: result.mode === 'context' ? 'attached' : 'draft',
      }).catch(() => setNotice(uiText('材料已交给原消息框；本地记录暂未保存，不会重复附加。')));
      if (cancelled?.()) {
        await bridge.clearContext();
        setAttached(null);
        await action('cancel', { snapshotId: result.selection.snapshotId });
        return false;
      }
      if (run) setRunSelection(null);
      return true;
    } catch (e) {
      report(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function handoffWorkflow(
    objectId: string,
    expectedRevision: number,
    options?: WorkflowRunOptions,
  ) {
    if (!binding || busy || workflowSendActive.current) return false;
    const original = binding,
      requestKey = `ai-desktop:workflow-submit:${original.workspaceId}:${objectId}`;
    if (!bridge.supportsSend()) {
      try {
        await flush();
        await reload();
        const prepared = await action('workflow', {
          operation: 'prepare',
          objectId,
          expectedRevision,
          requestId: uid(),
          ...options,
        });
        return await attachMaterials(undefined, prepared.objectIds, {}, prepared.run.id);
      } catch (error) {
        report(error);
        return false;
      }
    }
    workflowSendActive.current = true;
    setBusy(true);
    setError('');
    try {
      await flush();
      await reload();
      requireOpen();
      if (bindingRef.current?.panelInstanceId !== original.panelInstanceId)
        throw new SendRejectedError('SESSION_CHANGED', uiText('桌面会话已切换。'));
      const existingRuns = await action('workflow', { operation: 'runs', objectId });
      acknowledgeWorkflowRequests(original.workspaceId, objectId, existingRuns.runs ?? []);
      let pending = JSON.parse(localStorage.getItem(requestKey) ?? 'null');
      if (pending && JSON.stringify(pending.options ?? {}) !== JSON.stringify(options ?? {}))
        throw new Error(uiText('上一次流程提交尚未确认，请从原运行记录继续后再开始局部运行。'));
      if (!pending) {
        pending = {
          payload: {
            operation: 'prepare',
            objectId,
            expectedRevision,
            requestId: uid(),
            ...options,
          },
          options,
          createdAt: new Date().toISOString(),
        };
        writeDraftNow(requestKey, JSON.stringify(pending));
      }
      if (!pending.runId) {
        const prepared = await action('workflow', pending.payload);
        pending.runId = prepared.run.id;
        writeDraftNow(requestKey, JSON.stringify(pending));
      }
      const sent = await deliverWorkflowRuns([pending.runId], original);
      if (sent) {
        writeDraftNow(requestKey, null);
        await reload();
      }
      return sent;
    } catch (error) {
      if (
        error instanceof SendRejectedError ||
        (error instanceof PanelActionError &&
          !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code))
      )
        writeDraftNow(requestKey, null);
      report(error);
      return false;
    } finally {
      workflowSendActive.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function deliverWorkflowRuns(runIds: string[], original: PanelBinding, continuing = false) {
    const requestKey = `ai-desktop:workflow-send:${original.workspaceId}:${runIds.slice().sort().join(',')}:${continuing ? 'continue' : 'start'}`;
    const stored = localStorage.getItem(requestKey);
    let receipt = stored ? JSON.parse(stored) : null;
    if (!receipt) {
      receipt = { requestId: uid(), createdAt: new Date().toISOString() };
      writeDraftNow(requestKey, JSON.stringify(receipt));
    }
    const requestId = receipt.requestId as string;
    let result: { sent: boolean; receiptPending: boolean };
    try {
      result = await sendWorkflowRuns({
        bridge,
        binding: original,
        runIds,
        requestId,
        continuing,
        check: () => {
          requireOpen();
          if (bindingRef.current?.panelInstanceId !== original.panelInstanceId)
            throw new SendRejectedError('SESSION_CHANGED', uiText('桌面或原会话已切换。'));
        },
      });
    } catch (error) {
      if (
        error instanceof SendRejectedError ||
        (error instanceof PanelActionError &&
          !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code))
      )
        writeDraftNow(requestKey, null);
      throw error;
    }
    writeDraftNow(requestKey, null);
    setNotice(
      result.receiptPending
        ? uiText('流程已提交，投递回执暂未保存；请查看原运行记录。')
        : uiText('已提交当前 Codex 会话，节点状态与结果会回到桌面小工具。'),
    );
    return true;
  }
  async function submitWorkflowRuns(runIds: string[], continuing = false) {
    if (!binding || busy || workflowSendActive.current) return false;
    const original = binding;
    workflowSendActive.current = true;
    setBusy(true);
    setError('');
    try {
      await flush();
      return await deliverWorkflowRuns(runIds, original, continuing);
    } catch (error) {
      report(error);
      return false;
    } finally {
      workflowSendActive.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function checkWorkflowDelivery(dispatchId: string, objectId: string, runIds: string[]) {
    if (!binding || busy || workflowSendActive.current) return;
    workflowSendActive.current = true;
    setBusy(true);
    try {
      const result = await deliverDesktopWorkflow(binding, dispatchId);
      if (result.receiptPending) {
        setNotice(uiText('流程已提交，投递回执暂未保存；请稍后核对。'));
        return;
      }
      const runKey = `ai-desktop:workflow-send:${binding.workspaceId}:${runIds.slice().sort().join(',')}`;
      writeDraftNow(`${runKey}:start`, null);
      writeDraftNow(`${runKey}:continue`, null);
      const submitKey = `ai-desktop:workflow-submit:${binding.workspaceId}:${objectId}`;
      const pending = JSON.parse(localStorage.getItem(submitKey) ?? 'null');
      if (runIds.includes(pending?.runId)) writeDraftNow(submitKey, null);
      setNotice(uiText('已确认流程投递。'));
      await reload();
    } finally {
      workflowSendActive.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function sendComment(threadId: string, expectedRevision: number) {
    const original = bindingRef.current;
    if (!original || busy || commentSendActive.current)
      throw new SendRejectedError('DESKTOP_BUSY', uiText('正在处理桌面操作，请稍后再提交。'));
    if (fileDirty || imageDirty || workflowDirtyRef.current)
      throw new SendRejectedError(
        'DRAFT_ACTIVE',
        uiText('请先保存当前文件或编辑草稿，再让 AI 处理。'),
      );
    const epoch = bridge.epoch();
    const check = () => {
      requireOpen();
      if (
        bindingRef.current?.panelInstanceId !== original.panelInstanceId ||
        bridge.epoch() !== epoch ||
        !bridge.visible()
      )
        throw new SendRejectedError(
          'SESSION_CHANGED',
          uiText('工作区或会话已切换，本次请求未发送。请回到原桌面重新操作。'),
        );
      if (!original.hostSessionRef || !original.messageRouteAvailable || !bridge.supportsSend())
        throw new SendRejectedError(
          'SEND_UNAVAILABLE',
          uiText('宿主尚未开放当前会话发送能力，评论已保留。'),
        );
    };
    const call = (payload: Record<string, unknown>) =>
      bridge.call('desktop_panel_action', {
        workspaceId: original.workspaceId,
        credential: original.credential,
        action: 'comments',
        payload,
      });
    commentSendActive.current = true;
    setBusy(true);
    setError('');
    let dispatchId: string | undefined,
      claimedRevision: number | undefined,
      hostAttempted = false;
    try {
      check();
      await flush();
      check();
      const prepared = await call({
        operation: 'prepare',
        threadId,
        expectedRevision,
        requestId: uid(),
      });
      dispatchId = prepared.dispatchId;
      check();
      const probe = await bridge.call('desktop_panel_action', {
        workspaceId: original.workspaceId,
        credential: original.credential,
        action: 'probe',
        payload: {},
      });
      check();
      if (!probe.messageRouteAvailable || probe.hostSessionRef !== original.hostSessionRef)
        throw new SendRejectedError('SESSION_CHANGED', uiText('当前会话路由已变化，评论未发送。'));
      const claimed = await call({
        operation: 'claim',
        threadId,
        dispatchId,
        expectedRevision: prepared.thread.revision,
        requestId: uid(),
      });
      if (!claimed.send)
        throw new Error(
          uiText('这次处理请求已提交或投递状态未知，不会重复发送。请查看评论中的最新状态。'),
        );
      claimedRevision = claimed.thread.revision;
      check();
      hostAttempted = true;
      await bridge.send(claimed.content);
      // The host can start reporting before this receipt arrives; the backend keeps that newer progress.
      try {
        await call({
          operation: 'delivery',
          threadId,
          dispatchId,
          expectedRevision: claimedRevision,
          requestId: uid(),
          outcome: 'sent',
        });
      } catch {
        setNotice(uiText('请求已提交，投递回执暂未保存。请等待评论回复，不要重复提交。'));
        return;
      }
      setNotice(uiText('已提交到当前 Codex 会话，进度、问题和结果会回到这条评论。'));
    } catch (error) {
      if (dispatchId && claimedRevision !== undefined) {
        await call({
          operation: 'delivery',
          threadId,
          dispatchId,
          expectedRevision: claimedRevision,
          requestId: uid(),
          outcome: error instanceof SendRejectedError ? 'failed' : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      }
      if (!hostAttempted && !(error instanceof SendRejectedError))
        throw new SendRejectedError(
          'COMMENT_NOT_SENT',
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    } finally {
      commentSendActive.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function recoverWorkflow(runId: string) {
    if (!binding || busy) return false;
    if (bridge.supportsSend()) return submitWorkflowRuns([runId], true);
    try {
      await flush();
      await reload();
      const prepared = await action('workflow', { operation: 'recover', runId, requestId: uid() });
      return await attachMaterials(undefined, prepared.objectIds, {}, prepared.run.id);
    } catch (e) {
      report(e);
      return false;
    }
  }
  async function submitWebTask(request: WebTaskRequestValue | string) {
    const original = bindingRef.current;
    if (!original || busy || webSending.current) return false;
    if (!bridge.supportsSend()) {
      setNotice(uiText('当前宿主未开放直接发送，Web 任务可以先保存在桌面。'));
      return false;
    }
    const key =
      typeof request === 'string'
        ? null
        : `ai-desktop:web-create:${original.workspaceId}:${request.pageId}`;
    webSending.current = true;
    setBusy(true);
    setError('');
    try {
      await flush();
      requireOpen();
      const check = () => {
        requireOpen();
        if (bindingRef.current?.panelInstanceId !== original.panelInstanceId)
          throw new SendRejectedError('SESSION_CHANGED', uiText('工作区或原会话已切换。'));
      };
      check();
      let taskId: string;
      if (typeof request === 'string') taskId = request;
      else {
        let pending = JSON.parse(localStorage.getItem(key!) ?? 'null');
        if (pending?.taskId) {
          const { tasks } = await action('web_task', { operation: 'list', pageId: request.pageId }),
            prior = tasks.find((task: any) => task.id === pending.taskId);
          if (prior?.reportedAt || prior?.delivery === 'sent') {
            writeDraftNow(key!, null);
            pending = null;
          }
        }
        if (pending && JSON.stringify(pending.request) !== JSON.stringify(request))
          throw Error(uiText('上一次 Web 任务尚未确认，请先在任务记录继续它，再提交不同要求。'));
        if (!pending) {
          pending = { request, requestId: uid() };
          writeDraftNow(key!, JSON.stringify(pending));
        }
        if (!pending.taskId) {
          const result = await action('web_task', {
            operation: 'create',
            requestId: pending.requestId,
            ...pending.request,
          });
          pending.taskId = result.task.id;
          writeDraftNow(key!, JSON.stringify(pending));
        }
        taskId = pending.taskId;
        await reload().catch(() => {});
        check();
      }
      const result = await sendWebTask({
        bridge,
        binding: original,
        taskId,
        continuing: typeof request === 'string',
        check,
      });
      if (key) writeDraftNow(key, null);
      setNotice(
        result.receiptPending
          ? uiText('Web 任务已提交，投递回执暂未保存；请查看原任务回报。')
          : uiText('Web 任务已提交原 Codex 会话，采集内容与进度会回到桌面。'),
      );
      return true;
    } catch (error) {
      if (
        key &&
        (error instanceof SendRejectedError ||
          (error instanceof PanelActionError &&
            !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code)))
      )
        writeDraftNow(key, null);
      report(error);
      return false;
    } finally {
      webSending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function attachRunRecovery(runId: string) {
    if (!binding || busy) return false;
    setBusy(true);
    setError('');
    try {
      const contextEpoch = bridge.contextEpoch();
      const result = await attachSelection(
        bridge,
        binding,
        async () => {},
        () => action('local_run_recover', { requestId: uid(), runId }),
      );
      requireOpen();
      if (result.mode === 'context') {
        if (bridge.contextEpoch() !== contextEpoch && bridge.contextState() !== undefined)
          reflectContext(bridge.contextState());
        else setAttached(result.selection);
      }
      setNotice(
        uiText(
          '已将原运行记录和回收授权附到原消息框。输入继续回收的要求后，Codex 会接着处理这次结果。',
        ),
      );
      await action('delivery', {
        snapshotId: result.selection.snapshotId,
        outcome: result.mode === 'context' ? 'attached' : 'draft',
      }).catch(() => setNotice(uiText('恢复材料已交给原消息框；本地回执暂未保存，请勿重复附加。')));
      setRunSelection(null);
      return true;
    } catch (e) {
      report(e);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function removeAttached() {
    if (!attached) return true;
    if (busy) return false;
    const current = attached;
    setBusy(true);
    try {
      await bridge.clearContext();
      requireOpen();
      setAttached(null);
      await action('cancel', { snapshotId: current.snapshotId });
      setNotice(uiText('已取消材料引用，聊天记录保留。'));
      return true;
    } catch (e) {
      report(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const removeAttachedRef = useRef(removeAttached);
  removeAttachedRef.current = removeAttached;
  return {
    attachMaterials,
    handoffWorkflow,
    deliverWorkflowRuns,
    submitWorkflowRuns,
    sendComment,
    recoverWorkflow,
    checkWorkflowDelivery,
    submitWebTask,
    attachRunRecovery,
    removeAttached,
    removeAttachedRef,
  };
}
