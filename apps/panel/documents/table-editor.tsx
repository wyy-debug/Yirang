import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useState } from 'react';
import type { Table } from '../../../packages/contracts/index.js';

type Position = { rowId: string; columnId: string };
type Selection = {
  mode: 'cells' | 'rows' | 'columns' | 'all';
  anchor: Position;
  end: Position;
  structure: string;
};
export function TableEditor({
  value,
  change,
  compact = false,
  selectRange,
  manageRange = false,
}: {
  value: Table;
  change: (next: Table) => void;
  compact?: boolean;
  manageRange?: boolean;
  selectRange?: (rowIds: string[], columnIds: string[], source: Table) => void;
}) {
  useUiLocale();
  const [page, setPage] = useState(0),
    [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null),
    [removing, setRemoving] = useState<'rows' | 'columns' | null>(null);
  const structure = JSON.stringify([
    value.rows.map((row) => row.id),
    value.columns.map((column) => column.id),
  ]);
  const stale = !!selection && selection.structure !== structure;
  const range = stale ? null : selection;
  const rowIndex = (id: string) => value.rows.findIndex((row) => row.id === id);
  const columnIndex = (id: string) => value.columns.findIndex((column) => column.id === id);
  const minRow = range ? Math.min(rowIndex(range.anchor.rowId), rowIndex(range.end.rowId)) : -1;
  const maxRow = range ? Math.max(rowIndex(range.anchor.rowId), rowIndex(range.end.rowId)) : -1;
  const minColumn = range
    ? Math.min(columnIndex(range.anchor.columnId), columnIndex(range.end.columnId))
    : -1;
  const maxColumn = range
    ? Math.max(columnIndex(range.anchor.columnId), columnIndex(range.end.columnId))
    : -1;
  const selectedRows = range
    ? range.mode === 'columns' || range.mode === 'all'
      ? value.rows
      : value.rows.slice(minRow, maxRow + 1)
    : [];
  const selectedColumns = range
    ? range.mode === 'rows' || range.mode === 'all'
      ? value.columns
      : value.columns.slice(minColumn, maxColumn + 1)
    : [];
  const rowIds = new Set(selectedRows.map((row) => row.id)),
    columnIds = new Set(selectedColumns.map((column) => column.id));
  const pages = Math.max(1, Math.ceil(value.rows.length / 40)),
    currentPage = Math.min(page, pages - 1);
  const rows = compact
    ? value.rows.slice(0, 4)
    : value.rows.slice(currentPage * 40, currentPage * 40 + 40);
  const summary = range
    ? uiText('{0}选区 · {1} 行 × {2} 列', {
        '0': {
          cells: uiText('单元格'),
          rows: uiText('整行'),
          columns: uiText('整列'),
          all: uiText('整表'),
        }[range.mode],
        '1': selectedRows.length,
        '2': selectedColumns.length,
      })
    : uiText('尚未选择范围');
  function pick(mode: Selection['mode'], rowId: string, columnId: string, extend = false) {
    const end = { rowId, columnId },
      anchor = extend && range?.mode === mode ? range.anchor : end;
    setSelection({ mode, anchor, end, structure });
    setRemoving(null);
  }
  function clear() {
    setSelection(null);
    setRemoving(null);
  }
  function remove() {
    if (!range || !removing) return;
    if (removing === 'rows')
      change({ ...value, rows: value.rows.filter((row) => !rowIds.has(row.id)) });
    else if (selectedColumns.length < value.columns.length) {
      const keep = value.columns.flatMap((column, index) =>
        columnIds.has(column.id) ? [] : [index],
      );
      change({
        ...value,
        columns: keep.map((index) => value.columns[index]),
        rows: value.rows.map((row) => ({ ...row, cells: keep.map((index) => row.cells[index]) })),
      });
    }
    clear();
  }
  return (
    <div className={`table-editor nodrag nopan nowheel ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="editor-tools">
          <span>
            {value.rows.length} {uiText('行 ×')}
            {value.columns.length} {uiText('列 · 按文字保存')}
          </span>
          <button
            disabled={value.rows.length >= 500}
            onClick={() => {
              clear();
              change({
                ...value,
                rows: [
                  ...value.rows,
                  { id: crypto.randomUUID(), cells: value.columns.map(() => '') },
                ],
              });
            }}
          >
            {uiText('添加行')}
          </button>
          <button
            disabled={value.columns.length >= 50}
            onClick={() => {
              clear();
              change({
                ...value,
                columns: [
                  ...value.columns,
                  {
                    id: crypto.randomUUID(),
                    label: uiText('列 {0}', { '0': value.columns.length + 1 }),
                  },
                ],
                rows: value.rows.map((row) => ({ ...row, cells: [...row.cells, ''] })),
              });
            }}
          >
            {uiText('添加列')}
          </button>
          {(selectRange || manageRange) && (
            <button
              className={selecting ? 'active' : ''}
              onClick={() => {
                setSelecting(!selecting);
                clear();
              }}
            >
              {selecting ? uiText('返回编辑') : uiText('选择范围')}
            </button>
          )}
        </div>
      )}
      {!compact && selecting && (
        <div className="table-selection-tools">
          <div>
            <strong aria-live="polite">
              {stale ? uiText('行列结构已变化，请重新选择') : summary}
            </strong>
            {range && selectedRows.length > 0 && (
              <small>
                {uiText('行')}
                {rowIndex(selectedRows[0].id) + 1}–{rowIndex(selectedRows.at(-1)!.id) + 1}
                {uiText('，列')}
                {columnIndex(selectedColumns[0].id) + 1}–
                {columnIndex(selectedColumns.at(-1)!.id) + 1}
              </small>
            )}
          </div>
          <p>
            {uiText(
              '点行号选整行，点列名选整列；Shift 点击扩展范围。翻页后继续选择，整列包含全部页面。',
            )}
          </p>
          <div className="table-range-actions">
            {selectRange && (
              <button
                className="primary"
                disabled={!selectedRows.length || !selectedColumns.length}
                onClick={() =>
                  selectRange(
                    selectedRows.map((row) => row.id),
                    selectedColumns.map((column) => column.id),
                    structuredClone(value),
                  )
                }
              >
                {uiText('使用选中范围')}
              </button>
            )}
            <button
              disabled={!value.rows.length}
              onClick={() => pick('all', value.rows[0]?.id ?? '', value.columns[0].id)}
            >
              {uiText('全选表格')}
            </button>
            <button disabled={!selection} onClick={clear}>
              {uiText('清除范围')}
            </button>
            <button disabled={!selectedRows.length} onClick={() => setRemoving('rows')}>
              {uiText('删除涉及的')}
              {selectedRows.length} {uiText('行')}
            </button>
            <button
              disabled={!selectedColumns.length || selectedColumns.length === value.columns.length}
              onClick={() => setRemoving('columns')}
            >
              {uiText('删除涉及的')}
              {selectedColumns.length} {uiText('列')}
            </button>
          </div>
          {removing && range && (
            <div className="table-remove-confirm">
              <span>
                {uiText('将删除完整的')}
                {removing === 'rows'
                  ? uiText('{0} 行（含其他列）', { '0': selectedRows.length })
                  : uiText('{0} 列（含全部页面）', { '0': selectedColumns.length })}
                。
              </span>
              <button onClick={remove}>{uiText('确认删除')}</button>
              <button onClick={() => setRemoving(null)}>{uiText('保留')}</button>
            </div>
          )}
        </div>
      )}
      <div className="grid-scroll">
        <table>
          <thead>
            <tr>
              <th className="row-number">
                {selecting ? (
                  <button
                    disabled={!value.rows.length}
                    aria-label={uiText('选择整张表格')}
                    onClick={() => pick('all', value.rows[0]?.id ?? '', value.columns[0].id)}
                  >
                    {uiText('全')}
                  </button>
                ) : (
                  '#'
                )}
              </th>
              {value.columns.map((column, index) => (
                <th
                  key={column.id}
                  className={
                    selecting && columnIds.has(column.id) && rowIds.size === value.rows.length
                      ? 'range-header-selected'
                      : ''
                  }
                >
                  {compact ? (
                    column.label
                  ) : selecting ? (
                    <button
                      className="column-selector"
                      aria-label={uiText('选择第 {0} 列 {1}', {
                        '0': index + 1,
                        '1': column.label,
                      })}
                      aria-pressed={columnIds.has(column.id) && rowIds.size === value.rows.length}
                      onClick={(event) =>
                        pick('columns', value.rows[0]?.id ?? '', column.id, event.shiftKey)
                      }
                    >
                      {column.label || uiText('列 {0}', { '0': index + 1 })}
                    </button>
                  ) : (
                    <input
                      aria-label={uiText('列 {0} 名称', { '0': index + 1 })}
                      value={column.label}
                      maxLength={500}
                      onChange={(event) =>
                        change({
                          ...value,
                          columns: value.columns.map((item) =>
                            item.id === column.id ? { ...item, label: event.target.value } : item,
                          ),
                        })
                      }
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const number = compact ? index + 1 : currentPage * 40 + index + 1;
              return (
                <tr key={row.id}>
                  <th
                    className={`row-number ${selecting && rowIds.has(row.id) && columnIds.size === value.columns.length ? 'range-header-selected' : ''}`}
                  >
                    {selecting ? (
                      <button
                        aria-label={uiText('选择第 {0} 行', { '0': number })}
                        aria-pressed={rowIds.has(row.id) && columnIds.size === value.columns.length}
                        onClick={(event) =>
                          pick('rows', row.id, value.columns[0].id, event.shiftKey)
                        }
                      >
                        {number}
                      </button>
                    ) : (
                      number
                    )}
                  </th>
                  {row.cells.map((text, column) => (
                    <td
                      key={value.columns[column].id}
                      className={
                        selecting && rowIds.has(row.id) && columnIds.has(value.columns[column].id)
                          ? 'range-selected'
                          : ''
                      }
                    >
                      {compact ? (
                        <span>{text || '—'}</span>
                      ) : selecting ? (
                        <button
                          className="cell-selector"
                          aria-label={uiText('选择第 {0} 行第 {1} 列：{2}', {
                            '0': number,
                            '1': column + 1,
                            '2': text || uiText('空'),
                          })}
                          aria-pressed={
                            rowIds.has(row.id) && columnIds.has(value.columns[column].id)
                          }
                          onClick={(event) =>
                            pick('cells', row.id, value.columns[column].id, event.shiftKey)
                          }
                        >
                          {text || '—'}
                        </button>
                      ) : (
                        <input
                          aria-label={uiText('第 {0} 行 第 {1} 列', {
                            '0': number,
                            '1': column + 1,
                          })}
                          value={text}
                          maxLength={4000}
                          onChange={(event) =>
                            change({
                              ...value,
                              rows: value.rows.map((item) =>
                                item.id === row.id
                                  ? {
                                      ...item,
                                      cells: item.cells.map((cell, i) =>
                                        i === column ? event.target.value : cell,
                                      ),
                                    }
                                  : item,
                              ),
                            })
                          }
                        />
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!value.rows.length && (
          <p className="editor-empty">{uiText('还没有数据行，点击“添加行”开始。')}</p>
        )}
      </div>
      {!compact && (
        <div className="editor-tools pager">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            {uiText('上一页')}
          </button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>
            {uiText('下一页')}
          </button>
          {selecting && range && <small>{uiText('翻页保留当前范围')}</small>}
        </div>
      )}
      {compact && (
        <small>
          {value.rows.length} {uiText('行 ·')}
          {value.columns.length} {uiText('列 · 展开编辑')}
        </small>
      )}
    </div>
  );
}
