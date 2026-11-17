import { useRef, useState } from 'react';

export type CanvasHistoryStep = {
  check: (redo: boolean) => void;
  apply: (redo: boolean) => void | Promise<void>;
};
// Changes committed in the same pointer-up belong to one gesture (cards + marks).
export function useCanvasHistory(
  workspaceId: string | undefined,
  report: (error: unknown) => void,
) {
  const state = useRef({
    scope: workspaceId,
    entries: [] as CanvasHistoryStep[][],
    index: 0,
    batch: false,
    busy: false,
  });
  const [, render] = useState(0),
    latestReport = useRef(report);
  latestReport.current = report;
  if (state.current.scope !== workspaceId)
    state.current = { scope: workspaceId, entries: [], index: 0, batch: false, busy: false };
  function record(step: CanvasHistoryStep) {
    const s = state.current;
    if (s.busy || !s.scope) return;
    if (s.batch) s.entries[s.index - 1].push(step);
    else {
      s.entries = [...s.entries.slice(0, s.index), [step]].slice(-40);
      s.index = s.entries.length;
      s.batch = true;
      queueMicrotask(() => {
        s.batch = false;
      });
    }
    render((n) => n + 1);
  }
  async function travel(redo = false) {
    const s = state.current;
    if (s.busy) return;
    const entry = s.entries[redo ? s.index : s.index - 1];
    if (!entry) return;
    s.busy = true;
    render((n) => n + 1);
    try {
      for (const step of entry) step.check(redo);
      for (const step of redo ? entry : [...entry].reverse()) {
        if (state.current !== s) return;
        await step.apply(redo);
      }
      if (state.current === s) s.index += redo ? 1 : -1;
    } catch (error) {
      latestReport.current(error);
    } finally {
      s.busy = false;
      render((n) => n + 1);
    }
  }
  return {
    record,
    undo: () => void travel(),
    redo: () => void travel(true),
    busy: state.current.busy,
    canUndo: state.current.index > 0,
    canRedo: state.current.index < state.current.entries.length,
  };
}
