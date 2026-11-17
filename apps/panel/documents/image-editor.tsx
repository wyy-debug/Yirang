import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { subscribeUiLanguage as onUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import {
  Annotation,
  type AnnotationDraft,
  type AnnotationDraftSummary,
  type DesktopObject,
  type RectAnnotation,
} from '../../../packages/contracts/index.js';
import { ImagePreview, type AnnotationTool } from './images.js';
import { PanelActionError, PanelClosedError } from '../host.js';

type Draft = { base: number; before: RectAnnotation[]; annotations: RectAnnotation[] };
type ImageContent = {
  assetHash: string;
  mime: string;
  width: number;
  height: number;
  annotations: RectAnnotation[];
};
let names: Record<AnnotationTool, string> = {
  rect: uiText('矩形'),
  ellipse: uiText('圈选'),
  arrow: uiText('箭头'),
  pen: uiText('自由笔'),
  text: uiText('文字'),
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function mergeDraft(draft: Draft, current: RectAnnotation[]): RectAnnotation[] {
  const ids = [...new Set([...draft.before, ...draft.annotations].map((item) => item.id))];
  const touched = ids.filter(
    (id) =>
      !same(
        draft.before.find((item) => item.id === id),
        draft.annotations.find((item) => item.id === id),
      ),
  );
  for (const id of touched) {
    if (
      !same(
        current.find((item) => item.id === id),
        draft.before.find((item) => item.id === id),
      )
    )
      throw new Error(uiText('同一条批注已有新修改。请先比较当前批注与草稿，再决定保留哪一份。'));
  }
  const next = current
    .filter(
      (item) =>
        !touched.includes(item.id) || draft.annotations.some((value) => value.id === item.id),
    )
    .map((item) =>
      touched.includes(item.id) ? draft.annotations.find((value) => value.id === item.id)! : item,
    );
  for (const item of draft.annotations)
    if (touched.includes(item.id) && !current.some((value) => value.id === item.id))
      next.push(item);
  if (next.length > 100) throw new Error(uiText('合并后超过 100 条批注，请减少批注后再保存。'));
  return next;
}
function transform(
  annotation: RectAnnotation,
  x: number,
  y: number,
  width: number,
  height: number,
): RectAnnotation {
  width = Math.max(0.001, Math.min(1, width));
  height = Math.max(0.001, Math.min(1, height));
  x = Math.max(0, Math.min(1 - width, x));
  y = Math.max(0, Math.min(1 - height, y));
  return {
    ...annotation,
    x,
    y,
    width,
    height,
    ...(annotation.points
      ? {
          points: annotation.points.map((point) => ({
            x: Math.max(0, Math.min(1, x + ((point.x - annotation.x) / annotation.width) * width)),
            y: Math.max(
              0,
              Math.min(1, y + ((point.y - annotation.y) / annotation.height) * height),
            ),
          })),
        }
      : {}),
  };
}

export function ImageEditor({
  object,
  action,
  saved,
  leave,
  dirtyChanged,
}: {
  object: DesktopObject;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  saved: (draft: AnnotationDraft) => Promise<void>;
  leave: () => void;
  dirtyChanged: (dirty: boolean) => void;
}) {
  useUiLocale();
  const image = object.content as ImageContent,
    original = image.annotations;
  const [draft, setDraft] = useState<Draft | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<AnnotationTool | null>(null),
    [note, setNote] = useState('');
  const [saving, setSaving] = useState(false),
    [unknown, setUnknown] = useState(false),
    [error, setError] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [recovery, setRecovery] = useState<AnnotationDraftSummary[]>([]),
    [loading, setLoading] = useState(true);
  const [checkpointState, setCheckpointState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );
  const mounted = useRef(true),
    active = useRef(false),
    draftRef = useRef(draft),
    pending = useRef<string | null>(null);
  const checkpoint = useRef<AnnotationDraft | null>(null),
    checkpointId = useRef<string>(crypto.randomUUID());
  const checkpointRequest = useRef<Record<string, unknown> | null>(null),
    checkpointQueue = useRef<Promise<unknown>>(Promise.resolve());
  const actionRef = useRef(action);
  actionRef.current = action;
  const values = draft?.annotations ?? original,
    chosen = values.find((item) => item.id === selected);
  const stale = !!draft && draft.base !== object.revision,
    locked = saving || unknown || showCurrent || loading;
  useEffect(() => {
    dirtyChanged(!!draft || saving || unknown);
  }, [draft, saving, unknown, dirtyChanged]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dirtyChanged(false);
    };
  }, [dirtyChanged]);
  async function listRecovery() {
    const result: AnnotationDraftSummary[] = await actionRef.current('annotation_drafts');
    if (mounted.current) setRecovery(result.filter((item) => item.objectId === object.id));
  }
  useEffect(() => {
    void listRecovery()
      .catch((e) => {
        if (mounted.current) setError(String(e));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, [object.id]);
  function enqueue<T>(fn: () => Promise<T>) {
    const result = checkpointQueue.current
      .catch(() => {})
      .then(() => {
        if (!mounted.current) throw new PanelClosedError();
        return fn();
      });
    checkpointQueue.current = result;
    return result;
  }
  async function persist() {
    const captured = draftRef.current && structuredClone(draftRef.current);
    if (!captured) return;
    return enqueue(async () => {
      if (mounted.current) setCheckpointState('saving');
      async function dispatch() {
        const result = await actionRef.current('annotation_draft', checkpointRequest.current!);
        checkpoint.current = result.draft;
        checkpointRequest.current = null;
      }
      // A transport failure keeps the exact request for an idempotent retry.
      if (checkpointRequest.current) await dispatch();
      const current = checkpoint.current;
      if (
        !current ||
        current.baseRevision !== captured.base ||
        !same(current.annotations, captured.annotations)
      ) {
        checkpointRequest.current = {
          operation: 'write',
          id: checkpointId.current,
          objectId: object.id,
          expectedVersion: current?.version ?? 0,
          baseRevision: captured.base,
          annotations: captured.annotations,
          requestId: crypto.randomUUID(),
        };
        await dispatch();
      }
      if (mounted.current) setCheckpointState(same(draftRef.current, captured) ? 'saved' : 'idle');
      return checkpoint.current!;
    });
  }
  useEffect(() => {
    if (!draft || saving || unknown) return;
    const timer = setTimeout(
      () =>
        void persist().catch((e) => {
          if (mounted.current) {
            setCheckpointState('error');
            setError(uiText('草稿暂存失败，请保持面板打开并重试：{0}', { '0': String(e) }));
          }
        }),
      350,
    );
    return () => clearTimeout(timer);
  }, [draft, saving, unknown]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!draftRef.current || active.current || pending.current) return;
      void enqueue(async () => {
        const value = checkpoint.current;
        if (!value || value.state !== 'editing') return;
        await actionRef.current('annotation_draft', {
          operation: 'renew',
          id: value.id,
          expectedVersion: value.version,
        });
      }).catch((e) => {
        if (mounted.current) {
          setCheckpointState('error');
          setError(uiText('草稿仍保留，但编辑租约未续期：{0}', { '0': String(e) }));
        }
      });
    }, 10000);
    return () => clearInterval(timer);
  }, []);
  async function recover(item: AnnotationDraftSummary) {
    if (active.current || draftRef.current) return;
    active.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await actionRef.current('annotation_draft', {
        operation: 'claim',
        id: item.id,
        expectedVersion: item.version,
        requestId: crypto.randomUUID(),
      });
      if (!mounted.current) return;
      const value = result.draft as AnnotationDraft;
      if (value.state === 'saved') {
        await saved(value);
        await listRecovery();
        setError(uiText('这份草稿已保存为正式版本。'));
        return;
      }
      checkpoint.current = value;
      checkpointId.current = value.id;
      checkpointRequest.current = null;
      const next = {
        base: value.baseRevision,
        before: value.before,
        annotations: value.annotations,
      };
      draftRef.current = next;
      setDraft(next);
      pending.current = value.pending?.requestId ?? null;
      setUnknown(!!value.pending);
      setCheckpointState('saved');
      setSelected(null);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      active.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function keepAndLeave() {
    if (active.current || unknown) return;
    active.current = true;
    setSaving(true);
    setError('');
    try {
      const value = await persist();
      if (value)
        await actionRef.current('annotation_draft', {
          operation: 'release',
          id: value.id,
          expectedVersion: value.version,
        });
      if (mounted.current) leave();
    } catch (e) {
      if (mounted.current) {
        setCheckpointState('error');
        setError(uiText('草稿尚未安全暂存：{0}', { '0': String(e) }));
      }
    } finally {
      active.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function replace(annotations: RectAnnotation[]) {
    if (locked || active.current) return;
    const previous = draftRef.current;
    const next: Draft = {
      base: previous?.base ?? object.revision,
      before: previous?.before ?? structuredClone(original),
      annotations,
    };
    draftRef.current = next;
    setDraft(next);
    pending.current = null;
    setCheckpointState('idle');
    setError('');
  }
  function edit(annotation: RectAnnotation) {
    replace(values.map((item) => (item.id === annotation.id ? annotation : item)));
  }
  function choose(id: string) {
    if (saving || showCurrent) return;
    setTool(null);
    setSelected(id);
  }
  function add(annotation: RectAnnotation) {
    if (values.length >= 100) return;
    replace([...values, annotation]);
    setSelected(annotation.id);
    setTool(null);
  }
  async function discard() {
    if (saving || unknown || active.current) return;
    active.current = true;
    setSaving(true);
    try {
      const value = await persist();
      if (value)
        await actionRef.current('annotation_draft', {
          operation: 'discard',
          id: value.id,
          expectedVersion: value.version,
          requestId: crypto.randomUUID(),
        });
      if (!mounted.current) return;
      draftRef.current = null;
      setDraft(null);
      pending.current = null;
      checkpoint.current = null;
      checkpointId.current = crypto.randomUUID();
      setCheckpointState('idle');
      setError('');
      setShowCurrent(false);
      setSelected(null);
      setTool(null);
      await listRecovery();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      active.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  function merge() {
    if (!draft || locked) return;
    try {
      const annotations = mergeDraft(draft, original);
      const next = { base: object.revision, before: structuredClone(original), annotations };
      draftRef.current = next;
      setDraft(next);
      pending.current = null;
      setCheckpointState('idle');
      setError('');
      setShowCurrent(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function commit() {
    const captured = draftRef.current;
    if (!captured || active.current) return;
    if (!pending.current) {
      try {
        if (captured.annotations.length > 100) throw new Error(uiText('每张图片最多 100 条批注。'));
        if (
          new Set(captured.annotations.map((item) => item.id)).size !== captured.annotations.length
        )
          throw new Error(uiText('批注标识重复，请重新选择。'));
        captured.annotations.forEach((item) => Annotation.parse(item));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    active.current = true;
    setSaving(true);
    setError('');
    try {
      const value = unknown ? checkpoint.current : await persist();
      if (!value) throw new Error(uiText('草稿尚未暂存，请重试。'));
      pending.current ??= crypto.randomUUID();
      const result = await actionRef.current('annotation_draft', {
        operation: 'save',
        id: value.id,
        expectedVersion: value.version,
        requestId: pending.current,
      });
      if (!mounted.current) return;
      checkpoint.current = result.draft;
      if (result.error) {
        pending.current = null;
        setUnknown(false);
        setError(result.error.message);
        return;
      }
      if (result.draft.state !== 'saved') throw new Error(uiText('保存结果尚待确认。'));
      draftRef.current = null;
      setDraft(null);
      pending.current = null;
      checkpoint.current = null;
      checkpointId.current = crypto.randomUUID();
      setUnknown(false);
      setCheckpointState('idle');
      setShowCurrent(false);
      setTool(null);
      // A display refresh cannot turn a confirmed save into an unknown write.
      try {
        await saved(result.draft);
        await listRecovery();
      } catch (e) {
        if (mounted.current) setError(uiText('批注已保存，界面暂未刷新：{0}', { '0': String(e) }));
      }
    } catch (e) {
      if (!mounted.current || e instanceof PanelClosedError) return;
      if (e instanceof PanelActionError && e.code !== 'LOCAL_ERROR') {
        pending.current = null;
        setUnknown(false);
        setError(e.message);
      } else if (pending.current) {
        setUnknown(true);
        setError(
          uiText('尚未确认保存结果：{0}。请重试同一次保存。', {
            '0': e instanceof Error ? e.message : String(e),
          }),
        );
      } else {
        setCheckpointState('error');
        setError(uiText('草稿尚未暂存：{0}。请保持面板打开并重试。', { '0': String(e) }));
      }
    } finally {
      active.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const preview: DesktopObject = {
    ...object,
    content: { ...image, annotations: showCurrent ? original : values },
  };
  return (
    <div className="image-editor">
      {!draft && (
        <div className="annotation-recovery">
          {loading ? (
            <span>{uiText('正在读取批注草稿…')}</span>
          ) : recovery.length > 0 ? (
            <>
              <strong>
                {uiText('有')}
                {recovery.length} {uiText('份未完成的批注草稿')}
              </strong>
              {recovery.map((item) => (
                <button key={item.id} disabled={saving} onClick={() => void recover(item)}>
                  {uiText('恢复')}
                  {new Date(item.updatedAt).toLocaleString(interfaceLocale())} ·{' '}
                  {item.annotationCount} {uiText('条')}
                  {item.pending ? uiText(' · 保存待确认') : ''}
                </button>
              ))}
            </>
          ) : (
            <span>{uiText('批注草稿会暂存到本地，正式保存后才更新图片版本。')}</span>
          )}
          <button
            disabled={saving}
            onClick={() => void listRecovery().catch((e) => setError(String(e)))}
          >
            {uiText('刷新草稿')}
          </button>
        </div>
      )}
      <div className="image-tools">
        <button disabled={locked} className={!tool ? 'active' : ''} onClick={() => setTool(null)}>
          {uiText('选择批注')}
        </button>
        {(Object.keys(names) as AnnotationTool[]).map((value) => (
          <button
            key={value}
            disabled={locked || values.length >= 100}
            className={tool === value ? 'active' : ''}
            onClick={() => {
              setTool(value);
              setSelected(null);
            }}
          >
            {names[value]}
          </button>
        ))}
        <span>
          {uiText('原图不变 ·')}
          {values.length} {uiText('/ 100 条批注')}
        </span>
      </div>
      {!showCurrent && (tool || chosen) && (
        <div className="annotation-note">
          <label>
            {chosen ? uiText('修改这条批注的说明') : uiText('新批注说明')}
            <textarea
              value={chosen?.note ?? note}
              maxLength={1000}
              disabled={locked}
              placeholder={
                tool === 'text' ? uiText('输入文字后点击图片放置') : uiText('可添加说明')
              }
              onChange={(event) =>
                chosen ? edit({ ...chosen, note: event.target.value }) : setNote(event.target.value)
              }
            />
          </label>
          {chosen && (
            <div className="annotation-geometry">
              <span>
                {names[chosen.type]} {uiText('· 位置')}
                {Math.round(chosen.x * 100)}%, {Math.round(chosen.y * 100)}%
              </span>
              <div>
                {[
                  { label: '←', direction: uiText('左'), dx: -0.01, dy: 0 },
                  { label: '↑', direction: uiText('上'), dx: 0, dy: -0.01 },
                  { label: '↓', direction: uiText('下'), dx: 0, dy: 0.01 },
                  { label: '→', direction: uiText('右'), dx: 0.01, dy: 0 },
                ].map((move) => (
                  <button
                    key={move.label}
                    disabled={locked}
                    aria-label={uiText('向{0}移动批注 1%', { '0': move.direction })}
                    onClick={() =>
                      edit(
                        transform(
                          chosen,
                          chosen.x + move.dx,
                          chosen.y + move.dy,
                          chosen.width,
                          chosen.height,
                        ),
                      )
                    }
                  >
                    {move.label}
                  </button>
                ))}
                <button
                  disabled={locked || chosen.type === 'text'}
                  onClick={() =>
                    edit(
                      transform(
                        chosen,
                        chosen.x,
                        chosen.y,
                        chosen.width * 0.95,
                        chosen.height * 0.95,
                      ),
                    )
                  }
                >
                  {uiText('缩小')}
                </button>
                <button
                  disabled={locked || chosen.type === 'text'}
                  onClick={() =>
                    edit(
                      transform(
                        chosen,
                        chosen.x,
                        chosen.y,
                        chosen.width * 1.05,
                        chosen.height * 1.05,
                      ),
                    )
                  }
                >
                  {uiText('放大')}
                </button>
                <button
                  disabled={locked}
                  onClick={() => {
                    replace(values.filter((item) => item.id !== chosen.id));
                    setSelected(null);
                  }}
                >
                  {uiText('删除此条')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="annotation-feedback error-text" role="alert">
          {error}
        </div>
      )}
      {stale && !unknown && (
        <div className="annotation-feedback">
          <span>
            {uiText('图片已有 v')}
            {object.revision}
            {uiText('，草稿基于 v')}
            {draft.base}
            {uiText('。同一条批注被他人改动时不会覆盖。')}
          </span>
          <button
            disabled={saving}
            onClick={() => {
              setShowCurrent(!showCurrent);
              setTool(null);
            }}
          >
            {showCurrent ? uiText('返回草稿预览') : uiText('查看当前已保存批注')}
          </button>
          <button disabled={locked} onClick={merge}>
            {uiText('合并未冲突批注')}
          </button>
        </div>
      )}
      <div className="image-edit-body">
        <div className="full-image">
          <ImagePreview
            object={preview}
            selectedId={selected ?? undefined}
            choose={saving ? undefined : choose}
            annotate={tool && !locked ? add : undefined}
            tool={tool ?? 'rect'}
            note={note}
          />
        </div>
        <aside className="annotation-list" aria-label={uiText('逐条批注')}>
          <strong>{showCurrent ? uiText('当前已保存批注') : uiText('批注清单')}</strong>
          {(showCurrent ? original : values).map((annotation, index) => (
            <button
              key={annotation.id}
              disabled={saving || showCurrent}
              className={selected === annotation.id ? 'selected' : ''}
              onClick={() => choose(annotation.id)}
            >
              <span>
                {index + 1} · {names[annotation.type]}
              </span>
              <small>{annotation.note || uiText('无文字说明')}</small>
            </button>
          ))}
          {!values.length && <p>{uiText('选择上方工具，在图片上添加批注。')}</p>}
        </aside>
      </div>
      <footer className="annotation-save">
        <span>
          {saving
            ? uiText('正在保存批注…')
            : unknown
              ? uiText('保存结果待确认')
              : draft
                ? checkpointState === 'saved'
                  ? uiText('草稿已暂存本地，尚未更新图片')
                  : checkpointState === 'saving'
                    ? uiText('正在暂存草稿…')
                    : checkpointState === 'error'
                      ? uiText('草稿暂存失败，请保持面板打开')
                      : uiText('草稿等待暂存')
                : uiText('批注已保存')}
        </span>
        {draft && (
          <>
            <button disabled={saving || unknown} onClick={() => void keepAndLeave()}>
              {uiText('保留草稿并返回')}
            </button>
            <button disabled={saving || unknown} onClick={() => void discard()}>
              {uiText('放弃批注草稿')}
            </button>
          </>
        )}
        <button
          className="primary"
          disabled={saving || !draft || (stale && !unknown) || showCurrent}
          onClick={() => void commit()}
        >
          {unknown ? uiText('重试此次保存') : uiText('保存批注')}
        </button>
      </footer>
    </div>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  names = {
    rect: uiText('矩形'),
    ellipse: uiText('圈选'),
    arrow: uiText('箭头'),
    pen: uiText('自由笔'),
    text: uiText('文字'),
  };
});
