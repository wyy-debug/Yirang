import React from 'react';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import type { CanvasTool } from './canvas-board.js';

export function ToolIcon({
  name,
}: {
  name: CanvasTool | 'undo' | 'redo' | 'trash' | 'edit' | 'close' | 'style';
}) {
  useUiLocale();
  const paths: Record<string, React.ReactNode> = {
    select: <path d="m5 3 14 9-7 1-3 7z" />,
    rectangle: <rect x="5" y="4" width="14" height="16" rx="2" />,
    hand: (
      <path d="M7 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v6c0 5-3 7-6 7h-1c-2 0-3-1-4-3l-4-5a1.5 1.5 0 0 1 2-2l3 2" />
    ),
    diamond: <path d="m12 3 9 9-9 9-9-9z" />,
    ellipse: <circle cx="12" cy="12" r="8" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    line: <path d="M4 12h16" />,
    pen: (
      <>
        <path d="m5 16-1 4 4-1L20 7l-3-3zM14 7l3 3" />
        <path d="m4 20 4-1-3-3" />
      </>
    ),
    text: (
      <>
        <path d="m4 20 8-17 8 17M7 14h10M3 21h18" />
      </>
    ),
    note: (
      <>
        <path d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM15 21v-6h6M7 8h10M7 12h7" />
      </>
    ),
    eraser: (
      <>
        <path d="m4 12 9-9 8 8-9 9H8l-5-5a2 2 0 0 1 1-3ZM8 8l8 8M12 20h9" />
      </>
    ),
    undo: <path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" />,
    redo: <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />,
    trash: <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />,
    edit: <path d="m5 16-1 4 4-1L20 7l-3-3zM14 7l3 3" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    style: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 4v16" />
        <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill={name === 'select' ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
