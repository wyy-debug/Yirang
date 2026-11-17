import { t as uiText } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import type { CanvasMark } from '../../../packages/contracts/canvas-board.js';
import type { CanvasPoint } from './canvas-links.js';

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function pointDistance(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint) {
  const dx = end.x - start.x,
    dy = end.y - start.y,
    length = dx * dx + dy * dy;
  const ratio = length
    ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1)
    : 0;
  return Math.hypot(point.x - start.x - ratio * dx, point.y - start.y - ratio * dy);
}

function markPoints(mark: CanvasMark): CanvasPoint[] {
  return mark.points?.length
    ? mark.points
    : [
        { x: 0, y: 0 },
        { x: mark.width, y: mark.height },
      ];
}

export function hitMark(mark: CanvasMark, point: CanvasPoint, tolerance: number) {
  const local = { x: point.x - mark.x, y: point.y - mark.y };
  if (mark.kind === 'pen' || mark.kind === 'line' || mark.kind === 'arrow') {
    const points = markPoints(mark);
    return points.length === 1
      ? Math.hypot(local.x - points[0].x, local.y - points[0].y) <= tolerance
      : points.some(
          (p, i) =>
            i > 0 && pointDistance(local, points[i - 1], p) <= tolerance + mark.strokeWidth / 2,
        );
  }
  if (
    mark.fill === 'transparent' &&
    (mark.kind === 'rectangle' || mark.kind === 'diamond' || mark.kind === 'ellipse')
  ) {
    const w = mark.width,
      h = mark.height;
    if (mark.kind === 'ellipse') {
      const rx = Math.max(0.1, w / 2),
        ry = Math.max(0.1, h / 2),
        distance = Math.hypot((local.x - rx) / rx, (local.y - ry) / ry);
      return Math.abs(distance - 1) * Math.min(rx, ry) <= tolerance + mark.strokeWidth / 2;
    }
    const corners =
      mark.kind === 'diamond'
        ? [
            { x: w / 2, y: 0 },
            { x: w, y: h / 2 },
            { x: w / 2, y: h },
            { x: 0, y: h / 2 },
          ]
        : [
            { x: 0, y: 0 },
            { x: w, y: 0 },
            { x: w, y: h },
            { x: 0, y: h },
          ];
    return corners.some(
      (start, index) =>
        pointDistance(local, start, corners[(index + 1) % corners.length]) <=
        tolerance + mark.strokeWidth / 2,
    );
  }
  return (
    local.x >= -tolerance &&
    local.x <= mark.width + tolerance &&
    local.y >= -tolerance &&
    local.y <= mark.height + tolerance
  );
}

export function normalizeStroke(mark: CanvasMark): CanvasMark {
  const points = markPoints(mark),
    xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const minX = Math.min(...xs),
    minY = Math.min(...ys),
    maxX = Math.max(...xs),
    maxY = Math.max(...ys);
  return {
    ...mark,
    x: mark.x + minX,
    y: mark.y + minY,
    width: maxX - minX,
    height: maxY - minY,
    points: points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
  };
}

export function textLines(text: string, width: number, maxLines = 200) {
  const limit = Math.max(2, Math.floor(width / 8.5)),
    rows: string[] = [];
  for (const line of text.split('\n')) {
    let part = '',
      count = 0;
    for (const char of Array.from(line)) {
      const weight = /[\u0000-\u007f]/.test(char) ? 1 : 1.8;
      if (count + weight > limit && part) {
        rows.push(part);
        part = '';
        count = 0;
      }
      part += char;
      count += weight;
      if (rows.length >= maxLines) return rows;
    }
    rows.push(part);
    if (rows.length >= maxLines) return rows;
  }
  return rows;
}

export function MarkContent({ mark, arrowId }: { mark: CanvasMark; arrowId: string }) {
  useUiLocale();
  const { kind, width: w, height: h, stroke, fill, strokeWidth, text = '' } = mark;
  const shared = { stroke, fill, strokeWidth, strokeLinejoin: 'round' as const };
  const points = markPoints(mark),
    path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const padding = kind === 'text' ? 2 : 16,
    lines = textLines(
      text,
      Math.max(30, w - padding * 2),
      Math.max(1, Math.floor((h - padding * 2) / 22)),
    );
  return (
    <>
      {kind === 'rectangle' && <rect width={w} height={h} rx="5" {...shared} />}
      {kind === 'diamond' && (
        <path d={`M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`} {...shared} />
      )}
      {kind === 'ellipse' && <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...shared} />}
      {kind === 'note' && (
        <>
          <rect
            width={w}
            height={h}
            rx="5"
            fill={fill === 'transparent' ? '#fff3b0' : fill}
            stroke={stroke}
            strokeOpacity=".13"
            strokeWidth="1"
          />
          <path
            d={`M ${w - 22} ${h} L ${w - 22} ${h - 22} L ${w} ${h - 22}`}
            fill="#00000008"
            stroke={stroke}
            strokeOpacity=".12"
          />
        </>
      )}
      {kind === 'text' && fill !== 'transparent' && (
        <rect width={w} height={h} rx="3" fill={fill} />
      )}
      {(kind === 'line' || kind === 'arrow' || kind === 'pen') && (
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          markerEnd={kind === 'arrow' ? `url(#${arrowId})` : undefined}
        />
      )}
      {text && (
        <text
          x={padding}
          y={padding + 17}
          fill={stroke}
          stroke="none"
          fontSize="16"
          fontFamily="inherit"
          style={{ userSelect: 'none' }}
        >
          {lines.map((line, index) => (
            <tspan key={index} x={padding} dy={index ? 22 : 0}>
              {line || ' '}
            </tspan>
          ))}
        </text>
      )}
      {kind === 'text' && !text && (
        <text x="2" y="20" fill={stroke} opacity=".4" fontSize="16">
          {uiText('文字')}
        </text>
      )}
    </>
  );
}

export function MarkHit({
  mark,
  zoom,
  selected = false,
}: {
  mark: CanvasMark;
  zoom: number;
  selected?: boolean;
}) {
  useUiLocale();
  const w = mark.width,
    h = mark.height,
    outline = {
      fill: !selected && mark.fill === 'transparent' ? 'none' : 'transparent',
      stroke: 'transparent',
      strokeWidth: Math.max(mark.strokeWidth, 14 / zoom),
      pointerEvents: 'visiblePainted' as const,
    };
  if (mark.kind === 'rectangle') return <rect width={w} height={h} rx="5" {...outline} />;
  if (mark.kind === 'diamond')
    return <path d={`M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`} {...outline} />;
  if (mark.kind === 'ellipse')
    return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...outline} />;
  if (mark.kind === 'text' || mark.kind === 'note')
    return (
      <rect
        x="-4"
        y="-4"
        width={Math.max(8, w + 8)}
        height={Math.max(8, h + 8)}
        fill="transparent"
        stroke="none"
        pointerEvents="all"
      />
    );
  return (
    <path
      d={markPoints(mark)
        .map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`)
        .join(' ')}
      stroke="transparent"
      strokeWidth={Math.max(mark.strokeWidth, 14 / zoom)}
      fill="none"
      pointerEvents="stroke"
    />
  );
}
