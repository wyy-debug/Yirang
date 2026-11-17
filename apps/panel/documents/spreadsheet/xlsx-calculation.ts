import { useEffect, useRef, useState } from 'react';
import {
  cellPosition,
  type SheetEdit,
  type StructureEdit,
  type XlsxCalculation,
  type XlsxPage,
} from '../../../../packages/contracts/xlsx.js';

type CalculationRequest = {
  objectId: string;
  expectedRevision: number;
  sheetId: string;
  row: number;
  column: number;
  rows: number;
  columns: number;
  edits: SheetEdit[];
  operations: StructureEdit[];
};
const emptyResult: XlsxCalculation = { cells: {}, issues: 0 };

// Only request the occupied part of this page. All draft edits are retained so
// formulas can still resolve dependencies on other pages and worksheets.
export function xlsxCalculationRequest(
  page: XlsxPage,
  edits: SheetEdit[],
  operations: StructureEdit[],
): CalculationRequest | null {
  const values = new Map(
    Object.entries(page.cells)
      .filter(([, cell]) => cell.input !== '' || cell.formula)
      .map(([address]) => [address, true]),
  );
  for (const edit of edits)
    if (edit.sheetId === page.sheetId && edit.value !== undefined)
      values.set(edit.address, edit.value !== '');
  let top = Infinity,
    left = Infinity,
    bottom = 0,
    right = 0;
  for (const [address, occupied] of values) {
    if (!occupied) continue;
    const at = cellPosition(address);
    if (
      !at ||
      at.row < page.row ||
      at.row >= page.row + page.rows ||
      at.column < page.column ||
      at.column >= page.column + page.columns ||
      page.hiddenRows?.includes(at.row) ||
      page.hiddenColumns?.includes(at.column)
    )
      continue;
    top = Math.min(top, at.row);
    left = Math.min(left, at.column);
    bottom = Math.max(bottom, at.row);
    right = Math.max(right, at.column);
  }
  return bottom
    ? {
        objectId: page.objectId,
        expectedRevision: page.revision,
        sheetId: page.sheetId,
        row: top,
        column: left,
        rows: bottom - top + 1,
        columns: right - left + 1,
        edits,
        operations,
      }
    : null;
}

// The transport cannot abort a dispatched MCP call. Keep one in flight and one
// replaceable, debounced successor, and only publish the latest request's result.
export function useXlsxCalculation(
  request: CalculationRequest | null,
  paused: boolean,
  calculate: (request: CalculationRequest) => Promise<XlsxCalculation>,
) {
  const latest = useRef(request),
    pause = useRef(paused),
    calculateRef = useRef(calculate),
    mounted = useRef(false);
  const queued = useRef<CalculationRequest | null>(null),
    running = useRef<CalculationRequest | null>(null);
  const [flight, setFlight] = useState<CalculationRequest | null>(null);
  const [completed, setCompleted] = useState<{
    request: CalculationRequest;
    result: XlsxCalculation;
  } | null>(null);
  const [failed, setFailed] = useState<{ request: CalculationRequest; error: string } | null>(null);
  // Invalidate before effects run: an old response can settle between render
  // and the debounce effect, including during worksheet navigation.
  if (latest.current !== request || pause.current !== paused) queued.current = null;
  latest.current = request;
  pause.current = paused;
  calculateRef.current = calculate;

  function drain() {
    const next = queued.current;
    if (!mounted.current || running.current || pause.current || !next || next !== latest.current)
      return;
    queued.current = null;
    running.current = next;
    setFlight(next);
    setFailed(null);
    void Promise.resolve()
      .then(() => calculateRef.current(next))
      .then((result) => {
        if (mounted.current && !pause.current && latest.current === next) {
          setCompleted({ request: next, result });
          setFailed(null);
        }
      })
      .catch((error) => {
        if (mounted.current && !pause.current && latest.current === next)
          setFailed({ request: next, error: String(error) });
      })
      .finally(() => {
        running.current = null;
        if (mounted.current) {
          setFlight(null);
          drain();
        }
      });
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queued.current = null;
    };
  }, []);
  useEffect(() => {
    queued.current = null;
    if (paused || !request) return;
    const timer = setTimeout(() => {
      if (latest.current === request && !pause.current) {
        queued.current = request;
        drain();
      }
    }, 260);
    return () => clearTimeout(timer);
  }, [request, paused]);

  const fresh = paused
    ? null
    : !request
      ? emptyResult
      : completed?.request === request
        ? completed.result
        : null;
  const error = !paused && failed?.request === request ? failed.error : '';
  return {
    fresh,
    error,
    phase: paused ? 'paused' : fresh ? 'ready' : error ? 'error' : flight ? 'running' : 'stale',
  };
}
