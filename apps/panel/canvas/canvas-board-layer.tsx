import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { useStoreApi } from '@xyflow/react';
import { hasVisibleOverlay } from '../ui/visible-overlay.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { overlaps, extent, type Rect } from '../../../packages/components/canvas-spatial.js';
import type { CanvasBoard, CanvasMark } from '../../../packages/contracts/canvas-board.js';
import {
  CanvasLinks,
  cardAtPoint,
  shortLinkGeometry,
  type CanvasLinkCard,
  type CanvasLink,
  type CanvasPoint,
} from './canvas-links.js';
import type { CanvasBoardHandle, CanvasTool, DraggedCard } from './canvas-board.js';
import {
  clamp,
  hitMark,
  MarkContent,
  MarkHit,
  normalizeStroke,
  pointDistance,
  textLines,
} from './mark-geometry.js';
import { tools } from './canvas-board-toolbar.js';
import { ToolIcon } from './tool-icon.js';

import './canvas-board.css';

type BoardContent = Pick<CanvasBoard, 'items' | 'links'>;
type Selection = { kind: 'mark'; ids: string[] } | { kind: 'link'; id: string };
type CardPosition = { id: string; x: number; y: number };

type Viewport = { x: number; y: number; zoom: number };

const editable = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest("input,textarea,select,[contenteditable='true'],[role='dialog']");
const uid = () => `canvas-${crypto.randomUUID()}`;

type Gesture = {
  pointerId: number;
  start: CanvasPoint;
  type: 'draw' | 'move' | 'erase' | 'link';
  mark?: CanvasMark;
  preview?: CanvasMark;
  marks?: CanvasMark[];
  moved?: CanvasMark[];
  cards?: CardPosition[];
  movedCards?: CardPosition[];
  sourceId?: string;
  current?: CanvasPoint;
  targetId?: string;
  removedMarks: Set<string>;
  removedLinks: Set<string>;
};
type Editing = { mark: CanvasMark; value: string; isNew: boolean };
export type CanvasBoardLayerProps = {
  board: CanvasBoard;
  viewport: Viewport;
  cards: CanvasLinkCard[];
  outputLinks?: CanvasLink[];
  tool: CanvasTool;
  setTool: (tool: CanvasTool) => void;
  stroke: string;
  fill: string;
  strokeWidth: number;
  disabled?: boolean;
  onChange: (next: BoardContent) => void;
  onNotice?: (message: string) => void;
  selectedCardIds: string[];
  onSelectCards: (ids: string[]) => void;
  onMoveCards: (positions: CardPosition[], phase: 'preview' | 'commit' | 'cancel') => void;
  onDeleteMixed: (cardIds: string[], markIds: string[]) => void;
  hiddenMarks?: Set<string>;
  presentationMarks?: CanvasMark[];
  visibleRect?: Rect;
  snap?: (bounds: Rect, exclude: string[], bypass: boolean) => { dx: number; dy: number };
  clearGuides?: () => void;
};

