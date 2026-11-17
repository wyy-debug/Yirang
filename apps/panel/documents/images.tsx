import React, { useEffect, useId, useRef, useState } from 'react';
import type { DesktopObject, RectAnnotation } from '../../../packages/contracts/index.js';
export type AnnotationTool = RectAnnotation['type'];
type Point = { x: number; y: number };
export function ImagePreview({
  object,
  annotate,
  tool = 'rect',
  note = '',
  selectedId,
  choose,
}: {
  object: DesktopObject;
  annotate?: (a: RectAnnotation) => void;
  tool?: AnnotationTool;
  note?: string;
  selectedId?: string;
  choose?: (id: string) => void;
}) {
  const content = object.content as {
    width: number;
    height: number;
    annotations: RectAnnotation[];
  };
  const [drawing, setDrawing] = useState<RectAnnotation | null>(null);
  const points = useRef<Point[]>([]);
  const current = useRef<RectAnnotation | null>(null);
  const pointer = useRef<number | null>(null);
  useEffect(() => {
    current.current = null;
    points.current = [];
    pointer.current = null;
    setDrawing(null);
  }, [object.id, tool, !!annotate]);
  const marker = `arrow-${useId().replace(/:/g, '')}`;
  function point(e: React.PointerEvent) {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  function build(end: Point): RectAnnotation {
    const start = points.current[0];
    if (tool === 'pen' && points.current.length < 500) points.current.push(end);
    const path = tool === 'pen' ? points.current : [start, end];
    const x = Math.min(...path.map((p) => p.x)),
      y = Math.min(...path.map((p) => p.y));
    return {
      id: current.current?.id ?? crypto.randomUUID(),
      type: tool,
      x,
      y,
      width: Math.max(0.001, Math.max(...path.map((p) => p.x)) - x),
      height: Math.max(0.001, Math.max(...path.map((p) => p.y)) - y),
      note,
      points: tool === 'pen' || tool === 'arrow' ? [...path] : undefined,
    };
  }
  function show(a: RectAnnotation) {
    const xy = { x: a.x * 1000, y: a.y * 1000, width: a.width * 1000, height: a.height * 1000 };
    return (
      <g
        key={a.id}
        className={choose && !annotate ? 'annotation-hit' : undefined}
        onClick={
          choose && !annotate
            ? (event) => {
                event.stopPropagation();
                choose(a.id);
              }
            : undefined
        }
      >
        {choose && !annotate && (
          <rect
            className="annotation-hit-area"
            x={Math.max(0, xy.x - 5)}
            y={Math.max(0, xy.y - 5)}
            width={Math.max(12, xy.width + 10)}
            height={Math.max(12, xy.height + 10)}
            fill="transparent"
            stroke="none"
          />
        )}
        {a.type === 'ellipse' ? (
          <ellipse
            cx={xy.x + xy.width / 2}
            cy={xy.y + xy.height / 2}
            rx={xy.width / 2}
            ry={xy.height / 2}
          />
        ) : a.type === 'pen' ? (
          <polyline
            points={a.points?.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ')}
            fill="none"
          />
        ) : a.type === 'arrow' ? (
          <line
            x1={(a.points?.[0]?.x ?? a.x) * 1000}
            y1={(a.points?.[0]?.y ?? a.y) * 1000}
            x2={(a.points?.[1]?.x ?? a.x + a.width) * 1000}
            y2={(a.points?.[1]?.y ?? a.y + a.height) * 1000}
            markerEnd={`url(#${marker})`}
          />
        ) : a.type === 'text' ? null : (
          <rect {...xy} />
        )}
        {a.note && (
          <text
            x={xy.x + 4}
            y={Math.max(22, xy.y + (a.type === 'text' ? 22 : -8))}
            fill="#9b5d24"
            stroke="none"
            fontSize="22"
          >
            {a.note}
          </text>
        )}
        {selectedId === a.id && (
          <rect
            x={Math.max(0, xy.x - 5)}
            y={Math.max(0, xy.y - 5)}
            width={Math.max(12, xy.width + 10)}
            height={Math.max(12, xy.height + 10)}
            fill="none"
            stroke="#5087a0"
            strokeDasharray="6 4"
            strokeWidth="3"
          />
        )}
      </g>
    );
  }
  return (
    <div
      className={`image-wrap ${annotate || choose ? 'nodrag nopan' : ''} ${annotate ? 'drawing' : ''}`}
      style={{ aspectRatio: `${content.width}/${content.height}` }}
      onPointerDown={(e) => {
        if (!annotate || e.button !== 0 || pointer.current !== null) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        pointer.current = e.pointerId;
        points.current = [point(e)];
        current.current = build(points.current[0]);
        setDrawing(current.current);
      }}
      onPointerMove={(e) => {
        if (!annotate || !current.current || pointer.current !== e.pointerId) return;
        current.current = build(point(e));
        setDrawing(current.current);
      }}
      onPointerUp={(e) => {
        if (!annotate || !current.current || pointer.current !== e.pointerId) return;
        const a = build(point(e));
        if (tool === 'text' ? !!note.trim() : a.width > 0.005 || a.height > 0.005) annotate(a);
        current.current = null;
        points.current = [];
        pointer.current = null;
        setDrawing(null);
      }}
      onPointerCancel={() => {
        current.current = null;
        points.current = [];
        pointer.current = null;
        setDrawing(null);
      }}
    >
      <img src={object.dataUrl} alt={object.title} draggable={false} />
      <svg
        className="annotation-layer"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <marker
            id={marker}
            markerWidth="9"
            markerHeight="9"
            refX="7"
            refY="4"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L8,4 L0,8" fill="none" stroke="#b87c38" strokeWidth="1.5" />
          </marker>
        </defs>
        <g
          stroke="#b87c38"
          strokeWidth="2.5"
          fill="#e6ba7018"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          {content.annotations.map(show)}
          {drawing && show(drawing)}
        </g>
      </svg>
    </div>
  );
}
