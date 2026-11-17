// Kept-alive app pages remain in the DOM; only visible overlays block canvas input.
export function hasVisibleOverlay(selector = 'dialog[open],[data-desktop-overlay]') {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).some((node) => {
    if (node.closest('[hidden]')) return false;
    if (node instanceof HTMLDialogElement && !node.open) return false;
    if (typeof node.checkVisibility === 'function')
      return node.checkVisibility({ checkVisibilityCSS: true });
    return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  });
}
