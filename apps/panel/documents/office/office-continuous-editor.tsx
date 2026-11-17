import { getUiLanguage as getUiLocale } from '../../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useMemo, useRef, useState } from 'react';
import type {
  OfficeChange,
  OfficePage,
  OfficeParagraph,
  OfficeRun,
} from '../../../../packages/contracts/office.js';
type Props = {
  data: OfficePage;
  edits: OfficeChange[];
  blocked: boolean;
  change: (edits: OfficeChange[]) => void;
  reference: (ids: string[]) => void;
  canReference: boolean;
  comment?: (ids: string[]) => void;
  canComment?: boolean;
};
export function OfficeContinuousEditor({
  data,
  edits,
  blocked,
  change,
  reference,
  canReference,
  comment,
  canComment,
}: Props) {
  useUiLocale();
  const [selection, setSelection] = useState<string[]>([]),
    [preview, setPreview] = useState(false),
    input = useRef<HTMLTextAreaElement | null>(null);
  const byId = useMemo(() => new Map(edits.map((e) => [e.id, e])), [edits, getUiLocale()]);
  const groups = useMemo(() => {
    const result: OfficeParagraph[][] = [];
    for (const p of data.paragraphs) {
      const last = result.at(-1);
      if (p.continuous && last?.at(-1)?.continuous) last.push(p);
      else result.push([p]);
    }
    return result;
  }, [data, getUiLocale()]);
  const effective = (p: OfficeParagraph) => {
    const edit = byId.get(p.id);
    return edit?.kind === 'paragraph' && edit.replacement !== undefined
      ? edit.replacement
      : [
          p.runs
            .map((r) => {
              const e = byId.get(r.id);
              return e?.kind === 'run' ? e.text : r.text;
            })
            .join(''),
        ];
  };
  const selected = data.paragraphs.filter((p) => selection.includes(p.id) && !p.readOnly),
    first = selected[0],
    sample = first?.runs[0],
    run = sample
      ? ({
          ...sample,
          ...(byId.get(sample.id)?.kind === 'run' ? byId.get(sample.id) : {}),
        } as OfficeRun)
      : undefined;
  function applyRun(format: Partial<OfficeRun>) {
    change(
      selected.flatMap((p) =>
        p.runs.map((r) => {
          const e = byId.get(r.id);
          return {
            text: r.text,
            ...(e?.kind === 'run' ? e : {}),
            ...format,
            kind: 'run',
            id: r.id,
          } as OfficeChange;
        }),
      ),
    );
    input.current?.focus();
  }
  function applyParagraph(format: {
    align?: 'left' | 'center' | 'right' | 'both';
    before?: number;
    after?: number;
  }) {
    change(
      selected.map((p) => {
        const e = byId.get(p.id);
        return { ...(e?.kind === 'paragraph' ? e : {}), kind: 'paragraph', id: p.id, ...format };
      }),
    );
  }
  function locate(records: { p: OfficeParagraph; text: string }[], offset: number) {
    let at = 0;
    for (let i = 0; i < records.length; i++) {
      const end = at + records[i].text.length;
      if (offset <= end || i === records.length - 1)
        return { index: i, offset: Math.max(0, offset - at) };
      at = end + 1;
    }
    return { index: 0, offset: 0 };
  }
  function track(element: HTMLTextAreaElement, group: OfficeParagraph[]) {
    input.current = element;
    const records = group
      .map((p) => ({
        p,
        text: effective(p)
          .map((v) => v.replace(/\n/g, '\u2028'))
          .join('\n'),
      }))
      .filter((r) => effective(r.p).length);
    if (!records.length) {
      setSelection([group[0].id]);
      return;
    }
    const a = locate(records, element.selectionStart),
      b = locate(records, element.selectionEnd);
    setSelection(records.slice(a.index, b.index + 1).map((r) => r.p.id));
  }
  function editGroup(group: OfficeParagraph[], next: string) {
    let records = group
      .map((p) => ({
        p,
        text: effective(p)
          .map((v) => v.replace(/\n/g, '\u2028'))
          .join('\n'),
      }))
      .filter((r) => effective(r.p).length);
    if (!records.length) records = [{ p: group[0], text: '' }];
    const previous = records.map((r) => r.text).join('\n');
    if (previous === next) return;
    let a = 0,
      b = 0;
    while (a < previous.length && a < next.length && previous[a] === next[a]) a++;
    while (
      b < previous.length - a &&
      b < next.length - a &&
      previous[previous.length - 1 - b] === next[next.length - 1 - b]
    )
      b++;
    const start = locate(records, a),
      end = locate(records, previous.length - b),
      text =
        records[start.index].text.slice(0, start.offset) +
        next.slice(a, next.length - b) +
        records[end.index].text.slice(end.offset);
    const changes: OfficeChange[] = records.slice(start.index, end.index + 1).map((r, i) => {
      const e = byId.get(r.p.id);
      return {
        ...(e?.kind === 'paragraph' ? e : {}),
        kind: 'paragraph',
        id: r.p.id,
        replacement: i === 0 ? text.split('\n').map((v) => v.replace(/\u2028/g, '\n')) : [],
      };
    });
    change(changes);
  }
  return (
    <div className="office-document">
      <div className="office-document-toolbar">
        <button onClick={() => setPreview((v) => !v)}>
          {preview ? uiText('继续编辑') : uiText('查看格式')}
        </button>
        <span>
          {selection.length
            ? uiText('选中 {0} 个段落', { '0': selection.length })
            : uiText('选取文字后统一设置段落格式')}
        </span>
        <fieldset disabled={blocked || !selected.length}>
          <button
            aria-pressed={run?.bold ?? false}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyRun({ bold: !run?.bold })}
          >
            <b>B</b>
          </button>
          <button
            aria-pressed={run?.italic ?? false}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyRun({ italic: !run?.italic })}
          >
            <i>I</i>
          </button>
          <button
            aria-pressed={run?.underline ?? false}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyRun({ underline: !run?.underline })}
          >
            <u>U</u>
          </button>
          <select
            aria-label={uiText('字体')}
            value={run?.fontFamily ?? ''}
            onChange={(e) => applyRun({ fontFamily: e.target.value })}
          >
            <option value="" disabled>
              {uiText('原字体')}
            </option>
            {['Aptos', 'Arial', 'Calibri', 'Times New Roman', 'Microsoft YaHei', 'SimSun'].map(
              (f) => (
                <option key={f}>{f}</option>
              ),
            )}
          </select>
          <input
            aria-label={uiText('字号')}
            type="number"
            min="1"
            max="400"
            placeholder={uiText('字号')}
            value={run?.fontSize ?? ''}
            onChange={(e) => {
              const size = Number(e.target.value);
              if (size >= 1 && size <= 400) applyRun({ fontSize: size });
            }}
          />
          <input
            aria-label={uiText('字体颜色')}
            type="color"
            value={run?.color ?? '#202124'}
            onChange={(e) => applyRun({ color: e.target.value })}
          />
          <select
            aria-label={uiText('段落对齐')}
            value={
              (first && byId.get(first.id)?.kind === 'paragraph'
                ? (byId.get(first.id) as any).align
                : undefined) ??
              first?.align ??
              'left'
            }
            onChange={(e) => applyParagraph({ align: e.target.value as any })}
          >
            <option value="left">{uiText('左对齐')}</option>
            <option value="center">{uiText('居中')}</option>
            <option value="right">{uiText('右对齐')}</option>
            <option value="both">{uiText('两端对齐')}</option>
          </select>
          {(['before', 'after'] as const).map((k) => (
            <label key={k}>
              {k === 'before' ? uiText('段前') : uiText('段后')}
              <input
                type="number"
                min="0"
                max="200"
                value={
                  (first && byId.get(first.id)?.kind === 'paragraph'
                    ? (byId.get(first.id) as any)[k]
                    : undefined) ??
                  first?.[k] ??
                  0
                }
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (n >= 0 && n <= 200) applyParagraph({ [k]: n });
                }}
              />
            </label>
          ))}
          <button
            disabled={!canReference || selection.length > 100}
            title={
              selection.length > 100
                ? uiText('每次最多引用 100 个段落')
                : uiText('引用当前选中的原段落')
            }
            onClick={() => reference(selection)}
          >
            {uiText('引用选中段落')}
          </button>
          {comment && (
            <button
              disabled={!canComment || !selection.length || selection.length > 100}
              title={
                !canComment
                  ? uiText('先保存修改，再评论原文件段落')
                  : selection.length > 100
                    ? uiText('每次最多评论 100 个段落')
                    : uiText('评论当前选中的原文件段落')
              }
              onClick={() => comment(selection)}
            >
              {uiText('评论选中段落')}
            </button>
          )}
        </fieldset>
      </div>
      <small>
        {uiText(
          '连续编辑已载入的正文（可继续载入后续段落），可跨段落输入、粘贴和选取；Enter 新段落，Shift+Enter 段内换行。格式应用于选中段落。表格、分节及复杂内容单独保留。',
        )}
      </small>
      <div className="office-document-paper">
        {groups.map((group) => {
          const p = group[0];
          if (p.continuous) {
            const visible = group.filter((p) => effective(p).length),
              text = visible
                .map((p) =>
                  effective(p)
                    .map((v) => v.replace(/\n/g, '\u2028'))
                    .join('\n'),
                )
                .join('\n');
            return preview ? (
              <div key={p.id} className="office-document-formatted">
                {visible.flatMap((p) => {
                  const e = byId.get(p.id),
                    format = e?.kind === 'paragraph' ? { ...p, ...e } : p;
                  return effective(p).map((value, index) => (
                    <p
                      key={`${p.id}:${index}`}
                      style={{
                        textAlign: format.align === 'both' ? 'justify' : (format.align as any),
                        marginTop: format.before,
                        marginBottom: format.after,
                      }}
                    >
                      {e?.kind === 'paragraph' && e.replacement !== undefined ? (
                        <span
                          style={(() => {
                            const r = p.runs[0],
                              edit = r && byId.get(r.id),
                              run = edit?.kind === 'run' ? { ...r, ...edit } : r;
                            return {
                              fontWeight: run?.bold ? 700 : 400,
                              fontStyle: run?.italic ? 'italic' : 'normal',
                              textDecoration: run?.underline ? 'underline' : undefined,
                              fontSize: run?.fontSize ? `${run.fontSize}pt` : undefined,
                              fontFamily: run?.fontFamily,
                              color: run?.color,
                            };
                          })()}
                        >
                          {value || '\u00a0'}
                        </span>
                      ) : (
                        p.runs.map((r) => {
                          const edit = byId.get(r.id),
                            run = edit?.kind === 'run' ? { ...r, ...edit } : r;
                          return (
                            <span
                              key={r.id}
                              style={{
                                fontWeight: run.bold ? 700 : 400,
                                fontStyle: run.italic ? 'italic' : 'normal',
                                textDecoration: run.underline ? 'underline' : undefined,
                                fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
                                fontFamily: run.fontFamily,
                                color: run.color,
                              }}
                            >
                              {run.text || '\u00a0'}
                            </span>
                          );
                        })
                      )}
                    </p>
                  ));
                })}
              </div>
            ) : (
              <textarea
                key={p.id}
                className="office-document-flow"
                spellCheck={false}
                readOnly={blocked}
                aria-label={uiText('连续文档正文')}
                value={text}
                rows={Math.max(8, Math.min(80, text.split('\n').length + 3))}
                onFocus={(e) => track(e.currentTarget, group)}
                onSelect={(e) => track(e.currentTarget, group)}
                onChange={(e) => editGroup(group, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.shiftKey && !blocked && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    const t = e.currentTarget,
                      a = t.selectionStart,
                      b = t.selectionEnd;
                    editGroup(group, t.value.slice(0, a) + '\u2028' + t.value.slice(b));
                    requestAnimationFrame(() => t.setSelectionRange(a + 1, a + 1));
                  }
                }}
              />
            );
          }
          return (
            <section key={p.id} className="office-document-preserved">
              <small>
                {p.readOnly ??
                  uiText('表格单元格或分节段落：保留结构，可在下方兼容片段中编辑文字。')}
              </small>
              <p>{p.runs.map((r) => r.text).join('') || uiText('空段落')}</p>
            </section>
          );
        })}
      </div>
    </div>
  );
}
