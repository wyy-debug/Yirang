import type { CanvasPoint } from './canvas-links.js';
import './canvas-board.css';

export type CanvasTool =
  | 'select'
  | 'hand'
  | 'rectangle'
  | 'diamond'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'pen'
  | 'text'
  | 'note'
  | 'eraser';
export type DraggedCard = { id: string; position: CanvasPoint };
export type CanvasBoardHandle = {
  cardDrag: (phase: 'start' | 'move' | 'end', card: DraggedCard) => void;
  removeMarks: (ids: string[]) => void;
  selectedMarks: () => string[];
};

export { CanvasToolbar } from './canvas-board-toolbar.js';
export type { CanvasToolbarProps } from './canvas-board-toolbar.js';
export { CanvasBoardLayer } from './canvas-board-layer.js';
export type { CanvasBoardLayerProps } from './canvas-board-layer.js';
