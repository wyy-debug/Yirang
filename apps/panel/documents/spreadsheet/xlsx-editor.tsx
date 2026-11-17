import { getUiLanguage as getUiLocale } from '../../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { XlsxCharts } from './xlsx-charts.js';
import { OfficeLayoutPreview } from '../office/office-layout-preview.js';
import { NativeMerge } from '../native/native-merge.js';
import type { DesktopObject, MaterialRange } from '../../../../packages/contracts/index.js';
import {
  XlsxSave,
  XlsxStructure,
  columnLabel,
  cellPosition,
  type SheetEdit,
  type StructureEdit,
  type XlsxPage,
  type XlsxCell,
  type CellFormat,
} from '../../../../packages/contracts/xlsx.js';
import './xlsx-editor.css';
import { PanelActionError } from '../../host.js';
import { XlsxControls } from './xlsx-controls.js';
import { flushDraftStorage, scheduleDraftWrite, writeDraftNow } from '../draft-storage.js';
import { useXlsxCalculation, xlsxCalculationRequest } from './xlsx-calculation.js';
import {
  boundedView,
  cellLayout,
  ChangeList,
  checkDraftCells,
  conditionalColor,
  Draft,
  key,
  mergeCell,
  parseClipboard,
  stable,
} from './xlsx-calc.js';
import type { Edits, EditorView } from './xlsx-calc.js';

type Props = {
  reference: (range?: MaterialRange) => Promise<boolean>;
  comment?: (range?: MaterialRange) => void;
  canReference: boolean;
  object: DesktopObject;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  details: () => void;
  dirtyChanged: (dirty: boolean) => void;
};
type History = { edits: Edits; operations: StructureEdit[]; view: EditorView };

