import { t as uiText } from '../../../packages/components/ui-language.js';
import { McpBridge, SendRejectedError, PanelActionError } from '../host.js';
import type { PanelBinding } from '../../../packages/contracts/index.js';
import { writeDraftNow } from '../documents/draft-storage.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import { browserCommand } from '../browser/electron-browser-bridge.js';

export async function deliverDesktopWorkflow(binding: PanelBinding, dispatchId: string) {
  const result = await browserCommand<{ sent: boolean; receiptPending: boolean; failed?: boolean }>(
    'workflow-delivery',
    { workspaceId: binding.workspaceId, credential: binding.credential, dispatchId },
    180000,
  );
  if (result.failed)
    throw new SendRejectedError('WORKFLOW_DELIVERY_FAILED', uiText('流程未发送，可从原运行重试。'));
  return result;
}

export function acknowledgeWorkflowRequests(
  workspaceId: string,
  objectId: string,
  runs: { id: string; reportedAt?: string; createdAt: string }[],
  delivered: { runIds: string[]; claimedAt?: string; createdAt: string; state: string }[] = [],
) {
  const acknowledged = (runId: string, since: string) =>
    delivered.some((record) =>
      record.state === 'sent' && record.runIds.includes(runId) &&
      (record.claimedAt ?? record.createdAt) >= since,
    ) ||
    runs.some((run) => run.id === runId && !!run.reportedAt && run.reportedAt > since);
  const submitKey = `ai-desktop:workflow-submit:${workspaceId}:${objectId}`;
  try {
    const pending = JSON.parse(localStorage.getItem(submitKey) ?? 'null'),
      run = runs.find((item) => item.id === pending?.runId);
    if (run && acknowledged(run.id, pending.createdAt ?? run.createdAt))
      writeDraftNow(submitKey, null);
    const prefix = `ai-desktop:workflow-send:${workspaceId}:`,
      keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
        (key): key is string => !!key && key.startsWith(prefix),
      );
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw?.startsWith('{')) continue;
      const receipt = JSON.parse(raw),
        ids = key
          .slice(prefix.length)
          .replace(/:(start|continue)$/, '')
          .split(',');
      if (
        typeof receipt.createdAt === 'string' &&
        ids.every((id) => acknowledged(id, receipt.createdAt))
      )
        writeDraftNow(key, null);
    }
  } catch {
    /* Keep uncertain delivery records when storage is unavailable. */
  }
}

export async function sendWorkflowRuns(options: {
  bridge: McpBridge;
  binding: PanelBinding;
  runIds: string[];
  requestId: string;
  continuing?: boolean;
  check: () => void;
}) {
  const { bridge, binding, check } = options,
    epoch = bridge.epoch();
  const route = () => {
    check();
    if (bridge.epoch() !== epoch || !bridge.visible())
      throw new SendRejectedError('SESSION_CHANGED', uiText('会话已变化，流程未重复发送。'));
    if (!binding.messageRouteAvailable || !binding.hostSessionRef || !bridge.supportsSend())
      throw new SendRejectedError(
        'SEND_UNAVAILABLE',
        uiText('当前宿主没有直接发送能力，请在原生 Codex 桌面中运行。'),
      );
  };
  const call = (payload: Record<string, unknown>) =>
    bridge.call('desktop_panel_action', {
      workspaceId: binding.workspaceId,
      credential: binding.credential,
      action: 'workflow_dispatch',
      payload,
    });
  route();
  const prepared = await call({
    operation: 'prepare',
    requestId: options.requestId,
    runIds: options.runIds,
    continuing: !!options.continuing,
  });
  if (isIntegratedDesktop && bridge.hostName() === 'Yirang') {
    route();
    return deliverDesktopWorkflow(binding, prepared.dispatchId);
  }
  let claimed: any;
  try {
    route();
    const probe = await bridge.call('desktop_panel_action', {
      workspaceId: binding.workspaceId,
      credential: binding.credential,
      action: 'probe',
      payload: {},
    });
    route();
    if (!probe.messageRouteAvailable || probe.hostSessionRef !== binding.hostSessionRef)
      throw new SendRejectedError(
        'SESSION_CHANGED',
        uiText('流程投递路由已变化，请回到原工作桌面。'),
      );
    claimed = await call({
      operation: 'claim',
      requestId: `${options.requestId}:claim`,
      dispatchId: prepared.dispatchId,
    });
  } catch (error) {
    if (
      error instanceof SendRejectedError ||
      (error instanceof PanelActionError &&
        !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code))
    )
      await call({
        operation: 'discard',
        requestId: `options-discard-${options.requestId}`,
        dispatchId: prepared.dispatchId,
      }).catch(() => {});
    throw error;
  }
  if (!claimed.send)
    throw new Error(uiText('本次流程已领取或发送，响应尚未确认时不会重复提交。请查看运行记录。'));
  try {
    route();
    await bridge.send(claimed.content);
  } catch (error) {
    await call({
      operation: 'delivery',
      requestId: `${options.requestId}:outcome`,
      dispatchId: prepared.dispatchId,
      outcome: error instanceof SendRejectedError ? 'failed' : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
  try {
    await call({
      operation: 'delivery',
      requestId: `${options.requestId}:outcome`,
      dispatchId: prepared.dispatchId,
      outcome: 'sent',
    });
  } catch {
    return { sent: true, receiptPending: true };
  }
  return { sent: true, receiptPending: false };
}
