import { t as uiText } from '../../../packages/components/ui-language.js';
import { useEffect, useRef, useState } from 'react';
import {
  CanvasBoardSchema,
  CanvasBoardAction,
  type CanvasBoard,
  type CanvasMark,
  type CanvasLink,
} from '../../../packages/contracts/canvas-board.js';
import type { Workspace } from '../../../packages/contracts/index.js';
import type { CanvasHistoryStep } from './use-canvas-history.js';

type Body = Pick<CanvasBoard, 'items' | 'links'>;
type SaveRequest = Body & { operation: 'save'; expectedRevision: number; requestId: string };
type Session = {
  id: string;
  base: CanvasBoard;
  board: CanvasBoard;
  dirty: boolean;
  pending?: SaveRequest;
  undo: Body[];
  redo: Body[];
  job?: Promise<void>;
  error: string;
};
const empty: CanvasBoard = { revision: 0, items: [], links: [] };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const key = (id: string) => `ai-desktop:canvas-board:${id}`;

// Independent edits merge by item ID. Concurrent edits keep both drawings; concurrent
// delete/edit keeps the edited drawing so a reconnect cannot silently discard work.
function reconcile<T extends CanvasMark | CanvasLink>(
  base: T[],
  local: T[],
  remote: T[],
): { items: T[]; conflicts: number } {
  const before = new Map(base.map((item) => [item.id, item])),
    ours = new Map(local.map((item) => [item.id, item])),
    theirs = new Map(remote.map((item) => [item.id, item]));
  const result: T[] = [];
  let conflicts = 0;
  for (const id of new Set([...theirs.keys(), ...ours.keys(), ...before.keys()])) {
    const b = before.get(id),
      l = ours.get(id),
      r = theirs.get(id);
    if (same(l, b)) {
      if (r) result.push(r);
      continue;
    }
    if (same(r, b) || same(l, r)) {
      if (l) result.push(l);
      continue;
    }
    conflicts++;
    if (r) result.push(r);
    if (l) result.push({ ...l, id: r ? crypto.randomUUID() : l.id });
  }
  return { items: result, conflicts };
}

