import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import {
  workflowPorts,
  type WorkflowNode,
  type WorkflowDocument,
} from '../../../packages/contracts/workflows.js';
export function WorkflowNestedFields({
  node,
  workspace,
  config,
  action,
}: {
  node: WorkflowNode;
  workspace: Workspace;
  config: (patch: Partial<WorkflowNode['config']>) => void;
  action: (name: string, payload: any) => Promise<any>;
}) {
  useUiLocale();
  const [child, setChild] = useState<WorkflowDocument | null>(null),
    [error, setError] = useState('');
  const actions = useRef(action);
  actions.current = action;
  const childRevision = workspace.objects.find(
    (object) => object.id === node.config.flowObjectId,
  )?.revision;
  useEffect(() => {
    let cancelled = false;
    setChild(null);
    setError('');
    if (node.config.flowObjectId)
      void actions
        .current('workflow', { operation: 'read', objectId: node.config.flowObjectId })
        .then((value) => {
          if (!cancelled) setChild(value.document);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, node.config.flowObjectId, childRevision]);
  if (node.type !== 'subflow' && node.type !== 'repeat') return null;
  const result = child?.nodes.find((item) => item.id === node.config.childResultNodeId);
  return (
    <>
      <label>
        {uiText('子流程文件')}
        <select
          value={node.config.flowObjectId ?? ''}
          onChange={(e) =>
            config({
              flowObjectId: e.target.value || undefined,
              childInputNodeId: undefined,
              childResultNodeId: undefined,
            })
          }
        >
          <option value="">{uiText('选择 .flow.json…')}</option>
          {workspace.objects
            .filter(
              (item) =>
                item.kind === 'file' &&
                /\.flow\.json$/i.test((item.content as { fileName: string }).fileName),
            )
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
        </select>
      </label>
      {error && <small>{error}</small>}
      {child && (
        <>
          <label>
            {uiText('接收上游的 JSON 输入')}
            <select
              value={node.config.childInputNodeId ?? ''}
              onChange={(e) => config({ childInputNodeId: e.target.value || undefined })}
            >
              <option value="">{uiText('选择输入节点…')}</option>
              {child.nodes
                .filter((item) => item.type === 'input' && item.config.inputMode === 'json')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {uiText('返回结果的节点')}
            <select
              value={node.config.childResultNodeId ?? ''}
              onChange={(e) =>
                config({
                  childResultNodeId: e.target.value || undefined,
                  childResultPort: e.target.value
                    ? workflowPorts(child.nodes.find((item) => item.id === e.target.value)!)
                        .outputs[0]?.name
                    : undefined,
                })
              }
            >
              <option value="">{uiText('选择结果节点…')}</option>
              {child.nodes
                .filter((item) => workflowPorts(item).outputs.length)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          </label>
          {result && (
            <label>
              {uiText('结果端口')}
              <select
                value={node.config.childResultPort ?? 'result'}
                onChange={(e) => config({ childResultPort: e.target.value })}
              >
                {workflowPorts(result).outputs.map((port) => (
                  <option key={port.name}>{port.name}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {node.type === 'repeat' && (
        <>
          <label>
            {uiText('最多执行次数')}
            <input
              type="number"
              min={1}
              max={20}
              value={node.config.maxIterations ?? 3}
              onChange={(e) =>
                config({ maxIterations: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })
              }
            />
          </label>
          <label>
            {uiText('停止字段（可选）')}
            <input
              placeholder={uiText('例如 done，结果中为真时停止')}
              value={node.config.stopWhenPath ?? ''}
              onChange={(e) => config({ stopWhenPath: e.target.value || undefined })}
            />
          </label>
          <small>
            {uiText('下一次使用上次结果作为输入。结果不再变化时停止；每次保留独立运行记录。')}
          </small>
        </>
      )}
    </>
  );
}
