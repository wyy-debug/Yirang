import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import { useTransientNotice } from '../../ui/use-transient-notice.js';
import React, { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { OfficeContinuousEditor } from './office-continuous-editor.js';
import { OfficeStructure } from './office-structure.js';
import { OfficeLayoutPreview } from './office-layout-preview.js';
import { NativeMerge } from '../native/native-merge.js';
import type { DesktopObject, MaterialRange } from '../../../../packages/contracts/index.js';
import {
  OfficeEdit,
  OfficeSave,
  type OfficeChange,
  type OfficePage,
} from '../../../../packages/contracts/office.js';
import { PanelActionError } from '../../host.js';
import { scheduleDraftWrite, flushDraftStorage, writeDraftNow } from '../draft-storage.js';
import './office-editor.css';
const Draft = z
  .object({
    objectId: z.string(),
    revision: z.number().int().positive(),
    edits: z.array(OfficeEdit).max(2000),
    pending: OfficeSave.nullable(),
    page: z.number().int().min(0).max(5000),
    pageCount: z.number().int().min(1).max(25).default(1),
  })
  .strict();
type Props = {
  reference: (range?: MaterialRange) => Promise<boolean>;
  comment?: (range?: MaterialRange) => void;
  canReference: boolean;
  object: DesktopObject;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  details: () => void;
  dirtyChanged: (value: boolean) => void;
};
export function OfficeFileEditor({
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
  const slot = `ai-desktop:office-draft:${object.id}`;
  const [initial] = useState(() => {
    try {
      const d = Draft.parse(JSON.parse(localStorage.getItem(slot) ?? 'null'));
      return d.objectId === object.id ? d : null;
    } catch {
      return null;
    }
  });
  const [revision, setRevision] = useState(initial?.revision ?? object.revision),
    [edits, setEdits] = useState<OfficeChange[]>(initial?.edits ?? []),
    [pending, setPending] = useState(initial?.pending ?? null),
    [page, setPage] = useState(initial?.page ?? focus?.page ?? 0),
    [pageCount, setPageCount] = useState(initial?.pageCount ?? 1),
    [data, setData] = useState<OfficePage | null>(null),
    [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [storageError, setStorageError] = useState(''),
    [notice, setNotice] = useTransientNotice(initial ? uiText('已恢复文档编辑草稿。') : ''),
    [discard, setDiscard] = useState(false),
    [selectedShape, setSelectedShape] = useState('');
  const [drag, setDrag] = useState<any>(null);
  const actions = useRef(action),
    input = useRef<HTMLInputElement>(null),
    inFlight = useRef(false),
    past = useRef<OfficeChange[][]>([]);
  actions.current = action;
  const dirty = !!edits.length || !!pending,
    blocked = busy || loading || !!pending,
    conflict = object.revision !== revision;
  useEffect(() => {
    if (!dirty && !loading && !busy && object.revision !== revision) {
      setRevision(object.revision);
      setReload((n) => n + 1);
      void actions
        .current('native_workbench', { operation: 'location', objectId: object.id })
        .then((location) => {
          const s = location?.selection;
          if (s?.kind === 'office') {
            setPage(s.page);
            if (s.ids[0]?.startsWith('s')) setSelectedShape(s.ids[0]);
          }
        })
        .catch(() => {});
    }
  }, [object.revision, revision, dirty, loading, busy]);
  const backup = () => ({ objectId: object.id, revision, edits, pending, page, pageCount });
  useEffect(() => {
    dirtyChanged(dirty || busy);
    return () => dirtyChanged(false);
  }, [dirty, busy, dirtyChanged]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setData(null);
    void actions
      .current('office_read', { objectId: object.id, expectedRevision: revision, page, pageCount })
      .then((r: OfficePage) => {
        if (live) setData(r);
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
  }, [object.id, revision, page, pageCount, reload]);
  useEffect(() => {
    scheduleDraftWrite(
      slot,
      () => (dirty ? JSON.stringify(backup()) : null),
      (error) =>
        setStorageError(error ? uiText('浏览器无法保留草稿，请下载草稿或保存后再关闭。') : ''),
    );
  }, [edits, pending, page, pageCount, revision]);
  useEffect(() => () => flushDraftStorage(slot), [slot]);
  useEffect(() => {
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [dirty]);
  function changeMany(changes: OfficeChange[]) {
    if (blocked || !changes.length) return;
    try {
      changes.forEach((edit) => OfficeEdit.parse(edit));
      const changed = new Map(changes.map((e) => [e.id, e])),
        next = [...edits.filter((e) => !changed.has(e.id)), ...changed.values()];
      const size = next.reduce(
        (n, e) =>
          n +
          256 +
          (e.kind === 'run'
            ? e.text.length
            : e.kind === 'paragraph'
              ? (e.replacement?.reduce((a, v) => a + v.length, 0) ?? 0)
              : 0),
        0,
      );
      if (next.length > 2000 || size > 1800000) throw Error(uiText('草稿过大，请先保存。'));
      past.current.push(edits);
      if (past.current.length > 30) past.current.shift();
      setEdits(next);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  function change(edit: OfficeChange) {
    changeMany([edit]);
  }
  async function commentSelection(ids: string[]) {
    if (!comment || dirty || blocked || conflict || !ids.length) return;
    try {
      const range = await action('native_workbench', {
        operation: 'reference',
        objectId: object.id,
        expectedRevision: revision,
        selection: { kind: 'office', page, ids },
      });
      comment(range);
    } catch (e) {
      setError(String(e));
    }
  }
  async function save() {
    if (inFlight.current || loading || !dirty) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (conflict && !pending)
        throw Error(uiText('文件已有新版本，请先下载草稿并在原对话中合并，或载入最新后重新编辑。'));
      const request =
        pending ??
        OfficeSave.parse({
          objectId: object.id,
          expectedRevision: revision,
          requestId: crypto.randomUUID(),
          edits,
        });
      setPending(request);
      try {
        writeDraftNow(slot, JSON.stringify({ ...backup(), pending: request }));
      } catch {}
      const result = await action('office_save', request);
      try {
        writeDraftNow(slot, null);
      } catch {}
      setEdits([]);
      setPending(null);
      setRevision(result.revision);
      if (data?.kind === 'docx' && data.page + (data.loadedPages ?? 1) >= data.pages) {
        const total =
          data.page * 40 +
          data.paragraphs.length +
          edits.reduce(
            (n, e) =>
              n +
              (e.kind === 'paragraph' && e.replacement !== undefined
                ? e.replacement.length - 1
                : 0),
            0,
          );
        setPage((p: number) => Math.min(p, Math.max(0, Math.ceil(Math.max(1, total) / 40) - 1)));
      }
      past.current = [];
      setReload((n) => n + 1);
      setNotice(uiText('已保存回原文件'));
      await updated();
    } catch (e) {
      if (
        e instanceof PanelActionError &&
        [
          'OFFICE_FILE',
          'OFFICE_EDIT',
          'OFFICE_LIMIT',
          'OFFICE_READ_ONLY',
          'REVISION_CONFLICT',
          'DRAFT_ACTIVE',
          'VALIDATION_FAILED',
          'REQUEST_ID_REUSED',
        ].includes(e.code)
      )
        setPending(null);
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup(), null, 2)], { type: 'application/json' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = uiText('原生文档编辑草稿.json');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function restore(file: File) {
    if (blocked || dirty || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (file.size > 8 * 1024 * 1024) throw Error(uiText('草稿文件过大。'));
      const d = Draft.parse(JSON.parse(await file.text()));
      if (d.objectId !== object.id) throw Error(uiText('请在原文档对象中导入。'));
      if (
        new Set(d.edits.map((e) => e.id)).size !== d.edits.length ||
        JSON.stringify(d.edits).length > 1800000
      )
        throw Error(uiText('草稿含重复编辑或超过上限。'));
      if (
        d.pending &&
        (d.pending.objectId !== object.id ||
          d.pending.expectedRevision !== d.revision ||
          JSON.stringify(d.pending.edits) !== JSON.stringify(d.edits))
      )
        throw Error(uiText('草稿与待确认请求不一致。'));
      await action('office_read', {
        objectId: object.id,
        expectedRevision: d.revision,
        page: d.page,
        pageCount: d.pageCount,
      });
      setEdits(d.edits);
      setPending(d.pending);
      setRevision(d.revision);
      setPage(d.page);
      setPageCount(d.pageCount);
      setReload((n) => n + 1);
      setNotice(uiText('已导入原文档的草稿。'));
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function reset() {
    setEdits([]);
    setPending(null);
    setPage(0);
    setPageCount(1);
    setRevision(object.revision);
    setReload((n) => n + 1);
    setDiscard(false);
    setError('');
    past.current = [];
  }
  const shape = data?.shapes.find((s) => s.id === selectedShape),
    geometry = edits.find((e) => e.id === selectedShape && e.kind === 'shape');
  return (
    <div
      className="office-editor"
      onKeyDown={(e) => {
        if (!e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }
      }}
    >
      <header>
        <div>
          <strong>{(object.content as { fileName: string }).fileName}</strong>
          <small>
            {uiText('原生文档编辑 · v')}
            {revision}
          </small>
        </div>
        <button
          className="primary"
          disabled={busy || loading || !dirty}
          onClick={() => void save()}
        >
          {pending ? uiText('重试同一次保存') : busy ? uiText('保存中…') : uiText('保存回原文件')}
        </button>
        <button
          disabled={blocked || !past.current.length}
          onClick={() => setEdits(past.current.pop()!)}
        >
          {uiText('撤销')}
        </button>
        <button disabled={!dirty} onClick={download}>
          {uiText('下载草稿')}
        </button>
        <button disabled={blocked || dirty} onClick={() => input.current?.click()}>
          {uiText('导入草稿')}
        </button>
        <input
          hidden
          ref={input}
          type="file"
          accept=".json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void restore(f);
          }}
        />
        <button disabled={busy} onClick={() => (dirty ? setDiscard(true) : reset())}>
          {uiText('载入最新')}
        </button>
        <button disabled={dirty || busy} onClick={details}>
          {uiText('文件详情')}
        </button>
      </header>
      {(error || storageError || notice || conflict) && (
        <div className="office-message" role="status">
          {error && <p className="error-text">{error}</p>}
          {storageError && <p>{storageError}</p>}
          {notice && <p>{notice}</p>}
          {conflict && (
            <p>
              {uiText('桌面已有 v')}
              {object.revision}
              {uiText('，本页草稿仍基于 v')}
              {revision}
              {uiText('，不能直接覆盖。')}
            </p>
          )}
        </div>
      )}
      {conflict && !pending && (
        <NativeMerge
          objectId={object.id}
          baseRevision={revision}
          format="office"
          edits={edits}
          action={action}
          apply={(rev, changes) => {
            setRevision(rev);
            setEdits(changes);
            setPage(0);
            setPending(null);
            setNotice(uiText('已采用合并草稿，请保存。'));
          }}
        />
      )}
      {discard && (
        <div className="office-message">
          {uiText('先下载草稿保留修改。待确认请求可能已保存，建议先重试。')}
          <button onClick={download}>{uiText('下载草稿')}</button>
          <button disabled={busy} onClick={reset}>
            {uiText('丢弃草稿并载入')}
          </button>
          <button onClick={() => setDiscard(false)}>{uiText('取消')}</button>
        </div>
      )}
      <nav>
        <button
          disabled={blocked || page === 0}
          onClick={() => {
            setPage((p: number) => p - 1);
            setPageCount(1);
          }}
        >
          {uiText('上一页')}
        </button>
        <select
          disabled={blocked}
          value={page}
          onChange={(e) => {
            setPage(Number(e.target.value));
            setPageCount(1);
          }}
        >
          {data?.labels.map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
        <button
          disabled={blocked || !data || page >= data.pages - 1}
          onClick={() => {
            setPage((p: number) => p + 1);
            setPageCount(1);
          }}
        >
          {uiText('下一页')}
        </button>
        <span>
          {edits.length} {uiText('处待保存')}
        </span>
        {data?.kind === 'docx' && (
          <>
            <span>
              {uiText('已连续载入')}
              {data.paragraphs.length} {uiText('段')}
            </span>
            <button
              disabled={blocked || page + (data.loadedPages ?? 1) >= data.pages || pageCount >= 25}
              onClick={() => setPageCount((n) => Math.min(25, n + 1))}
            >
              {uiText('继续载入 40 段')}
            </button>
            {pageCount >= 25 && (
              <small>{uiText('当前已达 1000 段上限，保存后可切换起始位置。')}</small>
            )}
          </>
        )}
      </nav>
      <OfficeLayoutPreview object={object} action={action} dirty={dirty || busy} />
      {data && (
        <OfficeStructure
          object={object}
          data={data}
          dirty={dirty || busy || loading}
          selectedShape={selectedShape}
          action={action}
          updated={updated}
          saved={(rev, nextPage) => {
            setRevision(rev);
            setPage(nextPage);
            setSelectedShape('');
            setReload((n) => n + 1);
            past.current = [];
          }}
        />
      )}
      {data?.kind === 'docx' &&
        data.shapes
          .filter((s) => s.image)
          .map((s) => (
            <figure key={s.id}>
              <img src={s.image} alt={s.name} style={{ maxWidth: '100%', maxHeight: 400 }} />
            </figure>
          ))}
      {loading && <p>{uiText('正在读取原文档…')}</p>}
      {data?.kind === 'pptx' && (
        <>
          <div
            className="office-slide"
            style={{
              aspectRatio: `${data.width}/${data.height}`,
              background: data.background ?? 'white',
            }}
          >
            {data.shapes.map((s) => {
              const changed = edits.find((e) => e.kind === 'shape' && e.id === s.id),
                g =
                  drag?.id === s.id
                    ? drag.value
                    : changed?.kind === 'shape'
                      ? { ...s, ...changed }
                      : s;
              return (
                <button
                  key={s.id}
                  className={s.id === selectedShape ? 'selected' : ''}
                  title={s.name}
                  onPointerDown={(e) => {
                    if (blocked || !s.editable || e.button !== 0) return;
                    const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setSelectedShape(s.id);
                    setDrag({
                      id: s.id,
                      start: { x: e.clientX, y: e.clientY },
                      scale: { x: data.width / rect.width, y: data.height / rect.height },
                      original: g,
                      value: g,
                    });
                  }}
                  onPointerMove={(e) => {
                    if (drag?.id !== s.id) return;
                    setDrag({
                      ...drag,
                      value: {
                        ...drag.original,
                        x: drag.original.x + (e.clientX - drag.start.x) * drag.scale.x,
                        y: drag.original.y + (e.clientY - drag.start.y) * drag.scale.y,
                      },
                    });
                  }}
                  onPointerUp={() => {
                    if (drag?.id === s.id) {
                      change({
                        ...(changed?.kind === 'shape' ? changed : {}),
                        kind: 'shape',
                        id: s.id,
                        x: drag.value.x,
                        y: drag.value.y,
                        width: drag.value.width,
                        height: drag.value.height,
                      });
                      setDrag(null);
                    }
                  }}
                  onPointerCancel={() => setDrag(null)}
                  style={{
                    left: `${(g.x / data.width) * 100}%`,
                    top: `${(g.y / data.height) * 100}%`,
                    width: `${(g.width / data.width) * 100}%`,
                    height: `${(g.height / data.height) * 100}%`,
                    transform: `rotate(${g.rotation ?? 0}deg)`,
                    background: g.fill && g.fill !== 'none' ? g.fill : 'transparent',
                    borderColor: g.stroke && g.stroke !== 'none' ? g.stroke : undefined,
                    borderWidth: g.strokeWidth ? g.strokeWidth : undefined,
                  }}
                  onClick={() => setSelectedShape(s.id)}
                >
                  {s.image ? (
                    <img src={s.image} alt={s.name} />
                  ) : (
                    data.paragraphs
                      .filter((p) => p.shapeId === s.id)
                      .map((p) => (
                        <span
                          key={p.id}
                          style={{
                            textAlign:
                              ((edits.find((e) => e.id === p.id && e.kind === 'paragraph') as any)
                                ?.align ?? p.align) === 'both'
                                ? 'justify'
                                : ((
                                    edits.find(
                                      (e) => e.id === p.id && e.kind === 'paragraph',
                                    ) as any
                                  )?.align ?? p.align),
                          }}
                        >
                          {p.runs.map((r) => {
                            const edit = edits.find((e) => e.id === r.id),
                              run = edit?.kind === 'run' ? { ...r, ...edit } : r;
                            return (
                              <span
                                className="office-slide-run"
                                key={r.id}
                                style={{
                                  fontWeight: run.bold ? 700 : 400,
                                  fontStyle: run.italic ? 'italic' : 'normal',
                                  fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
                                  fontFamily: run.fontFamily,
                                  color: run.color,
                                  textDecoration: run.underline ? 'underline' : undefined,
                                }}
                              >
                                {run.text}
                              </span>
                            );
                          })}
                        </span>
                      ))
                  )}
                </button>
              );
            })}
          </div>
          <small>{uiText('内容定位视图；母版、主题及复杂对象保留在原文件。')}</small>
          {shape && (
            <fieldset disabled={blocked || !shape.editable} className="office-geometry">
              <legend>
                {shape.name} {uiText('· 位置与大小（px）')}
              </legend>
              {(['x', 'y', 'width', 'height'] as const).map((k) => (
                <label key={k}>
                  {
                    { x: uiText('左'), y: uiText('上'), width: uiText('宽'), height: uiText('高') }[
                      k
                    ]
                  }
                  <input
                    type="number"
                    value={(geometry?.kind === 'shape' ? geometry : shape)[k]}
                    onChange={(e) =>
                      change({
                        kind: 'shape',
                        id: shape.id,
                        x: shape.x,
                        y: shape.y,
                        width: shape.width,
                        height: shape.height,
                        ...(geometry?.kind === 'shape' ? geometry : {}),
                        [k]: Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
              <label>
                {uiText('旋转')}
                <input
                  type="number"
                  min="-360"
                  max="360"
                  value={
                    (geometry?.kind === 'shape' ? geometry.rotation : undefined) ??
                    shape.rotation ??
                    0
                  }
                  onChange={(e) =>
                    change({
                      kind: 'shape',
                      id: shape.id,
                      x: shape.x,
                      y: shape.y,
                      width: shape.width,
                      height: shape.height,
                      ...(geometry?.kind === 'shape' ? geometry : {}),
                      rotation: Number(e.target.value),
                    })
                  }
                />
              </label>
              {shape.styleEditable && (
                <>
                  {(['fill', 'stroke'] as const).map((k) => (
                    <label key={k}>
                      {k === 'fill' ? uiText('填充') : uiText('描边')}
                      <input
                        type="color"
                        value={
                          (
                            (geometry?.kind === 'shape' ? geometry[k] : undefined) ?? shape[k]
                          )?.startsWith('#')
                            ? ((geometry?.kind === 'shape' ? geometry[k] : undefined) ?? shape[k])
                            : '#ffffff'
                        }
                        onChange={(e) =>
                          change({
                            kind: 'shape',
                            id: shape.id,
                            x: shape.x,
                            y: shape.y,
                            width: shape.width,
                            height: shape.height,
                            ...(geometry?.kind === 'shape' ? geometry : {}),
                            [k]: e.target.value,
                          })
                        }
                      />
                      <button
                        onClick={() =>
                          change({
                            kind: 'shape',
                            id: shape.id,
                            x: shape.x,
                            y: shape.y,
                            width: shape.width,
                            height: shape.height,
                            ...(geometry?.kind === 'shape' ? geometry : {}),
                            [k]: 'none',
                          })
                        }
                      >
                        {uiText('无')}
                      </button>
                    </label>
                  ))}
                  <label>
                    {uiText('描边宽')}
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={
                        (geometry?.kind === 'shape' ? geometry.strokeWidth : undefined) ??
                        shape.strokeWidth ??
                        0
                      }
                      onChange={(e) =>
                        change({
                          kind: 'shape',
                          id: shape.id,
                          x: shape.x,
                          y: shape.y,
                          width: shape.width,
                          height: shape.height,
                          ...(geometry?.kind === 'shape' ? geometry : {}),
                          strokeWidth: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </>
              )}
            </fieldset>
          )}
        </>
      )}
      {data?.kind === 'pptx' && comment && (
        <button
          disabled={dirty || blocked || conflict || !selectedShape}
          title={
            dirty ? uiText('先保存修改，再评论原文件元素') : uiText('评论当前选中的幻灯片元素')
          }
          onClick={() => void commentSelection([selectedShape])}
        >
          {uiText('评论选中元素')}
        </button>
      )}
      {data?.kind === 'docx' && (
        <OfficeContinuousEditor
          data={data}
          edits={edits}
          blocked={blocked}
          change={changeMany}
          canReference={canReference && !dirty && !blocked}
          reference={(ids) =>
            void action('native_workbench', {
              operation: 'reference',
              objectId: object.id,
              expectedRevision: revision,
              selection: { kind: 'office', page, ids },
            })
              .then(reference)
              .catch((e) => setError(String(e)))
          }
          comment={comment ? (ids) => void commentSelection(ids) : undefined}
          canComment={!dirty && !blocked && !conflict}
        />
      )}
      <div className="office-paragraphs">
        {data?.paragraphs
          .filter((p) => data.kind !== 'docx' || !p.continuous)
          .map((p, i) => {
            const paragraph = edits.find((e) => e.id === p.id),
              format = paragraph?.kind === 'paragraph' ? { ...p, ...paragraph } : p;
            return (
              <section
                key={p.id}
                data-paragraph-id={p.id}
                className={
                  p.shapeId === selectedShape || p.id === focus?.paragraphId ? 'selected' : ''
                }
              >
                <header>
                  <button
                    disabled={dirty || blocked || !canReference}
                    onClick={() =>
                      void action('native_workbench', {
                        operation: 'reference',
                        objectId: object.id,
                        expectedRevision: revision,
                        selection: { kind: 'office', page, ids: [p.shapeId ?? p.id] },
                      })
                        .then(reference)
                        .catch((e) => setError(String(e)))
                    }
                  >
                    {uiText('引用')}
                    {p.shapeId ? uiText('此元素') : uiText('此段落')}
                  </button>
                  {comment && (
                    <button
                      disabled={dirty || blocked || conflict}
                      title={
                        dirty
                          ? uiText('先保存修改，再评论原文件段落')
                          : uiText('评论当前原文件段落')
                      }
                      onClick={() => void commentSelection([p.shapeId ?? p.id])}
                    >
                      {uiText('评论')}
                      {p.shapeId ? uiText('此元素') : uiText('此段落')}
                    </button>
                  )}
                  <strong>
                    {p.shapeId
                      ? (data.shapes.find((s) => s.id === p.shapeId)?.name ?? uiText('文本'))
                      : uiText('段落 {0}', { '0': page * 40 + i + 1 })}
                  </strong>
                  <select
                    aria-label={uiText('段落对齐')}
                    disabled={blocked || !!p.readOnly}
                    value={format.align}
                    onChange={(e) =>
                      change({
                        ...(paragraph?.kind === 'paragraph' ? paragraph : {}),
                        kind: 'paragraph',
                        id: p.id,
                        align: e.target.value as any,
                      })
                    }
                  >
                    <option value="left">{uiText('左对齐')}</option>
                    <option value="center">{uiText('居中')}</option>
                    <option value="right">{uiText('右对齐')}</option>
                    <option value="both">{uiText('两端对齐')}</option>
                  </select>
                  {data.kind === 'docx' &&
                    (['before', 'after'] as const).map((k) => (
                      <label key={k}>
                        {k === 'before' ? uiText('段前') : uiText('段后')}
                        <input
                          type="number"
                          min="0"
                          max="200"
                          disabled={blocked || !!p.readOnly}
                          value={format[k]}
                          onChange={(e) =>
                            change({
                              ...(paragraph?.kind === 'paragraph' ? paragraph : {}),
                              kind: 'paragraph',
                              id: p.id,
                              [k]: Number(e.target.value),
                            })
                          }
                        />{' '}
                        pt
                      </label>
                    ))}
                </header>
                {p.readOnly && <small>{p.readOnly}</small>}
                {p.runs.map((r) => {
                  const current = edits.find((e) => e.id === r.id),
                    run = current?.kind === 'run' ? { ...r, ...current } : r;
                  return (
                    <div key={r.id} className="office-run">
                      <textarea
                        spellCheck={false}
                        aria-label={uiText('文本片段')}
                        readOnly={blocked || !!p.readOnly}
                        value={run.text}
                        style={{
                          fontWeight: run.bold ? 700 : 400,
                          fontStyle: run.italic ? 'italic' : 'normal',
                          fontFamily: run.fontFamily,
                          fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
                          color: run.color,
                          textDecoration: run.underline ? 'underline' : undefined,
                          textAlign: format.align === 'both' ? 'justify' : (format.align as any),
                        }}
                        onChange={(e) =>
                          change({
                            ...(current?.kind === 'run' ? current : {}),
                            kind: 'run',
                            id: r.id,
                            text: e.target.value,
                          })
                        }
                      />
                      <button
                        disabled={blocked || !!p.readOnly}
                        aria-pressed={run.bold}
                        onClick={() =>
                          change({
                            ...(current?.kind === 'run' ? current : {}),
                            kind: 'run',
                            id: r.id,
                            text: run.text,
                            bold: !run.bold,
                          })
                        }
                      >
                        B
                      </button>
                      <button
                        disabled={blocked || !!p.readOnly}
                        aria-pressed={run.italic}
                        onClick={() =>
                          change({
                            ...(current?.kind === 'run' ? current : {}),
                            kind: 'run',
                            id: r.id,
                            text: run.text,
                            italic: !run.italic,
                          })
                        }
                      >
                        I
                      </button>
                      <button
                        disabled={blocked || !!p.readOnly}
                        aria-pressed={run.underline ?? false}
                        onClick={() =>
                          change({
                            ...(current?.kind === 'run' ? current : {}),
                            kind: 'run',
                            id: r.id,
                            text: run.text,
                            underline: !run.underline,
                          })
                        }
                      >
                        U
                      </button>
                      <label>
                        {uiText('字号')}
                        <input
                          type="number"
                          min="1"
                          max="400"
                          disabled={blocked || !!p.readOnly}
                          value={run.fontSize ?? ''}
                          onChange={(e) => {
                            const value = Number(e.target.value);
                            if (value >= 1 && value <= 400)
                              change({
                                ...(current?.kind === 'run' ? current : {}),
                                kind: 'run',
                                id: r.id,
                                text: run.text,
                                fontSize: value,
                              });
                          }}
                        />
                      </label>
                      <label>
                        {uiText('字体')}
                        <select
                          disabled={blocked || !!p.readOnly}
                          value={run.fontFamily ?? ''}
                          onChange={(e) =>
                            change({
                              ...(current?.kind === 'run' ? current : {}),
                              kind: 'run',
                              id: r.id,
                              text: run.text,
                              fontFamily: e.target.value,
                            })
                          }
                        >
                          <option value="" disabled>
                            {uiText('原字体')}
                          </option>
                          {[
                            'Arial',
                            'Aptos',
                            'Calibri',
                            'Microsoft YaHei',
                            'SimSun',
                            'Times New Roman',
                          ].map((f) => (
                            <option key={f}>{f}</option>
                          ))}
                        </select>
                      </label>
                      <input
                        aria-label={uiText('文本颜色')}
                        type="color"
                        disabled={blocked || !!p.readOnly}
                        value={run.color ?? '#202124'}
                        onChange={(e) =>
                          change({
                            ...(current?.kind === 'run' ? current : {}),
                            kind: 'run',
                            id: r.id,
                            text: run.text,
                            color: e.target.value,
                          })
                        }
                      />
                    </div>
                  );
                })}
              </section>
            );
          })}
      </div>
      <footer>
        {data?.warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
      </footer>
    </div>
  );
}
