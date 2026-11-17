import { hasVisibleOverlay } from '../ui/visible-overlay.js';
import { subscribeUiLanguage } from '../../../packages/components/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useEffect, useRef } from 'react';
import {
  defaultFileAiShortcut,
  matchesFileAiShortcut,
  validFileAiShortcut,
  listenFileAiMouseShortcut,
} from '../../../packages/components/file-ai-shortcut.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';
import './file-ai-target.css';
import {
  previewSourceSelection,
  type PreviewSourceSpan,
} from '../documents/preview-source-selection.js';

export type PreviewQuote = {
  text: string;
  revision: number;
  start?: number;
  spans?: PreviewSourceSpan[];
};
type Options = {
  selected: () => string[];
  attachMany: (ids: string[], cancelled: () => boolean) => Promise<boolean>;
  available: boolean;
  workspaceId?: string;
  find: (id: string) => { title: string; revision?: number } | undefined;
  attach: (id: string, cancelled: () => boolean, quote?: PreviewQuote) => Promise<boolean>;
  attachWidget: (
    widget: { id: string; instanceId: string },
    cancelled: () => boolean,
  ) => Promise<boolean>;
  notice: (text: string) => void;
};
const blocksQuestion = () =>
  hasVisibleOverlay(
    'dialog[open],[data-desktop-overlay]:not([data-ai-surface]),[aria-modal="true"]:not(.desktop-preview-window)',
  );
