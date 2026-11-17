import { z } from 'zod';

const Key = z.string().trim().min(1).max(150),
  Revision = z.number().int().positive();
const PortName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
  .refine((name) => !['__proto__', 'prototype', 'constructor'].includes(name));
export const WORKFLOW_BYTE_LIMIT = 1024 * 1024;
export const WORKFLOW_VALUE_LIMIT = 256 * 1024;
export const WorkflowPortTypeSchema = z.enum([
  'text',
  'json',
  'table',
  'file',
  'files',
  'browser-session',
]);
export const WorkflowPortSchema = z
  .object({ name: PortName, type: WorkflowPortTypeSchema, required: z.boolean().optional() })
  .strict();
export type WorkflowPort = z.infer<typeof WorkflowPortSchema>;
export type WorkflowPortType = z.infer<typeof WorkflowPortTypeSchema>;
const ports = z
  .array(WorkflowPortSchema)
  .max(24)
  .refine(
    (values) => new Set(values.map((p) => p.name)).size === values.length,
    '端口名称不能重复。',
  );
export const WorkflowNodeSchema = z
  .object({
    id: Key,
    type: z.enum([
      'input',
      'skill',
      'mcp',
      'prompt',
      'output',
      'python',
      'browser',
      'condition',
      'approval',
      'extract',
      'chart',
      'subflow',
      'repeat',
    ]),
    label: z.string().trim().min(1).max(120),
    position: z
      .object({
        x: z.number().finite().min(-100000).max(100000),
        y: z.number().finite().min(-100000).max(100000),
      })
      .strict(),
    origin: z.object({ objectId: Key, revision: Revision }).strict().optional(),
    config: z
      .object({
        objectIds: z.array(Key).max(10).optional(),
        instructions: z.string().max(24000).optional(),
        skillPath: z.string().max(2048).optional(),
        server: z.string().max(200).optional(),
        toolName: z.string().max(200).optional(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        argumentBindings: z.record(PortName, PortName).optional(),
        fieldBindings: z
          .record(
            PortName,
            z.object({ port: PortName, path: z.string().max(500).optional() }).strict(),
          )
          .optional(),
        targetObjectId: Key.optional(),
        outputName: z.string().max(120).optional(),
        parameterSchema: z
          .record(
            PortName,
            z
              .object({
                label: z.string().max(100).optional(),
                type: z.enum([
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
                ]),
                required: z.boolean().optional(),
                options: z.array(z.string().max(300)).max(200).optional(),
                description: z.string().max(1000).optional(),
              })
              .strict(),
          )
          .optional(),
        condition: z
          .object({
            inputPort: PortName,
            path: z.string().max(500).optional(),
            operator: z.enum([
              'equals',
              'not_equals',
              'contains',
              'gt',
              'gte',
              'lt',
              'lte',
              'exists',
              'truthy',
            ]),
            value: z.unknown().optional(),
          })
          .strict()
          .optional(),
        passThroughType: WorkflowPortTypeSchema.optional(),
        flowObjectId: Key.optional(),
        childInputNodeId: Key.optional(),
        childResultNodeId: Key.optional(),
        childResultPort: PortName.optional(),
        maxIterations: z.number().int().min(1).max(20).optional(),
        stopWhenPath: z.string().max(500).optional(),
        pythonEnvironmentId: z.string().uuid().optional(),
        inputMode: z.enum(['files', 'text', 'json']).optional(),
        value: z.unknown().optional(),
        inputPorts: ports.optional(),
        outputPorts: ports.optional(),
        codeObjectId: Key.optional(),
        requirementsObjectId: Key.optional(),
        entryFunction: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
          .optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        browserAction: z.enum(['open', 'read', 'interact', 'screenshot', 'download']).optional(),
        url: z.string().max(4096).optional(),
        provider: z.string().max(100).optional(),
      })
      .strict(),
  })
  .strict();
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export function workflowParameterFileIds(node: WorkflowNode) {
  const values = node.type === 'mcp' ? node.config.arguments : node.config.parameters,
    ids: string[] = [];
  for (const [name, spec] of Object.entries(node.config.parameterSchema ?? {})) {
    if (
      node.config.fieldBindings?.[name] ||
      (node.type === 'mcp' && node.config.argumentBindings?.[name])
    )
      continue;
    const value = values?.[name];
    if (spec.type === 'file' && typeof value === 'string' && value) ids.push(value);
    if (spec.type === 'files' && Array.isArray(value))
      for (const id of value) if (typeof id === 'string' && id) ids.push(id);
  }
  return [...new Set(ids)];
}
export function workflowPorts(node: WorkflowNode): {
  inputs: WorkflowPort[];
  outputs: WorkflowPort[];
} {
  const c = node.config,
    port = (name: string, type: WorkflowPortType, required = false): WorkflowPort => ({
      name,
      type,
      required,
    });
  let inputs: WorkflowPort[] = [port('input', 'json', true)],
    outputs: WorkflowPort[] = [port('result', 'json', true)];
  if (node.type === 'input') {
    inputs = [];
    outputs =
      c.inputMode === 'text'
        ? [port('text', 'text', true)]
        : c.inputMode === 'json'
          ? [port('data', 'json', true)]
          : [port('files', 'files', true)];
  } else if (node.type === 'output') outputs = [];
  else if (node.type === 'condition') {
    inputs = [port('input', c.passThroughType ?? 'json', true)];
    outputs = [
      port('true', c.passThroughType ?? 'json'),
      port('false', c.passThroughType ?? 'json'),
    ];
  } else if (node.type === 'approval') {
    inputs = [port('input', c.passThroughType ?? 'json', true)];
    outputs = [port('result', c.passThroughType ?? 'json', true)];
  } else if (node.type === 'subflow' || node.type === 'repeat') {
    inputs = [port('input', 'json', true)];
    outputs = [port('result', 'json', true)];
  } else if (node.type === 'extract') {
    inputs = [port('files', 'files', true)];
    outputs = [
      port('text', 'text', true),
      port('table', 'table', true),
      port('metadata', 'json', true),
    ];
  } else if (node.type === 'chart') {
    inputs = [port('table', 'table', true)];
    outputs = [port('svg', 'text', true), port('summary', 'json', true)];
  } else if (node.type === 'browser') {
    const operation = c.browserAction ?? 'open';
    inputs =
      operation === 'open'
        ? [port('url', 'text', !c.url?.trim())]
        : [port('session', 'browser-session', true)];
    outputs = [
      port('session', 'browser-session', true),
      ...(operation === 'open'
        ? []
        : operation === 'read' || operation === 'interact'
          ? [port('content', 'text', true)]
          : [port('files', 'files', true)]),
    ];
  }
  return { inputs: c.inputPorts ?? inputs, outputs: c.outputPorts ?? outputs };
}
/** JSON ports accept serialized payloads; no implicit text/file coercion. */
export function workflowPortCompatible(source: WorkflowPortType, target: WorkflowPortType) {
  return source === target || target === 'json';
}
const EdgeSchema = z
  .object({ id: Key, source: Key, target: Key, sourcePort: PortName, targetPort: PortName })
  .strict();
const documentFields = {
  kind: z.literal('ai-desktop-flow'),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(6000),
  nodes: z.array(WorkflowNodeSchema).max(80),
  batch: z
    .object({ inputNodeId: Key, continueOnError: z.boolean().optional() })
    .strict()
    .optional(),
  widget: z
    .object({
      enabled: z.boolean(),
      title: z.string().max(100).optional(),
      description: z.string().max(1000).optional(),
      fields: z
        .array(
          z
            .object({
              key: PortName,
              label: z.string().max(100),
              nodeId: Key,
              target: z.enum(['value', 'parameters', 'arguments']),
              path: z.string().max(500).optional(),
              type: z.enum(['text', 'number', 'boolean', 'file', 'files', 'select']),
              required: z.boolean().optional(),
              options: z.array(z.string().max(300)).max(200).optional(),
            })
            .strict(),
        )
        .max(32),
    })
    .strict()
    .optional(),
};
const WorkflowV2Schema = z
  .object({ schemaVersion: z.literal(2), ...documentFields, edges: z.array(EdgeSchema).max(160) })
  .strict();
export const WorkflowV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ...documentFields,
    edges: z.array(z.object({ id: Key, source: Key, target: Key }).strict()).max(160),
  })
  .strict();
