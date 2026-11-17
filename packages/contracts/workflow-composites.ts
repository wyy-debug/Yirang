import { z } from 'zod';
import {
  WorkflowNodeSchema,
  WorkflowDocumentSchema,
  workflowPorts,
  type WorkflowDocument,
  type WorkflowNode,
} from './workflows.js';

const key = z.string().trim().min(1).max(150),
  name = z.string().trim().min(1).max(100);
const endpoint = z.object({ name, nodeId: key, port: z.string().min(1).max(64) }).strict();
const parameter = z
  .object({
    name,
    nodeId: key,
    target: z.enum(['value', 'parameters', 'arguments']),
    path: z.string().max(200).optional(),
  })
  .strict();
export const WorkflowComponentSchema = z
  .union([
    z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal('ai-desktop-component'),
        name,
        node: WorkflowNodeSchema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(2),
        kind: z.literal('ai-desktop-component'),
        name,
        document: WorkflowDocumentSchema,
        inputs: z.array(endpoint).max(80),
        outputs: z.array(endpoint).max(80),
        parameters: z.array(parameter).max(80),
      })
      .strict(),
  ])
  .superRefine((definition, ctx) => {
    if (definition.schemaVersion === 1) return;
    const nodes = new Map(definition.document.nodes.map((node) => [node.id, node]));
    for (const direction of ['inputs', 'outputs'] as const)
      for (const item of definition[direction]) {
        const node = nodes.get(item.nodeId);
        if (!node || !workflowPorts(node)[direction].some((port) => port.name === item.port))
          ctx.addIssue({ code: 'custom', message: `暴露的 ${direction} 端口不存在。` });
      }
    for (const item of definition.parameters)
      if (!nodes.has(item.nodeId))
        ctx.addIssue({ code: 'custom', message: '暴露的参数组件不存在。' });
    if (
      new Set(definition.document.nodes.map((node) => node.id)).size !==
      definition.document.nodes.length
    )
      ctx.addIssue({ code: 'custom', message: '组件 ID 不能重复。' });
    for (const edge of definition.document.edges)
      if (!nodes.has(edge.source) || !nodes.has(edge.target))
        ctx.addIssue({ code: 'custom', message: '组合组件包含外部连线。' });
  });
export type WorkflowComponentDefinition = z.infer<typeof WorkflowComponentSchema>;

export function bundleSelection(
  document: WorkflowDocument,
  ids: string[],
  name: string,
): WorkflowComponentDefinition {
  const selected = new Set(ids),
    nodes = document.nodes.filter((node) => selected.has(node.id)),
    edges = document.edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target));
  const inputs = nodes.flatMap((node) =>
    workflowPorts(node)
      .inputs.filter(
        (port) => !edges.some((edge) => edge.target === node.id && edge.targetPort === port.name),
      )
      .map((port) => ({
        name: `${node.label} · ${port.name}`.slice(0, 100),
        nodeId: node.id,
        port: port.name,
      })),
  );
  const outputs = nodes.flatMap((node) =>
    workflowPorts(node)
      .outputs.filter(
        (port) =>
          !edges.some((edge) => edge.source === node.id && edge.sourcePort === port.name) ||
          document.edges.some(
            (edge) =>
              edge.source === node.id &&
              edge.sourcePort === port.name &&
              !selected.has(edge.target),
          ),
      )
      .map((port) => ({
        name: `${node.label} · ${port.name}`.slice(0, 100),
        nodeId: node.id,
        port: port.name,
      })),
  );
  const parameters = nodes.flatMap<z.infer<typeof parameter>>((node) =>
    node.type === 'input'
      ? [{ name: node.label.slice(0, 100), nodeId: node.id, target: 'value' as const }]
      : Object.keys(
          node.type === 'mcp' ? (node.config.arguments ?? {}) : (node.config.parameters ?? {}),
        ).map((path) => ({
          name: `${node.label} · ${path}`.slice(0, 100),
          nodeId: node.id,
          target: node.type === 'mcp' ? ('arguments' as const) : ('parameters' as const),
          path,
        })),
  );
  return WorkflowComponentSchema.parse({
    schemaVersion: 2,
    kind: 'ai-desktop-component',
    name,
    document: { schemaVersion: 2, kind: 'ai-desktop-flow', name, description: '', nodes, edges },
    inputs: inputs.slice(0, 80),
    outputs: outputs.slice(0, 80),
    parameters: parameters.slice(0, 80),
  });
}

/** Expand a bundle into ordinary nodes; retain file references and rebuild only internal IDs. */
export function expandComponent(
  definition: WorkflowComponentDefinition,
  position: { x: number; y: number },
  origin: { objectId: string; revision: number },
): { nodes: WorkflowNode[]; edges: WorkflowDocument['edges'] } {
  const nodes = definition.schemaVersion === 1 ? [definition.node] : definition.document.nodes,
    edges = definition.schemaVersion === 1 ? [] : definition.document.edges;
  const mapping = new Map(nodes.map((node) => [node.id, crypto.randomUUID()])),
    minX = Math.min(...nodes.map((node) => node.position.x)),
    minY = Math.min(...nodes.map((node) => node.position.y));
  return {
    nodes: nodes.map((node) => ({
      ...structuredClone(node),
      id: mapping.get(node.id)!,
      origin: definition.schemaVersion === 1 ? origin : undefined,
      position: {
        x: Math.max(-100000, Math.min(100000, node.position.x - minX + position.x)),
        y: Math.max(-100000, Math.min(100000, node.position.y - minY + position.y)),
      },
    })),
    edges: edges.map((edge) => ({
      ...edge,
      id: crypto.randomUUID(),
      source: mapping.get(edge.source)!,
      target: mapping.get(edge.target)!,
    })),
  };
}
