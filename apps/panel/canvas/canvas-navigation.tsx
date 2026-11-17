import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState, useMemo } from 'react';
import { scheduleRenderFrame, cancelRenderFrame } from '../ui/render-frame.js';
import { extent, type Rect, type Guide } from '../../../packages/components/canvas-spatial.js';
import type { CanvasGroups } from '../../../packages/contracts/index.js';
import { Icon } from '../ui/icons.js';
import './canvas-space.css';

export function useCanvasSize(ref: React.RefObject<HTMLElement | null>, workspaceId?: string) {
  const [size, setSize] = useState({ width: 1200, height: 800 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const key = {};
    let live = true;
    const update = () =>
      scheduleRenderFrame(key, () => {
        const width = element.clientWidth,
          height = element.clientHeight;
        return () => {
          if (live && width && height)
            setSize((old) =>
              old.width === width && old.height === height ? old : { width, height },
            );
        };
      });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      live = false;
      observer.disconnect();
      cancelRenderFrame(key);
    };
  }, [ref, workspaceId]);
  return size;
}
export function CanvasGuides({
  guides,
  viewport,
}: {
  guides: Guide[];
  viewport: { x: number; y: number; zoom: number };
}) {
  useUiLocale();
  return (
    <svg className="canvas-align-guides" aria-hidden="true">
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        {guides.map((guide, i) => (
          <line
            key={i}
            x1={guide.axis === 'x' ? guide.at : guide.from}
            y1={guide.axis === 'x' ? guide.from : guide.at}
            x2={guide.axis === 'x' ? guide.at : guide.to}
            y2={guide.axis === 'x' ? guide.to : guide.at}
            stroke="#d38deb"
            strokeWidth="1"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
    </svg>
  );
}
type Item = Rect & { id: string };
export function CanvasNavigation({
  cards,
  marks,
  regions,
  view,
  selected,
  pan,
  panState,
  fit,
  fitSelection,
  createRegion,
  grid,
  setGrid,
  snap,
  setSnap,
  disabled,
  zoomControls,
}: {
  zoomControls?: React.ReactNode;
  cards: Item[];
  marks: Item[];
  regions: CanvasGroups['items'];
  view: Rect;
  selected: string[];
  pan: (point: { x: number; y: number }) => void;
  panState: (active: boolean) => void;
  fit: () => void;
  fitSelection: () => void;
  createRegion: () => void;
  grid: boolean;
  setGrid: (value: boolean) => void;
  snap: boolean;
  setSnap: (value: boolean) => void;
  disabled: boolean;
}) {
  useUiLocale();
  const [open, setOpen] = useState(() => {
      try {
        return localStorage.getItem('desktop:minimap') === 'on';
      } catch {
        return false;
      }
    }),
    drag = useRef<Rect | null>(null);
  const contentBounds = useMemo(
    () =>
      extent([
        ...cards,
        ...marks,
        ...regions.filter((group) => group.bounds).map((group) => group.bounds!),
      ]),
    [cards, marks, regions],
  );
  const bounds = contentBounds ? extent([contentBounds, view])! : view;
  const miniItems = useMemo(() => {
    const chosen = new Set(selected);
    return (
      <>
        {regions
          .filter((group) => group.bounds)
          .map((group) => (
            <rect
              key={'region:' + group.id}
              {...group.bounds}
              fill="#edf0f6"
              stroke="#cfd8e6"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {marks.map((mark) => (
          <rect
            key={'mark:' + mark.id}
            x={mark.x}
            y={mark.y}
            width={Math.max(8, mark.width)}
            height={Math.max(8, mark.height)}
            fill="#c6c1db"
          />
        ))}
        {cards.map((card) => (
          <rect
            key={'card:' + card.id}
            x={card.x}
            y={card.y}
            width={card.width}
            height={card.height}
            rx={Math.min(16, card.width / 8)}
            fill={chosen.has(card.id) ? '#5c8be5' : '#b1c0d5'}
          />
        ))}
      </>
    );
  }, [cards, marks, regions, selected]);
  const fitBox = (rect: Rect) => {
    const width = Math.max(640, rect.width + 180),
      height = Math.max(400, rect.height + 140),
      ratio = 190 / 120;
    return width / height > ratio
      ? {
          x: rect.x - 90,
          y: rect.y - (width / ratio - rect.height) / 2,
          width,
          height: width / ratio,
        }
      : {
          x: rect.x - (height * ratio - rect.width) / 2,
          y: rect.y - 70,
          width: height * ratio,
          height,
        };
  };
  const box = drag.current ?? fitBox(bounds);
  const row = useRef<HTMLDivElement>(null),
    [covering, setCovering] = useState(false),
    [lift, setLift] = useState(0);
  // The bottom selection bar grows with the selection; when it reaches this corner, stack above it instead of colliding.
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>('.intent-work-bar');
    if (!bar) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const own = row.current?.getBoundingClientRect(),
          dock = bar.getBoundingClientRect();
        if (!own || !dock.width) {
          setLift(0);
          return;
        }
        setLift(
          dock.right > own.left - 8 && dock.left < own.right + 8 ? Math.ceil(dock.height + 10) : 0,
        );
      });
    };
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    window.addEventListener('resize', check);
    check();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', check);
    };
  }, []);
  // Floating controls sit over the canvas; fade them when they would hide the card the user is working on.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const own = row.current?.getBoundingClientRect();
      if (!own) return;
      const hit = [...document.querySelectorAll('.react-flow__node.selected')].some((node) => {
        const r = node.getBoundingClientRect();
        return (
          r.right > own.left - 8 &&
          r.left < own.right + 8 &&
          r.bottom > own.top - 8 &&
          r.top < own.bottom + 8
        );
      });
      setCovering(hit);
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, view, cards]);
  function move(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect(),
      area = drag.current ?? box;
    pan({
      x: area.x + ((event.clientX - rect.left) / rect.width) * area.width,
      y: area.y + ((event.clientY - rect.top) / rect.height) * area.height,
    });
  }
  return (
    <aside
      className={`canvas-navigation nodrag nopan nowheel${covering ? ' is-covering' : ''}`}
      style={lift ? { transform: `translateY(-${lift}px)` } : undefined}
      data-canvas-toolbar
      aria-label={uiText('画布导航')}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {open && (
        <div className="canvas-minimap">
          <header>
            <span>{uiText('画布全览')}</span>
            <button
              title={uiText('适合所有内容')}
              aria-label={uiText('适合所有内容')}
              onClick={fit}
            >
              <Icon name="expand" size={12} />
            </button>
          </header>
          <svg
            className="canvas-minimap-map"
            viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
            aria-label={uiText('点击或拖动小地图移动视口')}
            role="img"
            onPointerDown={(event) => {
              if (event.button !== 0 || disabled) return;
              event.preventDefault();
              drag.current = box;
              panState(true);
              event.currentTarget.setPointerCapture(event.pointerId);
              move(event);
            }}
            onPointerMove={(event) => {
              if (drag.current) move(event);
            }}
            onPointerUp={(event) => {
              if (!drag.current) return;
              drag.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              panState(false);
            }}
            onPointerCancel={() => {
              drag.current = null;
              panState(false);
            }}
            onLostPointerCapture={() => {
              if (drag.current) {
                drag.current = null;
                panState(false);
              }
            }}
          >
            {miniItems}
            <rect
              {...view}
              fill="#4e8cf111"
              stroke="#6e99e5"
              strokeWidth="1.2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <footer>{uiText('拖动浏览 · F 定位选区')}</footer>
        </div>
      )}
      <div className="canvas-navigation-row" ref={row}>
        <div className="canvas-navigation-actions">
          <button
            title={open ? uiText('收起小地图') : uiText('显示小地图')}
            aria-label={uiText('小地图')}
            aria-pressed={open}
            onClick={() => {
              setOpen(!open);
              try {
                localStorage.setItem('desktop:minimap', open ? 'off' : 'on');
              } catch {}
            }}
          >
            <Icon name="compass" size={15} />
          </button>
          <button
            title={uiText('定位选区；无选区时显示全部')}
            aria-label={uiText('定位选区')}
            onClick={fitSelection}
          >
            <Icon name="expand" size={15} />
          </button>
          <button
            title={uiText('创建区域：包住选中内容；无选区时新建空区域')}
            aria-label={uiText('创建画布区域')}
            disabled={disabled}
            onClick={createRegion}
          >
            <Icon name="group" size={15} />
          </button>
          <button
            title={uiText('网格吸附')}
            aria-label={uiText('网格吸附')}
            aria-pressed={grid}
            onClick={() => setGrid(!grid)}
          >
            <Icon name="grid" size={15} />
          </button>
          <button
            title={uiText('智能对齐 · 按住 Alt 暂停吸附')}
            aria-label={uiText('智能对齐')}
            aria-pressed={snap}
            onClick={() => setSnap(!snap)}
          >
            <Icon name="align" size={15} />
          </button>
        </div>
        {zoomControls}
      </div>
    </aside>
  );
}
