import { subscribeUiLanguage as onUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useEffect, useRef, useState } from 'react';
import type { CanvasTool } from './canvas-board.js';
import { ToolIcon } from './tool-icon.js';
import { useWorkbenchLayer } from '../ui/workbench-layers.js';

export let tools: { id: CanvasTool; label: string; key: string }[] = [
  { id: 'select', label: uiText('选择'), key: 'V' },
  { id: 'hand', label: uiText('抓手平移'), key: 'H' },
  { id: 'rectangle', label: uiText('矩形'), key: 'R' },
  { id: 'diamond', label: uiText('菱形'), key: 'D' },
  { id: 'ellipse', label: uiText('椭圆'), key: 'O' },
  { id: 'arrow', label: uiText('箭头 / 连接文件'), key: 'A' },
  { id: 'line', label: uiText('线段'), key: 'L' },
  { id: 'pen', label: uiText('画笔'), key: 'P' },
  { id: 'text', label: uiText('文字'), key: 'T' },
  { id: 'note', label: uiText('便签'), key: 'N' },
  { id: 'eraser', label: uiText('橡皮擦'), key: 'E' },
];
const palette = ['#374151', '#6366f1', '#1675ff', '#16a085', '#e59526', '#e06079'];
const fills = ['transparent', '#ffffff', '#fff3b0', '#e7edff', '#dff5ec', '#ffe5ea'];