export type WorkflowDocument = z.infer<typeof WorkflowV2Schema>;
/** Upgrade in memory; only an explicit save changes the original file. */
export const WorkflowDocumentSchema = z
  .union([WorkflowV2Schema, WorkflowV1Schema])
  .transform((document): WorkflowDocument => {
    if (document.schemaVersion === 2) return document;
    const nodes = document.nodes.map((node) => {
      const incoming = document.edges.filter((edge) => edge.target === node.id);
      return incoming.length > 1
        ? {
            ...node,
            config: {
              ...node.config,
              inputPorts: incoming.map((_, index) => ({
                name: `input_${index + 1}`,
                type: 'json' as const,
                required: true,
              })),
            },
          }
        : node;
    });
    return {
      ...document,
      schemaVersion: 2,
      nodes,
      edges: document.edges.map((edge) => {
        const source = nodes.find((node) => node.id === edge.source),
          target = nodes.find((node) => node.id === edge.target),
          index = document.edges
            .filter((item) => item.target === edge.target)
            .findIndex((item) => item.id === edge.id);
        return {
          ...edge,
          sourcePort: source ? (workflowPorts(source).outputs[0]?.name ?? 'result') : 'result',
          targetPort: target ? (workflowPorts(target).inputs[index]?.name ?? 'input') : 'input',
        };
      }),
    };
  });
