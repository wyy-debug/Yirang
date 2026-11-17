import { z } from 'zod';
import {
  WorkflowDocumentSchema,
  workflowPorts,
  type WorkflowDocument,
  type WorkflowNode,
} from './workflows.js';

export const DESKTOP_TOOL_MIME = 'application/x-ai-desktop-tool';
export const DesktopToolSource = z
  .object({ kind: z.enum(['recipe', 'preset', 'flow']), id: z.string().min(1).max(150) })
  .strict();
export type DesktopToolSource = z.infer<typeof DesktopToolSource>;
export const DesktopToolDrag = z
  .object({ workspaceId: z.string().min(1).max(150), source: DesktopToolSource })
  .strict();

/** Old flows get an in-memory form. Merely rendering a card never rewrites its file. */
export function desktopToolDocument(document: WorkflowDocument): WorkflowDocument {
  if (document.widget?.enabled) return document;
  const fields: NonNullable<WorkflowDocument['widget']>['fields'] = document.widget?.fields.length
    ? structuredClone(document.widget.fields)
    : [];
  if (!fields.length)
    document.nodes.forEach((node, index) => {
      if (node.type === 'input')
        fields.push({
          key: `input_${index}`,
          nodeId: node.id,
          label: node.label.slice(0, 100),
          target: 'value',
          type: (node.config.inputMode ?? 'files') === 'files' ? 'files' : 'text',
          required: true,
        });
      const target = node.type === 'mcp' ? 'arguments' : 'parameters',
        values = node.config[target] ?? {};
      const names = [
        ...new Set([...Object.keys(node.config.parameterSchema ?? {}), ...Object.keys(values)]),
      ];
      names.forEach((name, fieldIndex) => {
        if (
          node.config.fieldBindings?.[name] ||
          node.config.argumentBindings?.[name] ||
          /[.\[\]]/.test(name) ||
          ['__proto__', 'prototype', 'constructor'].includes(name)
        )
          return;
        const spec = node.config.parameterSchema?.[name],
          value = values[name],
          type =
            spec?.type ??
            (typeof value === 'number'
              ? 'number'
              : typeof value === 'boolean'
                ? 'boolean'
                : 'text');
        if (
          !['text', 'number', 'boolean', 'enum', 'file', 'files', 'column'].includes(type) ||
          (!spec && value !== null && typeof value === 'object')
        )
          return;
        fields.push({
          key: `param_${index}_${fieldIndex}`,
          nodeId: node.id,
          label: (spec?.label ?? name).slice(0, 100),
          target,
          path: name,
          type:
            type === 'enum'
              ? 'select'
              : type === 'column'
                ? 'text'
                : (type as 'text' | 'number' | 'boolean' | 'file' | 'files'),
          required: spec?.required,
          options: spec?.options,
        });
      });
    });
  return {
    ...document,
    widget: {
      enabled: true,
      title: document.widget?.title ?? document.name,
      description: document.widget?.description ?? document.description.slice(0, 1000),
      fields: fields.slice(0, 32),
    },
  };
}

/** A standalone preset has real input nodes so its card can accept materials immediately. */
export function desktopPresetDocument(
  node: WorkflowNode,
  name: string,
  description: string,
): WorkflowDocument {
  const nodes: WorkflowNode[] = [],
    edges: WorkflowDocument['edges'] = [];
  workflowPorts(node)
    .inputs.filter((port) => port.required !== false)
    .forEach((port, index) => {
      const mode =
        port.type === 'file' || port.type === 'files'
          ? 'files'
          : port.type === 'text'
            ? 'text'
            : 'json';
      const input: WorkflowNode = {
        id: `${node.id}_input_${index}`,
        type: 'input',
        label:
          port.name === 'files'
            ? '输入文件'
            : port.name === 'url'
              ? '网页地址'
              : `输入 ${port.name}`,
        position: { x: 0, y: index * 160 },
        config: {
          inputMode: mode,
          ...(mode === 'files'
            ? { objectIds: [] }
            : {
                value:
                  mode === 'text' ? (node.type === 'browser' ? (node.config.url ?? '') : '') : null,
              }),
          outputPorts: [{ name: 'value', type: port.type, required: !!port.required }],
        },
      };
      nodes.push(input);
      edges.push({
        id: `${node.id}_edge_${index}`,
        source: input.id,
        sourcePort: 'value',
        target: node.id,
        targetPort: port.name,
      });
    });
  nodes.push({ ...node, position: { x: nodes.length ? 320 : 0, y: 0 } });
  return desktopToolDocument(
    WorkflowDocumentSchema.parse({
      schemaVersion: 2,
      kind: 'ai-desktop-flow',
      name,
      description,
      nodes,
      edges,
    }),
  );
}
