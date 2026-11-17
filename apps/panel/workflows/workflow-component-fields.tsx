import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import {
  getUiLanguage as getUiLocale,
  subscribeUiLanguage as onUiLocale,
} from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import {
  workflowPorts,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowValue,
  type WorkflowFileValue,
} from '../../../packages/contracts/workflows.js';
import { Icon } from '../ui/icons.js';
import './workflow-result-preview.css';

export const workflowPortTypes = [
  'text',
  'json',
  'table',
  'file',
  'files',
  'browser-session',
] as const;
let typeLabels: Record<string, string> = {
  text: uiText('文本'),
  json: 'JSON',
  table: uiText('表格'),
  file: uiText('文件'),
  files: uiText('多个文件'),
  'browser-session': uiText('浏览器会话'),
};
export const fileName = (item: DesktopObject) =>
  item.kind === 'file' ? (item.content as { fileName: string }).fileName : '';
type FieldsProps = {
  node: WorkflowNode;
  workspace: Workspace;
  config: (change: Partial<WorkflowNode['config']>) => void;
  json: (field: string, label: string, value: unknown, objectOnly?: boolean) => React.ReactNode;
  createPython: () => void;
  openFile: (id: string) => void;
  canOpen: boolean;
};
export function WorkflowCustomFields({
  node,
  workspace,
  config,
  json,
  createPython,
  openFile,
  canOpen,
}: FieldsProps) {
  useUiLocale();
  const c = node.config;
  if (node.type === 'python')
    return (
      <>
        <div className="workflow-field-banner type-python">
          <Icon name="code" size={20} />
          <div>
            <strong>{uiText('Python 自定义组件')}</strong>
            <small>{uiText('源码保留为桌面的原生 .py 文件')}</small>
          </div>
        </div>
        <label>
          {uiText('Python 源文件')}
          <select
            value={c.codeObjectId ?? ''}
            onChange={(event) => config({ codeObjectId: event.target.value || undefined })}
          >
            <option value="">{uiText('选择 .py 文件…')}</option>
            {workspace.objects
              .filter((item) => /\.py$/i.test(fileName(item)))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
        <div className="workflow-inline-actions">
          <button onClick={createPython}>
            <Icon name="plus" size={14} />
            {uiText('新建组件源码')}
          </button>
          <button
            disabled={!c.codeObjectId || !canOpen}
            onClick={() => c.codeObjectId && openFile(c.codeObjectId)}
          >
            <Icon name="code" size={14} />
            {uiText('编辑源码')}
          </button>
        </div>
        <label>
          {uiText('入口函数')}
          <input
            placeholder="run"
            maxLength={64}
            value={c.entryFunction ?? 'run'}
            onChange={(event) => config({ entryFunction: event.target.value })}
          />
        </label>
        <label>
          {uiText('依赖文件 · 可选')}
          <select
            value={c.requirementsObjectId ?? ''}
            onChange={(event) => config({ requirementsObjectId: event.target.value || undefined })}
          >
            <option value="">{uiText('仅使用已有 Python 环境')}</option>
            {workspace.objects
              .filter((item) => /\.txt$/i.test(fileName(item)))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
        {c.requirementsObjectId && (
          <button disabled={!canOpen} onClick={() => openFile(c.requirementsObjectId!)}>
            {uiText('编辑依赖文件')}
          </button>
        )}
        {c.instructions && (
          <details className="workflow-preset-usage">
            <summary>{uiText('组件使用说明')}</summary>
            <p>{c.instructions}</p>
          </details>
        )}
        {json('parameters', uiText('组件参数'), c.parameters ?? {}, true)}
        <small className="workflow-field-help">
          {uiText(
            '入口接收 inputs 和 context，返回与输出端口同名的字典。冻结输入文件路径从 context["input_files"][objectId 或 artifactId] 获取。文件写入 context["output_dir"]，用',
          )}
          {`{"$file":"result.csv"}`} {uiText('返回。依赖安装与代码执行由原对话处理。')}
        </small>
      </>
    );
  if (node.type === 'browser')
    return (
      <>
        <div className="workflow-field-banner type-browser">
          <Icon name="desktop" size={20} />
          <div>
            <strong>{uiText('浏览器组件')}</strong>
            <small>{uiText('沿用原对话中可用的浏览器能力')}</small>
          </div>
        </div>
        <label>
          {uiText('浏览器操作')}
          <select
            value={c.browserAction ?? 'open'}
            onChange={(event) =>
              config({
                browserAction: event.target.value as NonNullable<
                  WorkflowNode['config']['browserAction']
                >,
                inputPorts: undefined,
                outputPorts: undefined,
              })
            }
          >
            <option value="open">{uiText('打开页面')}</option>
            <option value="read">{uiText('读取页面')}</option>
            <option value="interact">{uiText('操作页面')}</option>
            <option value="screenshot">{uiText('截取页面')}</option>
            <option value="download">{uiText('下载文件')}</option>
          </select>
        </label>
        <label>
          {uiText('浏览器能力 / 服务')}
          <input
            maxLength={100}
            placeholder={uiText('自动使用原对话可用能力')}
            value={c.provider ?? ''}
            onChange={(event) => config({ provider: event.target.value })}
          />
        </label>
        {(c.browserAction ?? 'open') === 'open' ? (
          <label>
            {uiText('页面地址')}
            <input
              maxLength={2048}
              type="url"
              placeholder={uiText('https://… 或连接上游 url 端口')}
              value={c.url ?? ''}
              onChange={(event) => config({ url: event.target.value })}
            />
          </label>
        ) : (
          <div className="workflow-session-hint">
            <Icon name="link" size={16} />
            <span>
              {uiText('会话来自上游')}
              <code>session</code> {uiText('连接。多个操作连接到同一个会话，继续使用同一页面。')}
            </span>
          </div>
        )}
        <label>
          {uiText('操作要求')}
          <textarea
            rows={7}
            maxLength={24000}
            value={c.instructions ?? ''}
            placeholder={
              c.browserAction === 'download'
                ? uiText('描述要下载的文件与位置，完成后收回桌面…')
                : c.browserAction === 'interact'
                  ? uiText('描述需要点击、填写或等待的内容…')
                  : uiText('描述页面范围、采集内容及预期结果…')
            }
            onChange={(event) => config({ instructions: event.target.value })}
          />
        </label>
        <small className="workflow-field-help">
          {uiText(
            '页面在真实浏览器标签页中打开；这里显示原对话回报的会话与采集结果。登录或人工接管后，可从原对话继续。',
          )}
        </small>
      </>
    );
  return null;
}

export function WorkflowPortEditor({
  node,
  change,
}: {
  node: WorkflowNode;
  change: (value: Partial<WorkflowNode['config']>) => void;
}) {
  useUiLocale();
  const ports = workflowPorts(node);
  if (['input', 'browser', 'condition', 'approval', 'extract', 'chart'].includes(node.type))
    return (
      <details className="workflow-port-editor">
        <summary>
          {uiText('组件端口')}
          <span>
            {ports.inputs.length} {uiText('入 ·')}
            {ports.outputs.length} {uiText('出')}
          </span>
        </summary>
        {(['inputs', 'outputs'] as const).map((direction) => (
          <div className="workflow-port-group" key={direction}>
            <header>
              <strong>{direction === 'inputs' ? uiText('输入端口') : uiText('输出端口')}</strong>
            </header>
            {ports[direction].map((port) => (
              <div key={port.name} className="workflow-port-row">
                <code>{port.name}</code>
                <small>{typeLabels[port.type]}</small>
              </div>
            ))}
          </div>
        ))}
        <small>{uiText('此组件使用固定语义端口，端口随输入类型或组件能力自动定义。')}</small>
        {(node.config.inputPorts || node.config.outputPorts) && (
          <button
            type="button"
            onClick={() => change({ inputPorts: undefined, outputPorts: undefined })}
          >
            {uiText('恢复标准端口')}
          </button>
        )}
      </details>
    );
  return (
    <details className="workflow-port-editor">
      <summary>
        {uiText('命名端口与数据类型')}
        <span>
          {ports.inputs.length} {uiText('入 ·')}
          {ports.outputs.length} {uiText('出')}
        </span>
      </summary>
      {(['inputs', 'outputs'] as const).map((direction) => {
        const key = direction === 'inputs' ? 'inputPorts' : 'outputPorts',
          list = ports[direction];
        return (
          <div key={direction} className="workflow-port-group">
            <header>
              <strong>{direction === 'inputs' ? uiText('输入端口') : uiText('输出端口')}</strong>
              <button
                type="button"
                disabled={
                  list.length >= 16 ||
                  (node.type === 'input' && direction === 'inputs') ||
                  (node.type === 'output' && direction === 'outputs')
                }
                onClick={() => {
                  let name = direction === 'inputs' ? 'input' : 'result',
                    suffix = 2;
                  while (list.some((item) => item.name === name))
                    name = `${direction === 'inputs' ? 'input' : 'result'}_${suffix++}`;
                  change({ [key]: [...list, { name, type: 'json' }] });
                }}
              >
                <Icon name="plus" size={13} />
              </button>
            </header>
            {list.map((port, index) => (
              <div className="workflow-port-row" key={index}>
                <input
                  aria-label={uiText('端口名称')}
                  maxLength={64}
                  value={port.name}
                  onChange={(event) =>
                    change({
                      [key]: list.map((item, i) =>
                        i === index ? { ...item, name: event.target.value } : item,
                      ),
                    })
                  }
                />
                <select
                  aria-label={uiText('端口类型')}
                  value={port.type}
                  onChange={(event) =>
                    change({
                      [key]: list.map((item, i) =>
                        i === index ? { ...item, type: event.target.value } : item,
                      ),
                    })
                  }
                >
                  {workflowPortTypes.map((type) => (
                    <option key={type} value={type}>
                      {typeLabels[type]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={uiText('删除端口 {0}', { '0': port.name })}
                  onClick={() => change({ [key]: list.filter((_, i) => i !== index) })}
                >
                  <Icon name="close" size={12} />
                </button>
                {direction === 'inputs' && (
                  <label className="workflow-port-required">
                    <input
                      type="checkbox"
                      checked={port.required ?? false}
                      onChange={(event) =>
                        change({
                          [key]: list.map((item, i) =>
                            i === index ? { ...item, required: event.target.checked } : item,
                          ),
                        })
                      }
                    />
                    {uiText('必填')}
                  </label>
                )}
              </div>
            ))}
          </div>
        );
      })}
      <button
        type="button"
        className="workflow-reset-ports"
        onClick={() => change({ inputPorts: undefined, outputPorts: undefined })}
      >
        {uiText('恢复组件默认端口')}
      </button>
      <small>
        {uiText('重命名或删除端口后，请重新连接受影响的连线。JSON 输入允许接收其他可序列化类型。')}
      </small>
    </details>
  );
}

export type ParameterSpec = {
  label?: string;
  type:
    | 'text'
    | 'number'
    | 'boolean'
    | 'enum'
    | 'file'
    | 'files'
    | 'column'
    | 'columns'
    | 'strings'
    | 'json';
  required?: boolean;
  options?: string[];
  description?: string;
};
const enumOptions: Record<string, string[]> = {
  format: ['auto', 'xlsx', 'docx', 'pdf', 'text'],
  chart_type: ['bar', 'line', 'metric'],
  aggregate: ['first', 'sum', 'mean', 'min', 'max'],
  encoding: ['utf-8', 'utf-8-sig', 'gb18030'],
  sort_order: ['ascending', 'descending'],
};
export function WorkflowParameterForm({
  value,
  change,
  schema = {},
  workspace,
  columns = [],
}: {
  value: Record<string, unknown>;
  change: (value: Record<string, unknown>) => void;
  schema?: Record<string, ParameterSpec>;
  workspace?: Workspace;
  columns?: string[];
}) {
  useUiLocale();
  const keys = [...new Set([...Object.keys(schema), ...Object.keys(value)])],
    listId = React.useId();
  return (
    <div className="workflow-parameter-form">
      <datalist id={listId}>
        {columns.map((column) => (
          <option key={column} value={column} />
        ))}
      </datalist>
      {!keys.length && (
        <p className="workflow-parameter-empty">
          {uiText('尚无参数，可在「参数定义」添加名称与类型。')}
        </p>
      )}
      {keys.map((key) => {
        const item = value[key],
          spec = schema[key],
          type =
            spec?.type ??
            (enumOptions[key]
              ? 'enum'
              : /^(?:x_column|sort_by|column)$/.test(key)
                ? 'column'
                : /^(?:y_columns|columns)$/.test(key)
                  ? 'columns'
                  : Array.isArray(item) && item.every((value) => typeof value === 'string')
                    ? 'strings'
                    : typeof item === 'boolean'
                      ? 'boolean'
                      : typeof item === 'number'
                        ? 'number'
                        : typeof item === 'string'
                          ? 'text'
                          : 'json'),
          label = spec?.label ?? parameterLabels[key] ?? key.replace(/[_-]/g, ' '),
          set = (next: unknown) => change({ ...value, [key]: next }),
          missing =
            spec?.required &&
            (item === undefined ||
              item === null ||
              item === '' ||
              (Array.isArray(item) && !item.length)),
          options = spec?.options ?? enumOptions[key] ?? [];
        return (
          <label
            className={`workflow-parameter-field${type === 'boolean' ? ' is-boolean' : ''}`}
            key={key}
          >
            <span className="workflow-parameter-label">
              <strong>
                {label}
                {spec?.required ? ' *' : ''}
              </strong>
              {label !== key && <code>{key}</code>}
            </span>
            {type === 'boolean' ? (
              <span className="workflow-parameter-toggle">
                <input
                  type="checkbox"
                  checked={!!item}
                  onChange={(event) => set(event.target.checked)}
                />
                <span>{item ? uiText('已开启') : uiText('已关闭')}</span>
              </span>
            ) : type === 'number' ? (
              <ParameterNumber value={typeof item === 'number' ? item : 0} change={set} />
            ) : type === 'enum' ? (
              <select value={String(item ?? '')} onChange={(event) => set(event.target.value)}>
                <option value="">{uiText('请选择…')}</option>
                {!options.includes(String(item ?? '')) && item !== undefined && (
                  <option value={String(item)}>{String(item)}</option>
                )}
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : type === 'file' || type === 'files' ? (
              <select
                multiple={type === 'files'}
                value={
                  type === 'files'
                    ? Array.isArray(item)
                      ? (item as string[])
                      : []
                    : String(item ?? '')
                }
                onChange={(event) =>
                  set(
                    type === 'files'
                      ? Array.from(event.target.selectedOptions).map((option) => option.value)
                      : event.target.value,
                  )
                }
              >
                {type === 'file' && <option value="">{uiText('选择桌面文件…')}</option>}
                {workspace?.objects
                  .filter((object) => !object.archived && object.kind === 'file')
                  .map((object) => (
                    <option key={object.id} value={object.id}>
                      {object.title}
                    </option>
                  ))}
              </select>
            ) : type === 'column' ? (
              <input
                list={listId}
                value={String(item ?? '')}
                placeholder={
                  columns.length
                    ? uiText('选择上游表格中的列')
                    : uiText('填写列名；有上游结果后可选择')
                }
                onChange={(event) => set(event.target.value)}
              />
            ) : type === 'strings' || type === 'columns' ? (
              <>
                <textarea
                  rows={3}
                  value={Array.isArray(item) ? item.join('\n') : ''}
                  placeholder={uiText('每行一个值')}
                  onChange={(event) => set(event.target.value.split('\n').filter(Boolean))}
                />
                {type === 'columns' && columns.length > 0 && (
                  <select
                    value=""
                    onChange={(event) => {
                      if (event.target.value)
                        set([
                          ...new Set([...(Array.isArray(item) ? item : []), event.target.value]),
                        ]);
                    }}
                  >
                    <option value="">{uiText('添加上游列…')}</option>
                    {columns.map((column) => (
                      <option key={column}>{column}</option>
                    ))}
                  </select>
                )}
              </>
            ) : type === 'text' ? (
              <textarea
                rows={Math.min(6, Math.max(2, String(item ?? '').split('\n').length))}
                spellCheck={false}
                value={String(item ?? '')}
                onChange={(event) => set(event.target.value)}
              />
            ) : (
              <StructuredParameter value={item} change={set} />
            )}
            {spec?.description && <small>{spec.description}</small>}
            {missing && (
              <small className="workflow-field-error">{uiText('此参数为必填项。')}</small>
            )}
          </label>
        );
      })}
    </div>
  );
}
function StructuredParameter({
  value,
  change,
}: {
  value: unknown;
  change: (value: unknown) => void;
}) {
  useUiLocale();
  const [raw, setRaw] = useState(() => jsonText(value)),
    [error, setError] = useState('');
  useEffect(() => {
    setRaw(jsonText(value));
    setError('');
  }, [value]);
  return (
    <>
      <textarea
        rows={4}
        spellCheck={false}
        value={raw}
        onChange={(event) => {
          setRaw(event.target.value);
          try {
            const parsed = JSON.parse(event.target.value);
            change(parsed);
            setError('');
          } catch {
            setError(uiText('JSON 尚未完整，保留上一次有效值。'));
          }
        }}
      />
      {error && <small className="workflow-field-error">{error}</small>}
    </>
  );
}

let parameterLabels: Record<string, string> = {
  text: uiText('文本'),
  title: uiText('标题'),
  description: uiText('描述'),
  prompt: uiText('提示词'),
  instructions: uiText('处理要求'),
  url: uiText('页面地址'),
  query: uiText('搜索条件'),
  pattern: uiText('匹配规则'),
  replacement: uiText('替换内容'),
  delimiter: uiText('分隔符'),
  separator: uiText('分隔符'),
  encoding: uiText('文件编码'),
  columns: uiText('列名'),
  column: uiText('目标列'),
  limit: uiText('数量上限'),
  max_rows: uiText('最大行数'),
  max_chars: uiText('最大字符数'),
  chunk_size: uiText('分段大小'),
  overlap: uiText('重叠长度'),
  case_sensitive: uiText('区分大小写'),
  include_header: uiText('包含表头'),
  trim: uiText('去除首尾空白'),
  unique: uiText('去除重复项'),
  sort_by: uiText('排序字段'),
  descending: uiText('降序'),
  output_name: uiText('输出文件名'),
  file_name: uiText('文件名'),
  sheet_name: uiText('工作表名'),
  timeout: uiText('超时时间'),
  enabled: uiText('启用'),
};

function ParameterNumber({ value, change }: { value: number; change: (value: number) => void }) {
  useUiLocale();
  const [raw, setRaw] = useState(String(value)),
    focused = useRef(false),
    lastCommitted = useRef(value);
  useEffect(() => {
    if (!focused.current || value !== lastCommitted.current) {
      setRaw(String(value));
      lastCommitted.current = value;
    }
  }, [value]);
  const valid = raw.trim() !== '' && Number.isFinite(Number(raw));
  return (
    <span className="workflow-parameter-number">
      <input
        type="text"
        inputMode="decimal"
        value={raw}
        aria-invalid={!valid}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onChange={(event) => {
          const next = event.target.value;
          setRaw(next);
          if (next.trim() !== '' && Number.isFinite(Number(next))) {
            const number = Number(next);
            lastCommitted.current = number;
            change(number);
          }
        }}
      />
      {!valid && <small role="status">{uiText('请填写有效数字；当前草稿未写入参数。')}</small>}
    </span>
  );
}

function jsonText(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return uiText('此值无法序列化为 JSON。');
  }
}
const PREVIEW_TEXT_LIMIT = 4000,
  EXPANDED_TEXT_LIMIT = 24000,
  TABLE_ROWS = 100,
  TABLE_COLUMNS = 30;

function CopyResult({ text, label = uiText('复制全文') }: { text: string; label?: string }) {
  useUiLocale();
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => setStatus('idle'), [text]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };
  return (
    <span className="workflow-copy-action">
      <button type="button" onClick={() => void copy()} aria-live="polite">
        {status === 'copied' ? (
          <>
            <Icon name="check" size={12} />
            {uiText('已复制')}
          </>
        ) : (
          label
        )}
      </button>
      {status === 'failed' && <small role="status">{uiText('复制受限，可选中文本复制')}</small>}
    </span>
  );
}

function TextPreview({
  text,
  format = 'text',
}: {
  text: string;
  format?: 'text' | 'json' | 'log';
}) {
  useUiLocale();
  const [expanded, setExpanded] = useState(false),
    limit = expanded ? EXPANDED_TEXT_LIMIT : PREVIEW_TEXT_LIMIT,
    visible = text.slice(0, limit);
  return (
    <div className={`workflow-value-text format-${format}`}>
      <div className="workflow-value-toolbar">
        <span>
          {text.length.toLocaleString(interfaceLocale())} {uiText('字符')}
        </span>
        <CopyResult text={text} />
      </div>
      <pre className="workflow-value-content">{visible || uiText('（空内容）')}</pre>
      {text.length > PREVIEW_TEXT_LIMIT && (
        <div className="workflow-value-overflow">
          <span>
            {text.length > limit
              ? uiText('预览前 {0} 字符，复制可获取完整内容。', {
                  '0': limit.toLocaleString(interfaceLocale()),
                })
              : uiText('已显示全部内容。')}
          </span>
          <button type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? uiText('收起') : uiText('展开预览')}
          </button>
        </div>
      )}
    </div>
  );
}

function TablePreview({ value }: { value: Extract<WorkflowValue, { type: 'table' }>['value'] }) {
  useUiLocale();
  const columns = value.columns.slice(0, TABLE_COLUMNS),
    rows = value.rows.slice(0, TABLE_ROWS),
    truncated = value.rows.length > TABLE_ROWS || value.columns.length > TABLE_COLUMNS,
    serialized = useMemo(() => jsonText(value), [value, getUiLocale()]);
  return (
    <div className="workflow-value-table">
      <div className="workflow-value-toolbar">
        <span>
          {value.rows.length.toLocaleString(interfaceLocale())} {uiText('行 ·')}
          {value.columns.length.toLocaleString(interfaceLocale())} {uiText('列')}
        </span>
        <CopyResult text={serialized} label={uiText('复制表格 JSON')} />
      </div>
      {columns.length ? (
        <div
          className="workflow-table-scroll"
          tabIndex={0}
          aria-label={uiText('输出表格，可横向和纵向滚动')}
        >
          <table>
            <thead>
              <tr>
                <th scope="col" className="workflow-table-index">
                  #
                </th>
                {columns.map((column, index) => (
                  <th scope="col" key={index}>
                    {column || uiText('列 {0}', { '0': index + 1 })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th scope="row" className="workflow-table-index">
                    {rowIndex + 1}
                  </th>
                  {columns.map((_, columnIndex) => {
                    const cell = row[columnIndex],
                      raw =
                        cell === undefined ? '' : typeof cell === 'string' ? cell : jsonText(cell);
                    return (
                      <td
                        key={columnIndex}
                        title={raw.slice(0, 2000)}
                        className={typeof cell === 'number' ? 'is-number' : undefined}
                      >
                        {raw.length > 400 ? `${raw.slice(0, 400)}…` : raw}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <p className="workflow-value-empty">{uiText('表格包含列定义，暂无数据行。')}</p>
          )}
        </div>
      ) : (
        <p className="workflow-value-empty">{uiText('表格暂无列定义。')}</p>
      )}
      {truncated && (
        <small className="workflow-value-footnote">
          {uiText('仅预览前')}
          {Math.min(TABLE_ROWS, value.rows.length)} {uiText('行、')}
          {Math.min(TABLE_COLUMNS, value.columns.length)} {uiText('列。复制包含完整表格。')}
        </small>
      )}
    </div>
  );
}

function FilePreview({
  value,
  openFile,
}: {
  value: WorkflowFileValue;
  openFile?: (id: string) => void;
}) {
  useUiLocale();
  const objectId = 'objectId' in value ? value.objectId : undefined,
    hash = 'assetHash' in value ? value.assetHash : 'sha256' in value ? value.sha256 : undefined;
  return (
    <div className="workflow-value-file">
      <span className="workflow-value-file-icon">
        <Icon name="document" size={19} />
      </span>
      <div className="workflow-value-file-info">
        <strong>{value.fileName || uiText('桌面文件')}</strong>
        <small>
          {'revision' in value
            ? uiText('桌面对象 · v{0}', { '0': value.revision })
            : uiText('运行产物 · {0}', { '0': formatBytes(value.size) })}
        </small>
        <code title={objectId ?? ('artifactId' in value ? value.artifactId : '')}>
          {objectId ?? ('artifactId' in value ? value.artifactId : '')}
        </code>
        {hash && <small title={hash}>SHA-256 · {hash.slice(0, 12)}…</small>}
      </div>
      {objectId ? (
        <button type="button" disabled={!openFile} onClick={() => openFile?.(objectId)}>
          {uiText('打开文件')}
          <Icon name="arrow" size={12} />
        </button>
      ) : (
        <span className="workflow-value-file-status">{uiText('运行产物')}</span>
      )}
    </div>
  );
}
function formatBytes(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function TypedValue({
  output,
  openFile,
}: {
  output: WorkflowValue;
  openFile?: (id: string) => void;
}) {
  useUiLocale();
  const serialized = useMemo(
    () => (output.type === 'json' ? jsonText(output.value) : ''),
    [output, getUiLocale()],
  );
  if (output.type === 'text') return <TextPreview text={output.value} />;
  if (output.type === 'json') return <TextPreview text={serialized} format="json" />;
  if (output.type === 'table') return <TablePreview value={output.value} />;
  if (output.type === 'file') return <FilePreview value={output.value} openFile={openFile} />;
  if (output.type === 'files')
    return (
      <div className="workflow-value-files">
        <div className="workflow-value-toolbar">
          <span>
            {output.value.length} {uiText('个文件')}
          </span>
        </div>
        {output.value.slice(0, 32).map((file, index) => (
          <FilePreview key={index} value={file} openFile={openFile} />
        ))}
        {!output.value.length && (
          <p className="workflow-value-empty">{uiText('本次未返回文件。')}</p>
        )}
      </div>
    );
  const session = output.value;
  return (
    <div className="workflow-value-browser">
      <div className="workflow-browser-heading">
        <Icon name="desktop" size={18} />
        <strong>{session.title || uiText('浏览器会话')}</strong>
      </div>
      {session.url && <p className="workflow-browser-url">{session.url}</p>}
      <dl>
        <dt>{uiText('服务')}</dt>
        <dd>{session.provider}</dd>
        {session.tabId && (
          <>
            <dt>{uiText('标签页')}</dt>
            <dd>{session.tabId}</dd>
          </>
        )}
        {session.sessionId && (
          <>
            <dt>{uiText('会话')}</dt>
            <dd>{session.sessionId}</dd>
          </>
        )}
      </dl>
      <small className="workflow-value-footnote">
        {uiText('显示执行回报中的页面信息。继续操作可连接下游浏览器组件。')}
      </small>
    </div>
  );
}

export function WorkflowRunValues({
  report,
  openFile,
}: {
  report: WorkflowRun['nodes'][string];
  openFile?: (id: string) => void;
}) {
  useUiLocale();
  const outputs = Object.entries(report.outputs ?? {}),
    python = report.pythonResult,
    resultIds = [...new Set(report.resultObjectIds ?? [])];
  return (
    <>
      {outputs.length > 0 && (
        <details className="workflow-run-values workflow-typed-results">
          <summary>
            {uiText('返回值 ·')}
            {outputs.length} {uiText('个输出端口')}
          </summary>
          {outputs.slice(0, 24).map(([port, output]) => (
            <section className="workflow-output-card" key={port}>
              <header>
                <code>{port}</code>
                <span className={`workflow-output-type type-${output.type}`}>
                  {typeLabels[output.type] ?? output.type}
                </span>
              </header>
              {port === 'svg' &&
              output.type === 'text' &&
              /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(output.value) ? (
                <>
                  <img
                    className="workflow-chart-preview"
                    alt={uiText('组件生成的 SVG 图表')}
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(output.value)}`}
                  />
                  <details>
                    <summary>{uiText('SVG 源码')}</summary>
                    <TextPreview text={output.value} />
                  </details>
                </>
              ) : (
                <TypedValue output={output} openFile={openFile} />
              )}
            </section>
          ))}
          {outputs.length > 24 && <p>{uiText('此处最多展示 24 个输出端口。')}</p>}
        </details>
      )}
      {python && (
        <details className="workflow-run-values workflow-typed-results">
          <summary>
            {uiText('Python 日志 ·')}
            {python.exitCode === null
              ? uiText('未取得退出码')
              : uiText('退出码 {0}', { '0': python.exitCode })}
          </summary>
          {python.runtime && (
            <section className="workflow-output-card">
              <header>
                <code>Python {python.runtime.version}</code>
              </header>
              <TextPreview text={python.runtime.executable} format="log" />
            </section>
          )}
          {python.stdout && (
            <section className="workflow-output-card">
              <header>
                <code>stdout</code>
              </header>
              <TextPreview text={python.stdout} format="log" />
            </section>
          )}
          {python.stderr && (
            <section className="workflow-output-card">
              <header>
                <code>stderr</code>
              </header>
              <TextPreview text={python.stderr} format="log" />
            </section>
          )}
          {!python.stdout && !python.stderr && <p>{uiText('本次执行没有标准输出或错误输出。')}</p>}
          {python.logsTruncated && (
            <p>{uiText('执行回报中的日志已截取，复制得到的是当前已收回的日志。')}</p>
          )}
          {python.issues.length > 0 && (
            <section className="workflow-output-card">
              <header>
                <code>
                  {uiText('结果回收问题 ·')}
                  {python.issues.length} {uiText('项')}
                </code>
              </header>
              <TextPreview
                text={python.issues
                  .map(
                    (issue) =>
                      `${issue.code}${issue.fileName ? ` · ${issue.fileName}` : ''}\n${issue.message}`,
                  )
                  .join('\n\n')}
                format="log"
              />
            </section>
          )}
        </details>
      )}
      {report.executionRef && (
        <details className="workflow-run-values workflow-typed-results">
          <summary>{uiText('执行会话信息')}</summary>
          <TextPreview text={jsonText(report.executionRef)} format="json" />
        </details>
      )}
      {resultIds.length > 0 && (
        <div className="workflow-result-links workflow-result-object-links">
          {resultIds.slice(0, 32).map((id, index) => (
            <button
              key={id}
              type="button"
              disabled={!openFile}
              title={id}
              onClick={() => openFile?.(id)}
            >
              <Icon name="document" size={12} />
              {uiText('打开结果')}
              {resultIds.length > 1 ? index + 1 : ''}
            </button>
          ))}
          {resultIds.length > 32 && <small>{uiText('已显示前 32 个结果文件。')}</small>}
        </div>
      )}
    </>
  );
}

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  typeLabels = {
    text: uiText('文本'),
    json: 'JSON',
    table: uiText('表格'),
    file: uiText('文件'),
    files: uiText('多个文件'),
    'browser-session': uiText('浏览器会话'),
  };
  parameterLabels = {
    text: uiText('文本'),
    title: uiText('标题'),
    description: uiText('描述'),
    prompt: uiText('提示词'),
    instructions: uiText('处理要求'),
    url: uiText('页面地址'),
    query: uiText('搜索条件'),
    pattern: uiText('匹配规则'),
    replacement: uiText('替换内容'),
    delimiter: uiText('分隔符'),
    separator: uiText('分隔符'),
    encoding: uiText('文件编码'),
    columns: uiText('列名'),
    column: uiText('目标列'),
    limit: uiText('数量上限'),
    max_rows: uiText('最大行数'),
    max_chars: uiText('最大字符数'),
    chunk_size: uiText('分段大小'),
    overlap: uiText('重叠长度'),
    case_sensitive: uiText('区分大小写'),
    include_header: uiText('包含表头'),
    trim: uiText('去除首尾空白'),
    unique: uiText('去除重复项'),
    sort_by: uiText('排序字段'),
    descending: uiText('降序'),
    output_name: uiText('输出文件名'),
    file_name: uiText('文件名'),
    sheet_name: uiText('工作表名'),
    timeout: uiText('超时时间'),
    enabled: uiText('启用'),
  };
});
