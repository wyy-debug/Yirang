import { t, subscribeUiLanguage } from '../../../packages/components/ui-language.js';

// Keep the existing select as the value owner, including its change handlers.
// The popover lives in the top layer so narrow chat surfaces cannot clip it.
export function compactSelect(
  select,
  { label, description = () => '', placement = 'bottom' } = {},
) {
  const trigger = document.createElement('button'),
    caption = document.createElement('span'),
    arrow = document.createElement('span');
  trigger.type = 'button';
  trigger.className = 'compact-select-trigger';
  arrow.className = 'ui-chevron';
  arrow.setAttribute('aria-hidden', 'true');
  trigger.append(caption, arrow);
  const popup = document.createElement('div');
  popup.className = 'compact-select-menu';
  popup.id = 'select-' + crypto.randomUUID();
  popup.setAttribute('popover', 'auto');
  popup.setAttribute('role', 'menu');
  popup.setAttribute('aria-label', t(label));
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-controls', popup.id);
  trigger.setAttribute('aria-expanded', 'false');
  select.classList.add('compact-select-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(trigger);
  document.body.append(popup);
  const opened = () => popup.matches(':popover-open');
  const close = (focus = false) => {
    if (opened()) popup.hidePopover();
    if (focus && !trigger.disabled) trigger.focus();
  };
  function position() {
    const r = trigger.getBoundingClientRect(),
      w = Math.min(Math.max(r.width, 230), 340, innerWidth - 16);
    popup.style.width = w + 'px';
    popup.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    const below = innerHeight - r.bottom - 12,
      above = r.top - 12,
      up = placement === 'top' ? above >= 150 : below < 180 && above > below;
    popup.style.maxHeight = Math.max(48, Math.min(320, up ? above : below)) + 'px';
    popup.style.top = up ? 'auto' : Math.max(8, r.bottom + 5) + 'px';
    popup.style.bottom = up ? Math.max(8, innerHeight - r.top + 5) + 'px' : 'auto';
  }
  function render() {
    caption.textContent = t(select.selectedOptions[0]?.textContent || label);
    trigger.title = caption.textContent;
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-label', t(label) + ': ' + caption.textContent);
    if (trigger.disabled) {
      close();
      return;
    }
    const focused = popup.contains(document.activeElement)
      ? document.activeElement.dataset.value
      : null;
    popup.replaceChildren();
    for (const option of select.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.dataset.value = option.value;
      item.disabled = option.disabled;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(option.selected));
      const copy = document.createElement('span'),
        name = document.createElement('span'),
        mark = document.createElement('span');
      copy.className = 'compact-select-copy';
      name.textContent = t(option.textContent);
      name.className = 'compact-select-name';
      copy.append(name);
      item.title = name.textContent;
      const hint = description(option);
      if (hint) {
        const small = document.createElement('small');
        small.textContent = t(hint);
        copy.append(small);
      }
      mark.textContent = option.selected ? '✓' : '';
      mark.setAttribute('aria-hidden', 'true');
      item.append(copy, mark);
      item.onclick = () => {
        if (select.disabled) return;
        select.value = option.value;
        close(true);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        render();
      };
      popup.append(item);
    }
    if (opened()) {
      position();
      if (focused !== null) [...popup.children].find((b) => b.dataset.value === focused)?.focus();
    }
  }
  const items = () => [...popup.querySelectorAll('button:not(:disabled)')];
  function open(last = false) {
    if (trigger.disabled) return;
    select.onfocus?.(new Event('focus'));
    render();
    popup.showPopover();
    position();
    const buttons = items();
    (last
      ? buttons.at(-1)
      : buttons.find((b) => b.getAttribute('aria-checked') === 'true') || buttons[0]
    )?.focus();
  }
  trigger.onclick = () => (opened() ? close() : open());
  trigger.onkeydown = (event) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      open(event.key === 'ArrowUp');
    }
  };
  popup.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      close(true);
      return;
    }
    const buttons = items(),
      index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      buttons[next]?.focus();
    }
  };
  popup.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(opened())));
  new MutationObserver(render).observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  select.addEventListener('change', render);
  window.addEventListener('resize', () => close());
  document.addEventListener(
    'scroll',
    (event) => {
      if (!popup.contains(event.target)) close();
    },
    true,
  );
  subscribeUiLanguage(render);
  render();
  return { refresh: render, close };
}
