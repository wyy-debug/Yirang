// Input/output resolution for workflow nodes: port binding, argument and
// field mapping, parameter validation and output checks.
import { fail } from '../../contracts/index.js';
import {
  WorkflowOutputsSchema,
  WORKFLOW_VALUE_LIMIT,
  workflowField,
  workflowPorts,
  workflowPortCompatible,
  type WorkflowRun,
  type WorkflowNode,
  type WorkflowValue,
  type WorkflowFileValue,
} from '../../contracts/workflows.js';
import { sha, type WorkflowRecordsMethods } from './workflow-records.js';
import type { WorkflowGraphMethods } from './workflow-graph.js';
import type { WorkflowMaterialsMethods } from './workflow-materials.js';
import type { Api } from './workflows.js';

/** The Workflows surface the resolution cluster relies on. */
export type WorkflowResolveHost = Pick<WorkflowRecordsMethods, never> &
  Pick<WorkflowGraphMethods, 'inactive' | 'dependency' | 'inputOutputs'> &
  Pick<WorkflowMaterialsMethods, 'file' | 'fileValues'> & { api?: Pick<Api, never> };

/** One resolved file reference with its materialized bytes summary. */
export type WorkflowResolvedFile = WorkflowFileValue & {
  fileName: string;
  sha256: string;
  size: number;
  path?: string;
  readHint: string;
};

/** Everything a node needs before it can execute. */
export type WorkflowResolved = {
  node: WorkflowNode;
  inputs: Record<string, WorkflowValue>;
  values: Record<string, unknown>;
  mcpArguments: Record<string, unknown>;
  parameters: Record<string, unknown>;
  fileReferences: WorkflowFileValue[];
  files: WorkflowResolvedFile[];
  outputPorts: ReturnType<typeof workflowPorts>['outputs'];
  inputOutputs?: Record<string, WorkflowValue>;
  writeback?: { targetObjectId?: string; instruction: string };
  browser?: {
    action: string;
    provider?: unknown;
    url?: unknown;
    session?: unknown;
    instructions?: unknown;
    note: string;
  };
};

export interface WorkflowResolveMethods {
  resolved(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
  ): WorkflowResolved;
  validateOutputs(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
    outputs: Record<string, WorkflowValue>,
  ): Record<string, WorkflowValue>;
}