export function previewQuote(node: HTMLElement, revision = Number(node.dataset.fileAiRevision)) {
  const active = document.activeElement;
  if (
    active instanceof HTMLTextAreaElement &&
    node.contains(active) &&
    active.selectionEnd > active.selectionStart
  )
    return { text: active.value.slice(active.selectionStart, active.selectionEnd), revision };
  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    !node.contains(selection.anchorNode) ||
    !node.contains(selection.focusNode)
  )
    return undefined;
  // Only document content is a quote, never the preview's title or toolbar.
  const anchor =
    selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode?.parentElement;
  if (
    anchor?.closest(
      '.desktop-preview-header,.desktop-preview-toolbar,.desktop-preview-keyboard,.material-caption,.full-view>header,.full-view>footer,button',
    )
  )
    return undefined;
  const text = selection.toString();
  if (!text.trim()) return undefined;
  const range = selection.getRangeAt(0),
    source = anchor?.closest('.desktop-preview-source');
  let start: number | undefined;
  if (source && source.contains(range.startContainer) && source.contains(range.endContainer)) {
    const before = range.cloneRange();
    before.selectNodeContents(source);
    before.setEnd(range.startContainer, range.startOffset);
    start = before.toString().length;
  }
  const spans = previewSourceSelection(node, range);
  return {
    text,
    revision,
    ...(start === undefined ? {} : { start }),
    ...(spans.length ? { spans } : {}),
  };
}
export function useFileAiTarget(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!isIntegratedDesktop) return;
    let armed = false,
      fileChatOpen = false,
      shortcut = defaultFileAiShortcut,
      highlight: Element | null = null;
    let candidate: {
      id: string;
      objectId: string;
      workspaceId?: string;
      cancelled?: boolean;
      quote?: PreviewQuote;
      objectIds?: string[];
      widget?: { id: string; instanceId: string };
    } | null = null;
    let swallowedTarget: Element | null = null,
      swallowUntil = 0;
    let selectedQuote: {
      node: HTMLElement;
      quote: PreviewQuote;
      workspaceId?: string;
      rect: DOMRect;
    } | null = null;
    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'file-ai-selection-button';
    ask.textContent = '问 AI';
    ask.hidden = true;
    ask.setAttribute('aria-label', '询问选中文字');
    document.body.append(ask);
    const halo = document.createElement('div'),
      hint = document.createElement('div');
    halo.className = 'file-ai-cursor';
    halo.hidden = true;
    halo.setAttribute('aria-hidden', 'true');
    hint.className = 'file-ai-target-hint';
    hint.hidden = true;
    hint.setAttribute('role', 'status');
    hint.textContent = uiText('点击文件、区域或小组件提问 · Esc 取消');
    document.body.append(halo, hint);
    const stopLanguage = subscribeUiLanguage(() => {
      hint.textContent = uiText('点击文件、区域或小组件提问 · Esc 取消');
    });
    const post = (value: Record<string, unknown>) => window.parent.postMessage(value, '*');
    const clearHighlight = () => {
      highlight?.classList.remove('file-ai-target');
      highlight = null;
    };
    let chosen: HTMLElement[] = [];
    const choose = (nodes: HTMLElement[]) => {
      for (const node of chosen) delete node.dataset.aiChosen;
      chosen = nodes;
      for (const node of nodes) node.dataset.aiChosen = 'true';
    };
    const setArmed = (value: boolean) => {
      if (value) (document.activeElement as HTMLElement)?.blur();
      armed = value;
      hint.hidden = !value;
      halo.hidden = true;
      document.documentElement.classList.toggle('file-ai-targeting', value);
      clearHighlight();
    };
    const targetFile = (node: HTMLElement, x: number, y: number, savedQuote?: PreviewQuote) => {
      const objectId = node.dataset.fileAiObject || node.dataset.id;
      if (candidate || !objectId || !latest.current.available) return false;
      const widget = node.dataset.appWidgetInstance
        ? { id: objectId, instanceId: node.dataset.appWidgetInstance }
        : undefined;
      const object = widget
        ? { title: node.dataset.appWidgetTitle || '小组件', revision: undefined }
        : latest.current.find(objectId);
      if (!object) return false;
      const quote =
        savedQuote ??
        previewQuote(
          node,
          node.dataset.fileAiRevision ? Number(node.dataset.fileAiRevision) : object.revision,
        );
      if (quote && quote.text.length > 24000) {
        latest.current.notice(uiText('选中文字过长，请缩小到 24000 字符以内再提问。'));
        return false;
      }
      candidate = {
        id: crypto.randomUUID(),
        objectId,
        workspaceId: latest.current.workspaceId,
        quote,
        widget,
      };
      const rect = node.getBoundingClientRect();
      ask.hidden = true;
      setArmed(false);
      choose([node]);
      post({
        type: 'ai-desktop:file-ai-target',
        id: candidate.id,
        objectId,
        workspaceId: candidate.workspaceId,
        title: quote ? uiText('{0} · 选中文本', { '0': object.title }) : object.title,
        anchor: { x, y, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      });
      return true;
    };
    const askSelected = () => {
      const ids = latest.current.selected().filter((id) => !!latest.current.find(id));
      if (!ids.length) return false;
      if (ids.length > 10) {
        latest.current.notice('一次最多询问 10 份材料，请缩小选区。');
        return true;
      }
      const nodes = ids
        .map((id) =>
          document.querySelector<HTMLElement>(
            '.react-flow__node[data-id="' + CSS.escape(id) + '"]',
          ),
        )
        .filter((n): n is HTMLElement => !!n);
      if (!nodes.length) return false;
      if (ids.length === 1) {
        const r = nodes[0].getBoundingClientRect();
        return targetFile(nodes[0], Math.min(innerWidth - 24, r.right), Math.max(24, r.top));
      }
      if (candidate || !latest.current.available) return true;
      const rects = nodes.map((n) => n.getBoundingClientRect()),
        left = Math.max(0, Math.min(...rects.map((r) => r.left))),
        right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right))),
        top = Math.max(0, Math.min(...rects.map((r) => r.top))),
        bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)));
      candidate = {
        id: crypto.randomUUID(),
        objectId: ids[0],
        objectIds: ids,
        workspaceId: latest.current.workspaceId,
      };
      setArmed(false);
      choose(nodes);
      post({
        type: 'ai-desktop:file-ai-target',
        id: candidate.id,
        title: '已选 ' + ids.length + ' 份材料',
        anchor: { x: right, y: top, left, right, top, bottom },
      });
      return true;
    };
    const captureSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const element =
        selection.anchorNode instanceof Element
          ? selection.anchorNode
          : selection.anchorNode?.parentElement;
      const node = element?.closest<HTMLElement>(
        '[data-file-ai-object],.react-flow__node[data-id]',
      );
      if (!node) {
        selectedQuote = null;
        ask.hidden = true;
        return;
      }
      const object = latest.current.find(node.dataset.fileAiObject || node.dataset.id || '');
      const quote = object
        ? previewQuote(
            node,
            node.dataset.fileAiRevision ? Number(node.dataset.fileAiRevision) : object.revision,
          )
        : undefined;
      if (!quote) {
        selectedQuote = null;
        ask.hidden = true;
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      selectedQuote = { node, quote, rect, workspaceId: latest.current.workspaceId };
      ask.hidden = !latest.current.available || fileChatOpen;
      ask.style.left = Math.max(8, Math.min(window.innerWidth - 90, rect.right - 70)) + 'px';
      ask.style.top = Math.max(8, Math.min(window.innerHeight - 44, rect.bottom + 8)) + 'px';
    };
    const askSelection = () => {
      const saved = selectedQuote;
      if (!saved || !saved.node.isConnected || saved.workspaceId !== latest.current.workspaceId)
        return false;
      return targetFile(saved.node, saved.rect.right, saved.rect.bottom, saved.quote);
    };
    const selectionPointerDown = (event: PointerEvent) => {
      if (event.target === ask) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if ((event.target as Element)?.closest?.('button,[role="button"]')) return;
      selectedQuote = null;
      ask.hidden = true;
    };
    const selectionClick = () => {
      if (!askSelection()) latest.current.notice(uiText('请重新选中文字后提问。'));
    };
    document.addEventListener('selectionchange', captureSelection);
    document.addEventListener('pointerdown', selectionPointerDown, true);
    ask.addEventListener('click', selectionClick);
    const askRegion = (event: Event) => {
      const node = (event as CustomEvent).detail?.node;
      if (!(node instanceof HTMLElement)) return;
      const rect = node.getBoundingClientRect();
      if (!targetFile(node, rect.right, rect.bottom))
        latest.current.notice(uiText('当前暂不能提问，请完成当前操作后重试。'));
    };
    window.addEventListener('ai-desktop:ask-region', askRegion);
    const cancelTargeting = () => {
      setArmed(false);
      post({ type: 'ai-desktop:file-ai-cancel' });
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (matchesFileAiShortcut(event, shortcut)) {
        if (blocksQuestion()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        if (!latest.current.available) {
          latest.current.notice(uiText('正在保存当前修改，请稍后再问 AI。'));
          return;
        }
        post({ type: 'ai-desktop:file-ai-toggle' });
      } else if (event.key === 'Escape' && armed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setArmed(false);
        post({ type: 'ai-desktop:file-ai-cancel' });
      } else if (event.key === 'Escape' && fileChatOpen && !blocksQuestion()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) post({ type: 'ai-desktop:file-ai-close' });
      }
    };
    const hit = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const direct = element?.closest<HTMLElement>(
        '[data-file-ai-object],.react-flow__node[data-id]',
      );
      if (direct) return direct;
      if (!element?.closest('.react-flow,.canvas-regions-handles,.canvas-regions-background'))
        return null;
      return (
        [...document.querySelectorAll<HTMLElement>('.canvas-region-fill[data-file-ai-object]')]
          .map((node) => ({ node, rect: node.getBoundingClientRect() }))
          .filter(
            ({ rect: r }) =>
              event.clientX >= r.left &&
              event.clientX <= r.right &&
              event.clientY >= r.top &&
              event.clientY <= r.bottom,
          )
          .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.node ??
        null
      );
    };
    const move = (event: PointerEvent) => {
      if (!armed) return;
      halo.hidden = false;
      halo.style.transform = `translate3d(${event.clientX}px,${event.clientY}px,0)`;
      const target = hit(event);
      if (target !== highlight) {
        clearHighlight();
        highlight = target;
        highlight?.classList.add('file-ai-target');
      }
    };
    const down = (event: PointerEvent) => {
      if (event.button === 3 || event.button === 4) return;
      if (!armed) return;
      if (event.button !== 0) {
        setArmed(false);
        post({ type: 'ai-desktop:file-ai-cancel' });
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const node = hit(event);
      if (
        !node ||
        target?.closest(
          'button,a,input,textarea,select,[role="button"],dialog,[data-desktop-overlay]',
        ) ||
        !latest.current.available
      ) {
        cancelTargeting();
        return;
      }
      if (!targetFile(node, event.clientX, event.clientY)) {
        cancelTargeting();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      swallowedTarget = target;
      swallowUntil = Date.now() + 500;
    };
    // Swallow the click following a targeting pointerdown so it cannot open an editor.
    const click = (event: MouseEvent) => {
      const target = swallowedTarget;
      swallowedTarget = null;
      if (!target || Date.now() > swallowUntil || event.target !== target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const receive = async (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const value = event.data;
      if (value?.type === 'ai-desktop:chat-layout') {
        const wasOpen = fileChatOpen;
        fileChatOpen = value.fileOpen === true;
        if (fileChatOpen) ask.hidden = true;
        else if (wasOpen) choose([]);
        return;
      }
      if (value?.type === 'ai-desktop:file-ai-config' && validFileAiShortcut(value.shortcut))
        shortcut = value.shortcut;
      if (value?.type === 'ai-desktop:file-ai-mode') {
        if (value.active && !latest.current.available) {
          post({ type: 'ai-desktop:file-ai-cancel' });
          latest.current.notice(uiText('正在保存当前修改，请稍后再问 AI。'));
          return;
        }
        if (value.active) {
          if (askSelection()) return;
          const preview = document.querySelector<HTMLElement>(
            '.desktop-preview-window[data-file-ai-object]',
          );
          if (preview) {
            const selection = window.getSelection(),
              range =
                selection?.rangeCount &&
                !selection.isCollapsed &&
                preview.contains(selection.anchorNode)
                  ? selection.getRangeAt(0).getBoundingClientRect()
                  : null;
            const rect = preview.getBoundingClientRect();
            if (
              !targetFile(
                preview,
                range?.width ? range.right : rect.right - 24,
                range?.height ? range.bottom : rect.top + 80,
              )
            )
              cancelTargeting();
            return;
          }
          if (blocksQuestion()) {
            cancelTargeting();
            return;
          }
          if (askSelected()) return;
        }
        setArmed(value.active === true);
      }
      if (value?.type === 'ai-desktop:file-ai-dismiss' && candidate?.id === value.id) {
        candidate!.cancelled = true;
        setArmed(false);
        choose([]);
        return;
      }
      if (value?.type === 'ai-desktop:file-ai-rejected') {
        if (candidate?.id === value.id) {
          candidate!.cancelled = true;
          candidate = null;
          choose([]);
        }
        return;
      }
      if (value?.type !== 'ai-desktop:file-ai-prepare' || !candidate || candidate.id !== value.id)
        return;
      const request = candidate;
      let ok = false;
      try {
        if (
          !request.cancelled &&
          request.workspaceId === latest.current.workspaceId &&
          latest.current.available
        )
          ok = request.objectIds
            ? await latest.current.attachMany(request.objectIds, () => !!request.cancelled)
            : request.widget
              ? await latest.current.attachWidget(request.widget, () => !!request.cancelled)
              : await latest.current.attach(
                  request.objectId,
                  () => !!request.cancelled,
                  request.quote,
                );
      } catch {
        latest.current.notice(uiText('材料引用失败，请重新点击文件重试。'));
      }
      post({ type: 'ai-desktop:file-ai-result', id: request.id, ok });
      candidate = null;
      if (!ok) choose([]);
    };
    const leave = () => {
      halo.hidden = true;
      clearHighlight();
    };
    const blur = () => {
      if (armed) {
        setArmed(false);
        post({ type: 'ai-desktop:file-ai-cancel' });
      }
    };
    const stopMouse = listenFileAiMouseShortcut(
      () => shortcut,
      () => blocksQuestion(),
      () => {
        if (!latest.current.available) {
          latest.current.notice(uiText('正在保存当前修改，请稍后再问 AI。'));
          return;
        }
        post({ type: 'ai-desktop:file-ai-toggle' });
      },
    );
    window.addEventListener('keydown', key, true);
    window.addEventListener('message', receive);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('click', click, true);
    document.documentElement.addEventListener('pointerleave', leave);
    window.addEventListener('blur', blur);
    post({ type: 'ai-desktop:file-ai-config-request' });
    return () => {
      choose([]);
      document.removeEventListener('selectionchange', captureSelection);
      document.removeEventListener('pointerdown', selectionPointerDown, true);
      ask.remove();
      window.removeEventListener('ai-desktop:ask-region', askRegion);
      stopLanguage();
      stopMouse();
      setArmed(false);
      halo.remove();
      hint.remove();
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('message', receive);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('click', click, true);
      document.documentElement.removeEventListener('pointerleave', leave);
      window.removeEventListener('blur', blur);
    };
  }, []);
}
