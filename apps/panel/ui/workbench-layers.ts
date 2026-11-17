import { useEffect, useRef, type RefObject } from 'react';

type Layer = {
  element: HTMLElement;
  kind: 'menu' | 'preview';
  close: () => void;
  focus?: HTMLElement | null;
};
const layers: Layer[] = [];
let questionOpen = false;
const visible = (node: HTMLElement) =>
  !node.closest('[hidden]') && node.getClientRects().length > 0;
function nativeModal() {
  return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(visible).at(-1);
}
function remove(layer: Layer) {
  const index = layers.indexOf(layer);
  if (index >= 0) layers.splice(index, 1);
}
function close(layer: Layer, restore = false) {
  remove(layer);
  layer.close();
  if (restore && layer.focus?.isConnected) layer.focus.focus({ preventScroll: true });
}
export function closeWorkbenchMenus() {
  for (const layer of [...layers]) if (layer.kind === 'menu') close(layer);
}

// One dismissal owner per document. Escape closes only the top layer; native
// dialogs retain their own focus trap and cancel behavior.
if (typeof document !== 'undefined') {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('.screenshot-ai-select, .screenshot-ai-composer')) return;
      const top = layers.filter((layer) => visible(layer.element)).at(-1),
        modal = nativeModal();
      if (
        !top ||
        (modal && !modal.contains(top.element)) ||
        (top.kind === 'preview' && questionOpen)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(top, true);
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      const top = layers.filter((layer) => layer.kind === 'menu' && visible(layer.element)).at(-1);
      if (top && !event.composedPath().includes(top.element)) close(top);
    },
    true,
  );
  window.addEventListener('yirang:navigation-committed', closeWorkbenchMenus);
  window.addEventListener('message', (event) => {
    if (event.source === window.parent && event.data?.type === 'ai-desktop:chat-layout')
      questionOpen = event.data.fileOpen === true;
  });
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'ai-desktop:panel-dismiss-for-ai')
      return;
    closeWorkbenchMenus();
    const modal = nativeModal();
    if (!modal) return;
    if (typeof modal.requestClose === 'function') modal.requestClose();
    else if (modal.dispatchEvent(new Event('cancel', { cancelable: true }))) modal.close();
  });
  let lastModal = false;
  const removal = new MutationObserver(() => publishModal());
  const publishModal = () => {
    const active = !!nativeModal();
    if (active === lastModal) return;
    lastModal = active;
    removal.disconnect();
    if (active) {
      closeWorkbenchMenus();
      removal.observe(document.body, { childList: true, subtree: true });
    }
    window.parent.postMessage({ type: 'ai-desktop:panel-modal', active }, '*');
  };
  document.addEventListener(
    'toggle',
    (event) => {
      if (!(event.target instanceof HTMLDialogElement)) return;
      publishModal();
    },
    true,
  );
}

export function useWorkbenchLayer(
  open: boolean,
  element: RefObject<HTMLElement | null>,
  dismiss: () => void,
  kind: Layer['kind'] = 'menu',
  focus?: RefObject<HTMLElement | null>,
) {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => {
    if (!open || !element.current) return;
    closeWorkbenchMenus();
    const layer: Layer = {
      element: element.current,
      kind,
      close: () => latest.current(),
      focus: focus?.current ?? (document.activeElement as HTMLElement | null),
    };
    layers.push(layer);
    return () => remove(layer);
  }, [open, element, kind, focus]);
}