export function useCanvasBoard({
  workspace,
  action,
  notice,
  onHistory,
}: {
  workspace: Workspace | null;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  notice: (message: string) => void;
  onHistory?: (step: CanvasHistoryStep) => void;
}) {
  const ref = useRef<Session | null>(null),
    alive = useRef(true),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const actions = useRef(action),
    notices = useRef(notice);
  actions.current = action;
  notices.current = notice;
  const [view, setView] = useState({
    board: empty,
    status: 'saved' as 'saved' | 'saving' | 'error',
    error: '',
    canUndo: false,
    canRedo: false,
  });
  function publish(s: Session) {
    if (alive.current && ref.current === s)
      setView({
        board: s.board,
        status: s.error ? 'error' : s.dirty || s.pending ? 'saving' : 'saved',
        error: s.error,
        canUndo: s.undo.length > 0,
        canRedo: s.redo.length > 0,
      });
  }
  function backup(s: Session) {
    try {
      if (s.dirty || s.pending)
        localStorage.setItem(
          key(s.id),
          JSON.stringify({ base: s.base, board: s.board, pending: s.pending }),
        );
      else localStorage.removeItem(key(s.id));
    } catch {
      notices.current(uiText('画布草稿备份不可用，请保存后再关闭桌面。'));
    }
  }
  async function saveSession(s: Session) {
    if (s.job) return s.job;
    const run = async () => {
      s.error = '';
      publish(s);
      let conflictAttempts = 0;
      while (ref.current === s && (s.dirty || s.pending)) {
        const request = s.pending ?? {
          operation: 'save' as const,
          expectedRevision: s.base.revision,
          requestId: crypto.randomUUID(),
          items: s.board.items,
          links: s.board.links,
        };
        s.pending = request;
        backup(s);
        let result: CanvasBoard;
        try {
          result = await actions.current('canvas_board', request);
        } catch (error) {
          if (ref.current !== s) return;
          const code = (error as { code?: string })?.code;
          if (code === 'REVISION_CONFLICT') {
            if (++conflictAttempts > 3)
              throw new Error(uiText('画布正在另一面板持续更新，请稍后重试保存。'));
            const remote: CanvasBoard = await actions.current('canvas_board', {
              operation: 'read',
            });
            if (ref.current !== s) return;
            const marks = reconcile(s.base.items, s.board.items, remote.items),
              links = reconcile(s.base.links, s.board.links, remote.links);
            s.base = remote;
            s.board = { revision: remote.revision, items: marks.items, links: links.items };
            s.pending = undefined;
            s.dirty = true;
            s.undo = [];
            s.redo = [];
            backup(s);
            publish(s);
            if (marks.conflicts + links.conflicts)
              notices.current(uiText('画布有同时修改的内容，已保留两个版本供你整理。'));
            continue;
          }
          // A definite controller rejection may be corrected with a fresh request.
          // Unknown outcomes retain the original request ID for idempotent retry.
          if (code) s.pending = undefined;
          throw error;
        }
        if (ref.current !== s) return;
        const unchanged = same(
          { items: s.board.items, links: s.board.links },
          { items: request.items, links: request.links },
        );
        s.base = result;
        s.pending = undefined;
        s.dirty = !unchanged;
        s.board = unchanged ? result : { ...s.board, revision: result.revision };
        backup(s);
        publish(s);
      }
    };
    s.job = run()
      .catch((error) => {
        if (ref.current === s) {
          s.error = error instanceof Error ? error.message : String(error);
          backup(s);
          publish(s);
        }
        throw error;
      })
      .finally(() => {
        s.job = undefined;
      });
    return s.job;
  }
  function schedule(s: Session) {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (ref.current === s) void saveSession(s).catch(() => {});
    }, 650);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      if (ref.current) backup(ref.current);
    };
  }, []);
  useEffect(() => {
    clearTimeout(timer.current);
    if (!workspace) {
      ref.current = null;
      setView({ board: empty, status: 'saved', error: '', canUndo: false, canRedo: false });
      return;
    }
    const base = workspace.canvasBoard ?? empty;
    const s: Session = {
      id: workspace.id,
      base,
      board: base,
      dirty: false,
      undo: [],
      redo: [],
      error: '',
    };
    try {
      const cached = JSON.parse(localStorage.getItem(key(s.id)) ?? 'null');
      if (cached?.base && cached?.board) {
        s.base = CanvasBoardSchema.parse(cached.base);
        s.board = CanvasBoardSchema.parse(cached.board);
        const pending = cached.pending ? CanvasBoardAction.parse(cached.pending) : undefined;
        s.pending = pending?.operation === 'save' ? pending : undefined;
        s.dirty = true;
        notices.current(uiText('已恢复本地画布草稿，正在继续保存。'));
      }
    } catch {
      s.base = base;
      s.board = base;
      s.pending = undefined;
      s.dirty = false; /* The saved workspace remains authoritative if the cache is unreadable. */
    }
    ref.current = s;
    publish(s);
    if (s.dirty) schedule(s);
  }, [workspace?.id]);
  useEffect(() => {
    const s = ref.current,
      remote = workspace?.canvasBoard;
    if (
      s &&
      remote &&
      s.id === workspace?.id &&
      !s.dirty &&
      !s.pending &&
      remote.revision > s.base.revision
    ) {
      s.base = remote;
      s.board = remote;
      s.undo = [];
      s.redo = [];
      publish(s);
    }
  }, [workspace?.canvasBoard]);
  function change(next: Body, history = true) {
    const s = ref.current;
    if (!s || same({ items: s.board.items, links: s.board.links }, next)) return;
    const valid = CanvasBoardSchema.safeParse({ ...next, revision: s.base.revision });
    if (!valid.success) {
      notices.current(uiText('画布内容超出保存范围，请减少图形数量、文字长度或笔迹点数。'));
      return;
    }
    if (history) {
      const before = { items: s.board.items, links: s.board.links };
      s.undo = [...s.undo.slice(-39), before];
      s.redo = [];
      onHistory?.({
        check: (redo) => {
          if (
            ref.current !== s ||
            !same({ items: s.board.items, links: s.board.links }, redo ? before : next)
          )
            throw Error(uiText('图形已有后续修改，无法撤销这次操作。'));
        },
        apply: async (redo) => {
          change(redo ? next : before, false);
          await flush();
        },
      });
    }
    s.board = { ...next, revision: s.base.revision };
    s.dirty = true;
    s.error = '';
    backup(s);
    publish(s);
    schedule(s);
  }
  function undo() {
    const s = ref.current;
    if (!s?.undo.length) return;
    const previous = s.undo.pop()!;
    s.redo.push({ items: s.board.items, links: s.board.links });
    change(previous, false);
  }
  function redo() {
    const s = ref.current;
    if (!s?.redo.length) return;
    const next = s.redo.pop()!;
    s.undo.push({ items: s.board.items, links: s.board.links });
    change(next, false);
  }
  async function flush() {
    clearTimeout(timer.current);
    const s = ref.current;
    if (s && (s.dirty || s.pending || s.job)) {
      await saveSession(s);
      if (s.dirty || s.pending) await saveSession(s);
    }
  }
  return { ...view, change, undo, redo, flush };
}
