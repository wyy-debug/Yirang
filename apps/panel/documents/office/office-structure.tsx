import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { DesktopObject } from '../../../../packages/contracts/index.js';
import type { OfficePage } from '../../../../packages/contracts/office.js';
export function OfficeStructure({
  object,
  data,
  dirty,
  selectedShape,
  action,
  updated,
  saved,
}: {
  object: DesktopObject;
  data: OfficePage;
  dirty: boolean;
  selectedShape: string;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  saved: (revision: number, page: number) => void;
}) {
  useUiLocale();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [anchor, setAnchor] = useState(''),
    [text, setText] = useState(''),
    [rows, setRows] = useState(3),
    [columns, setColumns] = useState(3),
    input = useRef<HTMLInputElement>(null);
  const [background, setBackground] = useState(data.background ?? '#ffffff'),
    [slideWidth, setSlideWidth] = useState(data.width),
    [slideHeight, setSlideHeight] = useState(data.height);
  useEffect(() => {
    setBackground(data.background ?? '#ffffff');
    setSlideWidth(data.width);
    setSlideHeight(data.height);
  }, [data.page, data.revision, data.width, data.height]);
  const paragraph =
      data.paragraphs.find((p) => p.id === anchor) ?? data.paragraphs.find((p) => !p.readOnly),
    disabled = dirty || busy;
  async function run(operation: any) {
    setBusy(true);
    setError('');
    try {
      const result = await action('native_workbench', {
        operation: 'office_structure',
        objectId: object.id,
        expectedRevision: object.revision,
        requestId: crypto.randomUUID(),
        change: { page: data.page, ...operation },
      });
      await updated();
      const page =
        operation.kind === 'slide_delete'
          ? Math.max(0, data.page - 1)
          : ['slide_add', 'slide_copy'].includes(operation.kind)
            ? data.page + 1
            : operation.kind === 'slide_move'
              ? operation.position - 1
              : data.page;
      saved(result.revision, page);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function image(file: File) {
    try {
      if (file.size > 5 * 1024 * 1024) throw Error(uiText('图片最多 5 MiB。'));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await run({
        kind: 'insert_image',
        ...(data.kind === 'docx' && paragraph ? { id: paragraph.id } : {}),
        data: btoa(binary),
      });
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <details>
      <summary>{uiText('内容与页面管理')}</summary>
      {dirty && <small>{uiText('先保存当前草稿，再修改内容结构。')}</small>}
      <fieldset disabled={disabled}>
        {data.kind === 'docx' ? (
          <>
            <label>
              {uiText('当前段落')}
              <select value={paragraph?.id ?? ''} onChange={(e) => setAnchor(e.target.value)}>
                {data.paragraphs
                  .filter((p) => !p.readOnly)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.runs
                        .map((r) => r.text)
                        .join('')
                        .slice(0, 50) || uiText('空段落')}
                    </option>
                  ))}
              </select>
            </label>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={uiText('新段落文字')}
            />
            <button onClick={() => void run({ kind: 'insert_paragraph', id: paragraph?.id, text })}>
              {uiText('在后面新增段落')}
            </button>
            <button
              disabled={!paragraph || disabled}
              onClick={() => void run({ kind: 'delete_paragraph', id: paragraph!.id })}
            >
              {uiText('删除当前段落')}
            </button>
            {(['bullet', 'decimal', 'none'] as const).map((list) => (
              <button
                key={list}
                disabled={!paragraph || disabled}
                onClick={() => void run({ kind: 'list', id: paragraph!.id, list })}
              >
                {list === 'bullet'
                  ? uiText('项目符号')
                  : list === 'decimal'
                    ? uiText('编号列表')
                    : uiText('取消列表')}
              </button>
            ))}
            <label>
              {uiText('表格行')}
              <input
                type="number"
                min="1"
                max="30"
                value={rows}
                onChange={(e) => setRows(Number(e.target.value))}
              />
            </label>
            <label>
              {uiText('列')}
              <input
                type="number"
                min="1"
                max="12"
                value={columns}
                onChange={(e) => setColumns(Number(e.target.value))}
              />
            </label>
            <button
              onClick={() => void run({ kind: 'insert_table', id: paragraph?.id, rows, columns })}
            >
              {uiText('插入表格')}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => void run({ kind: 'slide_add' })}>{uiText('新增空白页')}</button>
            <button onClick={() => void run({ kind: 'slide_copy' })}>{uiText('复制当前页')}</button>
            <button
              disabled={disabled || data.pages <= 1}
              onClick={() => void run({ kind: 'slide_delete' })}
            >
              {uiText('删除当前页')}
            </button>
            <button
              disabled={disabled || data.page === 0}
              onClick={() => void run({ kind: 'slide_move', position: data.page })}
            >
              {uiText('前移一页')}
            </button>
            <button
              disabled={disabled || data.page >= data.pages - 1}
              onClick={() => void run({ kind: 'slide_move', position: data.page + 2 })}
            >
              {uiText('后移一页')}
            </button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={uiText('新增文本框内容')}
            />
            <button onClick={() => void run({ kind: 'shape_add', text })}>
              {uiText('插入文本框')}
            </button>
            <button
              disabled={disabled || !selectedShape}
              onClick={() => void run({ kind: 'shape_delete', id: selectedShape })}
            >
              {uiText('删除选中元素')}
            </button>
            {(['front', 'back', 'forward', 'backward'] as const).map((layer) => (
              <button
                key={layer}
                disabled={disabled || !selectedShape}
                onClick={() => void run({ kind: 'shape_layer', id: selectedShape, layer })}
              >
                {
                  {
                    front: uiText('置于顶层'),
                    back: uiText('置于底层'),
                    forward: uiText('上移一层'),
                    backward: uiText('下移一层'),
                  }[layer]
                }
              </button>
            ))}
            <label>
              {uiText('页面背景')}
              <input
                type="color"
                value={background}
                onChange={(e) => setBackground(e.target.value)}
              />
            </label>
            <button onClick={() => void run({ kind: 'slide_style', color: background })}>
              {uiText('应用当前页背景')}
            </button>
            <label>
              {uiText('页面宽')}
              <input
                type="number"
                min="1"
                max="10000"
                value={slideWidth}
                onChange={(e) => setSlideWidth(Number(e.target.value))}
              />
            </label>
            <label>
              {uiText('页面高')}
              <input
                type="number"
                min="1"
                max="10000"
                value={slideHeight}
                onChange={(e) => setSlideHeight(Number(e.target.value))}
              />
            </label>
            <button
              onClick={() =>
                void run({ kind: 'slide_size', width: slideWidth, height: slideHeight })
              }
            >
              {uiText('应用全部页尺寸')}
            </button>
            <small>
              {uiText(
                '修改尺寸保留元素原坐标；主题背景未解析时显示白色，选择颜色会设置当前页显式背景。',
              )}
            </small>
          </>
        )}
        <button onClick={() => input.current?.click()}>{uiText('插入 PNG / JPEG 图片')}</button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void image(f);
          }}
        />
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
