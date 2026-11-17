import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React from 'react';
import type { DesktopObject } from '../../../packages/contracts/index.js';

export function liveOutputSources(object: DesktopObject, available: ReadonlySet<string>) {
  return (object.generation?.sources ?? []).filter(
    (source) => source.id !== object.id && available.has(source.id),
  );
}

export type CanvasPoint = { x: number; y: number };
export type CanvasLink = {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  arrow: boolean;
};
export function outputProvenanceLinks(
  objects: readonly DesktopObject[],
  collapsed: ReadonlySet<string>,
  selected: readonly string[],
): CanvasLink[] {
  const visible = objects.filter(
    (object) => !object.archived && !object.policy?.private && !collapsed.has(object.id),
  );
  const available = new Set(visible.map((object) => object.id));
  const selection = new Set(selected);
  return visible.flatMap((object) => {
    const sources = liveOutputSources(object, available);
    const anchor =
      sources.find((source) => source.id === object.generation?.anchorSourceId) ?? sources[0];
    return sources
      .filter(
        (source) => source === anchor || selection.has(object.id) || selection.has(source.id),
      )
      .map((source) => ({
        id: JSON.stringify([source.id, object.id]),
        sourceId: source.id,
        targetId: object.id,
        label: '',
        arrow: true,
      }));
  });
}
export type CanvasLinkCard = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  archived?: boolean;
};
export type ShortLinkGeometry = {
  start: CanvasPoint;
  end: CanvasPoint;
  label: CanvasPoint;
  length: number;
  d: string;
};

function usableCard(card: CanvasLinkCard) {
  return (
    !card.archived &&
    [card.x, card.y, card.width, card.height].every(Number.isFinite) &&
    card.width > 0 &&
    card.height > 0
  );
}

/** The last card is visually on top when card bounds overlap. */
export function cardAtPoint(
  cards: readonly CanvasLinkCard[],
  point: CanvasPoint,
  excludeId?: string,
): CanvasLinkCard | undefined {
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (
      card.id !== excludeId &&
      usableCard(card) &&
      point.x >= card.x &&
      point.x <= card.x + card.width &&
      point.y >= card.y &&
      point.y <= card.y + card.height
    )
      return card;
  }
  return undefined;
}

/** Join the closest points on the rectangles, keeping shared-edge connections straight. */
export function shortLinkGeometry(
  source: CanvasLinkCard,
  target: CanvasLinkCard,
): ShortLinkGeometry | null {
  if (source.id === target.id || !usableCard(source) || !usableCard(target)) return null;
  const sourceRight = source.x + source.width,
    sourceBottom = source.y + source.height;
  const targetRight = target.x + target.width,
    targetBottom = target.y + target.height;
  const sharedLeft = Math.max(source.x, target.x),
    sharedRight = Math.min(sourceRight, targetRight);
  const sharedTop = Math.max(source.y, target.y),
    sharedBottom = Math.min(sourceBottom, targetBottom);
  const overlapX = sharedLeft <= sharedRight,
    overlapY = sharedTop <= sharedBottom;
  if (overlapX && overlapY) return null;
  const sourceBeforeX = sourceRight < target.x,
    sourceBeforeY = sourceBottom < target.y;
  const sharedX = (sharedLeft + sharedRight) / 2,
    sharedY = (sharedTop + sharedBottom) / 2;
  const start = {
    x: overlapX ? sharedX : sourceBeforeX ? sourceRight : source.x,
    y: overlapY ? sharedY : sourceBeforeY ? sourceBottom : source.y,
  };
  const end = {
    x: overlapX ? sharedX : sourceBeforeX ? target.x : targetRight,
    y: overlapY ? sharedY : sourceBeforeY ? target.y : targetBottom,
  };
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 1) return null;
  return {
    start,
    end,
    length,
    label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
  };
}

