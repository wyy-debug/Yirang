import { useEffect, useRef } from 'react';
import type { MaterialRange } from '../../../packages/contracts/index.js';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { previewQuote, type PreviewQuote } from './use-file-ai-target.js';
import { isIntegratedDesktop } from '../workspace/workspace-mode.js';

export type VoiceSelectionTarget = {
  ids: string[];
  quote?: PreviewQuote;
  workspaceId?: string;
  ranges?: Record<string, MaterialRange>;
};
type Options = {
  workspaceId?: string;
  previewId?: string;
  selected: string[];
  ranges: Record<string, MaterialRange>;
  revision: (id: string) => number | undefined;
  prepare: (target: VoiceSelectionTarget, cancelled: () => boolean) => Promise<unknown[]>;
};

// Observe selections inside our desktop only. Focus changes in the surrounding
// composer must not replace a text quote with the entire file.
export function useVoiceSelection(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const navigation = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!isIntegratedDesktop) return;
    let owner: string | null = null,
      attempt = '',
      signature = '',
      timer: ReturnType<typeof setTimeout> | undefined,
      pendingUpdate: Promise<unknown> | undefined;
    let gesture: { x: number; y: number; blank: boolean } | null = null;
    const cancel = () => {
      attempt = '';
      clearTimeout(timer);
      timer = undefined;
      pendingUpdate = undefined;
      signature = '';
    };
    const send = (payload: Record<string, unknown>) => browserCommand('voice-selection', payload);
    const currentQuote = () => {
      const selection = window.getSelection(),
        active = document.activeElement;
      const anchor =
        active instanceof HTMLTextAreaElement && active.selectionEnd > active.selectionStart
          ? active
          : selection?.anchorNode instanceof Element
            ? selection.anchorNode
            : selection?.anchorNode?.parentElement;
      const node = anchor?.closest<HTMLElement>('[data-file-ai-object],.react-flow__node[data-id]');
      if (!node) return;
      const id = node.dataset.fileAiObject || node.dataset.id,
        quote = previewQuote(
          node,
          node.dataset.fileAiRevision
            ? Number(node.dataset.fileAiRevision)
            : latest.current.revision(id || ''),
        );
      if (id && quote)
        return {
          ids: [id],
          quote,
          workspaceId: latest.current.workspaceId,
          ranges: latest.current.ranges,
        };
    };
    const capture = (): VoiceSelectionTarget =>
      currentQuote() || {
        ids: latest.current.previewId ? [latest.current.previewId] : latest.current.selected,
        workspaceId: latest.current.workspaceId,
        ranges: latest.current.ranges,
      };
    const schedule = (target: VoiceSelectionTarget, force = false) => {
      if (!owner) return;
      const next = JSON.stringify(target);
      if (!force && signature === next) return;
      signature = next;
      const queued = timer !== undefined;
      clearTimeout(timer);
      const id = queued ? attempt : (attempt = crypto.randomUUID()),
        threadId = owner;
      const cancelled = () =>
        attempt !== id || owner !== threadId || target.workspaceId !== latest.current.workspaceId;
      // Invalidate before reading/saving anything so stale targets cannot be used.
      const pending = queued
        ? pendingUpdate!
        : (pendingUpdate = send({ threadId, id, phase: 'pending' }));
      void pending.catch(() => {});
      timer = setTimeout(async () => {
        timer = undefined;
        try {
          await pending;
          if (cancelled()) return;
          const blocks = target.ids.length ? await latest.current.prepare(target, cancelled) : [];
          if (cancelled()) return;
          await send({ threadId, id, phase: 'ready', blocks, snippet: target.quote?.text });
        } catch (error) {
          if (!cancelled()) {
            signature = '';
            void send({
              threadId,
              id,
              phase: 'error',
              error: String(error instanceof Error ? error.message : error),
            }).catch(() => {});
          }
        }
      }, 220);
    };
    const selectionChanged = () => {
      const target = currentQuote();
      if (target) schedule(target);
    };
    const pointerDown = (event: PointerEvent) => {
      gesture = null;
      if (!owner || event.button !== 0 || !(event.target instanceof Element)) return;
      if (
        event.target.closest(
          'button,input,select,[role="menu"],.desktop-preview-toolbar,.desktop-preview-header',
        )
      )
        return;
      const blank =
        !!event.target.closest('.react-flow__pane') && !event.target.closest('.react-flow__node');
      gesture = { x: event.clientX, y: event.clientY, blank };
      if (blank) schedule({ ids: [], workspaceId: latest.current.workspaceId }, true);
    };
    const pointerUp = (event: PointerEvent) => {
      if (!owner || event.button !== 0 || !(event.target instanceof Element)) return;
      if (
        event.target.closest(
          'button,input,select,[role="menu"],.desktop-preview-toolbar,.desktop-preview-header',
        )
      )
        return;
      const node = event.target.closest<HTMLElement>(
        '[data-file-ai-object],.react-flow__node[data-id]',
      );
      const id = node?.dataset.fileAiObject || node?.dataset.id;
      const blankClick =
        gesture?.blank && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5;
      if (blankClick) {
        schedule({ ids: [], workspaceId: latest.current.workspaceId }, true);
        return;
      }
      if (node || event.target.closest('.react-flow__pane'))
        requestAnimationFrame(() => {
          const quote = currentQuote();
          // React Flow can keep an old browser highlight while selecting a new
          // card. Only a quote inside the clicked card is still the active target.
          if (id && quote?.ids[0] === id) {
            schedule(quote);
            return;
          }
          const ids = id
            ? latest.current.selected.includes(id)
              ? latest.current.selected
              : [id]
            : latest.current.selected;
          schedule({ ids, workspaceId: latest.current.workspaceId, ranges: latest.current.ranges });
        });
    };
    const keyUp = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-file-ai-object],.react-flow') &&
        (event.key.startsWith('Arrow') || event.key === 'Escape')
      )
        schedule(capture());
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const value = event.data;
      if (value?.type === 'ai-desktop:voice-selection-mode') {
        cancel();
        owner = value.threadId || null;
        if (owner) {
          const target = capture();
          if (target.ids.length) schedule(target);
        }
      } else if (value?.type === 'ai-desktop:voice-selection-reset') {
        cancel();
        if (value.clear && owner)
          schedule({ ids: [], workspaceId: latest.current.workspaceId }, true);
      }
    };
    navigation.current = () => {
      if (owner) schedule(capture(), true);
    };
    window.addEventListener('message', receive);
    document.addEventListener('selectionchange', selectionChanged);
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('pointerup', pointerUp, true);
    document.addEventListener('keyup', keyUp);
    window.parent.postMessage({ type: 'ai-desktop:voice-selection-ready' }, '*');
    return () => {
      cancel();
      navigation.current = null;
      window.removeEventListener('message', receive);
      document.removeEventListener('selectionchange', selectionChanged);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('pointerup', pointerUp, true);
      document.removeEventListener('keyup', keyUp);
    };
  }, []);
  useEffect(() => {
    navigation.current?.();
  }, [options.previewId, options.workspaceId]);
}
