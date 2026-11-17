import { useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Node } from '@xyflow/react';
import {
  extent,
  snapRect,
  type Guide,
  type Rect,
} from '../../../packages/components/canvas-spatial.js';
import type { DesktopObject } from '../../../packages/contracts/index.js';
import type { CardData } from './object-card.js';
import type { CanvasBoardHandle } from './canvas-board.js';
import type { useCanvasBoard } from './use-canvas-board.js';
import type { useCanvasRegions } from './use-canvas-regions.js';
import type { useFrameViewport } from './use-frame-viewport.js';

export type LayoutChange = { objectId: string; bounds: DesktopObject['bounds'] };

/**
 * Card dragging on the canvas: snapping against neighbours, guide rendering
 * and the persist-on-drop bookkeeping. The desktop container owns the state
 * this reads; everything here is render-pure except the passed-in callbacks.
 */
export function useCardDrag(deps: {
  snapEnabled: boolean;
  gridEnabled: boolean;
  canvasCards: (Rect & { id: string })[];
  drawing: ReturnType<typeof useCanvasBoard>;
  regions: ReturnType<typeof useCanvasRegions>;
  viewport: ReturnType<typeof useFrameViewport>;
  canvasHistory: { busy: boolean };
  boardRef: { current: CanvasBoardHandle | null };
  setNodes: Dispatch<SetStateAction<Node<CardData>[]>>;
  recordCardMove: (before: LayoutChange[], after: LayoutChange[]) => void;
  persistView: (changes?: LayoutChange[]) => Promise<void> | void;
}) {
  const {
    snapEnabled,
    gridEnabled,
    canvasCards,
    drawing,
    regions,
    viewport,
    canvasHistory,
    boardRef,
    setNodes,
    recordCardMove,
    persistView,
  } = deps;
  const [guides, setGuides] = useState<Guide[]>([]);
  const cardDragStart = useRef<{
    anchor: { x: number; y: number };
    marks: ReturnType<typeof useCanvasBoard>['board']['items'];
    before: LayoutChange[];
  } | null>(null);
  function snapCanvas(bounds: Rect, exclude: string[], bypass: boolean) {
    if (bypass || (!snapEnabled && !gridEnabled)) {
      setGuides([]);
      return { dx: 0, dy: 0 };
    }
    const skip = new Set(exclude),
      others = snapEnabled
        ? [
            ...canvasCards,
            ...drawing.board.items.filter((mark) => !regions.collapsed.marks.has(mark.id)),
          ].filter((item) => !skip.has(item.id))
        : [];
    const result = snapRect(bounds, others, viewport.zoom, gridEnabled);
    setGuides(result.guides);
    return result;
  }
  function dragCard(
    event: MouseEvent | TouchEvent,
    node: Node<CardData>,
    dragged: Node<CardData>[],
    phase: 'start' | 'move' | 'end',
  ) {
    if (phase === 'start') {
      if (canvasHistory.busy) return;
      const ids = boardRef.current?.selectedMarks() ?? [];
      cardDragStart.current = {
        anchor: { ...node.position },
        marks: drawing.board.items.filter((mark) => ids.includes(mark.id)),
        before: (dragged.length ? dragged : [node]).map((item) => ({
          objectId: item.id,
          bounds: { ...item.data.object.bounds, ...item.position },
        })),
      };
      boardRef.current?.cardDrag('start', node);
      return;
    }
    const moving = dragged.length ? dragged : [node],
      start = cardDragStart.current;
    const marks =
      start?.marks.map((mark) => ({
        ...mark,
        x: mark.x + node.position.x - start.anchor.x,
        y: mark.y + node.position.y - start.anchor.y,
      })) ?? [];
    const cards = moving.map((item) => ({
        ...item.data.object.bounds,
        ...item.position,
        id: item.id,
      })),
      bounds = extent([...cards, ...marks]);
    const correction = bounds
      ? snapCanvas(
          bounds,
          [...moving.map((item) => item.id), ...marks.map((mark) => mark.id)],
          'altKey' in event && event.altKey,
        )
      : { dx: 0, dy: 0 };
    const all = [...cards, ...marks],
      dx = Math.max(
        Math.max(...all.map((item) => -100000 - item.x)),
        Math.min(Math.min(...all.map((item) => 100000 - item.x)), correction.dx),
      ),
      dy = Math.max(
        Math.max(...all.map((item) => -100000 - item.y)),
        Math.min(Math.min(...all.map((item) => 100000 - item.y)), correction.dy),
      );
    const adjusted = moving.map((item) => ({
        ...item,
        position: { x: item.position.x + dx, y: item.position.y + dy },
      })),
      byId = new Map(adjusted.map((item) => [item.id, item.position]));
    setNodes((current) =>
      current.map((item) =>
        byId.has(item.id)
          ? { ...item, position: byId.get(item.id)!, dragging: phase !== 'end' }
          : item,
      ),
    );
    boardRef.current?.cardDrag(phase, {
      id: node.id,
      position: { x: node.position.x + dx, y: node.position.y + dy },
    });
    if (phase === 'end') {
      cardDragStart.current = null;
      setGuides([]);
      const after = adjusted.map((item) => ({
        objectId: item.id,
        bounds: { ...item.data.object.bounds, ...item.position },
      }));
      if (start) recordCardMove(start.before, after);
      void persistView(after);
    }
  }
  return { guides, setGuides, snapCanvas, dragCard };
}
