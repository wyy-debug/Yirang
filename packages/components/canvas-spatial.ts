export type Rect = { x: number; y: number; width: number; height: number };
export type Guide = { axis: 'x' | 'y'; at: number; from: number; to: number };
export const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.width + gap &&
  a.x + a.width + gap > b.x &&
  a.y < b.y + b.height + gap &&
  a.y + a.height + gap > b.y;
export const contains = (a: Rect, b: Rect) =>
  b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
export function extent(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}
// Callers may pass a full rect; only its size is used and x/y are always replaced.
export function freePosition(
  size: { width: number; height: number; x?: number; y?: number },
  occupied: Rect[],
  view?: Rect,
  source?: Rect,
): Rect {
  const center = view ?? { x: 0, y: 0, width: 1400, height: 900 };
  const clear = (candidate: Rect) =>
    candidate.x >= -100000 &&
    candidate.y >= -100000 &&
    candidate.x + size.width <= 100000 &&
    candidate.y + size.height <= 100000 &&
    !occupied.some((other) => overlaps(candidate, other, 24));
  const inView = (area: Rect, preferred: { x: number; y: number }): Rect | undefined => {
    const left = Math.max(-100000, area.x + 20),
      right = Math.min(100000 - size.width, area.x + area.width - size.width - 20),
      top = Math.max(-100000, area.y + 20),
      bottom = Math.min(100000 - size.height, area.y + area.height - size.height - 20);
    if (left > right || top > bottom) return;
    const nearby = occupied.filter((item) => overlaps(item, area, 24));
    const ys = [
      ...new Set([
        top,
        bottom,
        Math.max(top, Math.min(bottom, preferred.y)),
        ...nearby.flatMap((item) => [item.y - size.height - 24, item.y + item.height + 24]),
      ]),
    ]
      .filter((y) => y >= top && y <= bottom)
      .sort((a, b) => Math.abs(a - preferred.y) - Math.abs(b - preferred.y));
    for (const y of ys) {
      const row = nearby.filter(
        (item) => y < item.y + item.height + 24 && y + size.height + 24 > item.y,
      );
      const xs = [
        left,
        right,
        Math.max(left, Math.min(right, preferred.x)),
        ...row.flatMap((item) => [item.x - size.width - 24, item.x + item.width + 24]),
      ]
        .filter((x) => x >= left && x <= right)
        .sort((a, b) => Math.abs(a - preferred.x) - Math.abs(b - preferred.x));
      for (const x of xs) {
        const candidate = { ...size, x, y };
        if (clear(candidate)) return candidate;
      }
    }
  };
  if (source) {
    const adjacent = [
      { ...size, x: source.x + source.width + 56, y: source.y },
      { ...size, x: source.x - size.width - 56, y: source.y },
      { ...size, x: source.x, y: source.y + source.height + 80 },
      { ...size, x: source.x, y: source.y - size.height - 56 },
    ];
    // Sources remain the anchor even if the user has panned elsewhere.
    const visible = adjacent.find((candidate) => contains(center, candidate) && clear(candidate)),
      near = visible ?? adjacent.find(clear);
    if (near) return near;
    const around = inView(
      {
        x: source.x - size.width * 2,
        y: source.y - size.height * 2,
        width: source.width + size.width * 4,
        height: source.height + size.height * 4,
      },
      adjacent[0],
    );
    if (around) return around;
  }
  const visible = inView(center, {
    x: center.x + (center.width - size.width) / 2,
    y: center.y + (center.height - size.height) / 2,
  });
  if (visible) return visible;
  // The viewport can be full or smaller than a card. Continue into nearby free space.
  const origin = source
    ? { x: source.x + source.width + 56, y: source.y }
    : {
        x: center.x + Math.max(24, (center.width - size.width) / 2),
        y: center.y + Math.max(24, (center.height - size.height) / 2),
      };
  origin.x = Math.max(-100000, Math.min(100000 - size.width, origin.x));
  origin.y = Math.max(-100000, Math.min(100000 - size.height, origin.y));
  const stepX = size.width + 40,
    stepY = size.height + 64;
  for (let ring = 0; ring < 150; ring++)
    for (let y = -ring; y <= ring; y++)
      for (let x = -ring; x <= ring; x++) {
        if (ring && Math.abs(x) !== ring && Math.abs(y) !== ring) continue;
        const candidate = {
          ...size,
          x: Math.round(origin.x + x * stepX),
          y: Math.round(origin.y + y * stepY),
        };
        if (clear(candidate)) return candidate;
      }
  throw Error('附近没有足够的空白位置，请整理画布后重试收回。');
}
export function snapRect(
  rect: Rect,
  others: Rect[],
  zoom: number,
  grid = false,
): { dx: number; dy: number; guides: Guide[] } {
  const threshold = 6 / Math.max(0.1, zoom),
    guides: Guide[] = [];
  let dx = 0,
    dy = 0;
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height',
      otherAxis = axis === 'x' ? 'y' : 'x',
      otherSize = axis === 'x' ? 'height' : 'width';
    let best = threshold + 0.001,
      delta = 0,
      guide: Guide | undefined;
    for (const target of others) {
      if (
        target[otherAxis] > rect[otherAxis] + rect[otherSize] + 240 / zoom ||
        rect[otherAxis] > target[otherAxis] + target[otherSize] + 240 / zoom
      )
        continue;
      for (const a of [0, 0.5, 1])
        for (const b of [0, 0.5, 1]) {
          const at = target[axis] + target[size] * b,
            d = at - (rect[axis] + rect[size] * a);
          if (Math.abs(d) < best) {
            best = Math.abs(d);
            delta = d;
            guide = {
              axis,
              at,
              from: Math.min(rect[otherAxis], target[otherAxis]) - 12 / zoom,
              to:
                Math.max(rect[otherAxis] + rect[otherSize], target[otherAxis] + target[otherSize]) +
                12 / zoom,
            };
          }
        }
    }
    if (!guide && grid) {
      delta = Math.round(rect[axis] / 24) * 24 - rect[axis];
      if (Math.abs(delta) > threshold) delta = 0;
    }
    if (axis === 'x') dx = delta;
    else dy = delta;
    if (guide) guides.push(guide);
  }
  return { dx, dy, guides };
}
