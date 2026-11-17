import { t as uiText } from '../../packages/components/ui-language.js';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import type { ModelBlock, PanelBinding } from '../../packages/contracts/index.js';
import { DESKTOP_VERSION } from '../../packages/contracts/version.js';

export class PanelActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}：${message}`);
    this.name = 'PanelActionError';
  }
}
export class PanelClosedError extends Error {
  constructor() {
    super(uiText('面板实例已切换，已停止旧面板后续操作。'));
  }
}
/** A local preflight failure or an explicit host rejection; never retried here. */
export class SendRejectedError extends Error {
  readonly outcome = 'rejected' as const;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SendRejectedError';
  }
}
/** A transport failure is not evidence that the host did not send the message. */
export class SendDeliveryUnknownError extends Error {
  readonly outcome = 'unknown' as const;
  constructor(readonly originalError: unknown) {
    super(uiText('宿主未确认请求是否已发送，投递结果未知；请查看原会话，不会自动重复发送。'));
    this.name = 'SendDeliveryUnknownError';
  }
}
export type LocalConnection = 'connecting' | 'ready' | 'unavailable' | 'reopen';
export function connectionAfterError(error: unknown): LocalConnection {
  if (!(error instanceof PanelActionError)) return 'unavailable';
  return [
    'PERMISSION_DENIED',
    'SESSION_MISMATCH',
    'PERMISSION_REVOKED',
    'WORKSPACE_SWITCHED',
    'TASK_CANCELLED',
  ].includes(error.code)
    ? 'reopen'
    : 'ready';
}

export type AttachedSelection = {
  workspaceId: string;
  snapshotId: string;
  objects: { id: string; title: string; revision: number }[];
  runRecovery?: { runId: string };
};
export type ContextState =
  | { updateId: string; selection: AttachedSelection | null }
  | null
  | undefined;
export interface Bridge {
  call(name: string, args: Record<string, unknown>): Promise<any>;
  attach(
    content: ModelBlock[],
    selection: AttachedSelection,
  ): Promise<{ mode: 'context' | 'draft'; updateId?: string }>;
  supportsImages(): boolean;
  supportsAttachments(): boolean;
  supportsSend(): boolean;
  supportsSendImages(): boolean;
  send(content: ModelBlock[]): Promise<void>;
  onInitial(handler: (value: any) => void): void;
  connect(): Promise<void>;
  epoch(): number;
  visible(): boolean;
}
export class McpBridge implements Bridge {
  readonly app = new App({ name: 'Yirang', version: DESKTOP_VERSION });
  readonly extensions = new OpenAIExtensions(this.app);
  private generation = 0;
  private contextGeneration = 0;
  private contextListeners = new Set<(state: ContextState) => void>();
  rebind() {
    this.generation++;
  }
  constructor() {
    document.addEventListener('visibilitychange', () => {
      this.generation++;
    });
    this.app.addEventListener('hostcontextchanged', (context) => {
      this.generation++;
      if (Object.prototype.hasOwnProperty.call(context, 'openai/modelContext')) {
        this.contextGeneration++;
        for (const listener of this.contextListeners) listener(this.contextState());
      }
      if (context.theme) applyDocumentTheme(context.theme);
      if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
    });
  }
  onInitial(handler: (value: any) => void) {
    this.app.ontoolresult = (result) => {
      const value = result._meta?.desktop;
      if (value?.binding || value?.needsWorkspaceChoice) {
        this.rebind();
        handler(value);
      }
    };
  }
  async connect() {
    if (window.parent === window)
      throw new Error(uiText('请从 Codex 的工作桌面插件入口打开。此文件需要宿主桥接。'));
    await this.app.connect();
    const context = this.app.getHostContext();
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  }
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.app.callServerTool({ name, arguments: args });
    if (result.isError) {
      const error = (result.structuredContent as any)?.error;
      throw new PanelActionError(
        error?.code ?? 'LOCAL_ERROR',
        error?.message ?? uiText('本地操作失败'),
      );
    }
    return result._meta?.desktop ?? result.structuredContent;
  }
  supportsContext() {
    return !!this.app.getHostCapabilities()?.updateModelContext?.text;
  }
  async openWebUrl(value: string) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error(uiText('请使用不含账号密码的 HTTP(S) 网页地址。'));
    if (!this.visible()) throw new Error(uiText('请在可见的工作桌面中打开网页。'));
    if (!this.app.getHostCapabilities()?.openLinks)
      throw new Error(uiText('当前宿主未开放网页打开接口；可以复制地址，在浏览器中打开。'));
    const result = await this.app.openLink({ url: url.href });
    if (result.isError) throw new Error(uiText('宿主未能打开此网页，请复制地址后手动打开。'));
  }
  supportsAttachments() {
    return (
      this.supportsContext() ||
      (!!this.extensions.message && !!this.app.getHostCapabilities()?.message?.text)
    );
  }
  supportsImages() {
    return this.supportsContext()
      ? !!this.app.getHostCapabilities()?.updateModelContext?.image
      : !!this.extensions.message && !!this.app.getHostCapabilities()?.message?.image;
  }
  // Updating model context only attaches material; it does not authorize message delivery.
  supportsSend() {
    return !!this.extensions.message && !!this.app.getHostCapabilities()?.message?.text;
  }
  supportsSendImages() {
    return this.supportsSend() && !!this.app.getHostCapabilities()?.message?.image;
  }
  /** Caller owns preparation, route checks, one-time delivery claim and outcome recording. */
  async send(content: ModelBlock[]): Promise<void> {
    const message = this.extensions.message;
    if (!this.supportsSend() || !message)
      throw new SendRejectedError(
        'SEND_UNSUPPORTED',
        uiText('当前宿主未提供评论发送接口，请在 Codex 中重新打开工作桌面。'),
      );
    if (!this.visible())
      throw new SendRejectedError(
        'PANEL_NOT_VISIBLE',
        uiText('面板已切换，本次评论未发送；请回到原工作桌面。'),
      );
    if (!content.length)
      throw new SendRejectedError('EMPTY_MESSAGE', uiText('评论内容为空，本次未发送。'));
    if (content.some((block) => block.type === 'image') && !this.supportsSendImages())
      throw new SendRejectedError(
        'SEND_IMAGES_UNSUPPORTED',
        uiText('宿主暂不支持发送图片材料，本次评论未发送；原图仍保留在桌面。'),
      );
    let result: Awaited<ReturnType<typeof message.send>>;
    try {
      // A single explicit send, with no context update, draft fallback or retry.
      result = await message.send({
        role: 'user',
        content,
        _meta: { 'openai/message': { target: 'active', send: true } },
      });
    } catch (error) {
      throw new SendDeliveryUnknownError(error);
    }
    if (result.isError)
      throw new SendRejectedError(
        'HOST_REJECTED',
        uiText('宿主拒绝了本次请求发送；不会自动重复发送。'),
      );
    // This acknowledges delivery only, not execution, completion or an AI response.
  }
  hostName() {
    return this.app.getHostVersion()?.name ?? uiText('宿主');
  }
  connectionMessage(binding: PanelBinding | null) {
    if (!binding) return uiText('正在连接 Codex');
    if (!binding.messageRouteAvailable)
      return this.hostName().includes('Harness')
        ? uiText('界面预览 · 引用材料需在 Codex 内打开工作桌面')
        : uiText('请在 Codex 中重新打开工作桌面');
    if (!this.supportsAttachments()) return uiText('宿主暂未提供材料引用接口');
    return uiText('仅引用所选内容');
  }
  contextState(): ContextState {
    const current = this.extensions.modelContext?.getCurrent();
    if (current === undefined || current === null) return current;
    const raw = current.content?.find((b) => b._meta?.['ai-desktop/selection'])?._meta?.[
      'ai-desktop/selection'
    ] as AttachedSelection | undefined;
    const selection =
      raw &&
      typeof raw.workspaceId === 'string' &&
      typeof raw.snapshotId === 'string' &&
      Array.isArray(raw.objects) &&
      raw.objects.every(
        (o) =>
          typeof o?.id === 'string' &&
          typeof o?.title === 'string' &&
          Number.isInteger(o?.revision),
      ) &&
      (!raw.runRecovery || typeof raw.runRecovery.runId === 'string')
        ? raw
        : null;
    return { updateId: current.updateId, selection };
  }
  onContext(handler: (state: ContextState) => void) {
    this.contextListeners.add(handler);
    return () => {
      this.contextListeners.delete(handler);
    };
  }
  contextEpoch() {
    return this.contextGeneration;
  }
  async attach(content: ModelBlock[], selection: AttachedSelection) {
    if (!this.supportsAttachments())
      throw new Error(uiText('当前宿主未提供材料引用接口，请在原生工作桌面中操作。'));
    const title =
      selection.objects.length === 1
        ? selection.objects[0].title
        : uiText('工作桌面 · {0} 份材料', { '0': selection.objects.length });
    const titled = content.map((block, index) => ({
      ...block,
      _meta: {
        'openai/title': index === 0 ? title : uiText('{0} · 图片 {1}', { '0': title, '1': index }),
        ...(index === 0 ? { 'ai-desktop/selection': selection } : {}),
      },
    }));
    if (this.supportsContext()) {
      const result = await this.app.updateModelContext({ content: titled });
      const metadata = result._meta?.['openai/modelContext'] as { updateId?: string } | undefined;
      return { mode: 'context' as const, updateId: metadata?.updateId };
    }
    // Compatibility path only appends a labeled attachment to the native draft.
    // It never submits a message or writes a separate instruction.
    const result = await this.extensions.message!.send({
      role: 'user',
      content: titled,
      _meta: { 'openai/message': { target: 'active', send: false } },
    });
    if (result.isError) throw new Error(uiText('宿主未确认接收材料，请检查原消息框。'));
    return { mode: 'draft' as const };
  }
  async clearContext() {
    if (!this.supportsContext()) throw new Error(uiText('请在 Codex 原消息框中移除材料附件。'));
    await this.app.updateModelContext({ content: [] });
  }
  epoch() {
    return this.generation;
  }
  visible() {
    return document.visibilityState === 'visible';
  }
}
/** No host context mutation occurs before all async steps and route checks finish. */
export async function attachSelection(
  bridge: Bridge,
  binding: PanelBinding,
  flush: () => Promise<void>,
  prepare: () => Promise<{
    content: ModelBlock[];
    snapshotId: string;
    objects: AttachedSelection['objects'];
    runRecovery?: AttachedSelection['runRecovery'];
  }>,
) {
  const epoch = bridge.epoch();
  const check = () => {
    if (!binding.messageRouteAvailable || !binding.hostSessionRef || !bridge.supportsAttachments())
      throw new Error(uiText('请在原生工作桌面中引用材料，然后在 Codex 原消息框输入要求。'));
    if (bridge.epoch() !== epoch || !bridge.visible())
      throw new Error(uiText('面板或会话已切换；请回到原面板重新选择材料。'));
  };
  check();
  await flush();
  check();
  const prepared = await prepare();
  let handedOff = false;
  try {
    check();
    if (prepared.content.some((b) => b.type === 'image') && !bridge.supportsImages())
      throw new Error(uiText('宿主暂不支持图片材料引用，请先移除图片；原图仍保留在桌面。'));
    const probe = await bridge.call('desktop_panel_action', {
      workspaceId: binding.workspaceId,
      credential: binding.credential,
      action: 'probe',
      payload: {},
    });
    check();
    if (!probe.messageRouteAvailable || probe.hostSessionRef !== binding.hostSessionRef)
      throw new Error(uiText('材料引用通道已变化，请重新打开工作桌面。'));
    const selection = {
      workspaceId: binding.workspaceId,
      snapshotId: prepared.snapshotId,
      objects: prepared.objects,
      ...(prepared.runRecovery ? { runRecovery: prepared.runRecovery } : {}),
    };
    handedOff = true;
    const result = await bridge.attach(prepared.content, selection);
    return { ...result, selection };
  } catch (e) {
    await bridge
      .call('desktop_panel_action', {
        workspaceId: binding.workspaceId,
        credential: binding.credential,
        action: handedOff ? 'delivery' : 'cancel',
        payload: { snapshotId: prepared.snapshotId, ...(handedOff ? { outcome: 'unknown' } : {}) },
      })
      .catch(() => {});
    if (handedOff)
      throw new Error(
        uiText('材料引用结果未知，请查看原消息框；不会自动重复附加。{0}', { '0': String(e) }),
      );
    throw e;
  }
}
