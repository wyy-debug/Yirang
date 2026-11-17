import { subscribeUiLanguage as onUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React from 'react';
import type { DesktopObject } from '../../../packages/contracts/index.js';
import { Icon } from '../ui/icons.js';
import './desktop-arrange.css';

export type ArrangeMode =
  | 'grid'
  | 'left'
  | 'center-x'
  | 'right'
  | 'top'
  | 'center-y'
  | 'bottom'
  | 'distribute-x'
  | 'distribute-y';
type ArrangeItem = { id: string; bounds: DesktopObject['bounds'] };
type ArrangeResult = { objectId: string; bounds: DesktopObject['bounds'] };
const coordinateLimit = 100000,
  gap = 24;
const compareId = (a: ArrangeItem, b: ArrangeItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Compute only positions. Dimensions, object order and persisted records are not mutated. */
export function arrangeDesktopObjects(items: ArrangeItem[], mode: ArrangeMode): ArrangeResult[] {
  if (mode.startsWith('distribute') && items.length < 3)
    throw new Error(uiText('等距分布至少需要选择 3 份材料。'));
  if (!items.length) return [];
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error(uiText('选区中包含重复材料，请重新选择。'));
  if (
    items.some(
      (item) =>
        Object.values(item.bounds).some((value) => !Number.isFinite(value)) ||
        item.bounds.width <= 0 ||
        item.bounds.height <= 0,
    )
  )
    throw new Error(uiText('材料的布局数据无效，暂时无法排列。'));
  const placements = new Map(items.map((item) => [item.id, { ...item.bounds }]));
  const left = Math.min(...items.map((item) => item.bounds.x)),
    top = Math.min(...items.map((item) => item.bounds.y));
  const right = Math.max(...items.map((item) => item.bounds.x + item.bounds.width)),
    bottom = Math.max(...items.map((item) => item.bounds.y + item.bounds.height));
  if (mode === 'grid') {
    const sorted = [...items].sort(
      (a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x || compareId(a, b),
    );
    const columns = Math.ceil(Math.sqrt(items.length)),
      rows = Math.ceil(items.length / columns);
    const widths = Array.from({ length: columns }, () => 0),
      heights = Array.from({ length: rows }, () => 0);
    sorted.forEach((item, index) => {
      widths[index % columns] = Math.max(widths[index % columns], item.bounds.width);
      heights[Math.floor(index / columns)] = Math.max(
        heights[Math.floor(index / columns)],
        item.bounds.height,
      );
    });
    const xs: number[] = [],
      ys: number[] = [];
    widths.forEach((_, index) => {
      xs[index] = index === 0 ? left : xs[index - 1] + widths[index - 1] + gap;
    });
    heights.forEach((_, index) => {
      ys[index] = index === 0 ? top : ys[index - 1] + heights[index - 1] + gap;
    });
    sorted.forEach((item, index) => {
      const bounds = placements.get(item.id)!;
      bounds.x = xs[index % columns];
      bounds.y = ys[Math.floor(index / columns)];
    });
  } else if (mode === 'distribute-x' || mode === 'distribute-y') {
    const axis = mode === 'distribute-x' ? 'x' : 'y',
      other = axis === 'x' ? 'y' : 'x',
      size = axis === 'x' ? 'width' : 'height';
    const sorted = [...items].sort(
      (a, b) =>
        a.bounds[axis] - b.bounds[axis] || a.bounds[other] - b.bounds[other] || compareId(a, b),
    );
    const first = sorted[0],
      last = sorted[sorted.length - 1];
    const available =
      last.bounds[axis] -
      first.bounds[axis] -
      sorted.slice(0, -1).reduce((total, item) => total + item.bounds[size], 0);
    if (available < 0)
      throw new Error(
        uiText(
          '当前{0}空间不足，无法在保留两端位置的同时等距分布。请先拉开两端材料，或使用网格排列。',
          { '0': axis === 'x' ? uiText('水平') : uiText('垂直') },
        ),
      );
    const spacing = available / (sorted.length - 1);
    let position = first.bounds[axis];
    sorted.forEach((item, index) => {
      placements.get(item.id)![axis] = index === sorted.length - 1 ? last.bounds[axis] : position;
      position += item.bounds[size] + spacing;
    });
  } else {
    for (const item of items) {
      const bounds = placements.get(item.id)!;
      if (mode === 'left') bounds.x = left;
      else if (mode === 'center-x') bounds.x = (left + right - bounds.width) / 2;
      else if (mode === 'right') bounds.x = right - bounds.width;
      else if (mode === 'top') bounds.y = top;
      else if (mode === 'center-y') bounds.y = (top + bottom - bounds.height) / 2;
      else if (mode === 'bottom') bounds.y = bottom - bounds.height;
      else throw new Error(uiText('暂不支持此排列方式。'));
    }
  }
  // Shift the entire arrangement at the coordinate boundary instead of clamping
  // individual items together and silently creating overlaps.
  for (const axis of ['x', 'y'] as const) {
    const coordinates = Array.from(placements.values(), (bounds) => bounds[axis]);
    const min = Math.min(...coordinates),
      max = Math.max(...coordinates);
    if (max - min > coordinateLimit * 2)
      throw new Error(uiText('所选材料超出桌面可排列范围，请减少选区或缩小材料间距。'));
    const shift =
      max > coordinateLimit
        ? coordinateLimit - max
        : min < -coordinateLimit
          ? -coordinateLimit - min
          : 0;
    if (shift)
      for (const bounds of placements.values())
        bounds[axis] = Math.max(-coordinateLimit, Math.min(coordinateLimit, bounds[axis] + shift));
  }
  return items.map((item) => ({ objectId: item.id, bounds: placements.get(item.id)! }));
}

type MenuProps = {
  count: number;
  disabled: boolean;
  arrange: (mode: ArrangeMode) => void;
  canUndo: boolean;
  undo: () => void;
  canRedo?: boolean;
  redo?: () => void;
};
let alignments: { mode: ArrangeMode; label: string }[] = [
  { mode: 'left', label: uiText('左对齐') },
  { mode: 'center-x', label: uiText('水平居中') },
  { mode: 'right', label: uiText('右对齐') },
  { mode: 'top', label: uiText('顶对齐') },
  { mode: 'center-y', label: uiText('垂直居中') },
  { mode: 'bottom', label: uiText('底对齐') },
];

function ArrangeIcon({ mode }: { mode: ArrangeMode }) {
  useUiLocale();
  const horizontal = mode === 'left' || mode === 'center-x' || mode === 'right';
  const position =
    mode === 'left' || mode === 'top' ? 4 : mode === 'right' || mode === 'bottom' ? 20 : 12;
  const sizes = [10, 15],
    starts = sizes.map((size) =>
      position === 4 ? 6 : position === 20 ? 18 - size : 12 - size / 2,
    );
  if (mode === 'distribute-x' || mode === 'distribute-y')
    return (
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <g transform={mode === 'distribute-y' ? 'rotate(90 12 12)' : undefined}>
          <path d="M3 4v16M21 4v16" />
          <rect x="6" y="7" width="3" height="10" rx=".7" />
          <rect x="15" y="7" width="3" height="10" rx=".7" />
          <path d="M11 12h2" />
        </g>
      </svg>
    );
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <g transform={horizontal ? undefined : 'rotate(90 12 12)'}>
        <path d={`M${position} 2v20`} />
        {sizes.map((size, index) => (
          <rect
            key={index}
            x={starts[index]}
            y={index ? 14 : 6}
            width={size}
            height="4"
            rx=".7"
            fill="var(--glass, white)"
          />
        ))}
      </g>
    </svg>
  );
}

/** The containing ActionPopover owns closing and persistence. */
export function DesktopArrangeMenu({
  count,
  disabled,
  arrange,
  canUndo,
  undo,
  canRedo = false,
  redo,
}: MenuProps) {
  useUiLocale();
  const unavailable = disabled || count < 2;
  return (
    <div className="desktop-arrange-menu">
      <div className="desktop-arrange-label">
        {uiText('排列所选材料')}
        <span>
          {count} {uiText('项')}
        </span>
      </div>
      <button type="button" disabled={unavailable} onClick={() => arrange('grid')}>
        <Icon name="grid" />
        <span>{uiText('整理成网格')}</span>
      </button>
      <div className="desktop-arrange-align" role="group" aria-label={uiText('对齐所选材料')}>
        {alignments.map((item) => (
          <button
            type="button"
            key={item.mode}
            disabled={unavailable}
            title={item.label}
            aria-label={item.label}
            onClick={() => arrange(item.mode)}
          >
            <ArrangeIcon mode={item.mode} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={disabled || count < 3}
        onClick={() => arrange('distribute-x')}
        title={
          count < 3
            ? uiText('至少选择 3 份材料')
            : uiText('保持最左和最右材料的位置，等距排列中间材料')
        }
      >
        <ArrangeIcon mode="distribute-x" />
        <span>{uiText('水平等距分布')}</span>
      </button>
      <button
        type="button"
        disabled={disabled || count < 3}
        onClick={() => arrange('distribute-y')}
        title={
          count < 3
            ? uiText('至少选择 3 份材料')
            : uiText('保持最上和最下材料的位置，等距排列中间材料')
        }
      >
        <ArrangeIcon mode="distribute-y" />
        <span>{uiText('垂直等距分布')}</span>
      </button>
      <div className="desktop-arrange-history" role="group" aria-label={uiText('排列历史')}>
        <button type="button" disabled={disabled || !canUndo} onClick={undo}>
          <span aria-hidden="true">↶</span>
          {uiText('撤销排列')}
        </button>
        {redo && (
          <button type="button" disabled={disabled || !canRedo} onClick={redo}>
            <span aria-hidden="true">↷</span>
            {uiText('重做')}
          </button>
        )}
      </div>
      {count < 2 && (
        <p className="desktop-arrange-hint">{uiText('选择至少 2 份材料后，可批量对齐。')}</p>
      )}
    </div>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  alignments = [
    { mode: 'left', label: uiText('左对齐') },
    { mode: 'center-x', label: uiText('水平居中') },
    { mode: 'right', label: uiText('右对齐') },
    { mode: 'top', label: uiText('顶对齐') },
    { mode: 'center-y', label: uiText('垂直居中') },
    { mode: 'bottom', label: uiText('底对齐') },
  ];
});