export function XlsxFileEditor({
  object,
  action,
  updated,
  details,
  dirtyChanged,
  reference,
  comment,
  canReference,
}: Props) {
  useUiLocale();
  const [focus] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`native-focus:${object.id}`) ?? 'null');
    } catch {
      return null;
    }
  });
  const storageKey = `ai-desktop:xlsx-draft:${object.id}`;
  const [initial] = useState(() => {
    try {
      flushDraftStorage(storageKey);
      const raw = localStorage.getItem(storageKey);
      const value = raw && raw.length < 5000000 ? Draft.parse(JSON.parse(raw)) : null;
      return value ? { ...value, view: value.view ? boundedView(value.view) : undefined } : null;
    } catch {
      return null;
    }
  });
  const [revision, setRevision] = useState(initial?.revision ?? object.revision),
    [edits, setEdits] = useState<Edits>(
      Object.fromEntries(
        (initial?.edits ?? []).map((edit) => [key(edit.sheetId, edit.address), edit]),
      ),
    );
  const [pending, setPending] = useState<z.infer<typeof XlsxSave> | null>(initial?.pending ?? null),
    [page, setPage] = useState<XlsxPage | null>(null);
  const [sheetId, setSheetId] = useState<string | undefined>(
      initial?.view?.sheetId ?? focus?.sheetId,
    ),
    [row, setRow] = useState(initial?.view?.row ?? cellPosition(focus?.address ?? '')?.row ?? 1),
    [column, setColumn] = useState(
      initial?.view?.column ?? cellPosition(focus?.address ?? '')?.column ?? 1,
    ),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(initial ? uiText('已恢复本地编辑草稿。') : '');
  const [storageError, setStorageError] = useState(''),
    [active, setActive] = useState(initial?.view?.active ?? focus?.address ?? 'A1'),
    [end, setEnd] = useState(initial?.view?.end ?? focus?.address ?? 'A1'),
    [input, setInput] = useState(''),
    [inputDirty, setInputDirty] = useState(false),
    [mode, setMode] = useState<'auto' | 'text'>('auto'),
    [go, setGo] = useState(initial?.view?.active ?? focus?.address ?? 'A1'),
    [discard, setDiscard] = useState(false),
    [reloadKey, setReloadKey] = useState(0);
  const [operations, setOperations] = useState<StructureEdit[]>(
      initial?.operations ?? initial?.pending?.operations ?? [],
    ),
    [structuring, setStructuring] = useState(false),
    [structureCount, setStructureCount] = useState('1'),
    [sheetName, setSheetName] = useState('');
  const [importing, setImporting] = useState(false),
    importInput = useRef<HTMLInputElement>(null),
    [composing, setComposing] = useState(false),
    composition = useRef(false),
    saveBusy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null),
    actions = useRef(action),
    cache = useRef<Record<string, XlsxCell>>({}),
    past = useRef<History[]>([]),
    future = useRef<History[]>([]),
    editsRef = useRef(edits),
    operationsRef = useRef(operations),
    structureBusy = useRef(false),
    cacheVersion = useRef('');
  operationsRef.current = operations;
  const operationsKey = useMemo(() => JSON.stringify(operations), [operations, getUiLocale()]);
  const [historyTick, setHistoryTick] = useState(0);
  void historyTick;
  actions.current = action;
  editsRef.current = edits;
  const sheet = sheetId ?? page?.sheetId ?? '',
    count =
      Object.keys(edits).length +
      operations.reduce((n, op) => n + (op.editsBefore?.length ?? 0), 0),
    dirty = count > 0 || operations.length > 0 || inputDirty || !!pending,
    conflict = object.revision !== revision;
  useEffect(() => {
    if (!dirty && !loading && !saving && object.revision !== revision) {
      setRevision(object.revision);
      setReloadKey((n) => n + 1);
      void actions
        .current('native_workbench', { operation: 'location', objectId: object.id })
        .then((location) => {
          const s = location?.selection;
          if (s?.kind === 'xlsx') {
            setSheetId(s.sheetId);
            const p = cellPosition(s.from)!;
            setRow(p.row);
            setColumn(p.column);
            setActive(s.from);
            setEnd(s.to);
          }
        })
        .catch(() => {});
    }
  }, [object.revision, revision, dirty, loading, saving]);
  const readonly =
    page?.sheets.find((s) => s.id === sheet)?.readOnly ||
    cache.current[key(sheet, active)]?.readOnly;
  const [chartDirty, setChartDirty] = useState(false);
  const blocked = saving || !!pending || loading || structuring || importing || chartDirty;
  const [customFormat, setCustomFormat] = useState('');
  const appliedEdits = useMemo(() => Object.values(edits), [edits, getUiLocale()]);
  const previewEdits = useMemo(() => {
    if (!inputDirty || !sheet) return appliedEdits;
    const id = key(sheet, active);
    return [
      ...appliedEdits.filter((edit) => key(edit.sheetId, edit.address) !== id),
      { ...edits[id], sheetId: sheet, address: active, value: input, mode },
    ];
  }, [edits, appliedEdits, inputDirty, sheet, active, input, mode, getUiLocale()]);
  const calculationRequest = useMemo(
    () => (page ? xlsxCalculationRequest(page, previewEdits, operations) : null),
    [page, previewEdits, operations, getUiLocale()],
  );
  const calculationPaused =
    composing ||
    loading ||
    structuring ||
    saving ||
    importing ||
    !page ||
    page.revision !== revision ||
    page.sheetId !== sheet ||
    page.row !== row ||
    page.column !== column ||
    cacheVersion.current !== `${revision}:${operationsKey}`;
  const {
    fresh,
    error: calculationError,
    phase: calculationPhase,
  } = useXlsxCalculation(calculationRequest, calculationPaused, (request) =>
    actions.current('xlsx_calculate', request),
  );
  const unsupportedCalculations = useMemo(
    () => Object.values(fresh?.cells ?? {}).filter((cell) => cell.error?.includes('不支持')).length,
    [fresh, getUiLocale()],
  );
  const activeFormat = {
    ...cache.current[key(sheet, active)],
    ...edits[key(sheet, active)]?.format,
  };
  useEffect(
    () => setSheetName(page?.sheets.find((s) => s.id === sheet)?.name ?? ''),
    [page?.sheets.find((s) => s.id === sheet)?.name, sheet],
  );
  useEffect(() => {
    dirtyChanged(dirty || importing || chartDirty);
    return () => dirtyChanged(false);
  }, [dirty, importing, chartDirty, dirtyChanged]);
  useEffect(() => {
    if (!dirty && !importing) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, importing]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    const version = `${revision}:${operationsKey}`;
    if (cacheVersion.current !== version) {
      cache.current = {};
      cacheVersion.current = version;
      setPage(null);
    }
    void actions
      .current('xlsx_read', {
        objectId: object.id,
        expectedRevision: revision,
        sheetId,
        row,
        column,
        rows: 50,
        columns: 16,
        operations,
      })
      .then((value: XlsxPage) => {
        if (!live) return;
        setPage(value);
        for (const [address, cell] of Object.entries(value.cells))
          cache.current[key(value.sheetId, address)] = cell;
        const valueEdit = editsRef.current[key(value.sheetId, active)],
          cell = value.cells[active];
        setInput(valueEdit?.value ?? cell?.input ?? '');
        setMode(
          valueEdit?.value !== undefined
            ? valueEdit.mode
            : !cell?.formula && cell?.input.startsWith('=')
              ? 'text'
              : 'auto',
        );
        setInputDirty(false);
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [object.id, revision, sheetId, row, column, reloadKey, operationsKey]);
  useEffect(() => {
    const snapshot = { revision, edits: previewEdits, operations, view: view(), pending };
    scheduleDraftWrite(
      storageKey,
      () =>
        !snapshot.edits.length && !snapshot.pending && !snapshot.operations.length
          ? null
          : JSON.stringify(snapshot),
      (failure) =>
        setStorageError(
          failure ? uiText('当前环境无法保留本地草稿。请保存后再离开，或下载修改清单。') : '',
        ),
    );
  }, [previewEdits, active, end, sheet, row, column, pending, revision, storageKey, operations]);
  useEffect(() => () => flushDraftStorage(storageKey), [storageKey]);
  function view(): EditorView {
    return { sheetId: sheet || undefined, row, column, active, end };
  }
  function remember(base = editsRef.current) {
    past.current.push({ edits: base, operations: operationsRef.current, view: view() });
    if (past.current.length > 20) past.current.shift();
    future.current = [];
  }
  function draftLimit(next: Edits, ops = operationsRef.current) {
    if (
      ops.length > 30 ||
      Object.keys(next).length + ops.reduce((n, op) => n + (op.editsBefore?.length ?? 0), 0) >
        2000 ||
      JSON.stringify({ edits: next, operations: ops }).length > 1900000
    )
      throw Error(uiText('一次最多 30 次结构修改、2000 格编辑 / 2 MiB 草稿，请先保存。'));
  }
  function stage(values: SheetEdit[], base = editsRef.current) {
    if (pending) return base;
    const next = { ...base };
    for (const edit of values) {
      if (!cellPosition(edit.address)) throw Error(uiText('粘贴超出工作表边界。'));
      const cell = cache.current[key(edit.sheetId, edit.address)];
      if (cell?.readOnly) throw Error(`${edit.address}：${cell.readOnly}`);
      const id = key(edit.sheetId, edit.address),
        previous = next[id],
        merged: SheetEdit = {
          ...previous,
          ...edit,
          mode: edit.value !== undefined ? edit.mode : (previous?.mode ?? 'auto'),
          format: { ...previous?.format, ...edit.format },
        };
      if (
        cell &&
        merged.value === cell.input &&
        (merged.mode === 'text' ? cell.textValue : !cell.textValue)
      ) {
        delete merged.value;
        merged.mode = 'auto';
      }
      const defaults: Record<string, unknown> = {
        bold: false,
        italic: false,
        underline: false,
        wrap: false,
        background: null,
        numberFormat: 'General',
      };
      for (const [field, value] of Object.entries(merged.format!))
        if (
          cell &&
          value === ((cell as unknown as Record<string, unknown>)[field] ?? defaults[field])
        )
          delete (merged.format as Record<string, unknown>)[field];
      if (!Object.keys(merged.format!).length) delete merged.format;
      if (merged.value === undefined && !merged.format) delete next[id];
      else next[id] = merged;
    }
    draftLimit(next);
    remember(base);
    editsRef.current = next;
    setEdits(next);
    setHistoryTick((t) => t + 1);
    return next;
  }
  function apply() {
    if (composition.current || !inputDirty || !sheet) return editsRef.current;
    const next = stage([{ sheetId: sheet, address: active, value: input, mode }]);
    setInputDirty(false);
    return next;
  }
  function choose(address: string, extend = false) {
    if (blocked || composition.current) return;
    try {
      const next = apply();
      if (extend) {
        setEnd(address);
        return;
      }
      setActive(address);
      setEnd(address);
      setGo(address);
      const cell = cache.current[key(sheet, address)],
        edit = next[key(sheet, address)];
      setInput(edit?.value ?? cell?.input ?? '');
      setMode(
        edit?.value !== undefined
          ? edit.mode
          : !cell?.formula && cell?.input.startsWith('=')
            ? 'text'
            : 'auto',
      );
      setInputDirty(false);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  function range() {
    const from = cellPosition(active)!,
      to = cellPosition(end)!;
    return {
      top: Math.min(from.row, to.row),
      bottom: Math.max(from.row, to.row),
      left: Math.min(from.column, to.column),
      right: Math.max(from.column, to.column),
    };
  }
  function formatCells(format: CellFormat) {
    if (blocked || readonly || composition.current) return;
    try {
      const selection = range(),
        values: SheetEdit[] = [];
      for (let r = selection.top; r <= selection.bottom; r++)
        for (let c = selection.left; c <= selection.right; c++)
          values.push({ sheetId: sheet, address: columnLabel(c) + r, mode: 'auto', format });
      stage(values, apply());
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  function clear() {
    if (blocked || composition.current) return;
    try {
      const selection = range(),
        values: SheetEdit[] = [];
      for (let r = selection.top; r <= selection.bottom; r++)
        for (let c = selection.left; c <= selection.right; c++)
          values.push({ sheetId: sheet, address: columnLabel(c) + r, value: '', mode: 'auto' });
      stage(values);
      setInput('');
      setInputDirty(false);
    } catch (e) {
      setError(String(e));
    }
  }
  function undo(redo = false) {
    if (blocked || composition.current) return;
    const source = redo ? future : past,
      target = redo ? past : future,
      next = source.current.pop();
    if (!next) return;
    target.current.push({
      edits: editsRef.current,
      operations: operationsRef.current,
      view: view(),
    });
    const changed =
      JSON.stringify(next.operations) !== operationsKey ||
      next.view.sheetId !== sheet ||
      next.view.row !== row ||
      next.view.column !== column;
    if (changed) {
      setLoading(true);
      setPage(null);
      cache.current = {};
    }
    operationsRef.current = next.operations;
    setOperations(next.operations);
    editsRef.current = next.edits;
    setEdits(next.edits);
    setSheetId(next.view.sheetId);
    setRow(next.view.row);
    setColumn(next.view.column);
    setActive(next.view.active);
    setEnd(next.view.end);
    setGo(next.view.active);
    setInputDirty(false);
    const edit = next.edits[key(next.view.sheetId ?? '', next.view.active)],
      cell = cache.current[key(next.view.sheetId ?? '', next.view.active)];
    setInput(edit?.value ?? cell?.input ?? '');
    setMode(
      edit?.value !== undefined
        ? edit.mode
        : !cell?.formula && cell?.input.startsWith('=')
          ? 'text'
          : 'auto',
    );
    setError('');
    setNotice(redo ? uiText('已重做草稿操作。') : uiText('已撤销草稿操作。'));
    setHistoryTick((t) => t + 1);
  }
  async function structure(operation: StructureEdit) {
    if (blocked || structureBusy.current || composition.current || !page) return;
    structureBusy.current = true;
    setStructuring(true);
    setError('');
    try {
      const changes = apply(),
        op = XlsxStructure.parse({ ...operation, editsBefore: Object.values(changes) }),
        next = [...operationsRef.current, op];
      draftLimit({}, next);
      const switchSheet = ['add_sheet', 'copy_sheet', 'delete_sheet'].includes(op.kind),
        nextSheet =
          op.kind === 'add_sheet'
            ? op.sheetId
            : op.kind === 'copy_sheet'
              ? op.newSheetId
              : op.kind === 'delete_sheet'
                ? (
                    page.sheets.find((s) => s.id !== sheet && !s.hidden) ??
                    page.sheets.find((s) => s.id !== sheet)
                  )?.id
                : sheet,
        nextRow = switchSheet ? 1 : row,
        nextColumn = switchSheet ? 1 : column;
      // Prepare the new draft without committing an object revision. A rejected operation leaves the current draft intact.
      await action('xlsx_read', {
        objectId: object.id,
        expectedRevision: revision,
        sheetId: nextSheet,
        row: nextRow,
        column: nextColumn,
        rows: 50,
        columns: 16,
        operations: next,
      });
      remember(changes);
      operationsRef.current = next;
      setOperations(next);
      editsRef.current = {};
      setEdits({});
      setInputDirty(false);
      setInput('');
      cache.current = {};
      setPage(null);
      setLoading(true);
      setSheetId(nextSheet);
      setRow(nextRow);
      setColumn(nextColumn);
      const address = switchSheet ? 'A1' : active;
      setActive(address);
      setEnd(address);
      setGo(address);
      setNotice(uiText('结构已更新，公式引用已同步调整；可撤销，点击保存后写回原文件。'));
    } catch (e) {
      setError(String(e));
    } finally {
      structureBusy.current = false;
      setStructuring(false);
    }
  }
  function changeAxis(kind: 'insert_rows' | 'delete_rows' | 'insert_columns' | 'delete_columns') {
    const selected = range(),
      rows = kind.endsWith('rows'),
      selectedCount = rows
        ? selected.bottom - selected.top + 1
        : selected.right - selected.left + 1,
      count = selectedCount > 1 ? selectedCount : Number(structureCount);
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      setError(uiText('每次请输入或选择 1–1000 行 / 列。'));
      return;
    }
    void structure({ kind, sheetId: sheet, at: rows ? selected.top : selected.left, count });
  }
  function addSheet() {
    if (!page) return;
    let index = 1,
      name = uiText('工作表{0}', { '0': index });
    const names = new Set(page.sheets.map((s) => s.name.toLowerCase()));
    while (names.has(name.toLowerCase())) name = uiText('工作表{0}', { '0': ++index });
    void structure({
      kind: 'add_sheet',
      sheetId: page.nextSheetId ?? String(Math.max(...page.sheets.map((s) => Number(s.id))) + 1),
      name,
    });
  }
  function movePage(nextRow: number, nextColumn: number, nextSheet = sheet) {
    if (blocked || composition.current) return;
    try {
      apply();
      setRow(nextRow);
      setColumn(nextColumn);
      setSheetId(nextSheet);
      setActive(columnLabel(nextColumn) + nextRow);
      setEnd(columnLabel(nextColumn) + nextRow);
      setGo(columnLabel(nextColumn) + nextRow);
    } catch (e) {
      setError(String(e));
    }
  }
  async function save() {
    if (chartDirty) {
      setNotice(uiText('请先在图表区域保存或清空图表草稿。'));
      return;
    }
    if (
      saveBusy.current ||
      saving ||
      loading ||
      importing ||
      structureBusy.current ||
      composition.current
    )
      return;
    saveBusy.current = true;
    setError('');
    let request = pending;
    try {
      if (!request) {
        const changes = apply();
        if (!Object.keys(changes).length && !operationsRef.current.length) {
          setNotice(uiText('没有待保存的修改。'));
          return;
        }
        if (conflict) throw Error(uiText('文件已有新版本，请保留修改清单并加载最新文件后合并。'));
        draftLimit(changes);
        request = {
          requestId: crypto.randomUUID(),
          objectId: object.id,
          expectedRevision: revision,
          edits: Object.values(changes),
          ...(operationsRef.current.length ? { operations: operationsRef.current } : {}),
        };
        setPending(request);
      }
      try {
        writeDraftNow(
          storageKey,
          JSON.stringify({
            revision: request.expectedRevision,
            edits: request.edits,
            operations: request.operations ?? [],
            view: view(),
            pending: request,
          }),
        );
        setStorageError('');
      } catch {
        setStorageError(uiText('无法保留浏览器草稿；正在直接保存，请勿关闭页面。'));
      }
      setSaving(true);
      const result = await action('xlsx_save', request);
      setPending(null);
      editsRef.current = {};
      setEdits({});
      operationsRef.current = [];
      setOperations([]);
      setInputDirty(false);
      past.current = [];
      future.current = [];
      cache.current = {};
      setRevision(result.revision);
      setReloadKey((n) => n + 1);
      setNotice(uiText('已保存回原文件'));
      try {
        writeDraftNow(storageKey, null);
        setStorageError('');
      } catch {
        setStorageError(
          uiText('原文件已保存，但浏览器草稿暂未清理。重新打开后可用原请求确认结果。'),
        );
      }
      await updated();
    } catch (e) {
      if (
        e instanceof PanelActionError &&
        [
          'XLSX_READ_ONLY',
          'XLSX_DATE',
          'XLSX_FORMULA',
          'XLSX_LIMIT',
          'XLSX_STRUCTURE_UNSUPPORTED',
          'XLSX_SHEET_NAME',
          'XLSX_SHEET',
          'XLSX_CELL',
          'REVISION_CONFLICT',
          'VALIDATION_FAILED',
          'REQUEST_ID_REUSED',
          'DRAFT_ACTIVE',
        ].includes(e.code)
      ) {
        setPending(null);
        try {
          writeDraftNow(
            storageKey,
            JSON.stringify({
              revision,
              edits: Object.values(editsRef.current),
              operations: operationsRef.current,
              view: view(),
              pending: null,
            }),
          );
        } catch {
          setStorageError(uiText('无法更新浏览器草稿，请下载修改清单后再离开。'));
        }
      }
      setError(String(e));
    } finally {
      saveBusy.current = false;
      setSaving(false);
    }
  }
  function downloadChanges() {
    const effective = { ...editsRef.current };
    if (inputDirty)
      effective[key(sheet, active)] = {
        ...effective[key(sheet, active)],
        sheetId: sheet,
        address: active,
        value: input,
        mode,
      };
    const blob = new Blob(
      [
        JSON.stringify(
          {
            format: 'ai-desktop-xlsx-draft',
            version: 1,
            objectId: object.id,
            baseRevision: revision,
            edits: Object.values(effective),
            operations: operationsRef.current,
            view: view(),
            pending,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = uiText('工作簿修改清单.json');
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importChanges(file: File) {
    if (blocked || dirty || structureBusy.current) return;
    structureBusy.current = true;
    setImporting(true);
    setError('');
    try {
      if (file.size > 12 * 1024 * 1024) throw Error(uiText('修改清单文件过大。'));
      const value = ChangeList.parse(JSON.parse(await file.text())),
        ops = value.operations ?? value.pending?.operations ?? [];
      if (value.objectId !== object.id)
        throw Error(uiText('修改清单属于另一份桌面工作簿，请在原文件对象中导入。'));
      checkDraftCells(value.edits);
      for (const operation of ops) checkDraftCells(operation.editsBefore ?? []);
      if (
        value.pending &&
        (value.pending.objectId !== object.id ||
          value.pending.expectedRevision !== value.baseRevision ||
          stable(value.pending.edits) !== stable(value.edits) ||
          stable(value.pending.operations ?? []) !== stable(ops))
      )
        throw Error(uiText('清单与待确认的保存请求不一致，未导入。'));
      const changes = Object.fromEntries(
        value.edits.map((edit) => [key(edit.sheetId, edit.address), edit]),
      );
      draftLimit(changes, ops);
      if (!value.edits.length && !ops.length) throw Error(uiText('修改清单中没有待恢复的编辑。'));
      const restoredView = boundedView(
        value.view ?? { row: 1, column: 1, active: 'A1', end: 'A1' },
      );
      // Reading the historical base previews structure operations; it never commits a file revision.
      const preview: XlsxPage = await action('xlsx_read', {
        objectId: object.id,
        expectedRevision: value.baseRevision,
        sheetId: restoredView.sheetId,
        row: restoredView.row,
        column: restoredView.column,
        rows: 50,
        columns: 16,
        operations: ops,
      });
      if (value.edits.some((edit) => !preview.sheets.some((s) => s.id === edit.sheetId)))
        throw Error(uiText('修改清单引用了不存在的工作表。'));
      operationsRef.current = ops;
      setOperations(ops);
      editsRef.current = changes;
      setEdits(changes);
      setPending(value.pending ?? null);
      setRevision(value.baseRevision);
      setSheetId(preview.sheetId);
      setRow(restoredView.row);
      setColumn(restoredView.column);
      setActive(restoredView.active);
      setEnd(restoredView.end);
      setGo(restoredView.active);
      setInputDirty(false);
      setInput('');
      cache.current = {};
      cacheVersion.current = '';
      past.current = [];
      future.current = [];
      setPage(null);
      setLoading(true);
      setReloadKey((n) => n + 1);
      try {
        writeDraftNow(
          storageKey,
          JSON.stringify({
            revision: value.baseRevision,
            edits: value.edits,
            operations: ops,
            view: { ...restoredView, sheetId: preview.sheetId },
            pending: value.pending ?? null,
          }),
        );
        setStorageError('');
      } catch {
        setStorageError(uiText('已导入修改，但无法保留浏览器草稿。请保存或下载修改清单后再离开。'));
      }
      setNotice(
        value.pending
          ? uiText('已恢复原保存请求。请重试同一次保存，避免重复应用结构修改。')
          : uiText('已导入修改清单，保存后更新原文件。'),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      structureBusy.current = false;
      setImporting(false);
    }
  }
  function reset() {
    try {
      writeDraftNow(storageKey, null);
      setStorageError('');
    } catch {
      setStorageError(uiText('浏览器草稿暂未清理，请在离开前重试。'));
    }
    setPending(null);
    setEdits({});
    editsRef.current = {};
    operationsRef.current = [];
    setOperations([]);
    setSheetId(undefined);
    setRow(1);
    setColumn(1);
    setActive('A1');
    setEnd('A1');
    setGo('A1');
    setInputDirty(false);
    setRevision(object.revision);
    setDiscard(false);
    setReloadKey((n) => n + 1);
    past.current = [];
    future.current = [];
    cache.current = {};
    setNotice(uiText('已载入最新文件。'));
  }
  const selection = range(),
    rowCount =
      selection.bottom - selection.top + 1 > 1
        ? selection.bottom - selection.top + 1
        : Number(structureCount) || 1,
    columnCount =
      selection.right - selection.left + 1 > 1
        ? selection.right - selection.left + 1
        : Number(structureCount) || 1;
  return (
    <div
      className="xlsx-editor"
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          composition.current
        )
          return;
        if (event.ctrlKey || event.metaKey) {
          if (event.key.toLowerCase() === 's') {
            event.preventDefault();
            event.stopPropagation();
            void save();
          } else if (
            event.key.toLowerCase() === 'z' &&
            !(event.target as HTMLElement).closest('input,textarea')
          ) {
            event.preventDefault();
            event.stopPropagation();
            undo(event.shiftKey);
          }
        }
      }}
    >
      <div className="xlsx-ribbon">
        <div className="xlsx-brand">
          <span>X</span>
          <div>
            <strong>{(object.content as { fileName: string }).fileName}</strong>
            <small>
              {uiText('本地 XLSX 编辑 · v')}
              {revision}
            </small>
          </div>
        </div>
        <div className="xlsx-tools">
          <button
            className="primary"
            disabled={
              chartDirty || saving || loading || structuring || importing || (!dirty && !pending)
            }
            onClick={() => void save()}
          >
            {saving
              ? uiText('保存中…')
              : pending
                ? uiText('重试同一次保存')
                : uiText('保存回原文件')}
          </button>
          <button disabled={blocked || !past.current.length} onClick={() => undo()}>
            {uiText('撤销')}
          </button>
          <button disabled={blocked || !future.current.length} onClick={() => undo(true)}>
            {uiText('重做')}
          </button>
          <button disabled={blocked || !!readonly} onClick={clear}>
            {uiText('清除内容')}
          </button>
          <button disabled={!dirty} onClick={downloadChanges}>
            {uiText('下载修改清单')}
          </button>
          <button
            disabled={blocked || dirty}
            title={
              dirty
                ? uiText('先保存现有草稿，或下载并清空后导入')
                : uiText('从同一工作簿的修改清单恢复')
            }
            onClick={() => importInput.current?.click()}
          >
            {importing ? uiText('正在恢复…') : uiText('导入修改清单')}
          </button>
          <input
            hidden
            type="file"
            accept=".json,application/json"
            ref={importInput}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importChanges(file);
            }}
          />
          <button disabled={dirty || chartDirty || saving || importing} onClick={details}>
            {uiText('文件详情')}
          </button>
        </div>
      </div>
      <OfficeLayoutPreview
        object={object}
        action={action}
        dirty={dirty || chartDirty || saving || !!pending}
      />
      <fieldset
        className="xlsx-structure"
        disabled={blocked || !!page?.structureBlocked || !page}
        aria-label={uiText('行列和工作表')}
      >
        <div className="xlsx-structure-group">
          <label>
            {uiText('数量')}
            <input
              aria-label={uiText('增删行列数量')}
              type="number"
              min="1"
              max="1000"
              value={structureCount}
              onChange={(e) => setStructureCount(e.target.value)}
            />
          </label>
          <button
            disabled={!!page?.sheets.find((s) => s.id === sheet)?.readOnly}
            onClick={() => changeAxis('insert_rows')}
          >
            {uiText('上方插入')}
            {rowCount} {uiText('行')}
          </button>
          <button
            disabled={!!page?.sheets.find((s) => s.id === sheet)?.readOnly}
            onClick={() => changeAxis('delete_rows')}
          >
            {uiText('删除')}
            {rowCount} {uiText('行')}
          </button>
          <button
            disabled={!!page?.sheets.find((s) => s.id === sheet)?.readOnly}
            onClick={() => changeAxis('insert_columns')}
          >
            {uiText('左侧插入')}
            {columnCount} {uiText('列')}
          </button>
          <button
            disabled={!!page?.sheets.find((s) => s.id === sheet)?.readOnly}
            onClick={() => changeAxis('delete_columns')}
          >
            {uiText('删除')}
            {columnCount} {uiText('列')}
          </button>
        </div>
        <div className="xlsx-structure-group">
          <button onClick={addSheet}>{uiText('＋ 工作表')}</button>
          <input
            aria-label={uiText('工作表名称')}
            maxLength={31}
            value={sheetName}
            onChange={(e) => setSheetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                void structure({ kind: 'rename_sheet', sheetId: sheet, name: sheetName });
              }
            }}
          />
          <button
            disabled={!sheetName || sheetName === page?.sheets.find((s) => s.id === sheet)?.name}
            onClick={() =>
              void structure({ kind: 'rename_sheet', sheetId: sheet, name: sheetName })
            }
          >
            {uiText('重命名')}
          </button>
        </div>
      </fieldset>
      <button
        disabled={dirty || blocked || !canReference}
        onClick={() =>
          void action('native_workbench', {
            operation: 'reference',
            objectId: object.id,
            expectedRevision: revision,
            selection: {
              kind: 'xlsx',
              sheetId: sheet,
              from: columnLabel(selection.left) + selection.top,
              to: columnLabel(selection.right) + selection.bottom,
            },
          })
            .then(reference)
            .catch((e) => setError(String(e)))
        }
      >
        {uiText('引用选中单元格到原对话')}
      </button>
      {comment && (
        <button
          disabled={dirty || blocked || conflict || !page}
          title={
            dirty ? uiText('先保存修改，再评论原文件单元格') : uiText('评论当前选中的原文件单元格')
          }
          onClick={() =>
            void action('native_workbench', {
              operation: 'reference',
              objectId: object.id,
              expectedRevision: revision,
              selection: {
                kind: 'xlsx',
                sheetId: sheet,
                from: columnLabel(selection.left) + selection.top,
                to: columnLabel(selection.right) + selection.bottom,
              },
            })
              .then((range) => comment(range))
              .catch((e) => setError(String(e)))
          }
        >
          {uiText('评论选中单元格')}
        </button>
      )}
      {conflict && !pending && !chartDirty && (
        <NativeMerge
          objectId={object.id}
          baseRevision={revision}
          format="xlsx"
          edits={previewEdits}
          operations={operations}
          action={action}
          apply={(rev, changes) => {
            setRevision(rev);
            setEdits(Object.fromEntries(changes.map((e) => [key(e.sheetId, e.address), e])));
            setInputDirty(false);
            setOperations([]);
            operationsRef.current = [];
            setPending(null);
            setNotice(uiText('已采用合并草稿，请保存。'));
          }}
        />
      )}
      <XlsxControls
        page={page}
        sheet={sheet}
        selection={selection}
        disabled={blocked || !!page?.structureBlocked || !!readonly}
        run={(op) => void structure(op)}
      />
      <div className="xlsx-structure-hint">
        {structuring
          ? uiText('正在调整工作表和公式引用…')
          : (page?.structureBlocked ??
            uiText(
              '以 {0}{1} 为起点；Shift 点击可选多行 / 列，选区数量优先。删除可撤销，保存后写回原文件。',
              { '0': columnLabel(selection.left), '1': selection.top },
            ))}
        {operations.length > 0 && (
          <span>
            {' '}
            · {operations.length} {uiText('次结构修改待保存')}
          </span>
        )}
      </div>
      <fieldset
        className="xlsx-format"
        disabled={blocked || !!readonly}
        aria-label={uiText('选区格式')}
      >
        <div className="xlsx-format-group">
          <button
            aria-label={uiText('加粗')}
            title={uiText('加粗')}
            aria-pressed={!!activeFormat.bold}
            onClick={() => formatCells({ bold: !activeFormat.bold })}
          >
            <b>B</b>
          </button>
          <button
            aria-label={uiText('斜体')}
            title={uiText('斜体')}
            aria-pressed={!!activeFormat.italic}
            onClick={() => formatCells({ italic: !activeFormat.italic })}
          >
            <i>I</i>
          </button>
          <button
            aria-label={uiText('下划线')}
            title={uiText('下划线')}
            aria-pressed={!!activeFormat.underline}
            onClick={() => formatCells({ underline: !activeFormat.underline })}
          >
            <u>U</u>
          </button>
          <select
            aria-label={uiText('字号')}
            value={activeFormat.fontSize ?? 11}
            onChange={(e) => formatCells({ fontSize: Number(e.target.value) })}
          >
            {[
              ...new Set([
                8,
                9,
                10,
                11,
                12,
                14,
                16,
                18,
                20,
                24,
                28,
                36,
                48,
                72,
                activeFormat.fontSize ?? 11,
              ]),
            ]
              .sort((a, b) => a - b)
              .map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
          </select>
          <label title={uiText('文字颜色')}>
            {uiText('文字')}
            <input
              type="color"
              aria-label={uiText('文字颜色')}
              value={activeFormat.color ?? '#222222'}
              onChange={(e) => formatCells({ color: e.target.value })}
            />
          </label>
          <label title={uiText('填充颜色')}>
            {uiText('填充')}
            <input
              type="color"
              aria-label={uiText('填充颜色')}
              value={activeFormat.background ?? '#ffffff'}
              onChange={(e) => formatCells({ background: e.target.value })}
            />
          </label>
          <button title={uiText('无填充')} onClick={() => formatCells({ background: null })}>
            {uiText('无填充')}
          </button>
        </div>
        <div className="xlsx-format-group">
          <select
            aria-label={uiText('水平对齐')}
            value={
              ['left', 'center', 'right'].includes(activeFormat.align ?? '')
                ? activeFormat.align
                : ''
            }
            onChange={(e) => formatCells({ align: e.target.value as 'left' | 'center' | 'right' })}
          >
            <option value="" disabled>
              {uiText('对齐')}
            </option>
            <option value="left">{uiText('左对齐')}</option>
            <option value="center">{uiText('居中')}</option>
            <option value="right">{uiText('右对齐')}</option>
          </select>
          <button
            aria-pressed={!!activeFormat.wrap}
            onClick={() => formatCells({ wrap: !activeFormat.wrap })}
          >
            {uiText('自动换行')}
          </button>
        </div>
        <div className="xlsx-format-group">
          <select
            aria-label={uiText('数字格式')}
            value={activeFormat.numberFormat ?? 'General'}
            onChange={(e) => formatCells({ numberFormat: e.target.value })}
          >
            {[
              ['General', uiText('常规')],
              ['0', uiText('整数')],
              ['0.00', uiText('两位小数')],
              ['#,##0.00', uiText('千分位')],
              ['0.00%', uiText('百分比')],
              ['"¥"#,##0.00', uiText('人民币')],
              ['yyyy-mm-dd', uiText('日期')],
              ['hh:mm:ss', uiText('时间')],
              ['@', uiText('文本')],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {activeFormat.numberFormat &&
              ![
                'General',
                '0',
                '0.00',
                '#,##0.00',
                '0.00%',
                '"¥"#,##0.00',
                'yyyy-mm-dd',
                'hh:mm:ss',
                '@',
              ].includes(activeFormat.numberFormat) && (
                <option value={activeFormat.numberFormat}>
                  {uiText('自定义：')}
                  {activeFormat.numberFormat}
                </option>
              )}
          </select>
          <input
            aria-label={uiText('自定义数字格式')}
            placeholder={uiText('自定义格式，如 0.000')}
            maxLength={120}
            value={customFormat}
            onChange={(e) => setCustomFormat(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === 'Enter' && customFormat.trim()) {
                e.preventDefault();
                formatCells({ numberFormat: customFormat.trim() });
              }
            }}
          />
          <button
            disabled={!customFormat.trim()}
            onClick={() => formatCells({ numberFormat: customFormat.trim() })}
          >
            {uiText('应用格式')}
          </button>
        </div>
      </fieldset>
      <div className="xlsx-formula">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const at = cellPosition(go.toUpperCase());
            if (at) movePage(at.row, at.column);
            else setError(uiText('请输入有效单元格，如 A1 或 AA120。'));
          }}
        >
          <input
            aria-label={uiText('跳转到单元格')}
            value={go}
            onChange={(e) => setGo(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229))
                e.preventDefault();
            }}
            disabled={blocked}
          />
        </form>
        <span>ƒx</span>
        <input
          ref={inputRef}
          aria-label={uiText('单元格值或公式')}
          value={input}
          placeholder={uiText('输入内容；公式以 = 开头')}
          disabled={blocked || !!readonly}
          onCompositionStart={() => {
            composition.current = true;
            setComposing(true);
          }}
          onCompositionEnd={(e) => {
            composition.current = false;
            setComposing(false);
            setInput(e.currentTarget.value);
            setInputDirty(true);
          }}
          onChange={(e) => {
            setInput(e.target.value);
            setInputDirty(true);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || composition.current)
              return;
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              try {
                apply();
              } catch (error) {
                setError(String(error));
              }
            } else if (e.key === 'Escape') {
              setInput(
                edits[key(sheet, active)]?.value ?? cache.current[key(sheet, active)]?.input ?? '',
              );
              setInputDirty(false);
            }
          }}
        />
        <select
          aria-label={uiText('输入类型')}
          value={mode}
          disabled={blocked || !!readonly}
          onChange={(e) => {
            setMode(e.target.value as 'auto' | 'text');
            setInputDirty(true);
          }}
        >
          <option value="auto">{uiText('自动类型')}</option>
          <option value="text">{uiText('纯文本')}</option>
        </select>
        <button
          disabled={blocked || !inputDirty || !!readonly}
          onClick={() => {
            try {
              apply();
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          {uiText('应用')}
        </button>
      </div>
      <div className="xlsx-calculation" role="status">
        <span className={calculationError || fresh?.issues ? 'calculation-warning' : ''}>
          {loading
            ? uiText('读取工作簿…')
            : composing
              ? uiText('中文输入中 · 结束后更新公式')
              : calculationError
                ? uiText('计算失败，修改仍保留')
                : fresh
                  ? unsupportedCalculations
                    ? uiText('{0} 格暂不支持计算{1} · 悬停查看原因', {
                        '0': unsupportedCalculations,
                        '1':
                          fresh.issues > unsupportedCalculations
                            ? uiText(' · 另有 {0} 格公式错误', {
                                '0': fresh.issues - unsupportedCalculations,
                              })
                            : '',
                      })
                    : fresh.issues
                      ? uiText('{0} 格公式错误 · 悬停查看原因', { '0': fresh.issues })
                      : uiText('公式已更新')
                  : calculationPhase === 'running'
                    ? uiText('正在计算… · 旧结果已过期')
                    : calculationPhase === 'paused'
                      ? uiText('结果已过期 · 完成当前操作后计算')
                      : uiText('结果已过期 · 等待输入停顿后计算')}
        </span>
        <small>{uiText('输入即预览 · 应用后保留修改 · 保存回原文件')}</small>
        {calculationError && <span>{calculationError}</span>}
      </div>
      {(dirty || error || notice || storageError || conflict || readonly) && (
        <div className="xlsx-notices" role="status">
          {error && <p className="error-text">{error}</p>}
          {storageError && <p className="error-text">{storageError}</p>}
          {conflict && (
            <p className="error-text">
              {uiText('桌面已是 v')}
              {object.revision}
              {uiText('，当前编辑基于 v')}
              {revision}
              {uiText('。草稿保留，不能直接覆盖新版本。')}
            </p>
          )}
          {notice && <p>{notice}</p>}
          {readonly && (
            <p>{typeof readonly === 'string' ? readonly : uiText('此工作表当前只读')}</p>
          )}
          {(dirty || conflict || error) && (
            <button
              disabled={chartDirty || saving || importing || structuring}
              onClick={() => setDiscard(true)}
            >
              {uiText('处理草稿 / 重新载入')}
            </button>
          )}
          {discard && (
            <div>
              <span>{uiText('先下载需要保留的修改。清空草稿不会撤销已成功写回的版本。')}</span>
              <button disabled={chartDirty || saving || importing || structuring} onClick={reset}>
                {uiText('清空此草稿并载入最新')}
              </button>
              <button onClick={() => setDiscard(false)}>{uiText('保留草稿')}</button>
            </div>
          )}
        </div>
      )}
      <div
        className="xlsx-grid"
        aria-busy={loading}
        onCopy={(event) => {
          if ((event.target as HTMLElement).closest('input,textarea')) return;
          const values: string[] = [];
          for (let r = selection.top; r <= selection.bottom; r++) {
            const line: string[] = [];
            for (let c = selection.left; c <= selection.right; c++) {
              const address = columnLabel(c) + r,
                value =
                  edits[key(sheet, address)]?.value ??
                  cache.current[key(sheet, address)]?.input ??
                  '';
              line.push(/[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value);
            }
            values.push(line.join('\t'));
          }
          event.clipboardData.setData('text/plain', values.join('\n'));
          event.preventDefault();
        }}
        onPaste={(event) => {
          if (blocked || !sheet || (event.target as HTMLElement).closest('input,textarea')) return;
          event.preventDefault();
          try {
            const rows = parseClipboard(event.clipboardData.getData('text/plain'));
            if (rows.reduce((n, row) => n + row.length, 0) > 2000)
              throw Error(uiText('一次最多粘贴 2000 个单元格。'));
            const values: SheetEdit[] = [];
            for (let r = 0; r < rows.length; r++)
              for (let c = 0; c < rows[r].length; c++)
                values.push({
                  sheetId: sheet,
                  address: columnLabel(selection.left + c) + (selection.top + r),
                  value: rows[r][c],
                  mode,
                });
            stage(values, apply());
            setInput(values[0]?.value ?? '');
            setInputDirty(false);
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        {loading && <div className="xlsx-loading">{uiText('正在读取原文件…')}</div>}
        {page && (
          <table role="grid" aria-label={uiText('工作表单元格')}>
            <colgroup>
              <col style={{ width: 52 }} />
              {page.widths.map((width, i) => (
                <col
                  key={i}
                  style={{
                    width,
                    display: page.hiddenColumns?.includes(page.column + i) ? 'none' : undefined,
                  }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th></th>
                {page.widths.map((_, i) => (
                  <th
                    key={i}
                    scope="col"
                    style={{
                      display: page.hiddenColumns?.includes(page.column + i) ? 'none' : undefined,
                    }}
                  >
                    {columnLabel(page.column + i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: page.rows }, (_, ri) => {
                const r = page.row + ri;
                return (
                  <tr
                    key={r}
                    style={{
                      height: page.heights[ri],
                      display: page.hiddenRows?.includes(r) ? 'none' : undefined,
                    }}
                  >
                    <th scope="row">{r}</th>
                    {Array.from({ length: page.columns }, (_, ci) => {
                      const c = page.column + ci,
                        address = columnLabel(c) + r,
                        cell = page.cells[address],
                        edit = edits[key(sheet, address)],
                        format = { ...cell, ...edit?.format },
                        result = fresh?.cells[address],
                        raw =
                          inputDirty && address === active
                            ? input
                            : (edit?.value ?? cell?.input ?? ''),
                        valueMode =
                          inputDirty && address === active
                            ? mode
                            : edit?.value !== undefined
                              ? edit.mode
                              : cell?.textValue
                                ? 'text'
                                : 'auto',
                        isFormula = valueMode === 'auto' && raw.startsWith('='),
                        display =
                          result?.display ??
                          (isFormula ? (calculationError ? uiText('计算不可用') : '…') : raw),
                        selected =
                          r >= selection.top &&
                          r <= selection.bottom &&
                          c >= selection.left &&
                          c <= selection.right;
                      const merged = mergeCell(page, address);
                      if (merged.skip) return null;
                      return (
                        <td
                          rowSpan={merged.rowSpan}
                          colSpan={merged.colSpan}
                          key={address}
                          tabIndex={address === active ? 0 : -1}
                          aria-selected={selected}
                          aria-label={`${address} ${display}`}
                          className={`${selected ? 'selected ' : ''}${address === active ? 'active ' : ''}${edit ? 'modified ' : ''}${cell?.readOnly ? 'readonly ' : ''}${result?.error ? 'calculation-error' : ''}`}
                          style={{
                            ...cellLayout(page, r, c),
                            fontWeight: format.bold ? 700 : undefined,
                            fontStyle: format.italic ? 'italic' : undefined,
                            textDecoration: format.underline ? 'underline' : undefined,
                            fontSize: format.fontSize ? `${format.fontSize}pt` : undefined,
                            whiteSpace: format.wrap ? 'pre-wrap' : 'pre',
                            overflowWrap: format.wrap ? 'anywhere' : undefined,
                            color: format.color,
                            backgroundColor: selected
                              ? undefined
                              : (conditionalColor(page, r, c, display) ??
                                format.background ??
                                undefined),
                            textAlign: ['left', 'center', 'right'].includes(format.align ?? '')
                              ? (format.align as 'left' | 'center' | 'right')
                              : undefined,
                          }}
                          title={
                            result?.error ??
                            cell?.readOnly ??
                            (isFormula ? `${raw} → ${display}` : format.numberFormat)
                          }
                          onClick={(event) => choose(address, event.shiftKey)}
                          onDoubleClick={() => {
                            choose(address);
                            inputRef.current?.focus();
                            inputRef.current?.select();
                          }}
                          onKeyDown={(event) => {
                            if (
                              blocked ||
                              event.nativeEvent.isComposing ||
                              event.nativeEvent.keyCode === 229
                            )
                              return;
                            const delta: { [k: string]: [number, number] } = {
                              ArrowUp: [-1, 0],
                              ArrowDown: [1, 0],
                              ArrowLeft: [0, -1],
                              ArrowRight: [0, 1],
                              Tab: [0, event.shiftKey ? -1 : 1],
                              Enter: [1, 0],
                            };
                            if (delta[event.key]) {
                              event.preventDefault();
                              event.stopPropagation();
                              const [dr, dc] = delta[event.key],
                                nextRow = Math.max(
                                  page.row,
                                  Math.min(page.row + page.rows - 1, r + dr),
                                ),
                                nextColumn = Math.max(
                                  page.column,
                                  Math.min(page.column + page.columns - 1, c + dc),
                                );
                              choose(
                                columnLabel(nextColumn) + nextRow,
                                event.shiftKey && event.key !== 'Tab',
                              );
                              const element = event.currentTarget
                                .closest('table')
                                ?.querySelector(
                                  `[data-address="${columnLabel(nextColumn) + nextRow}"]`,
                                ) as HTMLElement | null;
                              element?.focus();
                            } else if (event.key === 'Delete' || event.key === 'Backspace') {
                              event.preventDefault();
                              event.stopPropagation();
                              clear();
                            } else if (
                              !event.ctrlKey &&
                              !event.metaKey &&
                              !event.altKey &&
                              event.key.length === 1 &&
                              !cell?.readOnly
                            ) {
                              event.preventDefault();
                              setInput(event.key);
                              setInputDirty(true);
                              inputRef.current?.focus();
                            } else if (event.key === 'F2') {
                              event.preventDefault();
                              inputRef.current?.focus();
                            }
                          }}
                          data-address={address}
                        >
                          {cell?.merged && cell.merged !== address ? '' : display}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!loading && !page && (
          <div className="xlsx-empty">
            {uiText('暂时无法打开此工作簿。原文件仍保留，可返回文件详情导出。')}
          </div>
        )}
      </div>
      <div className="xlsx-tabs">
        <nav aria-label={uiText('工作表')}>
          {page?.sheets.map((s) => (
            <button
              key={s.id}
              disabled={blocked}
              className={s.id === sheet ? 'chosen' : ''}
              onClick={() => movePage(1, 1, s.id)}
            >
              {s.name}
              {s.hidden ? uiText(' · 隐藏表') : ''}
              {s.readOnly ? uiText(' · 只读') : ''}
            </button>
          ))}
        </nav>
      </div>
      <div className="xlsx-paging">
        <button
          disabled={blocked || row === 1}
          onClick={() => movePage(Math.max(1, row - 50), column)}
        >
          {uiText('上 50 行')}
        </button>
        <button disabled={blocked || row + 50 > 1048576} onClick={() => movePage(row + 50, column)}>
          {uiText('下 50 行')}
        </button>
        <button
          disabled={blocked || column === 1}
          onClick={() => movePage(row, Math.max(1, column - 16))}
        >
          {uiText('左 16 列')}
        </button>
        <button
          disabled={blocked || column + 16 > 16384}
          onClick={() => movePage(row, column + 16)}
        >
          {uiText('右 16 列')}
        </button>
        <small>
          {page
            ? `${columnLabel(page.column)}${page.row} — ${columnLabel(page.column + page.columns - 1)}${page.row + page.rows - 1}`
            : ''}{' '}
          · {count + (inputDirty ? 1 : 0)} {uiText('格 /')}
          {operations.length} {uiText('次结构修改待保存')}
        </small>
      </div>
      <XlsxCharts
        objectId={object.id}
        revision={revision}
        disabled={dirty || saving || loading || structuring || importing}
        action={action}
        dirtyChanged={setChartDirty}
        saved={async (next) => {
          setRevision(next);
          cache.current = {};
          cacheVersion.current = '';
          setReloadKey((n) => n + 1);
          setNotice(uiText('图表已保存回原文件'));
          await updated();
        }}
      />
      <details className="xlsx-limits">
        <summary>{uiText('兼容范围与操作提示')}</summary>
        <p>
          {uiText(
            '单击选择，双击或 F2 编辑；Shift 点击选择区域，Ctrl/Cmd C、V 复制粘贴，Ctrl/Cmd S 保存。此处提供 XLSX 兼容编辑界面，不是微软 Excel。',
          )}
        </p>
        <p>
          {page?.warnings.slice(1).join(' ') ??
            uiText('支持未加密的 .xlsx 文件，暂不支持 .xls / .xlsm。')}{' '}
          {uiText(
            '支持字体、填充、对齐、换行和数字格式，Shift 选区可批量修改。数字格式只改变显示，不转换数据类型；以 = 开头的文字请选纯文本。支持行列增删、工作表新增和改名；普通公式引用同步调整，被完全删除的引用变为 #REF!。含图表、透视表、外部数据等复杂部件的文件暂不能调整行列或改名；条件格式和数据验证区域暂不能增删行列。字符串中的地址（如 INDIRECT）不会随结构修改。数字和公式按输入类型保存，纯文本模式保留以 = 开头的文字。',
          )}
        </p>
      </details>
    </div>
  );
}
