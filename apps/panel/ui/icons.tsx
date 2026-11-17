import { useUiLanguage as useUiLocale } from './ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React from 'react';

const paths = {
  pointer: <path d="m5 3 14 9-7 1-3 7-4-17Z" />,
  hand: (
    <>
      <path d="M8 12V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 4-3 7-7 7h-1c-2 0-4-1-5-3l-4-6a2 2 0 0 1 3-2l2 2" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m16 8-2.4 5.6L8 16l2.4-5.6L16 8Z" />
    </>
  ),
  browser: (
    <>
      <rect x="2" y="3" width="20" height="18" rx="3" />
      <path d="M2 8h20M6 5.5h.01M9 5.5h.01M7 12h10M7 16h6" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="3" />
      <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" />
    </>
  ),
  comment: (
    <>
      <path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4V5a2 2 0 0 1 2-2Z" />
      <path d="M7 8h10M7 12h7" />
    </>
  ),
  workflow: (
    <>
      <rect x="2" y="3" width="6" height="5" rx="1.4" />
      <rect x="16" y="16" width="6" height="5" rx="1.4" />
      <rect x="16" y="3" width="6" height="5" rx="1.4" />
      <path d="M8 5.5h8M5 8v10.5h11" />
    </>
  ),
  desktop: (
    <>
      <rect x="3" y="3" width="18" height="16" rx="3" />
      <path d="M9 22h6m-3-3v3" />
    </>
  ),
  drive: (
    <>
      <path d="M5 4h14l3 10v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5L5 4Z M2 14h20m-4 4h1" />
    </>
  ),
  star: <path d="m12 2 3.1 6.3 7 .9-5 4.9 1.2 7-6.3-3.3-6.3 3.3 1.2-7-5-4.9 7-.9L12 2Z" />,
  box: (
    <>
      <path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm-9 5 9 5 9-5M12 12v10M7.5 4.5l9 5" />
    </>
  ),
  playCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4V8Z" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  folder: (
    <path d="M3 7V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  upload: (
    <>
      <path d="M12 16V3m-4 4 4-4 4 4M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13m-4-4 4 4 4-4M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  document: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8m-8 4h5" />
    </>
  ),
  text: <path d="M4 5h16M12 5v15m-4 0h8M4 5v3m16-3v3" />,
  sheet: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 9h18M3 15h18M9 9v12m6-12v12" />
    </>
  ),
  code: <path d="m7 6-6 6 6 6m10-12 6 6-6 6M14 4l-4 16" />,
  diagram: (
    <>
      <rect x="8" y="2" width="8" height="6" rx="2" />
      <rect x="2" y="16" width="7" height="6" rx="2" />
      <rect x="15" y="16" width="7" height="6" rx="2" />
      <path d="M12 8v4M5.5 16v-4h13v4" />
    </>
  ),
  slides: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M12 16v5m-5 0 5-5 5 5M8 8h8m-8 4h5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  tasks: (
    <>
      <rect x="5" y="4" width="14" height="18" rx="3" />
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="m8 12 2 2 5-5m-7 9h8" />
    </>
  ),
  play: <path d="m8 4 13 8-13 8V4Z" />,
  layers: <path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" />,
  history: (
    <>
      <path d="M3 11a9 9 0 1 1 2.5 7.2M3 4v7h7M12 7v5l3 2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="8" cy="7" r="3" fill="var(--icon-fill, currentColor)" />
      <circle cx="16" cy="17" r="3" fill="var(--icon-fill, currentColor)" />
    </>
  ),
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM7 3v6h10V3M7 21v-8h10v8" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m7 10 5 5 5-5" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  expand: <path d="M14 3h7v7m0-7-9 9M3 14v7h7" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  link: (
    <>
      <path
        d="m10 13 4-4m-5 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
        transform="translate(1 0)"
      />
    </>
  ),
  group: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <path d="M14 17h7m-3.5-3.5v7" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
    </>
  ),
  pen: (
    <>
      <path d="m14 4 6 6M3 21l6-1L21 8a3 3 0 0 0-5-5L4 15l-1 6Z" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M9 3v18m0-11h12" />
    </>
  ),
  align: <path d="M4 3v18M8 6h13M8 12h9M8 18h13" />,
  top: <path d="M3 4h18M6 8v13m6-13v9m6-9v13" />,
  fit: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5" />,
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;
export function FileBadge({ kind, fileName = '' }: { kind: string; fileName?: string }) {
  useUiLocale();
  const look = materialAppearance(kind, fileName),
    label = look.label.toLowerCase(),
    letter =
      label === 'docx' || label === 'doc'
        ? 'W'
        : label === 'xlsx' || label === 'xls' || kind === 'table'
          ? 'X'
          : label === 'pptx' || kind === 'deck'
            ? 'P'
            : null;
  return (
    <span className={`file-badge tone-${look.tone}`} aria-hidden="true">
      {letter ?? <Icon name={look.icon} size={15} />}
    </span>
  );
}
export function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  useUiLocale();
  return (
    <svg
      className={`desk-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

export function materialAppearance(
  kind: string,
  fileName = '',
): { icon: IconName; tone: string; label: string } {
  if (kind === 'file' && /\.component\.json$/i.test(fileName))
    return { icon: 'box', tone: 'purple', label: uiText('组件') };
  if (kind === 'workflow' || (kind === 'file' && /\.flow\.json$/i.test(fileName)))
    return { icon: 'workflow', tone: 'purple', label: uiText('流程') };
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (kind === 'file') {
    if (['xlsx', 'xls', 'csv', 'tsv'].includes(extension ?? ''))
      return { icon: 'sheet', tone: 'green', label: extension!.toUpperCase() };
    if (['docx', 'doc'].includes(extension ?? ''))
      return { icon: 'document', tone: 'blue', label: extension!.toUpperCase() };
    if (['pptx', 'ppt'].includes(extension ?? ''))
      return { icon: 'slides', tone: 'orange', label: extension!.toUpperCase() };
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(extension ?? ''))
      return { icon: 'image', tone: 'purple', label: extension!.toUpperCase() };
    if (['html', 'htm'].includes(extension ?? ''))
      return { icon: 'browser', tone: 'blue', label: uiText('网页') };
    if (['py', 'js', 'ts', 'json', 'css'].includes(extension ?? ''))
      return { icon: 'code', tone: 'slate', label: extension!.toUpperCase() };
    if (extension === 'pdf') return { icon: 'document', tone: 'rose', label: 'PDF' };
    return { icon: 'document', tone: 'blue', label: extension?.toUpperCase() ?? 'FILE' };
  }
  return (
    (
      {
        text: { icon: 'text', tone: 'blue', label: uiText('文字') },
        document: { icon: 'document', tone: 'blue', label: 'DOCX' },
        table: { icon: 'sheet', tone: 'green', label: uiText('表格') },
        workbook: { icon: 'sheet', tone: 'green', label: 'XLSX' },
        code: { icon: 'code', tone: 'slate', label: uiText('代码') },
        image: { icon: 'image', tone: 'purple', label: uiText('图片') },
        diagram: { icon: 'diagram', tone: 'purple', label: uiText('图形') },
        deck: { icon: 'slides', tone: 'orange', label: 'PPTX' },
      } as Record<string, { icon: IconName; tone: string; label: string }>
    )[kind] ?? { icon: 'document', tone: 'blue', label: uiText('文件') }
  );
}
