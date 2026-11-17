import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ChartChange,
  ChartSave,
  type NativeChart,
  type NativeChartChange,
  type NativeChartList,
} from '../../../../packages/contracts/native-charts.js';
import { flushDraftStorage, scheduleDraftWrite, writeDraftNow } from '../draft-storage.js';
import { PanelActionError } from '../../host.js';
import './xlsx-charts.css';
const palette = [
  '#007aff',
  '#34c759',
  '#ff9500',
  '#af52de',
  '#ff3b30',
  '#5ac8fa',
  '#ffcc00',
  '#5856d6',
];
const Draft = z
  .object({
    revision: z.number().int().positive(),
    edits: z.array(ChartChange).max(24),
    pending: ChartSave.nullable(),
  })
  .strict();
type Props = {
  objectId: string;
  revision: number;
  disabled: boolean;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  saved: (revision: number) => Promise<void>;
  dirtyChanged: (dirty: boolean) => void;
};
function ChartPreview({ chart }: { chart: NativeChart }) {
  useUiLocale();
  const values = chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (chart.kind === 'unknown' || !values.length)
    return (
      <div className="xlsx-chart-empty">
        {chart.kind === 'unknown'
          ? uiText('此图表类型仅保留原文件')
          : uiText('原文件没有数值缓存，未生成替代数据')}
      </div>
    );
  if (chart.kind === 'pie') {
    const series = chart.series[0];
    if (
      chart.series.length !== 1 ||
      series.truncated ||
      series.values.some((v) => v !== null && v < 0)
    )
      return (
        <div className="xlsx-chart-empty">{uiText('饼图缓存不完整或含负数，暂不绘制占比。')}</div>
      );
    const total = series.values.reduce<number>((n, v) => n + (v ?? 0), 0);
    if (!total)
      return <div className="xlsx-chart-empty">{uiText('缓存总值为 0，无法绘制占比。')}</div>;
    let angle = -Math.PI / 2;
    return (
      <svg viewBox="0 0 600 260" role="img" aria-label={uiText('饼图缓存预览')}>
        {series.values.map((value, i) => {
          if (!value || value < 0) return null;
          const start = angle;
          angle += (value / total) * Math.PI * 2;
          const color = series.color ?? palette[i % palette.length],
            label = `${series.categories[i] || i + 1}: ${value}`;
          return value === total ? (
            <circle key={i} cx="300" cy="130" r="104" fill={color}>
              <title>{label}</title>
            </circle>
          ) : (
            <path
              key={i}
              d={`M300 130 L${300 + 104 * Math.cos(start)} ${130 + 104 * Math.sin(start)} A104 104 0 ${angle - start > Math.PI ? 1 : 0} 1 ${300 + 104 * Math.cos(angle)} ${130 + 104 * Math.sin(angle)} Z`}
              fill={color}
              stroke="white"
              strokeWidth="1.5"
            >
              <title>{label}</title>
            </path>
          );
        })}
      </svg>
    );
  }
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values),
    span = max - min || 1,
    n = Math.max(1, ...chart.series.map((s) => s.values.length)),
    left = 54,
    top = 18,
    width = 520,
    height = 208,
    y = (v: number) => top + height - ((v - min) / span) * height;
  if (chart.kind === 'bar' && chart.direction === 'horizontal') {
    const count = Math.min(n, 20),
      band = height / count,
      zero = left + (-min / span) * width;
    return (
      <svg viewBox="0 0 600 260" role="img" aria-label={uiText('条形图缓存预览')}>
        <line x1={zero} y1={top} x2={zero} y2={top + height} stroke="#b9bdc6" />
        {chart.series.map((s, si) =>
          s.values.slice(0, count).map((v, i) =>
            v === null ? null : (
              <g key={`${si}:${i}`}>
                <rect
                  x={Math.min(zero, left + ((v - min) / span) * width)}
                  y={top + i * band + (si * band) / chart.series.length + 1}
                  width={(Math.abs(v) / span) * width}
                  height={Math.max(1, band / chart.series.length - 2)}
                  fill={s.color ?? palette[si % palette.length]}
                >
                  <title>{`${s.name} · ${s.categories[i] || i + 1}: ${v}`}</title>
                </rect>
                {si === 0 && (
                  <text x="48" y={top + (i + 0.6) * band} textAnchor="end">
                    {(s.categories[i] || String(i + 1)).slice(0, 8)}
                  </text>
                )}
              </g>
            ),
          ),
        )}
        {n > count && (
          <text x="300" y="250" textAnchor="middle">
            {uiText('条形图示意前')}
            {count} {uiText('个分类')}
          </text>
        )}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 600 260" role="img" aria-label={uiText('图表缓存预览')}>
      <line x1={left} y1={y(0)} x2={left + width} y2={y(0)} stroke="#b9bdc6" />
      <text x="48" y={top + 5} textAnchor="end">
        {Number(max.toPrecision(4))}
      </text>
      <text x="48" y={top + height} textAnchor="end">
        {Number(min.toPrecision(4))}
      </text>
      {chart.series.map((s, si) => {
        const color = s.color ?? palette[si % palette.length];
        if (chart.kind === 'bar')
          return (
            <g key={s.index}>
              {s.values.map((v, i) =>
                v === null ? null : (
                  <rect
                    key={i}
                    x={left + (i * width) / n + (si * width) / n / chart.series.length + 1}
                    y={Math.min(y(v), y(0))}
                    width={Math.max(0.5, width / n / chart.series.length - 2)}
                    height={Math.abs(y(v) - y(0))}
                    fill={color}
                  >
                    <title>{`${s.name} · ${s.categories[i] || i + 1}: ${v}`}</title>
                  </rect>
                ),
              )}
            </g>
          );
        let path = '',
          connected = false;
        for (let i = 0; i < s.values.length; i++) {
          const v = s.values[i];
          if (v === null) {
            connected = false;
            continue;
          }
          path += `${connected ? 'L' : 'M'}${left + (n === 1 ? 0.5 : i / (n - 1)) * width},${y(v)} `;
          connected = true;
        }
        return (
          <path key={s.index} d={path} fill="none" stroke={color} strokeWidth="2.5">
            <title>{s.name}</title>
          </path>
        );
      })}
      {Array.from({ length: Math.min(8, n) }, (_, i) => {
        const at = Math.round((i * (n - 1)) / Math.max(1, Math.min(8, n) - 1));
        return (
          <text
            key={at}
            x={left + (n === 1 ? 0.5 : at / (n - 1)) * width}
            y="248"
            textAnchor="middle"
          >
            {(chart.series[0]?.categories[at] || String(at + 1)).slice(0, 8)}
          </text>
        );
      })}
    </svg>
  );
}
export function XlsxCharts({ objectId, revision, disabled, action, saved, dirtyChanged }: Props) {
  useUiLocale();
  const slot = `ai-desktop:xlsx-chart-draft:${objectId}`;
  const [initial] = useState(() => {
      try {
        flushDraftStorage(slot);
        const raw = localStorage.getItem(slot);
        const d = raw && raw.length < 200000 ? Draft.parse(JSON.parse(raw)) : null;
        if (
          d?.pending &&
          (d.pending.objectId !== objectId ||
            d.pending.expectedRevision !== d.revision ||
            JSON.stringify(d.pending.edits) !== JSON.stringify(d.edits))
        )
          return null;
        return d;
      } catch {
        return null;
      }
    }),
    [base, setBase] = useState(initial?.revision ?? revision),
    [edits, setEdits] = useState<NativeChartChange[]>(initial?.edits ?? []),
    [pending, setPending] = useState<z.infer<typeof ChartSave> | null>(initial?.pending ?? null);
  const [open, setOpen] = useState(!!initial),
    [list, setList] = useState<NativeChartList | null>(null),
    [selected, setSelected] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [storageError, setStorageError] = useState(''),
    [reload, setReload] = useState(0),
    [notice, setNotice] = useState(initial ? uiText('已恢复图表草稿。') : '');
  const actions = useRef(action),
    inflight = useRef(false),
    importInput = useRef<HTMLInputElement>(null);
  actions.current = action;
  const dirty = !!edits.length || !!pending,
    conflict = base !== revision;
  useEffect(() => {
    dirtyChanged(dirty || busy);
    return () => dirtyChanged(false);
  }, [dirty, busy, dirtyChanged]);
  useEffect(() => {
    if (!dirty && !busy && base !== revision) setBase(revision);
  }, [revision, base, dirty, busy]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError('');
    void actions
      .current('native_workbench', { operation: 'chart_read', objectId, expectedRevision: base })
      .then((value: NativeChartList) => {
        if (live) {
          setList(value);
          setSelected((s) =>
            value.charts.some((c) => c.id === s) ? s : (value.charts[0]?.id ?? ''),
          );
        }
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
  }, [objectId, base, open, reload]);
  useEffect(() => {
    scheduleDraftWrite(
      slot,
      () => (dirty ? JSON.stringify({ revision: base, edits, pending }) : null),
      (failure) =>
        setStorageError(failure ? uiText('无法持久保留图表草稿，请下载草稿或先保存。') : ''),
    );
  }, [base, edits, pending, slot]);
  useEffect(() => () => flushDraftStorage(slot), [slot]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const chart = list?.charts.find((c) => c.id === selected),
    edit = edits.find((e) => e.chartId === selected),
    preview = chart
      ? {
          ...chart,
          title: edit?.title ?? chart.title,
          series: chart.series.map((s) => ({
            ...s,
            color: edit?.series?.find((v) => v.index === s.index)?.color ?? s.color,
          })),
        }
      : undefined;
  function change(value: NativeChartChange) {
    if (disabled || busy || loading || pending) return;
    try {
      ChartChange.parse(value);
      setEdits((e) => [...e.filter((v) => v.chartId !== value.chartId), value]);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  function download() {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify({ objectId, revision: base, edits, pending }, null, 2)], {
          type: 'application/json',
        }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = uiText('图表编辑草稿.json');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function restore(file: File) {
    if (dirty || busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      if (file.size > 200000) throw Error(uiText('图表草稿超过 200 KiB 上限。'));
      const d = Draft.extend({ objectId: z.string() }).parse(JSON.parse(await file.text()));
      if (d.objectId !== objectId) throw Error(uiText('请在草稿所属的原工作簿中导入。'));
      if (
        d.pending &&
        (d.pending.objectId !== objectId ||
          d.pending.expectedRevision !== d.revision ||
          JSON.stringify(d.pending.edits) !== JSON.stringify(d.edits))
      )
        throw Error(uiText('图表草稿与待确认请求不一致。'));
      if (new Set(d.edits.map((e) => e.chartId)).size !== d.edits.length)
        throw Error(uiText('图表草稿存在重复图表。'));
      await action('native_workbench', {
        operation: 'chart_read',
        objectId,
        expectedRevision: d.revision,
      });
      setBase(d.revision);
      setEdits(d.edits);
      setPending(d.pending);
      setOpen(true);
      setReload((n) => n + 1);
      setNotice(uiText('已恢复原工作簿的图表草稿。'));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (inflight.current || disabled || !dirty) return;
    inflight.current = true;
    setBusy(true);
    setError('');
    try {
      if (conflict && !pending)
        throw Error(uiText('原文件已有新版本，请下载草稿后载入最新图表，重新应用修改。'));
      const request =
        pending ??
        ChartSave.parse({
          operation: 'chart_save',
          objectId,
          expectedRevision: base,
          requestId: crypto.randomUUID(),
          edits,
        });
      setPending(request);
      try {
        writeDraftNow(slot, JSON.stringify({ revision: base, edits, pending: request }));
      } catch {}
      const result = await action('native_workbench', request);
      try {
        writeDraftNow(slot, null);
      } catch {}
      setEdits([]);
      setPending(null);
      setBase(result.revision);
      setReload((n) => n + 1);
      setNotice(uiText('图表已写回原文件 · v{0}；缓存数据未重算。', { '0': result.revision }));
      await saved(result.revision);
    } catch (e) {
      if (
        e instanceof PanelActionError &&
        [
          'CHART_EDIT',
          'CHART_READ_ONLY',
          'CHART_LIMIT',
          'REVISION_CONFLICT',
          'DRAFT_ACTIVE',
          'VALIDATION_FAILED',
          'REQUEST_ID_REUSED',
        ].includes(e.code)
      )
        setPending(null);
      setError(String(e));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="xlsx-charts"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }
      }}
    >
      <summary>
        {uiText('内嵌图表')}
        {list ? uiText('· {0} 个', { '0': list.total }) : ''}
        {dirty ? uiText(' · 有待保存修改') : ''}
      </summary>
      {open && (
        <div className="xlsx-chart-panel">
          <header>
            <div>
              <strong>{uiText('图表缓存快照')}</strong>
              <small>{uiText('标题和颜色写回原文件；图表数据不在此处重算。')}</small>
            </div>
            <button disabled={busy || loading || dirty} onClick={() => setReload((n) => n + 1)}>
              {uiText('重新读取')}
            </button>
            <button disabled={!dirty || busy} onClick={download}>
              {uiText('下载草稿')}
            </button>
            <button
              disabled={disabled || dirty || busy}
              onClick={() => importInput.current?.click()}
            >
              {uiText('导入草稿')}
            </button>
            <input
              hidden
              ref={importInput}
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void restore(file);
              }}
            />
            <button
              className="primary"
              disabled={disabled || busy || loading || !dirty}
              onClick={() => void save()}
            >
              {busy ? uiText('保存中…') : pending ? uiText('重试同一次保存') : uiText('保存图表')}
            </button>
          </header>
          {(error || storageError || notice || conflict) && (
            <div className="xlsx-chart-notice" role="status">
              {error || storageError || notice}
              {conflict && (
                <p>
                  {uiText('图表草稿基于 v')}
                  {base}
                  {uiText('，当前文件是 v')}
                  {revision}
                  {uiText('。请下载草稿后处理版本变化。')}
                </p>
              )}
            </div>
          )}
          {dirty && (
            <div className="xlsx-chart-draft">
              <span>{uiText('图表草稿保留期间，单元格编辑暂时锁定。')}</span>
              <button
                disabled={busy}
                onClick={() => {
                  download();
                  setEdits([]);
                  setPending(null);
                  setBase(revision);
                  setReload((n) => n + 1);
                  setNotice(uiText('草稿已下载，已载入当前版本。'));
                }}
              >
                {uiText('下载草稿并清空')}
              </button>
            </div>
          )}
          {disabled && (
            <p className="xlsx-chart-notice">
              {uiText('请先保存单元格草稿或完成当前文件操作，再修改图表。')}
            </p>
          )}
          {loading ? (
            <p>{uiText('正在读取工作簿内嵌图表…')}</p>
          ) : !list?.charts.length ? (
            <p className="xlsx-chart-empty">{uiText('未发现可读取的工作表内嵌图表。')}</p>
          ) : (
            <>
              <nav>
                {list.charts.map((c) => (
                  <button
                    key={c.id}
                    className={selected === c.id ? 'selected' : ''}
                    disabled={busy}
                    onClick={() => setSelected(c.id)}
                  >
                    {c.title || uiText('未命名图表')}
                    <small>{c.sheets.join('、')}</small>
                  </button>
                ))}
              </nav>
              {preview && chart && (
                <div className="xlsx-chart-workspace">
                  <div className="xlsx-chart-preview">
                    <strong>{preview.title}</strong>
                    <ChartPreview chart={preview} />
                    <div className="xlsx-chart-legend">
                      {preview.series.map((s, i) => (
                        <span key={s.index}>
                          <i style={{ background: s.color ?? palette[i % palette.length] }} />
                          {s.name}
                        </span>
                      ))}
                    </div>
                    <small>{uiText('缓存示意，坐标轴格式、主题及装饰未完整渲染。')}</small>
                  </div>
                  <fieldset disabled={disabled || busy || loading || !!pending || !!chart.readOnly}>
                    <legend>{uiText('标题与系列')}</legend>
                    <label>
                      {uiText('标题')}
                      <input
                        value={edit?.title ?? chart.title}
                        maxLength={500}
                        disabled={!chart.titleEditable}
                        onChange={(e) =>
                          change({ ...edit, chartId: chart.id, title: e.target.value })
                        }
                      />
                    </label>
                    {chart.series.map((s, i) => (
                      <label key={s.index}>
                        {s.name}
                        <input
                          type="color"
                          disabled={!s.colorEditable}
                          value={
                            edit?.series?.find((v) => v.index === s.index)?.color ??
                            s.color ??
                            palette[i % palette.length]
                          }
                          onChange={(e) =>
                            change({
                              ...edit,
                              chartId: chart.id,
                              series: [
                                ...(edit?.series ?? []).filter((v) => v.index !== s.index),
                                { index: s.index, color: e.target.value },
                              ],
                            })
                          }
                        />
                        <small>
                          {s.cachedPoints} {uiText('个缓存数据点')}
                          {s.warning ? ` · ${s.warning}` : ''}
                        </small>
                        {s.valueFormula && <code title={s.valueFormula}>{s.valueFormula}</code>}
                      </label>
                    ))}
                  </fieldset>
                  {chart.readOnly && <p className="xlsx-chart-notice">{chart.readOnly}</p>}
                  {chart.warnings.map((w) => (
                    <p className="xlsx-chart-note" key={w}>
                      {w}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
          {list?.truncated && (
            <p>
              {uiText('为控制读取开销，仅展开前')}
              {list.charts.length} / {list.total} {uiText('个图表。')}
            </p>
          )}
          <footer>
            {list?.calculationPending && (
              <strong>{uiText('工作簿请求重新计算；当前图表缓存可能过期。')}</strong>
            )}
            {list?.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </footer>
        </div>
      )}
    </details>
  );
}
