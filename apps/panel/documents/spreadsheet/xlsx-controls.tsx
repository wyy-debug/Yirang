import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useState } from 'react';
import {
  columnLabel,
  type StructureEdit,
  type XlsxPage,
} from '../../../../packages/contracts/xlsx.js';
export function XlsxControls({
  page,
  sheet,
  selection,
  disabled,
  run,
}: {
  page: XlsxPage | null;
  sheet: string;
  selection: { top: number; bottom: number; left: number; right: number };
  disabled: boolean;
  run: (op: StructureEdit) => void;
}) {
  useUiLocale();
  const [height, setHeight] = useState('20'),
    [width, setWidth] = useState('12'),
    [header, setHeader] = useState(true),
    [sortColumn, setSortColumn] = useState('');
  const [filterValue, setFilterValue] = useState(''),
    [condition, setCondition] = useState('0'),
    [color, setColor] = useState('#fff2b3'),
    [operator, setOperator] = useState('greaterThan');
  const index = page?.sheets.findIndex((s) => s.id === sheet) ?? -1,
    from = columnLabel(selection.left) + selection.top,
    to = columnLabel(selection.right) + selection.bottom;
  function copy() {
    if (!page) return;
    const original = page.sheets[index]?.name ?? uiText('工作表');
    let i = 1,
      name = '';
    do {
      name = uiText('{0} 副本{1}', { '0': original.slice(0, 24), '1': i++ });
    } while (page.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase()));
    run({ kind: 'copy_sheet', sheetId: sheet, newSheetId: page.nextSheetId!, name });
  }
  return (
    <details className="xlsx-extra-controls">
      <summary>{uiText('工作表管理、行列布局与区域操作')}</summary>
      <fieldset className="xlsx-structure" disabled={disabled || !page}>
        <div className="xlsx-structure-group">
          <button onClick={copy}>{uiText('复制工作表')}</button>
          <button
            disabled={index <= 0}
            onClick={() => run({ kind: 'move_sheet', sheetId: sheet, position: index })}
          >
            {uiText('向前移动')}
          </button>
          <button
            disabled={!page || index >= page.sheets.length - 1}
            onClick={() => run({ kind: 'move_sheet', sheetId: sheet, position: index + 2 })}
          >
            {uiText('向后移动')}
          </button>
          <button
            disabled={
              !page ||
              page.sheets.length <= 1 ||
              (!page.sheets[index]?.hidden && page.sheets.filter((s) => !s.hidden).length <= 1)
            }
            onClick={() => run({ kind: 'delete_sheet', sheetId: sheet })}
          >
            {uiText('删除当前表（可撤销）')}
          </button>
        </div>
        <div className="xlsx-structure-group">
          <label>
            {uiText('行高 pt')}
            <input
              type="number"
              min="1"
              max="409"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
          </label>
          <button
            onClick={() =>
              run({
                kind: 'row_layout',
                sheetId: sheet,
                start: selection.top,
                end: selection.bottom,
                size: Number(height),
              })
            }
          >
            {uiText('应用行高')}
          </button>
          <label>
            {uiText('列宽')}
            <input
              type="number"
              min="1"
              max="255"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            />
          </label>
          <button
            onClick={() =>
              run({
                kind: 'column_layout',
                sheetId: sheet,
                start: selection.left,
                end: selection.right,
                size: Number(width),
              })
            }
          >
            {uiText('应用列宽')}
          </button>
        </div>
        <div className="xlsx-structure-group">
          {[true, false].map((hidden) => (
            <React.Fragment key={String(hidden)}>
              <button
                onClick={() =>
                  run({
                    kind: 'row_layout',
                    sheetId: sheet,
                    start: selection.top,
                    end: selection.bottom,
                    hidden,
                  })
                }
              >
                {hidden ? uiText('隐藏') : uiText('显示')}
                {uiText('选中行')}
              </button>
              <button
                onClick={() =>
                  run({
                    kind: 'column_layout',
                    sheetId: sheet,
                    start: selection.left,
                    end: selection.right,
                    hidden,
                  })
                }
              >
                {hidden ? uiText('隐藏') : uiText('显示')}
                {uiText('选中列')}
              </button>
            </React.Fragment>
          ))}
          <button
            onClick={() =>
              run({
                kind: 'freeze',
                sheetId: sheet,
                rows: selection.top - 1,
                columns: selection.left - 1,
              })
            }
          >
            {uiText('冻结选区上方及左侧')}
          </button>
          <button onClick={() => run({ kind: 'freeze', sheetId: sheet, rows: 0, columns: 0 })}>
            {uiText('取消冻结')}
          </button>
        </div>
        <div className="xlsx-structure-group">
          <span>
            {from}:{to}
          </span>
          <button
            onClick={() => run({ kind: 'fill_range', sheetId: sheet, from, to, direction: 'down' })}
          >
            {uiText('首行向下填充')}
          </button>
          <button
            onClick={() =>
              run({ kind: 'fill_range', sheetId: sheet, from, to, direction: 'right' })
            }
          >
            {uiText('首列向右填充')}
          </button>
          <select
            aria-label={uiText('排序列')}
            value={
              Number(sortColumn) >= selection.left && Number(sortColumn) <= selection.right
                ? sortColumn
                : String(selection.left)
            }
            onChange={(e) => setSortColumn(e.target.value)}
          >
            {Array.from(
              { length: selection.right - selection.left + 1 },
              (_, i) => selection.left + i,
            ).map((c) => (
              <option key={c} value={c}>
                {columnLabel(c)} {uiText('列')}
              </option>
            ))}
          </select>
          <label>
            <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
            {uiText('首行为标题')}
          </label>
          {[false, true].map((descending) => (
            <button
              key={String(descending)}
              onClick={() =>
                run({
                  kind: 'sort_range',
                  sheetId: sheet,
                  from,
                  to,
                  keyColumn:
                    Number(sortColumn) >= selection.left && Number(sortColumn) <= selection.right
                      ? Number(sortColumn)
                      : selection.left,
                  descending,
                  header,
                })
              }
            >
              {descending ? uiText('降序') : uiText('升序')}
            </button>
          ))}
        </div>
        <div className="xlsx-structure-group">
          <button onClick={() => run({ kind: 'merge_cells', sheetId: sheet, from, to })}>
            {uiText('合并选区')}
          </button>
          <button onClick={() => run({ kind: 'unmerge_cells', sheetId: sheet, from, to })}>
            {uiText('取消合并')}
          </button>
          <input
            placeholder={uiText('筛选包含的文字')}
            value={filterValue}
            onChange={(e) => setFilterValue(e.target.value)}
          />
          <button
            onClick={() =>
              run({
                kind: 'filter_range',
                sheetId: sheet,
                from,
                to,
                column: selection.left,
                match: 'contains',
                value: filterValue,
              })
            }
          >
            {uiText('按选区首列筛选')}
          </button>
          <button
            onClick={() =>
              run({
                kind: 'filter_range',
                sheetId: sheet,
                from,
                to,
                column: selection.left,
                match: 'contains',
                value: '',
                clear: true,
              })
            }
          >
            {uiText('清除筛选')}
          </button>
        </div>
        <div className="xlsx-structure-group">
          <span>{uiText('条件格式')}</span>
          <select value={operator} onChange={(e) => setOperator(e.target.value)}>
            <option value="greaterThan">{uiText('大于')}</option>
            <option value="lessThan">{uiText('小于')}</option>
            <option value="equal">{uiText('等于')}</option>
          </select>
          <input type="number" value={condition} onChange={(e) => setCondition(e.target.value)} />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          <button
            onClick={() =>
              run({
                kind: 'conditional_format',
                sheetId: sheet,
                from,
                to,
                operator: operator as any,
                value: Number(condition),
                color,
              })
            }
          >
            {uiText('应用条件颜色')}
          </button>
          <button
            onClick={() =>
              run({
                kind: 'conditional_format',
                sheetId: sheet,
                from,
                to,
                operator: 'equal',
                value: 0,
                color,
                clear: true,
              })
            }
          >
            {uiText('清除选区规则')}
          </button>
        </div>
        <small>
          {uiText(
            '选区最多 2000 格；隐藏行列可用地址框定位后显示。冻结信息保存到原文件，当前分页内可见的冻结行列保持固定。',
          )}
        </small>
      </fieldset>
    </details>
  );
}
