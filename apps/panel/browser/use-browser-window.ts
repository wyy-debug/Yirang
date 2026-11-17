import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { browserCommand } from './electron-browser-bridge.js';

type WindowRect = { left: number; top: number; width: number; height: number };
function clamp(rect: WindowRect): WindowRect {
  const width = Math.min(Math.max(540, rect.width), window.innerWidth - 24),
    height = Math.min(Math.max(360, rect.height), window.innerHeight - 84);
  return {
    width,
    height,
    left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
    top: Math.max(68, Math.min(rect.top, window.innerHeight - height - 12)),
  };
}
export function useBrowserWindow(floating: boolean) {
  const [rect, setRect] = useState(() => clamp({ left: 240, top: 86, width: 960, height: 640 })),
    [moving, setMoving] = useState(false);
  const current = useRef(rect),
    cleanup = useRef<() => void>(() => {});
  current.current = rect;
  useEffect(() => {
    const resized = () => setRect((value) => clamp(value));
    window.addEventListener('resize', resized);
    return () => {
      cleanup.current();
      window.removeEventListener('resize', resized);
    };
  }, []);
  function start(event: ReactPointerEvent<HTMLElement>, resize = false) {
    if (
      !floating ||
      event.button !== 0 ||
      (!resize && (event.target as Element).closest('button,input,select'))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    cleanup.current();
    const origin = current.current,
      x = event.clientX,
      y = event.clientY,
      node = event.currentTarget;
    node.setPointerCapture(event.pointerId);
    setMoving(true);
    void browserCommand('layout', { visible: false }).catch(() => {});
    const move = (next: PointerEvent) =>
      setRect(
        clamp(
          resize
            ? {
                ...origin,
                width: origin.width + next.clientX - x,
                height: origin.height + next.clientY - y,
              }
            : {
                ...origin,
                left: origin.left + next.clientX - x,
                top: origin.top + next.clientY - y,
              },
        ),
      );
    const end = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      setMoving(false);
      cleanup.current = () => {};
    };
    cleanup.current = end;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  }
  return { style: floating ? rect : undefined, moving, start };
}
