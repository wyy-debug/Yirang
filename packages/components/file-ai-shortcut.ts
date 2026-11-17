import { t as uiText } from './ui-language.js';
export type FileAiShortcut = {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
};
export const defaultScreenshotShortcut: FileAiShortcut = {
  code: 'KeyS',
  ctrl: true,
  alt: false,
  shift: true,
  meta: false,
};
export const defaultFileAiShortcut: FileAiShortcut = {
  code: 'KeyA',
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
};
export function validFileAiShortcut(value: unknown): value is FileAiShortcut {
  if (!value || typeof value !== 'object') return false;
  const s = value as FileAiShortcut;
  return (
    [s.ctrl, s.alt, s.shift, s.meta].every((v) => typeof v === 'boolean') &&
    typeof s.code === 'string' &&
    /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|MouseBack|MouseForward)$/.test(s.code) &&
    (s.ctrl || s.alt || s.meta || s.code.startsWith('F') || s.code.startsWith('Mouse'))
  );
}
export function matchesFileAiShortcut(
  event: Pick<
    KeyboardEvent,
    'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'
  >,
  shortcut: FileAiShortcut,
) {
  return (
    !event.isComposing &&
    event.code === shortcut.code &&
    event.ctrlKey === shortcut.ctrl &&
    event.altKey === shortcut.alt &&
    event.shiftKey === shortcut.shift &&
    event.metaKey === shortcut.meta
  );
}
export function fileAiShortcutLabel(s: FileAiShortcut) {
  return [
    s.ctrl && 'Ctrl',
    s.alt && 'Alt',
    s.shift && 'Shift',
    s.meta && 'Meta',
    s.code === 'MouseBack'
      ? uiText('鼠标侧键（后退）')
      : s.code === 'MouseForward'
        ? uiText('鼠标侧键（前进）')
        : s.code.replace(/^(Key|Digit)/, ''),
  ]
    .filter(Boolean)
    .join('+');
}

export function fileAiMouseShortcut(
  event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): FileAiShortcut | null {
  if (event.button !== 3 && event.button !== 4) return null;
  return {
    code: event.button === 3 ? 'MouseBack' : 'MouseForward',
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

// Cancel both the press and release defaults so a bound side button cannot navigate.
export function listenFileAiMouseShortcut(
  current: () => FileAiShortcut,
  blocked: () => boolean,
  trigger: () => void,
) {
  let pressed: number | null = null;
  const handle = (event: MouseEvent) => {
    const value = fileAiMouseShortcut(event);
    if (!value) return;
    const shortcut = current();
    const matches =
      value.code === shortcut.code &&
      value.ctrl === shortcut.ctrl &&
      value.alt === shortcut.alt &&
      value.shift === shortcut.shift &&
      value.meta === shortcut.meta;
    if (event.type === 'mousedown' && !matches) return;
    if (!matches && pressed !== event.button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'mousedown') {
      pressed = event.button;
      if (!blocked()) trigger();
    }
    if (event.type === 'auxclick') pressed = null;
  };
  for (const type of ['mousedown', 'mouseup', 'auxclick'] as const)
    window.addEventListener(type, handle, true);
  return () => {
    for (const type of ['mousedown', 'mouseup', 'auxclick'] as const)
      window.removeEventListener(type, handle, true);
  };
}

export function fileAiShortcutError(value: unknown): string | null {
  if (!validFileAiShortcut(value))
    return uiText('请使用鼠标侧键、功能键，或 Ctrl / Alt / Meta 加字母或数字。');
  const reserved = [
    'Ctrl+A',
    'Ctrl+C',
    'Ctrl+V',
    'Ctrl+X',
    'Ctrl+Z',
    'Ctrl+Y',
    'Ctrl+S',
    'Ctrl+P',
    'Ctrl+K',
    'Ctrl+D',
    'Ctrl+G',
    'Ctrl+F',
    'Ctrl+R',
    'Ctrl+W',
    'Ctrl+N',
    'Ctrl+Shift+F',
    'Ctrl+Shift+Z',
    'Ctrl+Shift+R',
    'Ctrl+Shift+I',
    'Alt+F4',
    'F1',
    'F2',
    'F5',
    'F6',
    'F10',
    'F11',
    'F12',
  ];
  return reserved.includes(fileAiShortcutLabel(value).replace('Meta+', 'Ctrl+'))
    ? uiText('此组合已用于常见操作，请换一个组合键。')
    : null;
}
