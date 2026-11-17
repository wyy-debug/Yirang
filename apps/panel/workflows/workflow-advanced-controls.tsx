import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import {
  workflowPorts,
  type WorkflowDocument,
  type WorkflowNode,
  type WorkflowRun,
} from '../../../packages/contracts/workflows.js';
import {
  bundleSelection,
  type WorkflowComponentDefinition,
} from '../../../packages/contracts/workflow-composites.js';
import {
  WorkflowParameterForm,
  workflowPortTypes,
  type ParameterSpec,
} from './workflow-component-fields.js';
import { Icon } from '../ui/icons.js';
import { PanelActionError } from '../host.js';
import { writeDraftNow } from '../documents/draft-storage.js';
type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const fieldTypes: ParameterSpec['type'][] = [
  'text',
  'number',
  'boolean',
  'enum',
  'file',
  'files',
  'column',
  'columns',
  'strings',
  'json',
];
const compactKey = (raw: string) => {
  let hash = 2166136261;
  for (const char of raw) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `field_${(hash >>> 0).toString(36)}_${raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 42)}`;
};
const safeKey = (key: string) =>
  /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) &&
  !['__proto__', 'prototype', 'constructor'].includes(key);

export function WorkflowParameterDefinition({
  node,
  change,
}: {
  node: WorkflowNode;
  change: (config: Partial<WorkflowNode['config']>) => void;
}) {
  useUiLocale();
  const [name, setName] = useState(''),
    [kind, setKind] = useState<ParameterSpec['type']>('text'),
    schema = node.config.parameterSchema ?? {},
    target = node.type === 'mcp' ? 'arguments' : 'parameters',
    values = node.config[target] ?? {};
  return (
    <details className="workflow-advanced-section">
      <summary>{uiText('参数定义 · 类型与必填项')}</summary>
      {Object.entries(schema).map(([key, spec]) => (
        <div className="workflow-schema-row" key={key}>
          <strong>{key}</strong>
          <input
            aria-label={uiText('{0} 显示名称', { '0': key })}
            value={spec.label ?? ''}
            placeholder={uiText('显示名称')}
            onChange={(event) =>
              change({
                parameterSchema: { ...schema, [key]: { ...spec, label: event.target.value } },
              })
            }
          />
          <select
            value={spec.type}
            onChange={(event) =>
              change({
                parameterSchema: {
                  ...schema,
                  [key]: { ...spec, type: event.target.value as ParameterSpec['type'] },
                },
              })
            }
          >
            {fieldTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              checked={spec.required ?? false}
              onChange={(event) =>
                change({
                  parameterSchema: {
                    ...schema,
                    [key]: { ...spec, required: event.target.checked },
                  },
                })
              }
            />
            {uiText('必填')}
          </label>
          {spec.type === 'enum' && (
            <textarea
              placeholder={uiText('每行一个可选值')}
              value={(spec.options ?? []).join('\n')}
              onChange={(event) =>
                change({
                  parameterSchema: {
                    ...schema,
                    [key]: { ...spec, options: event.target.value.split('\n').filter(Boolean) },
                  },
                })
              }
            />
          )}
          <button
            type="button"
            onClick={() => {
              const next = { ...schema };
              delete next[key];
              change({ parameterSchema: next });
            }}
          >
            {uiText('移除定义')}
          </button>
        </div>
      ))}
      <div className="workflow-schema-add">
        <input
          aria-label={uiText('新参数名称')}
          placeholder={uiText('参数名，例如 query')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label={uiText('新参数类型')}
          value={kind}
          onChange={(event) => setKind(event.target.value as ParameterSpec['type'])}
        >
          {fieldTypes.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <button
          disabled={!safeKey(name) || !!schema[name]}
          type="button"
          onClick={() => {
            change({
              parameterSchema: { ...schema, [name]: { type: kind, label: name } },
              [target]: {
                ...values,
                [name]:
                  values[name] ??
                  (kind === 'boolean'
                    ? false
                    : kind === 'number'
                      ? 0
                      : kind === 'files' || kind === 'strings' || kind === 'columns'
                        ? []
                        : kind === 'json'
                          ? {}
                          : ''),
              },
            });
            setName('');
          }}
        >
          {uiText('添加参数')}
        </button>
      </div>
      <small>{uiText('定义随组件保存；文件参数是桌面对象 ID，表格列来自已回收的上游结果。')}</small>
    </details>
  );
}

function valuePaths(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > 3 || value === null || typeof value !== 'object') return [];
  return Object.entries(value)
    .slice(0, 40)
    .flatMap(([key, item]) => {
      if (!/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
        return [];
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...valuePaths(item, path, depth + 1)];
    })
    .slice(0, 120);
}
export function WorkflowFieldBindings({
  node,
  document,
  run,
  change,
}: {
  node: WorkflowNode;
  document: WorkflowDocument;
  run?: WorkflowRun;
  change: (config: Partial<WorkflowNode['config']>) => void;
}) {
  useUiLocale();
  const [newName, setNewName] = useState(''),
    bindings: Record<string, { port: string; path?: string }> = {
      ...Object.fromEntries(
        Object.entries(node.config.argumentBindings ?? {}).map(([key, port]) => [key, { port }]),
      ),
      ...node.config.fieldBindings,
    },
    ports = workflowPorts(node).inputs;
  const put = (key: string, value: { port: string; path?: string } | null) => {
    const next = { ...bindings };
    if (value) next[key] = value;
    else delete next[key];
    change({ fieldBindings: next, argumentBindings: undefined });
  };
  const names = [
    ...new Set([
      ...Object.keys(node.config.parameterSchema ?? {}),
      ...Object.keys(
        node.type === 'mcp' ? (node.config.arguments ?? {}) : (node.config.parameters ?? {}),
      ),
    ]),
  ];
  return (
    <section className="workflow-advanced-section">
      <strong>{uiText('上游字段映射')}</strong>
      <p>{uiText('选择参数、输入端口及字段。运行时覆盖同名常量。')}</p>
      {Object.entries(bindings).map(([key, binding]) => {
        const edge = document.edges.find(
            (edge) => edge.target === node.id && edge.targetPort === binding.port,
          ),
          output = edge ? run?.nodes[edge.source]?.outputs?.[edge.sourcePort] : undefined,
          paths = valuePaths(output?.value),
          listId = `binding-${node.id}-${key}`;
        return (
          <div className="workflow-binding-row" key={key}>
            <header>
              <code>{key}</code>
              <button
                type="button"
                aria-label={uiText('删除 {0} 映射', { '0': key })}
                onClick={() => put(key, null)}
              >
                <Icon name="close" size={12} />
              </button>
            </header>
            <select
              aria-label={uiText('{0} 输入端口', { '0': key })}
              value={binding.port}
              onChange={(event) => put(key, { port: event.target.value })}
            >
              <option value="">{uiText('选择输入端口')}</option>
              {ports.map((port) => (
                <option key={port.name} value={port.name}>
                  {port.name} · {port.type}
                </option>
              ))}
            </select>
            <input
              aria-label={uiText('{0} 上游字段', { '0': key })}
              list={listId}
              placeholder={uiText('整个值，或 data.title / rows.0.0')}
              value={binding.path ?? ''}
              onChange={(event) => put(key, { ...binding, path: event.target.value || undefined })}
            />
            <datalist id={listId}>
              {paths.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
            <small>
              {edge
                ? uiText('来自 {0} / {1}', {
                    '0': document.nodes.find((item) => item.id === edge.source)?.label,
                    '1': edge.sourcePort,
                  })
                : uiText('此端口还没有连接上游')}
            </small>
          </div>
        );
      })}
      <div className="workflow-schema-add">
        <input
          aria-label={uiText('映射参数名')}
          placeholder={uiText('参数名')}
          list={`parameter-${node.id}`}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
        />
        <datalist id={`parameter-${node.id}`}>
          {names.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button
          type="button"
          disabled={!safeKey(newName) || !!bindings[newName] || !ports.length}
          onClick={() => {
            put(newName, { port: ports[0].name });
            setNewName('');
          }}
        >
          {uiText('添加映射')}
        </button>
      </div>
    </section>
  );
}

export function WorkflowExecutionFields({
  node,
  change,
}: {
  node: WorkflowNode;
  change: (config: Partial<WorkflowNode['config']>) => void;
}) {
  useUiLocale();
  const c = node.config,
    condition = c.condition ?? { inputPort: 'input', operator: 'truthy' as const };
  const typePicker = (
    <label>
      {uiText('传递的数据类型')}
      <select
        value={c.passThroughType ?? 'json'}
        onChange={(event) =>
          change({
            passThroughType: event.target.value as NonNullable<
              WorkflowNode['config']['passThroughType']
            >,
            inputPorts: undefined,
            outputPorts: undefined,
          })
        }
      >
        {workflowPortTypes.map((type) => (
          <option key={type} value={type}>
            {
              (
                {
                  text: uiText('文本'),
                  json: 'JSON',
                  table: uiText('表格'),
                  file: uiText('文件'),
                  files: uiText('多个文件'),
                  'browser-session': uiText('浏览器会话'),
                } as Record<string, string>
              )[type]
            }
          </option>
        ))}
      </select>
      <small>{uiText('按上游数据选择类型；条件判断或人工确认后，保留原类型传给下游。')}</small>
    </label>
  );
  if (node.type === 'condition')
    return (
      <>
        {typePicker}
        <label>
          {uiText('判断输入')}
          <select
            value={condition.inputPort}
            onChange={(event) =>
              change({ condition: { ...condition, inputPort: event.target.value } })
            }
          >
            {workflowPorts(node).inputs.map((port) => (
              <option key={port.name}>{port.name}</option>
            ))}
          </select>
        </label>
        <label>
          {uiText('字段路径')}
          <input
            value={condition.path ?? ''}
            placeholder={uiText('例如 rows.0.status，留空表示整个值')}
            onChange={(event) =>
              change({ condition: { ...condition, path: event.target.value || undefined } })
            }
          />
        </label>
        <label>
          {uiText('判断方式')}
          <select
            value={condition.operator}
            onChange={(event) =>
              change({
                condition: {
                  ...condition,
                  operator: event.target.value as typeof condition.operator,
                },
              })
            }
          >
            {['equals', 'not_equals', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'truthy'].map(
              (operator) => (
                <option key={operator}>{operator}</option>
              ),
            )}
          </select>
        </label>
        {!['exists', 'truthy'].includes(condition.operator) && (
          <label>
            {uiText('比较值')}
            <input
              value={
                typeof condition.value === 'string'
                  ? condition.value
                  : JSON.stringify(condition.value ?? '')
              }
              onChange={(event) => {
                let value: unknown = event.target.value;
                try {
                  value = JSON.parse(event.target.value);
                } catch {}
                change({ condition: { ...condition, value } });
              }}
            />
          </label>
        )}
        <small>
          {uiText(
            '符合条件仅沿 true 分支继续，否则沿 false 分支继续。把两个分支连接到各自的下游组件。',
          )}
        </small>
      </>
    );
  if (node.type === 'approval')
    return (
      <>
        {typePicker}
        <label>
          {uiText('确认说明')}
          <textarea
            rows={6}
            value={c.instructions ?? ''}
            placeholder={uiText('请检查上游结果，确认后再继续…')}
            onChange={(event) => change({ instructions: event.target.value })}
          />
        </label>
        <small>
          {uiText('执行到这里会等待你的决定；在桌面运行记录批准或拒绝，原对话收到决定后继续。')}
        </small>
      </>
    );
  return null;
}

export function WorkflowPublishSettings({
  document,
  change,
}: {
  document: WorkflowDocument;
  change: (document: WorkflowDocument) => void;
}) {
  useUiLocale();
  const widget = document.widget ?? { enabled: false, fields: [] },
    inputs = document.nodes.filter(
      (node) => node.type === 'input' && (node.config.inputMode ?? 'files') === 'files',
    );
  const candidates: NonNullable<WorkflowDocument['widget']>['fields'] = document.nodes.flatMap<
    NonNullable<WorkflowDocument['widget']>['fields'][number]
  >((node) => {
    if (node.type === 'input')
      return [
        {
          key: compactKey(`input_${node.id}`),
          label: node.label.slice(0, 100),
          nodeId: node.id,
          target: 'value' as const,
          type: ((node.config.inputMode ?? 'files') === 'files' ? 'files' : 'text') as
            | 'files'
            | 'text',
          required: true,
        },
      ];
    const values =
        node.type === 'mcp' ? (node.config.arguments ?? {}) : (node.config.parameters ?? {}),
      schema = node.config.parameterSchema ?? {};
    return [...new Set([...Object.keys(values), ...Object.keys(schema)])].flatMap((path) => {
      const value = values[path],
        spec = schema[path];
      const type =
        spec?.type === 'file' || spec?.type === 'files'
          ? spec.type
          : spec?.type === 'enum'
            ? 'select'
            : spec?.type === 'number' || typeof value === 'number'
              ? 'number'
              : spec?.type === 'boolean' || typeof value === 'boolean'
                ? 'boolean'
                : spec?.type === 'text' || typeof value === 'string'
                  ? 'text'
                  : null;
      return type
        ? [
            {
              key: compactKey(`param_${node.id}_${path}`),
              label: (spec?.label ?? `${node.label} · ${path}`).slice(0, 100),
              nodeId: node.id,
              target: node.type === 'mcp' ? ('arguments' as const) : ('parameters' as const),
              path,
              type,
              required: spec?.required,
              ...(type === 'select' ? { options: spec?.options ?? [] } : {}),
            },
          ]
        : [];
    });
  });
  return (
    <section className="workflow-advanced-section">
      <strong>{uiText('桌面小工具')}</strong>
      <label className="workflow-checkbox">
        <input
          type="checkbox"
          checked={widget.enabled}
          onChange={(event) =>
            change({
              ...document,
              widget: {
                ...widget,
                enabled: event.target.checked,
                fields: widget.fields.length ? widget.fields : candidates.slice(0, 24),
              },
            })
          }
        />
        {uiText('在桌面卡片显示参数与运行按钮')}
      </label>
      {widget.enabled && (
        <>
          <label>
            {uiText('卡片标题')}
            <input
              maxLength={100}
              value={widget.title ?? ''}
              placeholder={document.name}
              onChange={(event) =>
                change({ ...document, widget: { ...widget, title: event.target.value } })
              }
            />
          </label>
          <label>
            {uiText('卡片说明')}
            <textarea
              rows={2}
              maxLength={1000}
              value={widget.description ?? ''}
              onChange={(event) =>
                change({ ...document, widget: { ...widget, description: event.target.value } })
              }
            />
          </label>
          <p>{uiText('只展示勾选的常用参数；完整配置保留在流程中。')}</p>
          {candidates.map((field) => (
            <label className="workflow-checkbox" key={field.key}>
              <input
                type="checkbox"
                checked={widget.fields.some((item) => item.key === field.key)}
                disabled={
                  !widget.fields.some((item) => item.key === field.key) &&
                  widget.fields.length >= 24
                }
                onChange={(event) =>
                  change({
                    ...document,
                    widget: {
                      ...widget,
                      fields: event.target.checked
                        ? [...widget.fields, field]
                        : widget.fields.filter((item) => item.key !== field.key),
                    },
                  })
                }
              />
              {field.label}
            </label>
          ))}
        </>
      )}
      <strong>{uiText('文件批处理')}</strong>
      <label>
        {uiText('逐文件运行的输入')}
        <select
          value={document.batch?.inputNodeId ?? ''}
          onChange={(event) =>
            change({
              ...document,
              batch: event.target.value
                ? { inputNodeId: event.target.value, continueOnError: true }
                : undefined,
            })
          }
        >
          <option value="">{uiText('关闭批处理')}</option>
          {inputs.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label}
            </option>
          ))}
        </select>
      </label>
      {document.batch && (
        <>
          <label className="workflow-checkbox">
            <input
              type="checkbox"
              checked={document.batch.continueOnError ?? true}
              onChange={(event) =>
                change({
                  ...document,
                  batch: { ...document.batch!, continueOnError: event.target.checked },
                })
              }
            />
            {uiText('单个文件失败后继续其他文件')}
          </label>
          <small>
            {uiText(
              '每个文件有独立运行与结果对象，不会互相覆盖。批量启动与失败重试在桌面卡片中操作。',
            )}
          </small>
        </>
      )}
    </section>
  );
}

export function WorkflowSourceManager({
  node,
  workspace,
  action,
  updated,
  change,
  openFile,
  busyChanged,
}: {
  node: WorkflowNode;
  workspace: Workspace;
  action: Action;
  updated: () => Promise<void>;
  change: (config: Partial<WorkflowNode['config']>) => void;
  openFile: (id: string) => void;
  busyChanged?: (busy: boolean) => void;
}) {
  useUiLocale();
  const source = workspace.objects.find((item) => item.id === node.config.codeObjectId),
    [target, setTarget] = useState(''),
    [preview, setPreview] = useState<any>(null),
    [usages, setUsages] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    key = `ai-desktop:workflow-source-operation:${workspace.id}:${node.id}`;
  const [pending, setPending] = useState<Record<string, unknown> | null>(() => {
      try {
        const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
        return raw &&
          typeof raw.requestId === 'string' &&
          ['duplicate_source', 'source_restore'].includes(raw.operation)
          ? raw
          : null;
      } catch {
        return null;
      }
    }),
    pendingRef = useRef(pending),
    working = useRef(false);
  pendingRef.current = pending;
  const mutate = async (request: Record<string, unknown>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    busyChanged?.(true);
    setError('');
    let dispatched = false;
    try {
      const payload = pendingRef.current ?? request;
      writeDraftNow(key, JSON.stringify(payload));
      pendingRef.current = payload;
      setPending(payload);
      dispatched = true;
      const result = await action('workflow_component', payload);
      if (payload.operation === 'duplicate_source') change({ codeObjectId: result.object.id });
      await updated();
      writeDraftNow(key, null);
      pendingRef.current = null;
      setPending(null);
      setPreview(null);
      setUsages(null);
    } catch (cause) {
      if (cause instanceof PanelActionError) {
        writeDraftNow(key, null);
        pendingRef.current = null;
        setPending(null);
      }
      setError(`${errorText(cause)}${dispatched ? uiText('。可继续同一请求收回结果。') : ''}`);
    } finally {
      working.current = false;
      setBusy(false);
      busyChanged?.(false);
    }
  };
  const read = async (operation: 'usages' | 'source_compare') => {
    if (!source || working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await action('workflow_component', {
        operation,
        objectId: source.id,
        ...(operation === 'source_compare' ? { revision: Number(target) } : {}),
      });
      if (operation === 'usages') setUsages(result);
      else setPreview(result);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  if (!source && !pending) return null;
  return (
    <section className="workflow-advanced-section">
      <strong>{uiText('源码与版本')}</strong>
      {source && (
        <small>
          {source.title} · v{source.revision}
        </small>
      )}
      {pending ? (
        <div className="workflow-pending-inline">
          <p>{uiText('有一项源码操作等待收回结果。保留原请求，避免重复复制或回滚。')}</p>
          <button disabled={busy} onClick={() => void mutate(pending)}>
            {uiText('继续原请求')}
          </button>
        </div>
      ) : (
        <>
          <div className="workflow-inline-actions">
            <button
              type="button"
              disabled={busy || !source}
              onClick={() =>
                void mutate({
                  operation: 'duplicate_source',
                  requestId: crypto.randomUUID(),
                  objectId: source!.id,
                  expectedRevision: source!.revision,
                })
              }
            >
              {uiText('独立复制源码')}
            </button>
            <button type="button" disabled={busy} onClick={() => void read('usages')}>
              {uiText('查看引用关系')}
            </button>
          </div>
          <label>
            {uiText('历史源码版本')}
            <input
              type="number"
              min="1"
              max={source?.revision}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setPreview(null);
              }}
              placeholder={uiText('版本号')}
            />
          </label>
          <button
            type="button"
            disabled={
              busy ||
              !Number.isInteger(Number(target)) ||
              Number(target) < 1 ||
              Number(target) > (source?.revision ?? 0)
            }
            onClick={() => void read('source_compare')}
          >
            {uiText('预览恢复内容')}
          </button>
        </>
      )}
      {usages && (
        <div className="workflow-usage-list">
          <strong>
            {usages.usages.length} {uiText('处已保存引用')}
          </strong>
          {usages.usages.map((item: any, index: number) => (
            <button type="button" key={index} onClick={() => openFile(item.objectId)}>
              {item.title} · {item.label}
              <small>{item.relation}</small>
            </button>
          ))}
          {!usages.usages.length && (
            <p>{uiText('未发现已保存的引用。当前未保存草稿不在统计中。')}</p>
          )}
          {(usages.issues.length > 0 || usages.truncated) && (
            <small>{uiText('部分文件未能读取或超出扫描上限，以上为可读取的引用。')}</small>
          )}
        </div>
      )}
      {preview && (
        <div className="workflow-version-preview">
          <strong>
            {uiText('当前 v')}
            {preview.object.revision} {uiText('→ 历史 v')}
            {preview.revision}
          </strong>
          <p>
            {preview.identical
              ? uiText('内容相同，无需恢复。')
              : uiText('恢复会新增版本，保留现有历史；所有共享此源码的流程会使用新版本。')}
          </p>
          <details>
            <summary>{uiText('当前内容')}</summary>
            <pre>{preview.before}</pre>
          </details>
          <details open>
            <summary>{uiText('将恢复的内容')}</summary>
            <pre>{preview.after}</pre>
          </details>
          {preview.truncated && (
            <small>{uiText('显示前 100,000 字符，保存会恢复完整内容。')}</small>
          )}
          <button
            type="button"
            disabled={busy || preview.identical || !!pending}
            onClick={() =>
              void mutate({
                operation: 'source_restore',
                requestId: crypto.randomUUID(),
                objectId: preview.object.id,
                expectedRevision: preview.object.revision,
                revision: preview.revision,
              })
            }
          >
            {uiText('恢复为新版本')}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="workflow-field-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function WorkflowComponentVersion({
  node,
  action,
  apply,
}: {
  node: WorkflowNode;
  action: Action;
  apply: (node: WorkflowNode) => void;
}) {
  useUiLocale();
  const [revision, setRevision] = useState(''),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (!node.origin) return null;
  const read = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await action('workflow_component', {
        operation: 'read',
        objectId: node.origin!.objectId,
        ...(revision ? { revision: Number(revision) } : {}),
      });
      if (result.definition.schemaVersion !== 1)
        throw Error(uiText('此文件已改为组合组件，请从个人库重新添加。当前实例保持不变。'));
      setPreview(result);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="workflow-advanced-section">
      <summary>
        {uiText('组件升级与回退 · 当前 v')}
        {node.origin.revision}
      </summary>
      <label>
        {uiText('目标版本')}
        <input
          type="number"
          min="1"
          value={revision}
          placeholder={uiText('留空读取最新版')}
          onChange={(event) => {
            setRevision(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <button
        type="button"
        disabled={
          busy || (!!revision && (!Number.isInteger(Number(revision)) || Number(revision) < 1))
        }
        onClick={() => void read()}
      >
        {uiText('预览版本变化')}
      </button>
      {preview && (
        <div className="workflow-version-preview">
          <strong>
            {uiText('应用 v')}
            {preview.revision}
          </strong>
          <p>
            {uiText(
              '将替换此实例的配置与端口；位置、现有连线和其他实例保持。应用后可用流程撤销恢复。',
            )}
          </p>
          {['type', 'label', 'config'].map((key) => (
            <details key={key}>
              <summary>
                {key}{' '}
                {JSON.stringify((node as any)[key]) === JSON.stringify(preview.definition.node[key])
                  ? uiText('· 无变化')
                  : uiText('· 已变化')}
              </summary>
              <pre>{JSON.stringify((node as any)[key], null, 2)}</pre>
              <b>↓</b>
              <pre>{JSON.stringify(preview.definition.node[key], null, 2)}</pre>
            </details>
          ))}
          <button
            type="button"
            onClick={() => {
              apply({
                ...structuredClone(preview.definition.node),
                id: node.id,
                position: node.position,
                origin: { objectId: node.origin!.objectId, revision: preview.revision },
              });
              setPreview(null);
            }}
          >
            {uiText('应用到当前实例')}
          </button>
        </div>
      )}
      {error && <p className="workflow-field-error">{error}</p>}
    </details>
  );
}

export function WorkflowBundleDialog({
  document,
  flowObjectId,
  selectedIds,
  entry,
  workspace,
  close,
  save,
  insert,
}: {
  document: WorkflowDocument;
  flowObjectId: string;
  selectedIds: string[];
  entry?: { definition: WorkflowComponentDefinition; objectId: string; revision: number };
  workspace: Workspace;
  close: () => void;
  save: (definition: WorkflowComponentDefinition) => Promise<void>;
  insert: (definition: WorkflowComponentDefinition) => void;
}) {
  useUiLocale();
  const pendingKey = `ai-desktop:workflow-bundle-save:${workspace.id}:${flowObjectId}`;
  const [restored] = useState(() => {
    if (entry) return null;
    try {
      return JSON.parse(localStorage.getItem(pendingKey) ?? 'null')?.definition ?? null;
    } catch {
      return null;
    }
  });
  const [definition, setDefinition] = useState<WorkflowComponentDefinition>(
      () =>
        entry?.definition ??
        restored ??
        bundleSelection(
          document,
          selectedIds,
          uiText('{0} · 组合组件', { '0': document.name.slice(0, 80) }),
        ),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [locked, setLocked] = useState(!!restored);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const all = useMemo(
    () => bundleSelection(document, selectedIds, definition.name),
    [getUiLocale()],
  );
  if (definition.schemaVersion === 1) return null;
  const source = all.schemaVersion === 2 ? all : definition;
  const commit = async () => {
    setBusy(true);
    setError('');
    try {
      await save(definition);
      close();
    } catch (cause) {
      const unknown = !(cause instanceof PanelActionError);
      setLocked(unknown);
      setError(
        `${errorText(cause)}${unknown ? uiText('；请求已保留，请继续保存收回同一份组合组件。') : ''}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="workflow-bundle-backdrop"
      data-desktop-overlay="bundle"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !busy) close();
        if (event.key === 'Tab') {
          const elements = Array.from(
              panel.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)',
              ) ?? [],
            ).filter((item) => item.getClientRects().length),
            first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && window.document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && window.document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={entry ? uiText('配置组合组件') : uiText('保存组合组件')}
        className="workflow-bundle-dialog"
      >
        <header>
          <div>
            <strong>{entry ? uiText('添加组合组件') : uiText('封装选中组件')}</strong>
            <small>
              {definition.document.nodes.length} {uiText('个步骤 ·')}
              {definition.document.edges.length} {uiText('条内部连接')}
            </small>
          </div>
          <button type="button" disabled={busy} aria-label={uiText('关闭组合组件')} onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        <div className="workflow-bundle-body">
          {locked && <p>{uiText('正在恢复上次保存请求，以下是该请求的固定配置。')}</p>}
          <label>
            {uiText('组件名称')}
            <input
              value={definition.name}
              maxLength={100}
              disabled={!!entry || busy || locked}
              onChange={(event) => setDefinition({ ...definition, name: event.target.value })}
            />
          </label>
          {entry ? (
            <>
              {definition.parameters.map((parameter) => {
                const node = definition.document.nodes.find((node) => node.id === parameter.nodeId);
                if (!node) return null;
                const fileInput =
                    parameter.target === 'value' &&
                    node.type === 'input' &&
                    (node.config.inputMode ?? 'files') === 'files',
                  value = fileInput
                    ? node.config.objectIds
                    : parameter.target === 'value'
                      ? node.config.value
                      : node.config[parameter.target]?.[parameter.path ?? ''];
                return (
                  <section key={`${parameter.nodeId}:${parameter.target}:${parameter.path}`}>
                    <WorkflowParameterForm
                      value={{ value }}
                      schema={{
                        value: {
                          ...(node.config.parameterSchema?.[parameter.path ?? ''] ?? {
                            type: fileInput
                              ? 'files'
                              : typeof value === 'number'
                                ? 'number'
                                : typeof value === 'boolean'
                                  ? 'boolean'
                                  : typeof value === 'object'
                                    ? 'json'
                                    : 'text',
                          }),
                          label: parameter.name,
                        },
                      }}
                      workspace={workspace}
                      change={(next) =>
                        setDefinition({
                          ...definition,
                          document: {
                            ...definition.document,
                            nodes: definition.document.nodes.map((item) =>
                              item.id !== node.id
                                ? item
                                : {
                                    ...item,
                                    config: fileInput
                                      ? { ...item.config, objectIds: next.value as string[] }
                                      : parameter.target === 'value'
                                        ? { ...item.config, value: next.value }
                                        : {
                                            ...item.config,
                                            [parameter.target]: {
                                              ...item.config[parameter.target],
                                              [parameter.path ?? '']: next.value,
                                            },
                                          },
                                  },
                            ),
                          },
                        })
                      }
                    />
                  </section>
                );
              })}
              <p>
                {uiText(
                  '插入后展开为普通组件，可继续修改每一步。源码和桌面文件引用会保留；Python 可单独复制源码。',
                )}
              </p>
            </>
          ) : (
            <>
              {(['inputs', 'outputs', 'parameters'] as const).map((kind) => (
                <section key={kind}>
                  <strong>
                    {
                      {
                        inputs: uiText('暴露输入端口'),
                        outputs: uiText('暴露输出端口'),
                        parameters: uiText('暴露常用参数'),
                      }[kind]
                    }
                  </strong>
                  {source[kind].map((field, index) => {
                    const identity = JSON.stringify(field),
                      checked = definition[kind].some((item) => JSON.stringify(item) === identity);
                    return (
                      <label className="workflow-checkbox" key={index}>
                        <input
                          type="checkbox"
                          disabled={busy || locked}
                          checked={checked}
                          onChange={(event) =>
                            setDefinition({
                              ...definition,
                              [kind]: event.target.checked
                                ? [...definition[kind], field]
                                : definition[kind].filter(
                                    (item) => JSON.stringify(item) !== identity,
                                  ),
                            } as typeof definition)
                          }
                        />
                        {field.name}
                      </label>
                    );
                  })}
                  {!source[kind].length && <small>{uiText('没有可暴露的项目。')}</small>}
                </section>
              ))}
            </>
          )}
          {definition.inputs.length > 0 && (
            <p>
              {uiText('输入：')}
              {definition.inputs.map((item) => item.name).join('、')}
            </p>
          )}
          {definition.outputs.length > 0 && (
            <p>
              {uiText('输出：')}
              {definition.outputs.map((item) => item.name).join('、')}
            </p>
          )}
          {error && (
            <p className="workflow-field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            {uiText('取消')}
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy || !definition.name.trim()}
            onClick={() => (entry ? insert(definition) : void commit())}
          >
            {busy ? uiText('保存中…') : entry ? uiText('加入当前流程') : uiText('保存到个人组件库')}
          </button>
        </footer>
      </section>
    </div>
  );
}