export type CanvasToolbarProps = {
  tool: CanvasTool;
  setTool: (tool: CanvasTool) => void;
  disabled?: boolean;
  stroke: string;
  setStroke: (value: string) => void;
  fill: string;
  setFill: (value: string) => void;
  strokeWidth: number;
  setStrokeWidth: (value: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  analyze?: () => void;
  analyzing?: boolean;
  screenshot?: () => void;
  screenshotLabel?: string;
};
export function CanvasToolbar({
  tool,
  setTool,
  disabled,
  stroke,
  setStroke,
  fill,
  setFill,
  strokeWidth,
  setStrokeWidth,
  undo,
  redo,
  canUndo,
  canRedo,
  analyze,
  analyzing,
  screenshot,
  screenshotLabel,
}: CanvasToolbarProps) {
  useUiLocale();
  const [styles, setStyles] = useState(false),
    [drawing, setDrawing] = useState(false),
    root = useRef<HTMLDivElement>(null);
  useWorkbenchLayer(styles, root, () => setStyles(false));
  useEffect(() => {
    if (tool !== 'select' && tool !== 'hand') setDrawing(true);
  }, [tool]);
  return (
    <div
      ref={root}
      className="canvas-board-toolbar nodrag nopan nowheel"
      data-canvas-toolbar
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="canvas-board-tools" role="toolbar" aria-label={uiText('画布工具')}>
        {tools
          .filter((item) => drawing || item.id === 'select' || item.id === 'hand')
          .map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              className={tool === item.id ? 'is-active' : ''}
              title={`${item.label} · ${item.key}`}
              aria-label={item.label}
              aria-pressed={tool === item.id}
              onClick={() => {
                setTool(item.id);
                setStyles(false);
              }}
            >
              <ToolIcon name={item.id} />
              <kbd>{item.key}</kbd>
            </button>
          ))}
        <button
          type="button"
          className="canvas-drawing-toggle"
          disabled={disabled}
          aria-expanded={drawing}
          title="展开或收起绘图工具"
          onClick={() => {
            setDrawing(!drawing);
            setStyles(false);
            if (drawing) setTool('select');
          }}
        >
          <ToolIcon name="pen" />
          <span>{drawing ? '收起绘图' : '绘图'}</span>
        </button>
        <i className="canvas-tools-divider" />
        {drawing && (
          <button
            type="button"
            title={uiText('画笔样式')}
            aria-label={uiText('画笔样式')}
            aria-expanded={styles}
            className={styles ? 'is-active' : ''}
            disabled={disabled}
            onClick={() => setStyles(!styles)}
          >
            <span
              className="canvas-current-style"
              style={{
                background: fill === 'transparent' ? 'var(--paper,#fff)' : fill,
                borderColor: stroke,
              }}
            />
          </button>
        )}
        <button
          type="button"
          title={uiText('撤销画布修改 · Ctrl+Z')}
          aria-label={uiText('撤销画布修改')}
          disabled={disabled || !canUndo}
          onClick={undo}
        >
          <ToolIcon name="undo" />
        </button>
        <button
          type="button"
          title={uiText('重做画布修改 · Ctrl+Shift+Z')}
          aria-label={uiText('重做画布修改')}
          disabled={disabled || !canRedo}
          onClick={redo}
        >
          <ToolIcon name="redo" />
        </button>
        {screenshot && (
          <button
            type="button"
            className="canvas-ai-analyze"
            disabled={disabled || analyzing}
            title={`框选截图并携带原文件 · ${screenshotLabel ?? 'Ctrl+Shift+S'}`}
            onClick={screenshot}
          >
            截图问 AI
          </button>
        )}
        {drawing && analyze && (
          <button
            type="button"
            className="canvas-ai-analyze"
            title={uiText(
              '将当前可见的选中标记（未选中则全部可见标记）与相关材料发送到侧边 Codex，检查问题',
            )}
            disabled={disabled || analyzing}
            onClick={analyze}
          >
            {analyzing ? uiText('正在准备…') : uiText('AI 检查标记')}
          </button>
        )}
      </div>
      {styles && (
        <div className="canvas-style-panel" role="group" aria-label={uiText('新建图形样式')}>
          <small>{uiText('线条颜色')}</small>
          <div className="canvas-style-colors">
            {palette.map((color) => (
              <button
                type="button"
                key={color}
                style={{ background: color }}
                className={stroke === color ? 'is-current' : ''}
                aria-label={uiText('线条颜色 {0}', { '0': color })}
                aria-pressed={stroke === color}
                onClick={() => setStroke(color)}
              />
            ))}
            <input
              aria-label={uiText('自定义线条颜色')}
              type="color"
              value={stroke}
              onChange={(event) => setStroke(event.target.value)}
            />
          </div>
          <small>{uiText('填充')}</small>
          <div className="canvas-style-colors">
            {fills.map((color) => (
              <button
                type="button"
                key={color}
                style={{ background: color }}
                className={`${fill === color ? 'is-current ' : ''}${color === 'transparent' ? 'is-transparent' : ''}`}
                aria-label={
                  color === 'transparent'
                    ? uiText('无填充')
                    : uiText('填充颜色 {0}', { '0': color })
                }
                aria-pressed={fill === color}
                onClick={() => setFill(color)}
              />
            ))}
          </div>
          <small>{uiText('线条粗细')}</small>
          <div className="canvas-style-widths">
            {[1, 2, 4, 6].map((width) => (
              <button
                type="button"
                key={width}
                className={strokeWidth === width ? 'is-current' : ''}
                title={uiText('{0} 像素', { '0': width })}
                aria-label={uiText('{0} 像素', { '0': width })}
                aria-pressed={strokeWidth === width}
                onClick={() => setStrokeWidth(width)}
              >
                <span style={{ height: width }} />
              </button>
            ))}
          </div>
          <p>{uiText('应用于新建的图形和笔画')}</p>
        </div>
      )}
    </div>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  tools = [
    { id: 'select', label: uiText('选择'), key: 'V' },
    { id: 'hand', label: uiText('抓手平移'), key: 'H' },
    { id: 'rectangle', label: uiText('矩形'), key: 'R' },
    { id: 'diamond', label: uiText('菱形'), key: 'D' },
    { id: 'ellipse', label: uiText('椭圆'), key: 'O' },
    { id: 'arrow', label: uiText('箭头 / 连接文件'), key: 'A' },
    { id: 'line', label: uiText('线段'), key: 'L' },
    { id: 'pen', label: uiText('画笔'), key: 'P' },
    { id: 'text', label: uiText('文字'), key: 'T' },
    { id: 'note', label: uiText('便签'), key: 'N' },
    { id: 'eraser', label: uiText('橡皮擦'), key: 'E' },
  ];
});
