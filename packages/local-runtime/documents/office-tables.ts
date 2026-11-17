import type { OfficeShape } from '../../contracts/office.js';
import { child, type XmlNode } from './spreadsheet/xlsx-xml.js';
import { officeColor } from './office-formatting.js';

// DrawingML tables have their own graphic-frame transform and a physical
// column slot for every cell, including merge continuations.
export function tableShapes(
  table: XmlNode,
  frame: OfficeShape,
  shapeMap: Map<XmlNode, string>,
): OfficeShape[] {
  const cols = (child(table, 'tblGrid')?.children ?? [])
    .filter((n) => n.local === 'gridCol')
    .map((n) => Math.max(1, Number(n.attributes.w) || 1));
  const rows = table.children.filter((n) => n.local === 'tr'),
    heights = rows.map((n) => Math.max(1, Number(n.attributes.h) || 1));
  if (!cols.length || !rows.length) return [];
  const totalWidth = cols.reduce((a, b) => a + b, 0),
    totalHeight = heights.reduce((a, b) => a + b, 0),
    sx = frame.width / totalWidth,
    sy = frame.height / totalHeight;
  const cells: OfficeShape[] = [];
  let y = frame.y;
  rows.forEach((row, ri) => {
    let x = frame.x;
    row.children
      .filter((n) => n.local === 'tc')
      .forEach((cell, ci) => {
        if (ci >= cols.length) return;
        const merge =
          cell.attributes.hMerge === '1' ||
          cell.attributes.hMerge === 'true' ||
          cell.attributes.vMerge === '1' ||
          cell.attributes.vMerge === 'true';
        const id = `${frame.id}:cell:${ri}:${ci}`;
        shapeMap.set(cell, id);
        if (!merge) {
          const cp = child(cell, 'tcPr'),
            span = Math.max(1, Math.min(cols.length - ci, Number(cell.attributes.gridSpan) || 1)),
            rowSpan = Math.max(1, Math.min(rows.length - ri, Number(cell.attributes.rowSpan) || 1));
          const borders = Object.fromEntries(
            ['Top', 'Right', 'Bottom', 'Left'].map((side) => {
              const line = cp && child(cp, 'ln' + side[0]);
              const color = officeColor(line);
              return [
                'border' + side,
                color === 'none'
                  ? 'none'
                  : color
                    ? `${Number(line?.attributes.w ?? 9525) / 9525}px solid ${color}`
                    : undefined,
              ];
            }),
          );
          cells.push({
            id,
            name: `${frame.name} · 第 ${ri + 1} 行第 ${ci + 1} 列`,
            x,
            y,
            width: cols.slice(ci, ci + span).reduce((a, b) => a + b, 0) * sx,
            height: heights.slice(ri, ri + rowSpan).reduce((a, b) => a + b, 0) * sy,
            editable: false,
            fill: officeColor(cp),
            cell: true,
            padding: [
              Number(cp?.attributes.marT ?? 45720) / 9525,
              Number(cp?.attributes.marR ?? 91440) / 9525,
              Number(cp?.attributes.marB ?? 45720) / 9525,
              Number(cp?.attributes.marL ?? 91440) / 9525,
            ],
            verticalAlign:
              cp?.attributes.anchor === 'ctr'
                ? 'center'
                : cp?.attributes.anchor === 'b'
                  ? 'end'
                  : 'start',
            ...borders,
          });
        }
        x += cols[ci] * sx;
      });
    y += heights[ri] * sy;
  });
  return cells;
}
