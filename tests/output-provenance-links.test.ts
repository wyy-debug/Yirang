import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DesktopObject } from '../packages/contracts/index.js';
import {
  CanvasLinks,
  outputProvenanceLinks,
} from '../apps/panel/canvas/canvas-links.js';

test('generated output connects to visible sources and its curve follows the cards', () => {
  const source = { id: 'source', title: '预算规划.xlsx', revision: 1 };
  const other = { id: 'other', title: '业务需求.md', revision: 3 };
  const output = {
    id: 'output',
    title: '季度预算.xlsx',
    generation: { anchorSourceId: source.id, sources: [source, other] },
  };
  const objects = [source, other, output] as DesktopObject[];
  const links = outputProvenanceLinks(objects, new Set(), []);
  assert.deepEqual(links.map((link) => link.sourceId), ['source']);
  assert.deepEqual(
    outputProvenanceLinks(objects, new Set(), ['output']).map((link) => link.sourceId),
    ['source', 'other'],
  );
  assert.deepEqual(
    outputProvenanceLinks(objects, new Set(['source']), []).map((link) => link.sourceId),
    ['other'],
  );
  assert.deepEqual(outputProvenanceLinks(objects, new Set(['output']), []), []);

  const render = (x: number) =>
    renderToStaticMarkup(createElement('svg', null, createElement(CanvasLinks, {
      links,
      cards: [
        { id: source.id, title: source.title, x: 0, y: 0, width: 350, height: 300 },
        { id: output.id, title: output.title, x, y: 0, width: 400, height: 290 },
      ],
      zoom: 0.25,
      interactive: false,
      provenance: true,
    })));
  assert.match(render(406), /data-output-link=/);
  assert.match(render(406), /d="M 87\.5 36\.25 C .* 101\.5 36\.25"/);
  assert.match(render(486), /d="M 87\.5 36\.25 C .* 121\.5 36\.25"/);
  assert.doesNotMatch(render(406), /data-canvas-link=/);
});