export type CanvasLinksProps = {
  visibleRect?: { x: number; y: number; width: number; height: number };
  links: readonly CanvasLink[];
  cards: readonly CanvasLinkCard[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
  onPointerDown?: (id: string, event: React.PointerEvent<SVGGElement>) => void;
  interactive?: boolean;
  provenance?: boolean;
  zoom?: number;
  viewport?: CanvasPoint;
};

function shortLabel(text: string, maxCharacters: number) {
  const characters = Array.from(text.replace(/\s+/g, ' ').trim());
  if (maxCharacters < 3) return '';
  return characters.length <= maxCharacters
    ? characters.join('')
    : characters.slice(0, maxCharacters - 1).join('') + '…';
}

/** Project live card geometry into screen pixels; avoid transformed SVG markers
 * and non-scaling strokes when panning the transparent overlay. */
export function CanvasLinks({
  links,
  cards,
  selectedId,
  onSelect,
  onDelete,
  onPointerDown,
  interactive = true,
  provenance = false,
  zoom = 1,
  visibleRect,
  viewport = { x: 0, y: 0 },
}: CanvasLinksProps) {
  useUiLocale();
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const byId = new Map(cards.filter(usableCard).map((card) => [card.id, card]));
  return (
    <g className="canvas-links" fill="none">
      {links.map((link) => {
        const source = byId.get(link.sourceId),
          target = byId.get(link.targetId);
        if (!source || !target) return null;
        const world = shortLinkGeometry(source, target);
        if (!world) return null;
        const selected = selectedId === link.id;
        const stroke = selected ? '#6366f1' : '#9299a8';
        if (visibleRect && !selected) {
          const { start, end } = world;
          if (
            Math.max(start.x, end.x) < visibleRect.x ||
            Math.min(start.x, end.x) > visibleRect.x + visibleRect.width ||
            Math.max(start.y, end.y) < visibleRect.y ||
            Math.min(start.y, end.y) > visibleRect.y + visibleRect.height
          )
            return null;
        }
        const project = (point: CanvasPoint) => ({
          x: viewport.x + point.x * scale,
          y: viewport.y + point.y * scale,
        });
        const start = project(world.start),
          end = project(world.end),
          center = project(world.label);
        if (provenance) {
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const distance = Math.hypot(dx, dy);
          const bend = Math.min(0.22, 21 / distance);
          const d = `M ${start.x} ${start.y} C ${start.x + dx * 0.38 - dy * bend} ${start.y + dy * 0.38 + dx * bend} ${end.x - dx * 0.38 + dy * bend} ${end.y - dy * 0.38 - dx * bend} ${end.x} ${end.y}`;
          return (
            <g key={link.id} data-output-link={link.id} pointerEvents="none">
              <title>{uiText('来源 {0} → 产出 {1}', { '0': source.title, '1': target.title })}</title>
              <path d={d} stroke="var(--paper, white)" strokeWidth={6} strokeLinecap="round" />
              <path d={d} stroke="#429477" strokeWidth={2.5} strokeLinecap="round" />
              <circle cx={start.x} cy={start.y} r={2.75} fill="#429477" />
              <circle cx={end.x} cy={end.y} r={3.75} fill="#429477" />
            </g>
          );
        }
        const geometry = {
          start,
          end,
          label: center,
          length: world.length * scale,
          d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
        };
        const angle = Math.atan2(end.y - start.y, end.x - start.x),
          back = { x: end.x - 6 * Math.cos(angle), y: end.y - 6 * Math.sin(angle) };
        const arrowPath = `M ${back.x - 3 * Math.sin(angle)} ${back.y + 3 * Math.cos(angle)} L ${end.x} ${end.y} L ${back.x + 3 * Math.sin(angle)} ${back.y - 3 * Math.cos(angle)}`;
        const label =
          scale < 0.4 && !selected
            ? ''
            : shortLabel(link.label, Math.min(28, Math.floor((geometry.length - 24) / 10)));
        const labelWidth =
          Array.from(label).reduce(
            (width, char) => width + (/[\u0000-\u007f]/.test(char) ? 6.6 : 11),
            0,
          ) + 16;
        const description = `${source.title} ${link.arrow ? uiText('指向') : uiText('连接')} ${target.title}${link.label ? `：${link.label}` : ''}`;
        return (
          <g
            key={link.id}
            className={`canvas-link nodrag nopan${selected ? ' is-selected' : ''}`}
            data-canvas-link={link.id}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={description}
            aria-pressed={interactive ? selected : undefined}
            style={{ cursor: interactive ? 'pointer' : undefined, outline: 'none' }}
            onPointerDown={interactive ? (event) => onPointerDown?.(link.id, event) : undefined}
            onClick={
              interactive
                ? (event) => {
                    event.stopPropagation();
                    onSelect?.(link.id);
                  }
                : undefined
            }
            onFocus={interactive ? () => onSelect?.(link.id) : undefined}
            onKeyDown={
              interactive
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelect?.(link.id);
                    }
                    if ((event.key === 'Delete' || event.key === 'Backspace') && onDelete) {
                      event.preventDefault();
                      event.stopPropagation();
                      onDelete(link.id);
                    }
                  }
                : undefined
            }
          >
            <title>{description}</title>
            <path
              d={geometry.d}
              stroke="transparent"
              strokeWidth={18}
              pointerEvents={interactive ? 'stroke' : 'none'}
            />
            <path
              d={geometry.d}
              stroke={stroke}
              strokeWidth={selected ? 2 : 1.5}
              strokeLinecap="round"
              pointerEvents="none"
            />
            {link.arrow && (
              <path
                d={arrowPath}
                fill="none"
                stroke={stroke}
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="none"
              />
            )}
            {selected && (
              <>
                <circle
                  cx={geometry.start.x}
                  cy={geometry.start.y}
                  r={3}
                  fill="#fff"
                  stroke="#6366f1"
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
                <circle
                  cx={geometry.end.x}
                  cy={geometry.end.y}
                  r={3}
                  fill="#fff"
                  stroke="#6366f1"
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
              </>
            )}
            {label && (
              <g pointerEvents="none">
                <rect
                  x={geometry.label.x - labelWidth / 2}
                  y={geometry.label.y - 10}
                  width={labelWidth}
                  height={20}
                  rx={7}
                  fill={selected ? '#eef0ff' : '#fff'}
                  fillOpacity="0.96"
                  stroke={selected ? '#c7c9ff' : '#e7e9ee'}
                  strokeWidth={0.7}
                />
                <text
                  x={geometry.label.x}
                  y={geometry.label.y}
                  dominantBaseline="central"
                  textAnchor="middle"
                  fill={selected ? '#4f46e5' : '#626b7c'}
                  fontSize={11}
                  fontFamily="inherit"
                >
                  {label}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}