export const CanvasBoardLayer = forwardRef<CanvasBoardHandle, CanvasBoardLayerProps>(
  function CanvasBoardLayer(props, handle) {
    useUiLocale();
    const {
      board,
      viewport,
      cards,
      tool,
      setTool,
      stroke,
      fill,
      strokeWidth,
      disabled,
      onChange,
      onNotice,
    } = props;
    const root = useRef<HTMLDivElement>(null),
      svg = useRef<SVGSVGElement>(null),
      latest = useRef(props);
    latest.current = props;
    const gesture = useRef<Gesture | null>(null),
      editorInput = useRef<HTMLTextAreaElement>(null);
    const [selection, setSelectionState] = useState<Selection | null>(null),
      selectionRef = useRef<Selection | null>(null),
      [draft, setDraft] = useState<CanvasMark | null>(null),
      [movedMarks, setMovedMarks] = useState<CanvasMark[]>([]);
    const flowStore = useStoreApi(),
      additivePointer = useRef(false),
      marquee = useRef<{
        ids: string[];
        cardIds: string[];
        additive: boolean;
        start: CanvasPoint;
      } | null>(null);
    const cardMove = useRef<{ anchor: DraggedCard; marks: CanvasMark[] } | null>(null);
    function setSelection(next: Selection | null) {
      if (next?.kind === 'mark' && !next.ids.length) next = null;
      const old = selectionRef.current;
      if (
        (old?.kind === 'mark' &&
          next?.kind === 'mark' &&
          old.ids.length === next.ids.length &&
          old.ids.every((id, index) => id === next.ids[index])) ||
        old === next
      )
        return;
      selectionRef.current = next;
      setSelectionState(next);
    }
    const [erased, setErased] = useState<{ marks: Set<string>; links: Set<string> }>({
      marks: new Set(),
      links: new Set(),
    });
    const [linkDraft, setLinkDraft] = useState<{
      sourceId: string;
      point: CanvasPoint;
      targetId?: string;
    } | null>(null);
    const [editing, setEditing] = useState<Editing | null>(null),
      [linkLabel, setLinkLabel] = useState('');
    const arrowId = `canvas-mark-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const selectedIds = new Set(selection?.kind === 'mark' ? selection.ids : []),
      selectedMarks = board.items.filter((item) => selectedIds.has(item.id));
    const selectedMark = selectedMarks.length === 1 ? selectedMarks[0] : undefined;
    const selectedLink =
      selection?.kind === 'link' ? board.links.find((item) => item.id === selection.id) : undefined;
    const active = tool !== 'select' && tool !== 'hand' && !disabled && !editing,
      zoom = Math.max(0.01, viewport.zoom);
    const sourceCard = linkDraft ? cards.find((card) => card.id === linkDraft.sourceId) : undefined;
    const targetCard = linkDraft?.targetId
      ? cards.find((card) => card.id === linkDraft.targetId)
      : undefined;

    function updateMark(mark: CanvasMark, isNew = false) {
      const current = latest.current.board;
      if (isNew && current.items.length >= 2000) {
        onNotice?.(uiText('画布元素已达 2000 个，请先删除不需要的图形。'));
        return;
      }
      onChange({
        items: isNew
          ? [...current.items, mark]
          : current.items.map((item) => (item.id === mark.id ? mark : item)),
        links: current.links,
      });
    }
    function deleteSelection() {
      const selected = selectionRef.current;
      if (!selected || latest.current.disabled) return;
      if (selected.kind === 'mark' && latest.current.selectedCardIds.length) {
        latest.current.onDeleteMixed(latest.current.selectedCardIds, selected.ids);
        return;
      }
      const current = latest.current.board;
      onChange({
        items: current.items.filter(
          (item) => selected.kind !== 'mark' || !selected.ids.includes(item.id),
        ),
        links: current.links.filter((item) => selected.kind !== 'link' || item.id !== selected.id),
      });
      setSelection(null);
    }
    function cancelGesture(restoreCards = true) {
      const pending = gesture.current;
      gesture.current = null;
      if (restoreCards && pending?.cards?.length)
        latest.current.onMoveCards(pending.cards, 'cancel');
      if (pending && svg.current?.hasPointerCapture(pending.pointerId))
        svg.current.releasePointerCapture(pending.pointerId);
      setDraft(null);
      setMovedMarks((previous) => (previous.length ? [] : previous));
      setLinkDraft(null);
      setErased((previous) =>
        previous.marks.size || previous.links.size
          ? { marks: new Set(), links: new Set() }
          : previous,
      );
      latest.current.clearGuides?.();
    }
    useEffect(() => {
      if (selection?.kind === 'mark')
        setSelection({
          kind: 'mark',
          ids: selection.ids.filter(
            (id) => !props.hiddenMarks?.has(id) && board.items.some((item) => item.id === id),
          ),
        });
      else if (selection && !board.links.some((item) => item.id === selection.id))
        setSelection(null);
    }, [board.items, board.links, selection, props.hiddenMarks]);
    useEffect(() => {
      setLinkLabel(selectedLink?.label ?? '');
    }, [selectedLink?.id, selectedLink?.label]);
    useEffect(() => {
      if (editing) {
        editorInput.current?.focus();
        editorInput.current?.setSelectionRange(editing.value.length, editing.value.length);
      }
    }, [editing?.mark.id]);
    useEffect(() => {
      cancelGesture();
    }, [tool, disabled]);
    // Switching tools finishes the current note without losing its text.
    useEffect(() => {
      if (editing && tool !== 'select' && !disabled) saveText();
    }, [tool]);
    useEffect(() => {
      const clear = (event: PointerEvent) => {
        const target = event.target as Element | null;
        if (event.button !== 0 || !target?.closest) return;
        additivePointer.current = event.shiftKey || event.ctrlKey || event.metaKey;
        if (
          target.closest(
            '[data-canvas-board],[data-canvas-toolbar],[data-desktop-overlay],[role="dialog"]',
          )
        )
          return;
        if (target.closest('.react-flow__nodesselection') && latest.current.selectedCardIds.length)
          return;
        const cardId = target.closest('.react-flow__node')?.getAttribute('data-id');
        if (cardId && latest.current.selectedCardIds.includes(cardId)) return;
        if (additivePointer.current && target.closest('.react-flow')) return;
        setSelection(null);
      };
      window.addEventListener('pointerdown', clear, true);
      return () => window.removeEventListener('pointerdown', clear, true);
    }, []);
    // React Flow owns the marquee. Apply that same rectangle to the SVG drawing layer.
    // Store subscription also receives the final rectangle before React batches pointer-up.
    useEffect(() => {
      function selectBox(
        box: { x: number; y: number; width: number; height: number },
        transform: number[],
      ) {
        const state = latest.current,
          session = marquee.current;
        if (!session || state.disabled || state.tool !== 'select') return;
        const [x, y, scale] = transform,
          left = (box.x - x) / scale,
          top = (box.y - y) / scale,
          right = left + box.width / scale,
          bottom = top + box.height / scale;
        const hits = state.board.items
          .filter(
            (item) =>
              !state.hiddenMarks?.has(item.id) &&
              item.x >= left &&
              item.y >= top &&
              item.x + item.width <= right &&
              item.y + item.height <= bottom,
          )
          .map((item) => item.id);
        setSelection({
          kind: 'mark',
          ids: [...new Set([...(session.additive ? session.ids : []), ...hits])],
        });
      }
      const unsubscribe = flowStore.subscribe((state, previous) => {
        const rect = state.userSelectionRect;
        if (rect && !previous.userSelectionRect) {
          const selected = selectionRef.current;
          marquee.current = {
            ids: selected?.kind === 'mark' ? selected.ids : [],
            cardIds: [...latest.current.selectedCardIds],
            additive: additivePointer.current,
            start: { x: rect.startX, y: rect.startY },
          };
        }
        if (
          rect &&
          state.userSelectionActive &&
          (rect !== previous.userSelectionRect || state.transform !== previous.transform)
        )
          selectBox(rect, state.transform);
        if (!rect && previous.userSelectionRect) {
          if (previous.userSelectionActive) {
            const box = previous.userSelectionRect,
              [x, y, scale] = previous.transform;
            selectBox(box, previous.transform);
            const left = (box.x - x) / scale,
              top = (box.y - y) / scale,
              right = left + box.width / scale,
              bottom = top + box.height / scale;
            const cards = latest.current.cards
                .filter(
                  (card) =>
                    card.x >= left &&
                    card.y >= top &&
                    card.x + card.width <= right &&
                    card.y + card.height <= bottom,
                )
                .map((card) => card.id),
              session = marquee.current;
            latest.current.onSelectCards([
              ...new Set([...(session?.additive ? session.cardIds : []), ...cards]),
            ]);
          }
          marquee.current = null;
        }
      });
      // Include the release position even if the last move event was coalesced.
      const finish = (event: PointerEvent) => {
        const state = flowStore.getState(),
          session = marquee.current;
        if (event.button !== 0 || !session || !state.userSelectionActive || !state.domNode) return;
        const bounds = state.domNode.getBoundingClientRect(),
          [x, y, scale] = state.transform,
          start = { x: session.start.x * scale + x, y: session.start.y * scale + y },
          end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        const rect = {
          ...state.userSelectionRect!,
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        };
        flowStore.setState({ userSelectionRect: rect });
      };
      window.addEventListener('pointerup', finish, true);
      return () => {
        unsubscribe();
        window.removeEventListener('pointerup', finish, true);
      };
    }, [flowStore]);
    function commitMoved(marks: CanvasMark[]) {
      const positions = new Map(marks.map((mark) => [mark.id, mark]));
      const current = latest.current.board;
      latest.current.onChange({
        items: current.items.map((item) => {
          const moved = positions.get(item.id);
          return moved ? { ...item, x: moved.x, y: moved.y } : item;
        }),
        links: current.links,
      });
    }
    useImperativeHandle(handle, () => ({
      selectedMarks() {
        return selectionRef.current?.kind === 'mark' ? [...selectionRef.current.ids] : [];
      },
      removeMarks(ids) {
        const current = latest.current.board;
        latest.current.onChange({
          items: current.items.filter((item) => !ids.includes(item.id)),
          links: current.links,
        });
        setSelection(null);
      },
      cardDrag(phase, card) {
        if (phase === 'start') {
          if (cardMove.current || latest.current.disabled) return;
          const selected = selectionRef.current;
          if (selected?.kind !== 'mark') return;
          cardMove.current = {
            anchor: { id: card.id, position: { ...card.position } },
            marks: latest.current.board.items.filter((mark) => selected.ids.includes(mark.id)),
          };
          return;
        }
        const start = cardMove.current;
        if (!start || card.id !== start.anchor.id) return;
        const dx = card.position.x - start.anchor.position.x,
          dy = card.position.y - start.anchor.position.y;
        const marks = start.marks.map((mark) => ({
          ...mark,
          x: clamp(mark.x + dx, -100000, 100000),
          y: clamp(mark.y + dy, -100000, 100000),
        }));
        if (phase === 'end') {
          cardMove.current = null;
          commitMoved(marks);
          setMovedMarks([]);
        } else setMovedMarks(marks);
      },
    }));
    useEffect(() => {
      const keyboard = (event: KeyboardEvent) => {
        if (
          editable(event.target) ||
          disabled ||
          !root.current?.checkVisibility({ checkVisibilityCSS: true }) ||
          hasVisibleOverlay()
        )
          return;
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.key.toLowerCase() === 'a' &&
          (event.target as Element)?.closest?.('.canvas')
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setSelection({
            kind: 'mark',
            ids: latest.current.board.items
              .filter((mark) => !latest.current.hiddenMarks?.has(mark.id))
              .map((mark) => mark.id),
          });
          latest.current.onSelectCards(latest.current.cards.map((card) => card.id));
          return;
        }
        if (event.key === 'Escape' && (selection || gesture.current)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          cancelGesture();
          setSelection(null);
          latest.current.onSelectCards([]);
          setTool('select');
        }
        if (
          (event.key === 'Delete' || event.key === 'Backspace') &&
          selection &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          deleteSelection();
        }
      };
      window.addEventListener('keydown', keyboard, true);
      return () => window.removeEventListener('keydown', keyboard, true);
    }, [selection, disabled]);
    function pointAt(event: { clientX: number; clientY: number }): CanvasPoint {
      const rect = root.current!.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left - viewport.x) / zoom, -100000, 100000),
        y: clamp((event.clientY - rect.top - viewport.y) / zoom, -100000, 100000),
      };
    }
    function capture(
      event: React.PointerEvent,
      request: Omit<Gesture, 'pointerId' | 'removedMarks' | 'removedLinks'>,
    ) {
      event.preventDefault();
      event.stopPropagation();
      root.current?.parentElement?.focus({ preventScroll: true });
      gesture.current = {
        ...request,
        pointerId: event.pointerId,
        removedMarks: new Set(),
        removedLinks: new Set(),
      };
      svg.current?.setPointerCapture(event.pointerId);
    }
    function eraseAt(point: CanvasPoint) {
      const current = gesture.current;
      if (!current) return;
      const state = latest.current,
        tolerance = 9 / Math.max(0.01, state.viewport.zoom);
      for (const item of state.board.items)
        if (!state.hiddenMarks?.has(item.id) && hitMark(item, point, tolerance))
          current.removedMarks.add(item.id);
      for (const link of state.board.links) {
        const source = state.cards.find((card) => card.id === link.sourceId),
          target = state.cards.find((card) => card.id === link.targetId);
        const geometry = source && target ? shortLinkGeometry(source, target) : null;
        if (geometry && pointDistance(point, geometry.start, geometry.end) <= tolerance)
          current.removedLinks.add(link.id);
      }
      setErased({ marks: new Set(current.removedMarks), links: new Set(current.removedLinks) });
    }
    function beginSurface(event: React.PointerEvent) {
      if (disabled || editing || event.button !== 0 || tool === 'select' || tool === 'hand') return;
      const point = pointAt(event);
      setSelection(null);
      if (tool === 'eraser') {
        capture(event, { type: 'erase', start: point });
        eraseAt(point);
        return;
      }
      if (tool === 'arrow') {
        const source = cardAtPoint(cards, point);
        if (source) {
          capture(event, { type: 'link', start: point, sourceId: source.id, current: point });
          setLinkDraft({ sourceId: source.id, point });
          return;
        }
      }
      const mark: CanvasMark = {
        id: uid(),
        kind: tool as CanvasMark['kind'],
        x: point.x,
        y: point.y,
        width: 0,
        height: 0,
        stroke,
        fill,
        strokeWidth,
      };
      if (tool === 'text' || tool === 'note') {
        event.preventDefault();
        event.stopPropagation();
        mark.width = tool === 'note' ? 220 : 260;
        mark.height = tool === 'note' ? 170 : 54;
        setEditing({ mark, value: '', isNew: true });
        setTool('select');
        return;
      }
      if (tool === 'pen' || tool === 'arrow' || tool === 'line') mark.points = [{ x: 0, y: 0 }];
      capture(event, { type: 'draw', start: point, mark });
      setDraft(mark);
    }
    function beginMark(event: React.PointerEvent, mark: CanvasMark) {
      if (disabled || editing || event.button !== 0) return;
      if (tool === 'eraser') {
        beginSurface(event);
        return;
      }
      if (tool !== 'select') return;
      root.current?.parentElement?.focus({ preventScroll: true });
      const selected = selectionRef.current,
        ids = selected?.kind === 'mark' ? selected.ids : [],
        alreadySelected = ids.includes(mark.id);
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        setSelection({
          kind: 'mark',
          ids: alreadySelected ? ids.filter((id) => id !== mark.id) : [...ids, mark.id],
        });
        return;
      }
      const next = alreadySelected ? ids : [mark.id];
      setSelection({ kind: 'mark', ids: next });
      if (!alreadySelected) latest.current.onSelectCards([]);
      const movingCards = alreadySelected
        ? latest.current.cards
            .filter((card) => latest.current.selectedCardIds.includes(card.id))
            .map(({ id, x, y }) => ({ id, x, y }))
        : [];
      capture(event, {
        type: 'move',
        start: pointAt(event),
        mark,
        marks: latest.current.board.items.filter((item) => next.includes(item.id)),
        cards: movingCards,
      });
    }
    function movePointer(event: React.PointerEvent) {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const point = pointAt(event);
      current.current = point;
      if (current.type === 'erase') {
        eraseAt(point);
        return;
      }
      if (current.type === 'link') {
        current.targetId = cardAtPoint(cards, point, current.sourceId)?.id;
        setLinkDraft({ sourceId: current.sourceId!, point, targetId: current.targetId });
        return;
      }
      const mark = current.mark!;
      if (current.type === 'move') {
        const marks = current.marks ?? [mark],
          positions = [...marks, ...(current.cards ?? [])];
        let dx = point.x - current.start.x,
          dy = point.y - current.start.y;
        const originalCards = (current.cards ?? []).map((initial) => {
          const card = cards.find((card) => card.id === initial.id);
          return { ...initial, width: card?.width ?? 0, height: card?.height ?? 0 };
        });
        const bounds = extent([...marks, ...originalCards]);
        if (bounds) {
          const correction = latest.current.snap?.(
            { ...bounds, x: bounds.x + dx, y: bounds.y + dy },
            positions.map((item) => item.id),
            event.altKey,
          );
          dx += correction?.dx ?? 0;
          dy += correction?.dy ?? 0;
        }
        dx = clamp(
          dx,
          Math.max(...positions.map((item) => -100000 - item.x)),
          Math.min(...positions.map((item) => 100000 - item.x)),
        );
        dy = clamp(
          dy,
          Math.max(...positions.map((item) => -100000 - item.y)),
          Math.min(...positions.map((item) => 100000 - item.y)),
        );
        current.moved = marks.map((item) => ({ ...item, x: item.x + dx, y: item.y + dy }));
        setMovedMarks(current.moved);
        current.movedCards = current.cards?.map((card) => ({
          ...card,
          x: card.x + dx,
          y: card.y + dy,
        }));
        if (current.movedCards?.length) latest.current.onMoveCards(current.movedCards, 'preview');
        return;
      }
      if (mark.kind === 'pen') {
        let points = mark.points!;
        const local = { x: point.x - mark.x, y: point.y - mark.y },
          last = points[points.length - 1];
        if (Math.hypot(local.x - last.x, local.y - last.y) < 1.5 / zoom) return;
        if (points.length >= 1999) points = points.filter((_, index) => index % 2 === 0);
        current.mark = { ...mark, points: [...points, local] };
        current.preview = current.mark;
        setDraft(current.mark);
        return;
      }
      let dx = point.x - current.start.x,
        dy = point.y - current.start.y;
      if (event.shiftKey) {
        if (mark.kind === 'line' || mark.kind === 'arrow') {
          const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4),
            length = Math.hypot(dx, dy);
          dx = Math.cos(angle) * length;
          dy = Math.sin(angle) * length;
        } else {
          const side = Math.max(Math.abs(dx), Math.abs(dy));
          dx = Math.sign(dx || 1) * side;
          dy = Math.sign(dy || 1) * side;
        }
      }
      dx = clamp(current.start.x + dx, -50000, 50000) - current.start.x;
      dy = clamp(current.start.y + dy, -50000, 50000) - current.start.y;
      const next =
        mark.kind === 'line' || mark.kind === 'arrow'
          ? {
              ...mark,
              points: [
                { x: 0, y: 0 },
                { x: dx, y: dy },
              ],
              width: Math.abs(dx),
              height: Math.abs(dy),
            }
          : {
              ...mark,
              x: Math.min(current.start.x, current.start.x + dx),
              y: Math.min(current.start.y, current.start.y + dy),
              width: Math.abs(dx),
              height: Math.abs(dy),
            };
      current.preview = next;
      setDraft(next);
    }
    function endPointer(event: React.PointerEvent) {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      // Flush the pointer-up coordinates too; React's last rendered preview may trail the pointer.
      movePointer(event);
      const currentBoard = latest.current.board,
        completedDraft = current.preview ?? draft ?? current.mark;
      if (current.type === 'erase') {
        if (current.removedMarks.size || current.removedLinks.size)
          onChange({
            items: currentBoard.items.filter((item) => !current.removedMarks.has(item.id)),
            links: currentBoard.links.filter((link) => !current.removedLinks.has(link.id)),
          });
      } else if (current.type === 'link') {
        const target = cardAtPoint(cards, pointAt(event), current.sourceId);
        if (target) {
          const exists = currentBoard.links.find(
            (link) => link.sourceId === current.sourceId && link.targetId === target.id,
          );
          if (exists) {
            setSelection({ kind: 'link', id: exists.id });
            onNotice?.(uiText('这两个文件已经连接。'));
          } else if (currentBoard.links.length >= 4000)
            onNotice?.(uiText('文件连线已达 4000 条，请先删除不需要的连线。'));
          else {
            const link = {
              id: uid(),
              sourceId: current.sourceId!,
              targetId: target.id,
              label: '',
              arrow: true,
            };
            onChange({ items: currentBoard.items, links: [...currentBoard.links, link] });
            setSelection({ kind: 'link', id: link.id });
          }
        } else onNotice?.(uiText('从一份文件拖到另一份文件，即可创建短连线。'));
        setTool('select');
      } else if (current.type === 'move') {
        if (current.moved?.length) commitMoved(current.moved);
        if (current.movedCards?.length) latest.current.onMoveCards(current.movedCards, 'commit');
      } else if (completedDraft) {
        let completed = completedDraft;
        if (completed.kind === 'pen' || completed.kind === 'line' || completed.kind === 'arrow') {
          if (!completed.points || completed.points.length < 2) {
            cancelGesture();
            return;
          }
          completed = normalizeStroke(completed);
          if ((completed.width + completed.height) * zoom < 2) {
            cancelGesture();
            return;
          }
        } else if (completed.width * zoom < 4 && completed.height * zoom < 4)
          completed = { ...completed, width: 140, height: 100 };
        else
          completed = {
            ...completed,
            width: Math.max(12, completed.width),
            height: Math.max(12, completed.height),
          };
        updateMark(completed, true);
        setSelection({ kind: 'mark', ids: [completed.id] });
        if (tool !== 'pen') setTool('select');
      }
      cancelGesture(false);
    }
    function editMark(mark: CanvasMark) {
      if (disabled || editing || ['line', 'arrow', 'pen'].includes(mark.kind)) return;
      setEditing({ mark, value: mark.text ?? '', isNew: false });
      setSelection(null);
      setTool('select');
    }
    function saveText() {
      if (!editing || disabled) return;
      const value = editing.value.slice(0, 20000);
      if (editing.isNew && !value.trim()) {
        setEditing(null);
        return;
      }
      const lines = textLines(value, editing.mark.width - 8);
      const mark = {
        ...editing.mark,
        text: value,
        height:
          editing.mark.kind === 'text'
            ? Math.max(36, lines.length * 22 + 8)
            : Math.max(editing.mark.height, lines.length * 22 + 32),
      };
      updateMark(mark, editing.isNew);
      setEditing(null);
      setSelection({ kind: 'mark', ids: [mark.id] });
    }
    function saveLabel() {
      if (!selectedLink || disabled || linkLabel === selectedLink.label) return;
      onChange({
        items: board.items,
        links: board.links.map((link) =>
          link.id === selectedLink.id ? { ...link, label: linkLabel.trim().slice(0, 200) } : link,
        ),
      });
    }
    const movingById = new Map(
      [...movedMarks, ...(props.presentationMarks ?? [])].map((mark) => [mark.id, mark]),
    );
    const renderedItems = board.items
      .filter(
        (item) =>
          !props.hiddenMarks?.has(item.id) &&
          !erased.marks.has(item.id) &&
          item.id !== editing?.mark.id,
      )
      .map((item) => movingById.get(item.id) ?? (draft?.id === item.id ? draft : item))
      .filter(
        (item) =>
          !props.visibleRect ||
          selectedIds.has(item.id) ||
          overlaps(
            { ...item, width: Math.max(1, item.width), height: Math.max(1, item.height) },
            props.visibleRect,
            100 / zoom,
          ),
      );
    if (draft && !renderedItems.some((item) => item.id === draft.id)) renderedItems.push(draft);
    const selectedBounds = selectedMarks.length
      ? (() => {
          const x = Math.min(...selectedMarks.map((mark) => mark.x)),
            y = Math.min(...selectedMarks.map((mark) => mark.y));
          return {
            x,
            y,
            width: Math.max(...selectedMarks.map((mark) => mark.x + mark.width)) - x,
            height: Math.max(...selectedMarks.map((mark) => mark.y + mark.height)) - y,
          };
        })()
      : null;
    const linkedGeometry = selectedLink
      ? (() => {
          const source = cards.find((card) => card.id === selectedLink.sourceId),
            target = cards.find((card) => card.id === selectedLink.targetId);
          return source && target ? shortLinkGeometry(source, target) : null;
        })()
      : null;
    const anchor = selectedBounds
      ? { x: selectedBounds.x + selectedBounds.width / 2, y: selectedBounds.y }
      : linkedGeometry?.label;
    const editorPosition = editing
      ? {
          left: clamp(
            viewport.x + editing.mark.x * zoom,
            12,
            Math.max(
              12,
              (root.current?.clientWidth ?? 800) -
                Math.max(220, Math.min(720, editing.mark.width * zoom)) -
                12,
            ),
          ),
          top: clamp(
            viewport.y + editing.mark.y * zoom,
            74,
            Math.max(74, (root.current?.clientHeight ?? 600) - 220),
          ),
        }
      : null;
    const hint =
      tool === 'hand'
        ? uiText('拖动画布 · V 返回选择 · 滚轮缩放')
        : tool === 'arrow'
          ? uiText('拖动连接两个文件 · 空白处绘制箭头')
          : tool === 'eraser'
            ? uiText('拖动擦除图形和连线 · 文件保持不变')
            : tool === 'pen'
              ? uiText('按住拖动画线 · Esc 返回选择')
              : tool !== 'select'
                ? uiText('拖动绘制 · Shift 保持比例 · Esc 返回选择')
                : '';
    return (
      <div
        ref={root}
        className={`canvas-board-layer canvas-tool-${tool}${disabled ? ' is-disabled' : ''}`}
        data-canvas-board
      >
        <svg
          ref={svg}
          className="canvas-board-svg"
          onPointerMove={movePointer}
          onPointerUp={endPointer}
          onPointerCancel={() => cancelGesture()}
          onLostPointerCapture={() => {
            if (gesture.current) cancelGesture();
          }}
        >
          <defs>
            <marker
              id={arrowId}
              markerWidth="9"
              markerHeight="9"
              refX="8"
              refY="4.5"
              viewBox="0 0 9 9"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path
                d="m1 1 7 3.5L1 8"
                fill="none"
                stroke="context-stroke"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          </defs>
          {active && (
            <rect
              width="100%"
              height="100%"
              fill="transparent"
              pointerEvents="all"
              onPointerDown={beginSurface}
            />
          )}
          {!!props.outputLinks?.length && (
            <CanvasLinks
              viewport={viewport}
              visibleRect={props.visibleRect}
              links={props.outputLinks}
              cards={cards}
              zoom={zoom}
              interactive={false}
              provenance
            />
          )}
          <CanvasLinks
            viewport={viewport}
            visibleRect={props.visibleRect}
            links={board.links.filter((link) => !erased.links.has(link.id))}
            cards={cards}
            selectedId={selection?.kind === 'link' ? selection.id : null}
            zoom={zoom}
            interactive={!disabled && (tool === 'select' || tool === 'eraser')}
            onSelect={(id) => {
              if (tool === 'select') setSelection({ kind: 'link', id });
            }}
            onPointerDown={(id, event) => {
              if (tool === 'eraser') beginSurface(event);
              else {
                event.stopPropagation();
                setSelection({ kind: 'link', id });
              }
            }}
          />
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${zoom})`}>
            {renderedItems.map((mark) => (
              <g
                key={mark.id}
                transform={`translate(${mark.x} ${mark.y})`}
                className={`canvas-mark nodrag nopan${selectedIds.has(mark.id) ? ' is-selected' : ''}`}
                data-canvas-mark={mark.id}
                pointerEvents={
                  !disabled && (tool === 'select' || tool === 'eraser') ? 'all' : 'none'
                }
                onPointerDown={(event) => beginMark(event, mark)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  editMark(mark);
                }}
              >
                <title>{mark.text || tools.find((item) => item.id === mark.kind)?.label}</title>
                {!disabled && (tool === 'select' || tool === 'eraser') && (
                  <MarkHit
                    mark={mark}
                    zoom={zoom}
                    selected={tool === 'select' && selectedIds.has(mark.id)}
                  />
                )}
                <g pointerEvents="none">
                  <MarkContent mark={mark} arrowId={arrowId} />
                </g>
                {selectedIds.has(mark.id) && !editing && (
                  <rect
                    x={-5 / zoom}
                    y={-5 / zoom}
                    width={Math.max(1, mark.width) + 10 / zoom}
                    height={Math.max(1, mark.height) + 10 / zoom}
                    fill="none"
                    stroke="#2879e7"
                    strokeWidth="1"
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                )}
              </g>
            ))}
            {sourceCard && (
              <>
                <rect
                  x={sourceCard.x - 3 / zoom}
                  y={sourceCard.y - 3 / zoom}
                  width={sourceCard.width + 6 / zoom}
                  height={sourceCard.height + 6 / zoom}
                  rx={10 / zoom}
                  fill="none"
                  stroke="#8b83ec"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
                {targetCard && (
                  <rect
                    x={targetCard.x - 3 / zoom}
                    y={targetCard.y - 3 / zoom}
                    width={targetCard.width + 6 / zoom}
                    height={targetCard.height + 6 / zoom}
                    rx={10 / zoom}
                    fill="none"
                    stroke="#8b83ec"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                )}
                <path
                  d={
                    targetCard
                      ? (shortLinkGeometry(sourceCard, targetCard)?.d ?? '')
                      : `M ${sourceCard.x + sourceCard.width / 2} ${sourceCard.y + sourceCard.height / 2} L ${linkDraft!.point.x} ${linkDraft!.point.y}`
                  }
                  fill="none"
                  stroke="#8b83ec"
                  strokeWidth="1.5"
                  strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              </>
            )}
          </g>
        </svg>
        {hint && <div className="canvas-board-hint">{hint}</div>}
        {selection && anchor && !editing && !disabled && !movedMarks.length && !marquee.current && (
          <div
            className="canvas-selection-tools nodrag nopan nowheel"
            style={{
              left: clamp(
                viewport.x + anchor.x * zoom,
                180,
                Math.max(180, (root.current?.clientWidth ?? 800) - 180),
              ),
              top: Math.max(78, viewport.y + anchor.y * zoom - 48),
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {selectedLink ? (
              <>
                <input
                  aria-label={uiText('连线名称')}
                  placeholder={uiText('添加简短说明…')}
                  maxLength={200}
                  value={linkLabel}
                  onChange={(event) => setLinkLabel(event.target.value)}
                  onBlur={saveLabel}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveLabel();
                      event.currentTarget.blur();
                    }
                  }}
                />
                <button
                  type="button"
                  title={selectedLink.arrow ? uiText('改为无箭头连线') : uiText('改为箭头连线')}
                  aria-label={
                    selectedLink.arrow ? uiText('改为无箭头连线') : uiText('改为箭头连线')
                  }
                  onClick={() =>
                    onChange({
                      items: board.items,
                      links: board.links.map((link) =>
                        link.id === selectedLink.id ? { ...link, arrow: !link.arrow } : link,
                      ),
                    })
                  }
                >
                  <ToolIcon name={selectedLink.arrow ? 'arrow' : 'line'} />
                </button>
              </>
            ) : (
              <>
                <span>
                  {selectedMarks.length > 1
                    ? uiText('已选择 {0} 个图形', { '0': selectedMarks.length })
                    : (tools.find((item) => item.id === selectedMark?.kind)?.label ??
                      uiText('图形'))}
                  {props.selectedCardIds.length
                    ? uiText(' · {0} 份材料', { '0': props.selectedCardIds.length })
                    : ''}
                </span>
                {selectedMark && !['pen', 'line', 'arrow'].includes(selectedMark.kind) && (
                  <button
                    type="button"
                    title={uiText('编辑文字')}
                    aria-label={uiText('编辑文字')}
                    onClick={() => editMark(selectedMark)}
                  >
                    <ToolIcon name="edit" />
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="is-danger"
              title={uiText('删除所选内容')}
              aria-label={uiText('删除所选内容')}
              onClick={deleteSelection}
            >
              <ToolIcon name="trash" />
            </button>
            <button
              type="button"
              title={uiText('取消选择')}
              aria-label={uiText('取消选择')}
              onClick={() => {
                setSelection(null);
                latest.current.onSelectCards([]);
              }}
            >
              <ToolIcon name="close" />
            </button>
          </div>
        )}
        {editing && editorPosition && (
          <div
            className="canvas-text-editor nodrag nopan nowheel"
            style={{
              ...editorPosition,
              width: Math.max(220, editing.mark.width * zoom),
              minHeight: Math.max(110, editing.mark.height * zoom),
              background:
                editing.mark.kind === 'note'
                  ? editing.mark.fill === 'transparent'
                    ? '#fff3b0'
                    : editing.mark.fill
                  : 'var(--paper,#fff)',
              color: editing.mark.stroke,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <textarea
              ref={editorInput}
              aria-label={editing.mark.kind === 'note' ? uiText('便签内容') : uiText('图形文字')}
              placeholder={editing.mark.kind === 'note' ? uiText('写下想法…') : uiText('输入文字…')}
              value={editing.value}
              maxLength={20000}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
              style={{
                minHeight: Math.max(65, editing.mark.height * zoom - 40),
                fontSize: clamp(16 * zoom, 12, 24),
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(null);
                } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  saveText();
                }
              }}
            />
            <footer>
              <span>{uiText('Ctrl + Enter 完成')}</span>
              <button type="button" onClick={() => setEditing(null)}>
                {uiText('取消')}
              </button>
              <button
                type="button"
                className="canvas-text-done"
                onClick={saveText}
                disabled={disabled}
              >
                {uiText('完成')}
              </button>
            </footer>
          </div>
        )}
      </div>
    );
  },
);
