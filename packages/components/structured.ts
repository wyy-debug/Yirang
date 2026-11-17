import type { Diagram, Deck, Workbook, Table, DesktopObject } from '../contracts/index.js';
const uid = () => crypto.randomUUID();
export function blankTable(): Table {
  return {
    columns: ['项目', '说明', '数量'].map((label) => ({ id: uid(), label })),
    rows: [{ id: uid(), cells: ['', '', ''] }],
  };
}
export function blankDiagram(): Diagram {
  const nodes = [
    {
      id: uid(),
      text: '输入',
      x: 80,
      y: 220,
      width: 200,
      height: 100,
      shape: 'box' as const,
      color: '#e9f0e2',
    },
    {
      id: uid(),
      text: '处理',
      x: 390,
      y: 220,
      width: 200,
      height: 100,
      shape: 'box' as const,
      color: '#dce8d1',
    },
    {
      id: uid(),
      text: '结果',
      x: 700,
      y: 220,
      width: 200,
      height: 100,
      shape: 'box' as const,
      color: '#e9f0e2',
    },
  ];
  return {
    width: 1000,
    height: 600,
    nodes,
    edges: [
      { id: uid(), from: nodes[0].id, to: nodes[1].id, label: '' },
      { id: uid(), from: nodes[1].id, to: nodes[2].id, label: '' },
    ],
  };
}
export function blankSlide(
  layout: Deck['slides'][number]['layout'] = 'bullets',
): Deck['slides'][number] {
  return {
    id: uid(),
    layout,
    title: layout === 'title' ? '在这里，开始讲述' : '新的章节',
    subtitle: layout === 'title' ? '把想法整理成清晰的表达' : '',
    body: layout === 'title' ? '' : '第一项关键内容\n第二项关键内容\n下一步行动',
    secondary: '',
    notes: '',
  };
}
export function blankDeck(): Deck {
  return {
    title: '我的演示文稿',
    accent: '#365e4b',
    footer: '一壤工作桌面',
    slides: [blankSlide('title'), blankSlide('bullets')],
  };
}
export function blankWorkbook(): Workbook {
  return {
    title: '我的工作簿',
    formulas: false,
    sheets: [{ id: uid(), name: '工作表 1', table: blankTable(), formats: {} }],
  };
}
export const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
function lines(text: string, width: number) {
  const size = Math.max(3, Math.floor(width / 18));
  return text.split('\n').flatMap((line) => {
    const chars = Array.from(line);
    return chars.length
      ? Array.from({ length: Math.ceil(chars.length / size) }, (_, i) =>
          chars.slice(i * size, (i + 1) * size).join(''),
        )
      : [''];
  });
}
export function diagramSvg(d: Diagram) {
  const edges = d.edges
    .map((e) => {
      const a = d.nodes.find((n) => n.id === e.from)!,
        b = d.nodes.find((n) => n.id === e.to)!;
      const ax = a.x + a.width / 2,
        ay = a.y + a.height / 2,
        bx = b.x + b.width / 2,
        by = b.y + b.height / 2,
        dx = bx - ax,
        dy = by - ay;
      const ta = Math.min(
          a.width / 2 / (Math.abs(dx) || 1),
          a.height / 2 / (Math.abs(dy) || 1),
          0.45,
        ),
        tb = Math.min(b.width / 2 / (Math.abs(dx) || 1), b.height / 2 / (Math.abs(dy) || 1), 0.45);
      const x1 = ax + dx * ta,
        y1 = ay + dy * ta,
        x2 = bx - dx * tb,
        y2 = by - dy * tb;
      return `<g><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#8a9b7d" stroke-width="2" marker-end="url(#arrow)"/><text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 12}" text-anchor="middle" font-size="14" fill="#64745a">${xml(e.label)}</text></g>`;
    })
    .join('');
  const nodes = d.nodes
    .map((n) => {
      const shape =
        n.shape === 'ellipse'
          ? `<ellipse cx="${n.x + n.width / 2}" cy="${n.y + n.height / 2}" rx="${n.width / 2}" ry="${n.height / 2}"`
          : n.shape === 'diamond'
            ? `<polygon points="${n.x + n.width / 2},${n.y} ${n.x + n.width},${n.y + n.height / 2} ${n.x + n.width / 2},${n.y + n.height} ${n.x},${n.y + n.height / 2}"`
            : `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="10"`;
      const text = lines(n.text, n.width - 32).slice(0, Math.max(1, Math.floor(n.height / 24)));
      return `${shape} fill="${n.color}" stroke="#a1b28f" stroke-width="1.5"/><text text-anchor="middle" font-size="17" fill="#344c32">${text.map((l, i) => `<tspan x="${n.x + n.width / 2}" y="${n.y + n.height / 2 + (i - (text.length - 1) / 2) * 24 + 6}">${xml(l)}</tspan>`).join('')}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}"><rect width="100%" height="100%" fill="#f9fbf5"/><defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0 0 L10 4 L0 8" fill="#8a9b7d"/></marker></defs><g font-family="Segoe UI,Microsoft YaHei,sans-serif">${edges}${nodes}</g></svg>`;
}
export function annotationSvg(object: DesktopObject, dataUrl: string) {
  const c = object.content as { width: number; height: number; annotations: any[] };
  const drawings = c.annotations
    .map((a) => {
      const x = a.x * c.width,
        y = a.y * c.height,
        w = a.width * c.width,
        h = a.height * c.height;
      let shape = '';
      if (a.type === 'rect') shape = `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
      if (a.type === 'ellipse')
        shape = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"/>`;
      if (a.type === 'pen')
        shape = `<polyline points="${(a.points ?? []).map((p: any) => `${p.x * c.width},${p.y * c.height}`).join(' ')}" fill="none"/>`;
      if (a.type === 'arrow') {
        const p = a.points ?? [
          { x: a.x, y: a.y },
          { x: a.x + a.width, y: a.y + a.height },
        ];
        shape = `<line x1="${p[0].x * c.width}" y1="${p[0].y * c.height}" x2="${p[1].x * c.width}" y2="${p[1].y * c.height}" marker-end="url(#arrow)"/>`;
      }
      return (
        shape +
        (a.note
          ? `<text x="${x + 4}" y="${Math.max(20, y + (a.type === 'text' ? 22 : -8))}" fill="#9b5d24" stroke="none" font-size="${Math.max(16, c.width / 45)}">${xml(a.note)}</text>`
          : '')
      );
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}"><defs><marker id="arrow" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8" fill="#b87c38"/></marker></defs><image href="${dataUrl}" width="${c.width}" height="${c.height}"/><g font-family="Microsoft YaHei,Segoe UI,sans-serif" fill="#e6ba7020" stroke="#b87c38" stroke-width="3">${drawings}</g></svg>`;
}
