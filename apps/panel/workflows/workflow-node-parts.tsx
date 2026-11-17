import { subscribeUiLanguage as onUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { memo, useEffect } from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { workflowPorts, type WorkflowNode } from '../../../packages/contracts/workflows.js';
import { Icon, type IconName } from '../ui/icons.js';
import type { WorkflowPreset } from './workflow-catalog.js';

export type NodeKind = WorkflowNode['type'];

export let components: {
  type: NodeKind;
  name: string;
  tag: string;
  description: string;
  icon: IconName;
}[] = [
  {
    type: 'input',
    name: uiText('输入'),
    tag: 'INPUT',
    description: uiText('桌面文件、文本与 JSON'),
    icon: 'folder',
  },
  {
    type: 'skill',
    name: 'Skill',
    tag: 'SKILL',
    description: uiText('加入可复用的方法与指令'),
    icon: 'layers',
  },
  {
    type: 'mcp',
    name: uiText('MCP 工具'),
    tag: 'TOOL',
    description: uiText('配置工具与结构化参数'),
    icon: 'settings',
  },
  {
    type: 'prompt',
    name: uiText('处理指令'),
    tag: 'PROMPT',
    description: uiText('描述这一步要完成的工作'),
    icon: 'text',
  },
  {
    type: 'python',
    name: 'Python',
    tag: 'PYTHON',
    description: uiText('用原生脚本编写处理逻辑'),
    icon: 'code',
  },
  {
    type: 'browser',
    name: uiText('浏览器'),
    tag: 'BROWSER',
    description: uiText('共享会话、操作与采集页面'),
    icon: 'desktop',
  },
  {
    type: 'extract',
    name: uiText('原生文件提取'),
    tag: 'EXTRACT',
    description: uiText('按工作表、段落与页码读取'),
    icon: 'document',
  },
  {
    type: 'chart',
    name: uiText('图表与指标'),
    tag: 'CHART',
    description: uiText('把表格转换为图表或指标'),
    icon: 'sheet',
  },
  {
    type: 'condition',
    name: uiText('条件分支'),
    tag: 'IF',
    description: uiText('按字段值选择后续处理路径'),
    icon: 'diagram',
  },
  {
    type: 'approval',
    name: uiText('人工确认'),
    tag: 'APPROVAL',
    description: uiText('等待桌面批准后再继续'),
    icon: 'check',
  },
  {
    type: 'subflow',
    name: uiText('子流程'),
    tag: 'FLOW',
    description: uiText('执行有独立记录的嵌套流程'),
    icon: 'layers',
  },
  {
    type: 'repeat',
    name: uiText('有界循环'),
    tag: 'REPEAT',
    description: uiText('按次数、停止条件或无进展结束'),
    icon: 'history',
  },
  {
    type: 'output',
    name: uiText('结果回写'),
    tag: 'OUTPUT',
    description: uiText('更新原文件或生成新产物'),
    icon: 'save',
  },
];

export let stateLabels: Record<string, string> = {
  prepared: uiText('已准备'),
  pending: uiText('待处理'),
  running: uiText('执行中'),
  waiting: uiText('等待原对话'),
  succeeded: uiText('已完成'),
  failed: uiText('失败'),
  skipped: uiText('已跳过'),
};

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const argumentError = (value: string, objectOnly = true) => {
  try {
    const parsed = JSON.parse(value);
    return objectOnly && (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object')
      ? uiText('参数必须是 JSON 对象，例如 {}。')
      : '';
  } catch {
    return uiText('JSON 尚未完整，请检查引号、逗号和括号。');
  }
};

export const nodeSummary = (node: WorkflowNode) =>
  node.type === 'input'
    ? node.config.inputMode === 'text'
      ? String(node.config.value ?? uiText('填写输入文本'))
      : node.config.inputMode === 'json'
        ? uiText('结构化 JSON 输入')
        : uiText('{0} 份材料', { '0': node.config.objectIds?.length ?? 0 })
    : node.type === 'python'
      ? node.config.codeObjectId
        ? `${node.config.entryFunction ?? 'run'}(inputs, context)`
        : uiText('选择或新建 Python 源码')
      : node.type === 'browser'
        ? {
            open: uiText('打开页面'),
            read: uiText('读取页面'),
            interact: uiText('操作页面'),
            screenshot: uiText('截取页面'),
            download: uiText('下载文件'),
          }[node.config.browserAction ?? 'open'] + (node.config.url ? ` · ${node.config.url}` : '')
        : node.type === 'mcp'
          ? node.config.toolName || uiText('选择或填写工具')
          : node.type === 'skill'
            ? node.config.skillPath?.split(/[\\/]/).slice(-2).join('/') ||
              node.config.instructions ||
              uiText('选择 Skill 或编写指令')
            : node.type === 'output'
              ? node.config.outputName ||
                (node.config.targetObjectId ? uiText('回写原文件') : uiText('配置输出位置'))
              : node.config.instructions || uiText('编写处理指令');

export type FlowNode = Node<{ node: WorkflowNode; state?: string; summary?: string }, 'workflow'>;

const WorkflowCard = memo(function WorkflowCard({ id, data, selected }: NodeProps<FlowNode>) {
  useUiLocale();
  const spec = components.find((item) => item.type === data.node.type)!,
    ports = workflowPorts(data.node),
    internals = useUpdateNodeInternals();
  const signature = JSON.stringify(ports);
  useEffect(() => {
    internals(id);
  }, [id, signature, internals]);
  return (
    <div className={`workflow-node type-${data.node.type}${selected ? ' is-selected' : ''}`}>
      <div className="workflow-node-top">
        <span className="workflow-node-icon">
          <Icon name={spec.icon} size={18} />
        </span>
        <span>{spec.tag}</span>
        {data.state && (
          <span className={`workflow-node-state state-${data.state}`}>
            {stateLabels[data.state] ?? data.state}
          </span>
        )}
      </div>
      <strong>{data.node.label}</strong>
      <p title={data.summary || nodeSummary(data.node)}>{data.summary || nodeSummary(data.node)}</p>
      <div className="workflow-node-port-list">
        {Array.from({ length: Math.max(ports.inputs.length, ports.outputs.length) }).map(
          (_, index) => (
            <div className="workflow-node-port-line" key={index}>
              {ports.inputs[index] ? (
                <span
                  className="workflow-port-label input-port"
                  title={`${ports.inputs[index].name} · ${ports.inputs[index].type}${ports.inputs[index].required ? uiText(' · 必填') : ''}`}
                >
                  <Handle id={ports.inputs[index].name} type="target" position={Position.Left} />
                  <code>
                    {ports.inputs[index].name}
                    {ports.inputs[index].required ? ' *' : ''}
                  </code>
                  <small>{ports.inputs[index].type}</small>
                </span>
              ) : (
                <span />
              )}
              {ports.outputs[index] ? (
                <span
                  className="workflow-port-label output-port"
                  title={`${ports.outputs[index].name} · ${ports.outputs[index].type}`}
                >
                  <small>{ports.outputs[index].type}</small>
                  <code>{ports.outputs[index].name}</code>
                  <Handle id={ports.outputs[index].name} type="source" position={Position.Right} />
                </span>
              ) : (
                <span />
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
});

export const nodeTypes = { workflow: WorkflowCard };

export const presetPorts = (preset: WorkflowPreset) =>
  workflowPorts({ ...preset.node, id: preset.id, position: { x: 0, y: 0 } });

export const matchesSearch = (query: string, ...parts: (string | undefined)[]) =>
  parts.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

// Refresh built-in labels without replacing document or editor state.
onUiLocale(() => {
  components = [
    {
      type: 'input',
      name: uiText('输入'),
      tag: 'INPUT',
      description: uiText('桌面文件、文本与 JSON'),
      icon: 'folder',
    },
    {
      type: 'skill',
      name: 'Skill',
      tag: 'SKILL',
      description: uiText('加入可复用的方法与指令'),
      icon: 'layers',
    },
    {
      type: 'mcp',
      name: uiText('MCP 工具'),
      tag: 'TOOL',
      description: uiText('配置工具与结构化参数'),
      icon: 'settings',
    },
    {
      type: 'prompt',
      name: uiText('处理指令'),
      tag: 'PROMPT',
      description: uiText('描述这一步要完成的工作'),
      icon: 'text',
    },
    {
      type: 'python',
      name: 'Python',
      tag: 'PYTHON',
      description: uiText('用原生脚本编写处理逻辑'),
      icon: 'code',
    },
    {
      type: 'browser',
      name: uiText('浏览器'),
      tag: 'BROWSER',
      description: uiText('共享会话、操作与采集页面'),
      icon: 'desktop',
    },
    {
      type: 'extract',
      name: uiText('原生文件提取'),
      tag: 'EXTRACT',
      description: uiText('按工作表、段落与页码读取'),
      icon: 'document',
    },
    {
      type: 'chart',
      name: uiText('图表与指标'),
      tag: 'CHART',
      description: uiText('把表格转换为图表或指标'),
      icon: 'sheet',
    },
    {
      type: 'condition',
      name: uiText('条件分支'),
      tag: 'IF',
      description: uiText('按字段值选择后续处理路径'),
      icon: 'diagram',
    },
    {
      type: 'approval',
      name: uiText('人工确认'),
      tag: 'APPROVAL',
      description: uiText('等待桌面批准后再继续'),
      icon: 'check',
    },
    {
      type: 'subflow',
      name: uiText('子流程'),
      tag: 'FLOW',
      description: uiText('执行有独立记录的嵌套流程'),
      icon: 'layers',
    },
    {
      type: 'repeat',
      name: uiText('有界循环'),
      tag: 'REPEAT',
      description: uiText('按次数、停止条件或无进展结束'),
      icon: 'history',
    },
    {
      type: 'output',
      name: uiText('结果回写'),
      tag: 'OUTPUT',
      description: uiText('更新原文件或生成新产物'),
      icon: 'save',
    },
  ];
  stateLabels = {
    prepared: uiText('已准备'),
    pending: uiText('待处理'),
    running: uiText('执行中'),
    waiting: uiText('等待原对话'),
    succeeded: uiText('已完成'),
    failed: uiText('失败'),
    skipped: uiText('已跳过'),
  };
});