export const WorkflowFileValueSchema = z.union([
  z
    .object({
      objectId: Key,
      revision: Revision,
      fileName: z.string().max(255).optional(),
      assetHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      artifactId: Key,
      fileName: z.string().max(255),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size: z.number().int().nonnegative(),
    })
    .strict(),
]);
export const WorkflowBrowserSessionSchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    sessionId: z.string().min(1).max(300).optional(),
    tabId: z.string().min(1).max(300).optional(),
    url: z.string().max(4096).optional(),
    title: z.string().max(500).optional(),
  })
  .strict()
  .refine((value) => !!value.sessionId || !!value.tabId, '需要实际浏览器会话或标签页标识。');
export const WorkflowValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string().max(WORKFLOW_VALUE_LIMIT) }).strict(),
  z
    .object({
      type: z.literal('json'),
      value: z
        .unknown()
        .refine((value) => value !== undefined, 'JSON 输出必须包含 value，空值请使用 null。'),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      value: z
        .object({
          columns: z.array(z.string().max(200)).max(200),
          rows: z.array(z.array(z.unknown()).max(200)).max(10000),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('file'), value: WorkflowFileValueSchema }).strict(),
  z.object({ type: z.literal('files'), value: z.array(WorkflowFileValueSchema).max(32) }).strict(),
  z.object({ type: z.literal('browser-session'), value: WorkflowBrowserSessionSchema }).strict(),
]);
export type WorkflowValue = z.infer<typeof WorkflowValueSchema>;
export type WorkflowFileValue = z.infer<typeof WorkflowFileValueSchema>;
export const WorkflowOutputsSchema = z.record(PortName, WorkflowValueSchema);
export const WorkflowExecutionRefSchema = z
  .object({
    kind: z.enum(['tool', 'python', 'browser']),
    id: z.string().trim().min(1).max(500),
    provider: z.string().max(100).optional(),
  })
  .strict();
