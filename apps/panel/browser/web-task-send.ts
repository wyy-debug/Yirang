import { t as uiText } from '../../../packages/components/ui-language.js';
import { McpBridge, PanelActionError, SendRejectedError } from '../host.js';
import type { PanelBinding } from '../../../packages/contracts/index.js';
import { writeDraftNow } from '../documents/draft-storage.js';

export async function sendWebTask({
  bridge,
  binding,
  taskId,
  continuing = false,
  check,
}: {
  bridge: McpBridge;
  binding: PanelBinding;
  taskId: string;
  continuing?: boolean;
  check: () => void;
}) {
  const key = `ai-desktop:web-send:${binding.workspaceId}:${taskId}:${continuing ? 'continue' : 'start'}`,
    epoch = bridge.epoch();
  const route = () => {
    check();
    if (bridge.epoch() !== epoch || !bridge.visible())
      throw new SendRejectedError('SESSION_CHANGED', uiText('Web 工作区或原会话已切换。'));
    if (!binding.messageRouteAvailable || !binding.hostSessionRef || !bridge.supportsSend())
      throw new SendRejectedError(
        'SEND_UNAVAILABLE',
        uiText('当前宿主未开放发送能力，任务已保留。'),
      );
  };
  const call = (payload: Record<string, unknown>) =>
    bridge.call('desktop_panel_action', {
      workspaceId: binding.workspaceId,
      credential: binding.credential,
      action: 'web_task',
      payload,
    });
  route();
  let receipt: {
    requestId: string;
    createdAt: string;
    dispatchId?: string;
    sent?: boolean;
  } | null = JSON.parse(localStorage.getItem(key) ?? 'null');
  if (receipt) {
    const { tasks } = await call({ operation: 'list' }),
      task = tasks.find((item: any) => item.id === taskId);
    route();
    if (receipt.sent && receipt.dispatchId) {
      await call({
        operation: 'delivery',
        requestId: `${receipt.requestId}:delivery`,
        taskId,
        dispatchId: receipt.dispatchId,
        outcome: 'sent',
      }).catch(() => {});
      writeDraftNow(key, null);
      return { sent: true, receiptPending: false };
    }
    if (task?.reportedAt && task.reportedAt > receipt.createdAt) {
      writeDraftNow(key, null);
      if (!continuing) return { sent: true, receiptPending: false };
      receipt = null;
    }
  }
  if (!receipt) {
    receipt = { requestId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    writeDraftNow(key, JSON.stringify(receipt));
  }
  let attempted = false,
    claimedDelivery = false;
  try {
    const prepared = await call({
      operation: 'prepare',
      requestId: receipt.requestId,
      taskId,
      continuing,
    });
    receipt.dispatchId = prepared.dispatchId;
    writeDraftNow(key, JSON.stringify(receipt));
    route();
    const probe = await bridge.call('desktop_panel_action', {
      workspaceId: binding.workspaceId,
      credential: binding.credential,
      action: 'probe',
      payload: {},
    });
    route();
    if (!probe.messageRouteAvailable || probe.hostSessionRef !== binding.hostSessionRef)
      throw new SendRejectedError('SESSION_CHANGED', uiText('Web 任务的原会话路由已变化。'));
    const claimed = await call({
      operation: 'claim',
      requestId: `${receipt.requestId}:claim`,
      taskId,
      dispatchId: prepared.dispatchId,
    });
    if (!claimed.send)
      throw Error(uiText('这次任务已领取或发送，结果未知时不会重复提交；请查看任务记录。'));
    claimedDelivery = true;
    route();
    attempted = true;
    await bridge.send(claimed.content);
    receipt.sent = true;
    try {
      writeDraftNow(key, JSON.stringify(receipt));
    } catch {
      /* Delivery is already known; still persist the server receipt. */
    }
    try {
      await call({
        operation: 'delivery',
        requestId: `${receipt.requestId}:delivery`,
        taskId,
        dispatchId: prepared.dispatchId,
        outcome: 'sent',
      });
      writeDraftNow(key, null);
      return { sent: true, receiptPending: false };
    } catch {
      return { sent: true, receiptPending: true };
    }
  } catch (error) {
    if (receipt.dispatchId && claimedDelivery)
      await call({
        operation: 'delivery',
        requestId: `${receipt.requestId}:delivery`,
        taskId,
        dispatchId: receipt.dispatchId,
        outcome: !attempted || error instanceof SendRejectedError ? 'failed' : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    if (
      error instanceof SendRejectedError ||
      (error instanceof PanelActionError &&
        !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code))
    )
      writeDraftNow(key, null);
    throw error;
  }
}
