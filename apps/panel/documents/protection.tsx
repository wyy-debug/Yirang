import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type {
  DesktopObject,
  MaterialRange,
  ProtectionTarget,
  Diagram,
  Deck,
  Workbook,
} from '../../../packages/contracts/index.js';
import { protectedContent, protectionLabel } from '../../../packages/components/protection.js';
import { contentText } from '../../../packages/components/content.js';
import { PanelActionError } from '../host.js';

export function RangeProtection({
  object,
  range: materialRange,
  hasDraft,
  action,
  updated,
  close,
  select,
}: {
  object: DesktopObject;
  range?: MaterialRange;
  hasDraft: boolean;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  close: () => void;
  select: () => void;
}) {
  useUiLocale();
  const [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [chosen, setChosen] = useState<{ base: number; keys: string[] } | null>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const mounted = useRef(true),
    active = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const entries = object.policy?.protectedRanges ?? [];
  const structured = ['diagram', 'deck', 'workbook'].includes(object.kind);
  const stale = !!chosen && chosen.base !== object.revision;
  const options =
    object.kind === 'diagram'
      ? [
          ...(object.content as Diagram).nodes.map((node) => ({
            key: `n:${node.id}`,
            title: node.text || uiText('未命名节点'),
            detail: uiText('节点 · 内容、位置与形状'),
          })),
          ...(object.content as Diagram).edges.map((edge) => ({
            key: `e:${edge.id}`,
            title:
              edge.label ||
              `${(object.content as Diagram).nodes.find((node) => node.id === edge.from)?.text ?? uiText('节点')} → ${(object.content as Diagram).nodes.find((node) => node.id === edge.to)?.text ?? uiText('节点')}`,
            detail: uiText('连线 · 关系与端点位置'),
          })),
        ]
      : object.kind === 'deck'
        ? (object.content as Deck).slides.map((slide, index) => ({
            key: `s:${slide.id}`,
            title: `${index + 1}. ${slide.title || uiText('未命名页面')}`,
            detail: uiText('整页 · 内容、版式和备注'),
          }))
        : object.kind === 'workbook'
          ? (object.content as Workbook).sheets.map((sheet) => ({
              key: `s:${sheet.id}`,
              title: sheet.name,
              detail: uiText('完整工作表 · {0} 行 × {1} 列，包括名称与格式', {
                '0': sheet.table.rows.length,
                '1': sheet.table.columns.length,
              }),
            }))
          : [];
  const selectedIds = (prefix: string) =>
    chosen?.keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(2)) ?? [];
  const range: ProtectionTarget | undefined = structured
    ? chosen?.keys.length
      ? object.kind === 'diagram'
        ? {
            type: 'diagram',
            nodeIds: selectedIds('n:'),
            edgeIds: selectedIds('e:'),
            baseRevision: chosen.base,
          }
        : object.kind === 'deck'
          ? { type: 'slides', slideIds: selectedIds('s:'), baseRevision: chosen.base }
          : { type: 'sheets', sheetIds: selectedIds('s:'), baseRevision: chosen.base }
      : undefined
    : materialRange;
  let preview = '',
    valid = false;
  try {
    if (range) {
      const content = protectedContent(object, range);
      preview = structured ? '' : contentText(content as DesktopObject['content']).slice(0, 700);
      valid = true;
    }
  } catch {}
  async function submit(payload: Record<string, unknown>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    let confirmed = false;
    try {
      await action('object_manage', payload);
      confirmed = true;
      if (!mounted.current) return;
      setPending(null);
      setNote('');
      setChosen(null);
      await updated();
    } catch (e) {
      if (!mounted.current) return;
      if (confirmed) setError(uiText('保护设置已保存，列表暂未刷新。请刷新列表。'));
      else if (e instanceof PanelActionError) {
        setPending(null);
        setError(e.message);
        try {
          await updated();
        } catch {}
      } else {
        setPending(payload);
        setError(uiText('尚未确认保存结果。请重试同一次保存，不会重复增加范围。'));
      }
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function save(removeId?: string) {
    if (!object.policy || pending || (!removeId && (!range || !valid))) return;
    const protectedRanges = removeId
      ? entries.filter((entry) => entry.id !== removeId)
      : [
          ...entries,
          {
            id: crypto.randomUUID(),
            range,
            note: note.trim() || uiText('已确认内容'),
            stale: false,
          },
        ];
    void submit({
      requestId: crypto.randomUUID(),
      objectId: object.id,
      expectedRevision: object.revision,
      operation: 'policy',
      policy: { ...object.policy, protectedRanges },
    });
  }
  return (
    <section className="range-protection" role="dialog" aria-label={uiText('保留范围')}>
      <header>
        <div>
          <span className="eyebrow">{uiText('保留已确认内容')}</span>
          <h2>{object.title}</h2>
        </div>
        <button disabled={busy || !!pending} onClick={close}>
          {uiText('关闭')}
        </button>
      </header>
      <p>
        {uiText(
          'AI 可以读取这些内容，但不能改动。你仍可编辑；稳定对象按你的新内容继续保护，删除受保护对象或影响文字边界时要求重新选择。',
        )}
      </p>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {pending && (
        <button className="primary" disabled={busy} onClick={() => void submit(pending)}>
          {uiText('重试此次保存')}
        </button>
      )}
      {structured && (
        <div className="structured-protection">
          <strong>
            {uiText('选择已确认的')}
            {object.kind === 'diagram'
              ? uiText('节点与连线')
              : object.kind === 'deck'
                ? uiText('幻灯片')
                : uiText('工作表')}
          </strong>
          <p>
            {object.kind === 'diagram'
              ? uiText('同时保留画布尺寸；保护连线时也保留端点几何位置。')
              : object.kind === 'deck'
                ? uiText('同时保留影响页面的全局主题色与页脚；不锁定页面顺序。')
                : uiText('保留工作表全部内容、名称与格式，以及工作簿公式模式；不锁定工作表顺序。')}
          </p>
          {stale && (
            <div className="protection-stale">
              <span>{uiText('内容版本已变化，请按当前内容重新勾选。')}</span>
              <button disabled={busy || !!pending} onClick={() => setChosen(null)}>
                {uiText('重新选择')}
              </button>
            </div>
          )}
          <div className="protection-choices">
            {options.map((option) => (
              <label key={option.key}>
                <input
                  type="checkbox"
                  checked={chosen?.keys.includes(option.key) ?? false}
                  disabled={busy || !!pending || hasDraft || stale}
                  onChange={(event) =>
                    setChosen((current) => ({
                      base: current?.base ?? object.revision,
                      keys: event.target.checked
                        ? [...(current?.keys ?? []), option.key]
                        : (current?.keys ?? []).filter((key) => key !== option.key),
                    }))
                  }
                />
                <span>
                  {option.title}
                  <small>{option.detail}</small>
                </span>
              </label>
            ))}
            {!options.length && <p>{uiText('先在编辑器中添加内容，再选择保留项。')}</p>}
          </div>
        </div>
      )}
      <div className="protection-add">
        <strong>{range ? uiText('当前局部选区') : uiText('先选择需要保留的内容')}</strong>
        {range && valid ? (
          <>
            {!structured && <pre>{preview || uiText('所选内容为空')}</pre>}
            <small>
              {protectionLabel(range)} · v{range.baseRevision}
            </small>
            <label>
              {uiText('保留说明')}
              <input
                value={note}
                disabled={busy || !!pending}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                placeholder={uiText('例如：已确认的金额，不要改动')}
              />
            </label>
            <button
              className="primary"
              disabled={busy || !!pending || hasDraft || entries.length >= 40}
              onClick={() => save()}
            >
              {uiText('保留这些内容')}
            </button>
          </>
        ) : (
          <p>
            {range
              ? uiText('当前选区已过期，请重新选择。')
              : structured
                ? uiText('从上方清单勾选需要保留的内容。')
                : uiText('在文字或代码编辑器中选择片段，或在表格中选择单元格，再点击“使用选区”。')}
          </p>
        )}
        <button disabled={busy || !!pending} onClick={select}>
          {structured ? uiText('回到编辑器') : uiText('回到编辑器选择范围')}
        </button>
        {hasDraft && <p className="error-text">{uiText('请先保存编辑，再设置保留范围。')}</p>}
      </div>
      <div className="protection-list">
        <strong>
          {uiText('已保留')}
          {entries.length} {uiText('/ 40 个范围')}
        </strong>
        {!entries.length && <p className="muted">{uiText('尚未设置局部保护。')}</p>}
        {entries.map((entry) => (
          <article key={entry.id}>
            <div>
              <b>{entry.note}</b>
              <small>
                {entry.stale
                  ? uiText('范围需要重新选择，当前对象的 AI 写入已阻止')
                  : protectionLabel(entry.range)}{' '}
                · v{entry.range.baseRevision}
              </small>
            </div>
            <button disabled={busy || !!pending} onClick={() => save(entry.id)}>
              {uiText('移除保护')}
            </button>
          </article>
        ))}
      </div>
      <footer>
        <button
          disabled={busy || !!pending}
          onClick={() => void updated().catch((e) => setError(String(e)))}
        >
          {uiText('刷新列表')}
        </button>
        <p>{uiText('更改保护设置会撤销本工作区旧的 AI 执行凭据，之后需重新引用材料。')}</p>
      </footer>
    </section>
  );
}