export type WorkflowExecutionRef = z.infer<typeof WorkflowExecutionRefSchema>;
export type WorkflowPlan = {
  valid: boolean;
  issues: string[];
  order: string[];
  objectIds: string[];
};
export type WorkflowNodeState =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'skipped';
export type WorkflowFrozenFile = {
  objectId: string;
  revision: number;
  fileName: string;
  assetHash: string;
  size: number;
};
export type WorkflowArtifact = {
  artifactId: string;
  nodeId: string;
  ownerRunId?: string;
  fileName: string;
  relativePath: string;
  path: string;
  sha256: string;
  size: number;
};
export type WorkflowRun = {
  id: string;
  flowObjectId: string;
  flowRevision: number;
  name: string;
  createdAt: string;
  status: 'prepared' | 'running' | 'waiting' | 'succeeded' | 'failed';
  document: WorkflowDocument;
  order: string[];
  objectIds: string[];
  expectedRevisions: Record<string, number>;
  frozenFiles?: Record<string, WorkflowFrozenFile>;
  artifacts?: Record<string, WorkflowArtifact>;
  restoredAt?: string;
  scope?: {
    fromRunId: string;
    nodeIds: string[];
    includeDownstream: boolean;
    reusedNodeIds: string[];
  };
  batch?: { batchId: string; itemId: string; attempt: number };
  parent?: { runId: string; nodeId: string; iteration: number; rootRunId: string; depth: number };
  nodes: Record<
    string,
    {
      state: WorkflowNodeState;
      summary?: string;
      reportedAt?: string;
      resultObjectIds: string[];
      outputs?: Record<string, WorkflowValue>;
      executionRef?: WorkflowExecutionRef;
      python?: unknown;
      skipReason?: 'branch' | 'scope' | 'dependency';
      reusedFromRunId?: string;
      builtinRequestId?: string;
      approval?: {
        state: 'pending' | 'approved' | 'rejected';
        requestedAt: string;
        decidedAt?: string;
      };
      childRunIds?: string[];
      lastChildValue?: unknown;
      collectedChildId?: string;
      pythonResult?: {
        stdout: string;
        stderr: string;
        logsTruncated: boolean;
        exitCode: number | null;
        runtime?: { executable: string; version: string };
        issues: { code: string; message: string; fileName?: string }[];
      };
    }
  >;
  logs: {
    nodeId?: string;
    state: Exclude<WorkflowNodeState, 'pending'>;
    summary: string;
    reportedAt: string;
    resultObjectIds: string[];
    executionRef?: WorkflowExecutionRef;
  }[];
  reportedAt?: string;
  reportSource: 'codex_reported';
  independentlyVerified: false;
};
export type WorkflowBatch = {
  id: string;
  flowObjectId: string;
  flowRevision: number;
  createdAt: string;
  restoredAt?: string;
  continueOnError: boolean;
  items: {
    id: string;
    objectId: string;
    fileName: string;
    runId: string;
    attempt: number;
    previousRunIds: string[];
  }[];
};
export function blankWorkflow(name = '新建工作流'): WorkflowDocument {
  return { schemaVersion: 2, kind: 'ai-desktop-flow', name, description: '', nodes: [], edges: [] };
}
/** Planning never authorizes a tool or executes user code. */
export function planWorkflow(document: WorkflowDocument): WorkflowPlan {
  const parsed = WorkflowDocumentSchema.safeParse(document);
  if (!parsed.success)
    return {
      valid: false,
      issues: ['工作流格式不正确，请使用 Yirang .flow.json 文件。'],
      order: [],
      objectIds: [],
    };
  const d = parsed.data,
    issues: string[] = [],
    order: string[] = [],
    objectIds = new Set<string>();
  if (new TextEncoder().encode(JSON.stringify(d)).length > WORKFLOW_BYTE_LIMIT)
    issues.push('工作流不能超过 1 MiB。');
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  if (nodes.size !== d.nodes.length) issues.push('组件 ID 不能重复。');
  if (new Set(d.edges.map((e) => e.id)).size !== d.edges.length) issues.push('连线 ID 不能重复。');
  const incoming = new Map(d.nodes.map((n) => [n.id, [] as string[]])),
    outgoing = new Map(d.nodes.map((n) => [n.id, [] as string[]]));
  const pairs = new Set<string>(),
    boundPorts = new Set<string>();
  for (const edge of d.edges) {
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target);
    if (!source || !target) {
      issues.push('连线包含不存在的组件。');
      continue;
    }
    const pair = JSON.stringify([edge.source, edge.sourcePort, edge.target, edge.targetPort]),
      bound = JSON.stringify([edge.target, edge.targetPort]);
    if (pairs.has(pair)) issues.push('相同端口之间不能重复连线。');
    pairs.add(pair);
    if (boundPorts.has(bound)) issues.push(`${target.label}：一个输入端口只能连接一个上游输出。`);
    boundPorts.add(bound);
    const a = workflowPorts(source).outputs.find((port) => port.name === edge.sourcePort),
      b = workflowPorts(target).inputs.find((port) => port.name === edge.targetPort);
    if (!a || !b) issues.push(`${source.label} → ${target.label}：连线端口不存在，请重新选择。`);
    else if (!workflowPortCompatible(a.type, b.type))
      issues.push(`${source.label}.${a.name} → ${target.label}.${b.name}：端口类型不匹配。`);
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }
  const inputs = d.nodes.filter(
      (n) =>
        n.type === 'input' ||
        (n.type === 'browser' &&
          (n.config.browserAction ?? 'open') === 'open' &&
          !!n.config.url?.trim() &&
          !incoming.get(n.id)!.length),
    ),
    outputs = d.nodes.filter((n) => n.type === 'output');
  if (!inputs.length) issues.push('请添加文件、文本、JSON 输入，或填写浏览器打开地址作为起点。');
  if (!outputs.length) issues.push('请添加至少一个结果输出组件。');
  for (const n of d.nodes) {
    const c = n.config,
      name = n.label,
      ports = workflowPorts(n);
    if (
      [
        'input',
        'browser',
        'condition',
        'approval',
        'extract',
        'chart',
        'subflow',
        'repeat',
      ].includes(n.type)
    ) {
      const defaults = workflowPorts({
        ...n,
        config: { ...c, inputPorts: undefined, outputPorts: undefined },
      });
      const shape = (values: WorkflowPort[]) =>
        JSON.stringify(
          values.map(({ name, type, required }) => ({ name, type, required: !!required })),
        );
      if (
        shape(ports.inputs) !== shape(defaults.inputs) ||
        shape(ports.outputs) !== shape(defaults.outputs)
      )
        issues.push(`${name}：输入和浏览器组件使用固定语义端口，请恢复默认端口。`);
    }
    if (n.type === 'input' && (c.inputMode ?? 'files') === 'files')
      for (const id of c.objectIds ?? []) objectIds.add(id);
    if (n.type === 'output' && c.targetObjectId) objectIds.add(c.targetObjectId);
    if (n.type === 'python') {
      if (c.codeObjectId) objectIds.add(c.codeObjectId);
      if (c.requirementsObjectId) objectIds.add(c.requirementsObjectId);
    }
    if (n.type === 'subflow' || n.type === 'repeat') {
      if (c.flowObjectId) objectIds.add(c.flowObjectId);
      else issues.push(`${name}：请选择子流程文件。`);
      if (!c.childInputNodeId || !c.childResultNodeId)
        issues.push(`${name}：请选择子流程的输入节点和结果节点。`);
      if (c.stopWhenPath && !safeWorkflowPath(c.stopWhenPath))
        issues.push(`${name}：停止条件字段路径不合法。`);
    }
    for (const id of workflowParameterFileIds(n)) objectIds.add(id);
    if (n.type === 'input') {
      if ((c.inputMode ?? 'files') === 'files' && !c.objectIds?.length)
        issues.push(`${name}：请选择输入材料。`);
      if (c.inputMode === 'text' && typeof c.value !== 'string')
        issues.push(`${name}：请填写文本输入。`);
      if (c.inputMode === 'json' && c.value === undefined)
        issues.push(`${name}：请填写 JSON 输入。`);
      if (incoming.get(n.id)!.length) issues.push(`${name}：输入组件不能接收上游连线。`);
    }
    if (n.type === 'output' && outgoing.get(n.id)!.length)
      issues.push(`${name}：输出组件不能继续连接下游。`);
    for (const port of ports.inputs)
      if (port.required && !boundPorts.has(JSON.stringify([n.id, port.name])))
        issues.push(`${name}：请连接必填输入端口 ${port.name}。`);
    if (n.type === 'skill' && !c.skillPath?.trim() && !c.instructions?.trim())
      issues.push(`${name}：请选择 Skill 或填写组件指令。`);
    if (n.type === 'mcp') {
      if (!c.server?.trim() || !c.toolName?.trim())
        issues.push(`${name}：请填写 MCP 服务和工具名称。`);
      for (const [argument, port] of Object.entries(c.argumentBindings ?? {})) {
        if (!ports.inputs.some((item) => item.name === port))
          issues.push(`${name}：参数 ${argument} 绑定的输入端口 ${port} 不存在。`);
        else if (!boundPorts.has(JSON.stringify([n.id, port])))
          issues.push(`${name}：参数 ${argument} 需要先连接输入端口 ${port}。`);
      }
    }
    if (n.type === 'prompt' && !c.instructions?.trim()) issues.push(`${name}：请填写处理指令。`);
    if (n.type === 'condition' && !c.condition) issues.push(`${name}：请选择判断字段和条件。`);
    if (
      n.type === 'condition' &&
      c.condition &&
      !ports.inputs.some((port) => port.name === c.condition!.inputPort)
    )
      issues.push(`${name}：条件输入端口不存在。`);
    if (c.condition?.path && !safeWorkflowPath(c.condition.path))
      issues.push(`${name}：条件字段路径不合法。`);
    for (const [parameter, binding] of Object.entries(c.fieldBindings ?? {})) {
      if (!ports.inputs.some((port) => port.name === binding.port))
        issues.push(`${name}：字段 ${parameter} 的来源端口不存在。`);
      if (binding.path && !safeWorkflowPath(binding.path))
        issues.push(`${name}：字段路径不合法，请使用点号字段或数字数组下标。`);
    }
    for (const [parameter, spec] of Object.entries(c.parameterSchema ?? {})) {
      if (c.fieldBindings?.[parameter] || (n.type === 'mcp' && c.argumentBindings?.[parameter]))
        continue;
      const value = (n.type === 'mcp' ? c.arguments : c.parameters)?.[parameter];
      if (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && !value.length)
      ) {
        if (spec.required) issues.push(`${name}：请填写必填参数 ${spec.label ?? parameter}。`);
        continue;
      }
      if (
        (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) ||
        (spec.type === 'boolean' && typeof value !== 'boolean') ||
        (spec.type === 'enum' && !spec.options?.includes(String(value))) ||
        (spec.type === 'file' && typeof value !== 'string') ||
        (spec.type === 'files' &&
          (!Array.isArray(value) || value.some((id) => typeof id !== 'string')))
      )
        issues.push(`${name}：参数 ${spec.label ?? parameter} 的值与类型不符。`);
    }
    if (n.type === 'python' && !c.codeObjectId) issues.push(`${name}：请选择原生 Python 脚本。`);
    if (n.type === 'browser') {
      if ((c.browserAction ?? 'open') === 'open' && c.url?.trim() && !/^https?:\/\//i.test(c.url))
        issues.push(`${name}：页面地址需使用 http 或 https。`);
      if (c.browserAction === 'interact' && !c.instructions?.trim())
        issues.push(`${name}：请填写浏览器操作要求。`);
    }
    if (n.type === 'output' && !c.targetObjectId)
      issues.push(`${name}：请选择桌面上的结果回写对象。`);
  }
  const pending = new Map([...incoming].map(([key, value]) => [key, value.length])),
    queue = d.nodes.filter((n) => !pending.get(n.id)).map((n) => n.id);
  while (queue.length) {
    const current = queue.shift()!;
    order.push(current);
    for (const target of outgoing.get(current) ?? []) {
      pending.set(target, pending.get(target)! - 1);
      if (!pending.get(target)) queue.push(target);
    }
  }
  if (order.length !== nodes.size)
    issues.push('工作流存在循环连线，请改成从输入到输出的有向流程。');
  const reachable = (start: string[], links: Map<string, string[]>) => {
    const seen = new Set(start),
      todo = [...start];
    while (todo.length) {
      for (const target of links.get(todo.shift()!) ?? [])
        if (!seen.has(target)) {
          seen.add(target);
          todo.push(target);
        }
    }
    return seen;
  };
  const forward = reachable(
      inputs.map((n) => n.id),
      outgoing,
    ),
    backward = reachable(
      outputs.map((n) => n.id),
      incoming,
    );
  for (const n of d.nodes)
    if (!forward.has(n.id) || !backward.has(n.id))
      issues.push(`${n.label}：请连接到完整的输入 → 输出流程。`);
  if (objectIds.size > 9) issues.push('输入、代码和回写材料最多 9 份，加上工作流文件共 10 份。');
  if (d.batch) {
    const input = nodes.get(d.batch.inputNodeId);
    if (input?.type !== 'input' || (input.config.inputMode ?? 'files') !== 'files')
      issues.push('批处理需要选择一个文件输入组件。');
  }
  if (d.widget) {
    const keys = new Set<string>();
    for (const field of d.widget.fields) {
      if (keys.has(field.key)) issues.push('小工具参数名称不能重复。');
      keys.add(field.key);
      if (!nodes.has(field.nodeId)) issues.push(`小工具参数 ${field.label} 对应的组件不存在。`);
      if (field.path && !safeWorkflowPath(field.path))
        issues.push(`小工具参数 ${field.label} 路径不合法。`);
    }
  }
  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)],
    order,
    objectIds: [...objectIds],
  };
}
export function safeWorkflowPath(path: string) {
  return (
    !path ||
    (path.length <= 500 &&
      path
        .split('.')
        .every(
          (part) =>
            /^[A-Za-z0-9_\-\u0080-\uffff]+$/.test(part) &&
            !['__proto__', 'prototype', 'constructor'].includes(part),
        ))
  );
}
export function workflowField(value: unknown, path?: string): unknown {
  if (!path) return value;
  if (!safeWorkflowPath(path)) throw new Error('字段路径不合法。');
  let current = value;
  for (const key of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, key)
    )
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