export const workflowResolve: WorkflowResolveMethods &
  ThisType<WorkflowResolveHost & WorkflowResolveMethods> = {
  resolved(w: string, c: string, s: string | null, run: WorkflowRun, node: WorkflowNode) {
    this.dependency(run, node);
    const inputs: Record<string, WorkflowValue> = {};
    for (const edge of run.document.edges.filter((edge) => edge.target === node.id)) {
      if (this.inactive(run, edge)) continue;
      const value = run.nodes[edge.source]?.outputs?.[edge.sourcePort],
        port = workflowPorts(node).inputs.find((p) => p.name === edge.targetPort);
      if (!value || !port || !workflowPortCompatible(value.type, port.type))
        fail('WORKFLOW_OUTPUT', '上游没有提供匹配的命名输出，请保留旧运行并重新准备正确流程。');
      inputs[edge.targetPort] = value;
    }
    for (const port of workflowPorts(node).inputs)
      if (port.required && !inputs[port.name])
        fail('WORKFLOW_INPUT', `缺少输入端口 ${port.name}。`);
    const mcpArguments = { ...node.config.arguments };
    for (const [argument, port] of Object.entries(node.config.argumentBindings ?? {})) {
      if (!inputs[port]) fail('WORKFLOW_INPUT', `参数 ${argument} 绑定的输入 ${port} 尚未提供。`);
      Object.defineProperty(mcpArguments, argument, {
        value: inputs[port].value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    const parameters = { ...node.config.parameters };
    for (const [parameter, binding] of Object.entries(node.config.fieldBindings ?? {})) {
      if (!inputs[binding.port])
        fail('WORKFLOW_INPUT', `字段 ${parameter} 的来源端口 ${binding.port} 尚未提供。`);
      const value = workflowField(inputs[binding.port].value, binding.path);
      if (value === undefined)
        fail('WORKFLOW_INPUT', `字段 ${parameter} 的路径 ${binding.path ?? ''} 不存在。`);
      Object.defineProperty(mcpArguments, parameter, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(parameters, parameter, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    for (const [key, definition] of Object.entries(node.config.parameterSchema ?? {})) {
      const value = node.type === 'mcp' ? mcpArguments[key] : parameters[key];
      if (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && !value.length)
      ) {
        if (definition.required) fail('WORKFLOW_PARAMETER', `请填写 ${definition.label ?? key}。`);
        continue;
      }
      if (
        (definition.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) ||
        (definition.type === 'boolean' && typeof value !== 'boolean') ||
        (definition.type === 'enum' && !definition.options?.includes(String(value)))
      )
        fail('WORKFLOW_PARAMETER', `参数 ${definition.label ?? key} 的值与类型不匹配。`);
    }
    const parameterFiles: WorkflowFileValue[] = [];
    for (const [key, spec] of Object.entries(node.config.parameterSchema ?? {})) {
      if (spec.type !== 'file' && spec.type !== 'files') continue;
      const value = (node.type === 'mcp' ? mcpArguments : parameters)[key];
      if (value === undefined || value === null || value === '') continue;
      const list =
        spec.type === 'files'
          ? Array.isArray(value)
            ? value
            : fail('WORKFLOW_PARAMETER', `参数 ${key} 需要文件列表。`)
          : [value];
      for (const item of list) {
        if (typeof item === 'string') {
          if (!run.frozenFiles?.[item])
            fail('WORKFLOW_PARAMETER', `参数 ${key} 引用的原生文件不在本次授权范围。`);
          parameterFiles.push({ objectId: item, revision: run.expectedRevisions[item] });
        } else {
          const references = this.fileValues(item);
          if (references.length !== 1)
            fail('WORKFLOW_PARAMETER', `参数 ${key} 需要真实的文件引用。`);
          parameterFiles.push(references[0]);
        }
      }
    }
    const fileReferences = [
      ...this.fileValues(inputs),
      ...this.fileValues(node.type === 'mcp' ? mcpArguments : parameters),
      ...parameterFiles,
    ];
    const files = fileReferences.map((ref) => {
      const file = this.file(w, c, s, run, ref);
      return {
        ...ref,
        fileName: file.fileName,
        sha256: sha(file.data),
        size: file.data.length,
        ...(file.path ? { path: file.path } : {}),
        readHint:
          'objectId' in ref
            ? '使用原生材料读取工具读取指定版本；回写使用 desktop_prepare_file 与 desktop_file_result。'
            : '只读取已登记的本次运行产物路径。',
      };
    });
    if (node.type === 'browser' && (node.config.browserAction ?? 'open') === 'open') {
      const url = inputs.url?.value ?? node.config.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
        fail('WORKFLOW_BROWSER_URL', '打开网页需要真实的 http 或 https 地址。');
    }
    return {
      node,
      inputs,
      values: Object.fromEntries(
        Object.entries(inputs).map(([name, value]) => [name, value.value]),
      ),
      mcpArguments,
      parameters,
      fileReferences,
      files,
      outputPorts: workflowPorts(node).outputs,
      ...(node.type === 'input' ? { inputOutputs: this.inputOutputs(run, node) } : {}),
      ...(node.type === 'output'
        ? {
            writeback: {
              targetObjectId: node.config.targetObjectId,
              instruction:
                '用本次凭据准备原文件工作副本，将输入内容或产物写入 workingPath，再提交原文件；取得新 revision 后回报输出组件成功。',
            },
          }
        : {}),
      ...(node.type === 'browser'
        ? {
            browser: {
              action: node.config.browserAction ?? 'open',
              provider: node.config.provider,
              url: inputs.url?.value ?? node.config.url,
              session: inputs.session?.value,
              instructions: node.config.instructions,
              note: '在原对话使用实际可用浏览器工具；会话引用不是 Cookie，也不能让 Python 直接接管宿主标签页。已有会话失联时回报 waiting，不自动新开页面冒充恢复。',
            },
          }
        : {}),
    };
  },
  validateOutputs(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
    outputs: Record<string, WorkflowValue>,
  ) {
    const result = WorkflowOutputsSchema.parse(outputs),
      ports = workflowPorts(node).outputs;
    if (Buffer.byteLength(JSON.stringify(result)) > WORKFLOW_VALUE_LIMIT)
      fail('WORKFLOW_LIMIT', '单个组件的结构化输出最多 256 KiB，大结果请保存为原生文件。');
    for (const [name, value] of Object.entries(result)) {
      const port = ports.find((p) => p.name === name);
      if (!port || !workflowPortCompatible(value.type, port.type))
        fail('WORKFLOW_OUTPUT', `输出 ${name} 不匹配声明的端口。`);
      for (const file of this.fileValues(value)) this.file(w, c, s, run, file);
    }
    for (const port of ports)
      if (port.required && !result[port.name])
        fail('WORKFLOW_OUTPUT', `缺少输出端口 ${port.name}。`);
    return result;
  }
};
