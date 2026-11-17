import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useRef, useState } from 'react';
import type { Diagram, Deck, Workbook } from '../../../packages/contracts/index.js';
import { blankSlide, blankTable, diagramSvg } from '../../../packages/components/structured.js';
import { TableEditor } from './editors.js';
export function DiagramEditor({
  value,
  change,
  compact = false,
}: {
  value: Diagram;
  change: (d: Diagram) => void;
  compact?: boolean;
}) {
  useUiLocale();
  const [selected, setSelected] = useState<string | null>(null),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [label, setLabel] = useState('');
  const [dragged, setDragged] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<{
    id: string;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const node = value.nodes.find((n) => n.id === selected);
  const shown = dragged
    ? {
        ...value,
        nodes: value.nodes.map((n) =>
          n.id === dragged.id ? { ...n, x: dragged.x, y: dragged.y } : n,
        ),
      }
    : value;
  function patch(p: Partial<Diagram['nodes'][number]>) {
    if (node)
      change({ ...value, nodes: value.nodes.map((n) => (n.id === node.id ? { ...n, ...p } : n)) });
  }
  function addNode() {
    const id = crypto.randomUUID(),
      count = value.nodes.length;
    change({
      ...value,
      nodes: [
        ...value.nodes,
        {
          id,
          text: uiText('新节点'),
          x: 40 + (count % 4) * 200,
          y: 50 + (Math.floor(count / 4) % 5) * 95,
          width: 160,
          height: 72,
          shape: 'box',
          color: '#e9f0e2',
        },
      ],
    });
    setSelected(id);
  }
  if (compact)
    return (
      <div className="diagram-editor compact nodrag nopan nowheel">
        <img
          alt={uiText('图形预览')}
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagramSvg(value))}`}
        />
        <small>
          {value.nodes.length} {uiText('个节点 ·')}
          {value.edges.length} {uiText('条连线')}
        </small>
      </div>
    );
  return (
    <div className="diagram-editor">
      <div className="editor-tools">
        <button onClick={addNode} disabled={value.nodes.length >= 100}>
          {uiText('＋ 节点')}
        </button>
        <span>{uiText('拖动节点调整图内布局；桌面上的位置保持不变。')}</span>
      </div>
      <div className="diagram-layout">
        <div className="diagram-workarea">
          <div
            className="diagram-stage"
            ref={stage}
            style={{ aspectRatio: `${value.width}/${value.height}` }}
          >
            <img
              alt={uiText('图形画布')}
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagramSvg(shown))}`}
            />
            {shown.nodes.map((n) => (
              <button
                key={n.id}
                aria-label={uiText('图形节点 {0}', { '0': n.text })}
                className={selected === n.id ? 'selected' : ''}
                style={{
                  left: `${(n.x / value.width) * 100}%`,
                  top: `${(n.y / value.height) * 100}%`,
                  width: `${(n.width / value.width) * 100}%`,
                  height: `${(n.height / value.height) * 100}%`,
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setSelected(n.id);
                  const b = stage.current!.getBoundingClientRect();
                  drag.current = {
                    id: n.id,
                    clientX: e.clientX,
                    clientY: e.clientY,
                    x: n.x,
                    y: n.y,
                    width: b.width,
                    height: b.height,
                  };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d || d.id !== n.id) return;
                  setDragged({
                    id: n.id,
                    x: Math.max(
                      0,
                      Math.min(
                        value.width - n.width,
                        d.x + ((e.clientX - d.clientX) / d.width) * value.width,
                      ),
                    ),
                    y: Math.max(
                      0,
                      Math.min(
                        value.height - n.height,
                        d.y + ((e.clientY - d.clientY) / d.height) * value.height,
                      ),
                    ),
                  });
                }}
                onPointerUp={() => {
                  if (dragged)
                    change({
                      ...value,
                      nodes: value.nodes.map((item) =>
                        item.id === dragged.id ? { ...item, x: dragged.x, y: dragged.y } : item,
                      ),
                    });
                  drag.current = null;
                  setDragged(null);
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  setDragged(null);
                }}
              />
            ))}
          </div>
          <div className="diagram-connections">
            <strong>{uiText('连线')}</strong>
            <div>
              <select
                aria-label={uiText('连线起点')}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              >
                <option value="">{uiText('选择起点')}</option>
                {value.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.text}
                  </option>
                ))}
              </select>
              <span>→</span>
              <select
                aria-label={uiText('连线终点')}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              >
                <option value="">{uiText('选择终点')}</option>
                {value.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.text}
                  </option>
                ))}
              </select>
              <input
                aria-label={uiText('连线说明')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={uiText('说明')}
                maxLength={100}
              />
              <button
                disabled={!from || !to || from === to || value.edges.length >= 200}
                onClick={() => {
                  change({
                    ...value,
                    edges: [...value.edges, { id: crypto.randomUUID(), from, to, label }],
                  });
                  setLabel('');
                }}
              >
                {uiText('添加')}
              </button>
            </div>
            {value.edges.map((edge) => (
              <p key={edge.id}>
                <span>
                  {value.nodes.find((n) => n.id === edge.from)?.text} →{' '}
                  {value.nodes.find((n) => n.id === edge.to)?.text}
                </span>
                <input
                  aria-label={uiText('编辑连线说明')}
                  value={edge.label}
                  maxLength={100}
                  onChange={(e) =>
                    change({
                      ...value,
                      edges: value.edges.map((item) =>
                        item.id === edge.id ? { ...item, label: e.target.value } : item,
                      ),
                    })
                  }
                />
                <button
                  onClick={() =>
                    change({ ...value, edges: value.edges.filter((item) => item.id !== edge.id) })
                  }
                >
                  {uiText('移除')}
                </button>
              </p>
            ))}
          </div>
        </div>
        <aside className="structured-inspector">
          {node ? (
            <>
              <span className="eyebrow">{uiText('节点设置')}</span>
              <label>
                {uiText('文字')}
                <textarea
                  value={node.text}
                  maxLength={500}
                  onChange={(e) => patch({ text: e.target.value })}
                />
              </label>
              <label>
                {uiText('形状')}
                <select
                  value={node.shape}
                  onChange={(e) => patch({ shape: e.target.value as typeof node.shape })}
                >
                  <option value="box">{uiText('圆角矩形')}</option>
                  <option value="ellipse">{uiText('椭圆')}</option>
                  <option value="diamond">{uiText('菱形')}</option>
                </select>
              </label>
              <label>
                {uiText('颜色')}
                <input
                  type="color"
                  value={node.color}
                  onChange={(e) => patch({ color: e.target.value })}
                />
              </label>
              <label>
                {uiText('宽度')}
                <input
                  type="range"
                  min="80"
                  max={Math.min(500, value.width - node.x)}
                  value={node.width}
                  onChange={(e) => patch({ width: Number(e.target.value) })}
                />
              </label>
              <label>
                {uiText('高度')}
                <input
                  type="range"
                  min="50"
                  max={Math.min(300, value.height - node.y)}
                  value={node.height}
                  onChange={(e) => patch({ height: Number(e.target.value) })}
                />
              </label>
              <button
                onClick={() => {
                  change({
                    ...value,
                    nodes: value.nodes.filter((n) => n.id !== node.id),
                    edges: value.edges.filter((e) => e.from !== node.id && e.to !== node.id),
                  });
                  setSelected(null);
                }}
              >
                {uiText('删除节点及连线')}
              </button>
            </>
          ) : (
            <p>{uiText('选择节点，编辑文字、形状与尺寸。')}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
export function SlidePreview({
  slide,
  accent,
  footer,
  index = 0,
}: {
  slide: Deck['slides'][number];
  accent: string;
  footer: string;
  index?: number;
}) {
  useUiLocale();
  return (
    <div
      className={`slide-preview layout-${slide.layout}`}
      style={{ '--slide-accent': accent } as React.CSSProperties}
    >
      <div className="slide-accent" />
      <div className="slide-content">
        <span className="slide-kicker">
          {slide.layout === 'title'
            ? 'PRESENTATION'
            : slide.layout === 'section'
              ? 'SECTION'
              : String(index + 1).padStart(2, '0')}
        </span>
        <h2>{slide.title}</h2>
        {slide.subtitle && <p className="slide-subtitle">{slide.subtitle}</p>}
        <div className="slide-columns">
          <div>
            {slide.body
              .split('\n')
              .filter(Boolean)
              .map((line, i) => (
                <p key={i}>
                  {slide.layout === 'bullets' && <span>• </span>}
                  {line}
                </p>
              ))}
          </div>
          {slide.layout === 'split' && (
            <div>
              {slide.secondary
                .split('\n')
                .filter(Boolean)
                .map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
            </div>
          )}
        </div>
      </div>
      <footer>
        <span>{footer}</span>
        <span>{index + 1}</span>
      </footer>
    </div>
  );
}
export function DeckEditor({
  value,
  change,
  compact = false,
}: {
  value: Deck;
  change: (d: Deck) => void;
  compact?: boolean;
}) {
  useUiLocale();
  const [active, setActive] = useState(value.slides[0].id);
  const slide = value.slides.find((s) => s.id === active) ?? value.slides[0],
    index = value.slides.findIndex((s) => s.id === slide.id);
  function patch(p: Partial<Deck['slides'][number]>) {
    change({ ...value, slides: value.slides.map((s) => (s.id === slide.id ? { ...s, ...p } : s)) });
  }
  function reorder(delta: number) {
    const slides = [...value.slides];
    [slides[index], slides[index + delta]] = [slides[index + delta], slides[index]];
    change({ ...value, slides });
  }
  if (compact)
    return (
      <div className="deck-editor compact nodrag nopan nowheel">
        <SlidePreview slide={value.slides[0]} accent={value.accent} footer={value.footer} />
        <small>
          {value.slides.length} {uiText('页 · 可编辑演示文稿')}
        </small>
      </div>
    );
  return (
    <div className="deck-editor">
      <div className="editor-tools">
        <label>
          {uiText('主题色')}
          <input
            type="color"
            value={value.accent}
            onChange={(e) => change({ ...value, accent: e.target.value })}
          />
        </label>
        <input
          aria-label={uiText('演示文稿标题')}
          value={value.title}
          onChange={(e) => change({ ...value, title: e.target.value })}
          maxLength={200}
        />
        <input
          aria-label={uiText('演示页脚')}
          value={value.footer}
          onChange={(e) => change({ ...value, footer: e.target.value })}
          maxLength={120}
          placeholder={uiText('页脚')}
        />
        <span>
          16:9 · {value.slides.length} {uiText('页')}
        </span>
      </div>
      <div className="deck-layout">
        <nav className="slide-list">
          {value.slides.map((s, i) => (
            <button
              className={s.id === slide.id ? 'selected' : ''}
              key={s.id}
              onClick={() => setActive(s.id)}
            >
              <SlidePreview slide={s} accent={value.accent} footer={value.footer} index={i} />
              <small>
                {i + 1}. {s.title}
              </small>
            </button>
          ))}
          <button
            disabled={value.slides.length >= 50}
            onClick={() => {
              const s = blankSlide();
              change({ ...value, slides: [...value.slides, s] });
              setActive(s.id);
            }}
          >
            {uiText('＋ 新增页面')}
          </button>
        </nav>
        <div className="slide-main">
          <SlidePreview slide={slide} accent={value.accent} footer={value.footer} index={index} />
          <div className="slide-controls">
            <button disabled={index === 0} onClick={() => reorder(-1)}>
              {uiText('前移')}
            </button>
            <button disabled={index === value.slides.length - 1} onClick={() => reorder(1)}>
              {uiText('后移')}
            </button>
            <button
              disabled={value.slides.length <= 1}
              onClick={() => {
                change({ ...value, slides: value.slides.filter((s) => s.id !== slide.id) });
                setActive(value.slides.find((s) => s.id !== slide.id)!.id);
              }}
            >
              {uiText('删除本页')}
            </button>
            <select
              aria-label={uiText('幻灯片版式')}
              value={slide.layout}
              onChange={(e) => patch({ layout: e.target.value as typeof slide.layout })}
            >
              <option value="title">{uiText('封面')}</option>
              <option value="bullets">{uiText('要点')}</option>
              <option value="split">{uiText('双栏')}</option>
              <option value="section">{uiText('章节')}</option>
            </select>
          </div>
          <div className="slide-fields">
            <label>
              {uiText('标题')}
              <input
                value={slide.title}
                onChange={(e) => patch({ title: e.target.value })}
                maxLength={200}
              />
            </label>
            <label>
              {uiText('副标题')}
              <input
                value={slide.subtitle}
                onChange={(e) => patch({ subtitle: e.target.value })}
                maxLength={500}
              />
            </label>
            <label>
              {uiText('正文（每行一项）')}
              <textarea
                value={slide.body}
                onChange={(e) => patch({ body: e.target.value })}
                maxLength={6000}
              />
            </label>
            {slide.layout === 'split' && (
              <label>
                {uiText('右栏')}
                <textarea
                  value={slide.secondary}
                  onChange={(e) => patch({ secondary: e.target.value })}
                  maxLength={6000}
                />
              </label>
            )}
            <label className="speaker-notes">
              {uiText('演讲备注')}
              <textarea
                value={slide.notes}
                onChange={(e) => patch({ notes: e.target.value })}
                maxLength={3000}
                placeholder={uiText('仅用于演讲者，不显示在幻灯片上')}
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
export function WorkbookEditor({
  value,
  change,
  compact = false,
}: {
  value: Workbook;
  change: (w: Workbook) => void;
  compact?: boolean;
}) {
  useUiLocale();
  const [active, setActive] = useState(value.sheets[0].id),
    [naming, setNaming] = useState(false),
    [name, setName] = useState(''),
    [error, setError] = useState('');
  const sheet = value.sheets.find((s) => s.id === active) ?? value.sheets[0];
  function rename() {
    const n = name.trim();
    if (
      !n ||
      n.length > 31 ||
      /[\\/*?:[\]]/.test(n) ||
      value.sheets.some((s) => s.id !== sheet.id && s.name.toLowerCase() === n.toLowerCase())
    ) {
      setError(uiText('名称需唯一，最多 31 字符，不能包含 \\ / * ? : [ ]'));
      return;
    }
    change({
      ...value,
      sheets: value.sheets.map((s) => (s.id === sheet.id ? { ...s, name: n } : s)),
    });
    setNaming(false);
    setError('');
  }
  if (compact)
    return (
      <div className="workbook-editor compact nodrag nopan nowheel">
        <TableEditor value={value.sheets[0].table} change={() => {}} compact />
        <small>
          {value.sheets.length} {uiText('个工作表 ·')}
          {value.formulas ? uiText('公式未计算') : uiText('文本与数值')}
        </small>
      </div>
    );
  return (
    <div className="workbook-editor">
      <div className="editor-tools">
        <input
          aria-label={uiText('工作簿标题')}
          value={value.title}
          onChange={(e) => change({ ...value, title: e.target.value })}
          maxLength={200}
        />
        <label>
          <input
            type="checkbox"
            checked={value.formulas}
            onChange={(e) => change({ ...value, formulas: e.target.checked })}
          />
          {uiText('导出支持的公式')}
        </label>
        <span>
          {value.formulas ? uiText('未计算 · 不显示猜测结果') : uiText('以 = 开头的内容作为文字')}
        </span>
      </div>
      <div className="workbook-tabs">
        {value.sheets.map((s) => (
          <button
            className={s.id === sheet.id ? 'active' : ''}
            key={s.id}
            onClick={() => {
              setActive(s.id);
              setNaming(false);
            }}
          >
            {s.name}
          </button>
        ))}
        <button
          disabled={value.sheets.length >= 12}
          onClick={() => {
            let i = value.sheets.length + 1;
            while (value.sheets.some((s) => s.name === `工作表 ${i}`)) i++;
            const s = {
              id: crypto.randomUUID(),
              name: uiText('工作表 {0}', { '0': i }),
              table: blankTable(),
              formats: {},
            };
            change({ ...value, sheets: [...value.sheets, s] });
            setActive(s.id);
          }}
        >
          ＋
        </button>
      </div>
      <div className="editor-tools">
        <button
          onClick={() => {
            setName(sheet.name);
            setNaming(true);
          }}
        >
          {uiText('重命名工作表')}
        </button>
        <button
          disabled={value.sheets.length <= 1}
          onClick={() => {
            change({ ...value, sheets: value.sheets.filter((s) => s.id !== sheet.id) });
            setActive(value.sheets.find((s) => s.id !== sheet.id)!.id);
          }}
        >
          {uiText('删除当前工作表')}
        </button>
        <span>{uiText('首行是列名，Excel 数据从第 2 行开始。')}</span>
      </div>
      {naming && (
        <div className="sheet-rename">
          <input
            aria-label={uiText('工作表名称')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={31}
          />
          <button onClick={rename}>{uiText('保存名称')}</button>
          <button onClick={() => setNaming(false)}>{uiText('取消')}</button>
          {error && <span>{error}</span>}
        </div>
      )}
      <div className="column-formats">
        <span>{uiText('列格式')}</span>
        {sheet.table.columns.map((c) => (
          <label key={c.id}>
            {c.label}
            <select
              value={sheet.formats[c.id] ?? 'text'}
              onChange={(e) =>
                change({
                  ...value,
                  sheets: value.sheets.map((s) =>
                    s.id === sheet.id
                      ? {
                          ...s,
                          formats: {
                            ...s.formats,
                            [c.id]: e.target.value as 'text' | 'number' | 'currency' | 'percent',
                          },
                        }
                      : s,
                  ),
                })
              }
            >
              <option value="text">{uiText('文字')}</option>
              <option value="number">{uiText('数值')}</option>
              <option value="currency">{uiText('金额')}</option>
              <option value="percent">{uiText('百分比')}</option>
            </select>
          </label>
        ))}
      </div>
      <TableEditor
        key={sheet.id}
        value={sheet.table}
        change={(table) =>
          change({
            ...value,
            sheets: value.sheets.map((s) => (s.id === sheet.id ? { ...s, table } : s)),
          })
        }
        manageRange
      />
      <footer className="workbook-calculation">
        {value.formulas
          ? uiText(
              '公式导出支持 SUM、AVERAGE、MIN、MAX、COUNT 与基本算术；外部引用、链接及其他函数保持文本。结果由外部表格软件计算。',
            )
          : uiText('格式只影响 XLSX 表达；输入值保留在当前工作簿中。')}
      </footer>
    </div>
  );
}
