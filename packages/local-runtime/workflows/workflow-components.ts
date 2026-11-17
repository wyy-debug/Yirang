import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Bounds, FileContent, Id, fail } from '../../contracts/index.js';
import {
  WorkflowNodeSchema,
  WorkflowDocumentSchema,
  WORKFLOW_BYTE_LIMIT,
  type WorkflowNode,
  type WorkflowDocument,
} from '../../contracts/workflows.js';
import { WORKFLOW_PRESETS, WORKFLOW_RECIPES } from '../../contracts/workflow-presets.js';
import type { WorkbenchAPI } from '../work/workbench.js';
import { WorkflowComponentSchema } from '../../contracts/workflow-composites.js';
import { desktopToolDocument, desktopPresetDocument } from '../../contracts/desktop-tools.js';

export { WorkflowComponentSchema } from '../../contracts/workflow-composites.js';
const Revision = z.number().int().positive();
const Position = WorkflowNodeSchema.shape.position;
const Action = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('instantiate'),
      requestId: Id,
      presetId: Id,
      position: Position,
    })
    .strict(),
  z
    .object({
      operation: z.literal('template'),
      requestId: Id,
      recipeId: Id,
      bounds: Bounds.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('desktop'),
      requestId: Id,
      source: z.object({ kind: z.enum(['recipe', 'preset']), id: Id }).strict(),
      bounds: Bounds,
    })
    .strict(),
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('read'), objectId: Id, revision: Revision.optional() }).strict(),
  z
    .object({
      operation: z.literal('create_bundle'),
      requestId: Id,
      definition: WorkflowComponentSchema,
      bounds: Bounds.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('save_bundle'),
      requestId: Id,
      objectId: Id,
      expectedRevision: Revision,
      definition: WorkflowComponentSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('duplicate_source'),
      requestId: Id,
      objectId: Id,
      expectedRevision: Revision,
      bounds: Bounds.optional(),
    })
    .strict(),
  z.object({ operation: z.literal('usages'), objectId: Id }).strict(),
  z.object({ operation: z.literal('source_compare'), objectId: Id, revision: Revision }).strict(),
  z
    .object({
      operation: z.literal('source_restore'),
      requestId: Id,
      objectId: Id,
      expectedRevision: Revision,
      revision: Revision,
    })
    .strict(),
  z
    .object({
      operation: z.literal('create'),
      requestId: Id,
      name: z.string().trim().min(1).max(100),
      node: WorkflowNodeSchema,
      bounds: Bounds.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('save'),
      requestId: Id,
      objectId: Id,
      expectedRevision: Revision,
      name: z.string().trim().min(1).max(100),
      node: WorkflowNodeSchema,
    })
    .strict(),
]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const filename = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 100) || '组件';
type Installation = {
  signature: string;
  nodes: { key: string; node: WorkflowNode; source?: string }[];
  bounds: z.infer<typeof Bounds>;
  recipe?: { name: string; description: string; edges: WorkflowDocument['edges'] };
};

/** A component is a native definition file. Loading a definition never imports its Python code. */
export class WorkflowComponents {
  constructor(
    private api: {
      workbench: (w: string, c: string, s: string | null) => WorkbenchAPI;
      auth: (w: string, c: string, s: string | null) => { owner: string };
      assertReady: (w: string, id: string, owner: string) => void;
    },
  ) {}
  action(w: string, c: string, s: string | null, input: unknown) {
    const auth = this.api.auth(w, c, s),
      p = Action.parse(input),
      wb = this.api.workbench(w, c, s);
    if (p.operation === 'instantiate' || p.operation === 'template') return this.install(wb, p);
    if (p.operation === 'desktop') {
      // Freeze before child imports. Retrying a partial drop resumes the same files.
      const key = `workflow-desktop:${digest(p.requestId)}`,
        signature = JSON.stringify(p),
        saved = wb.get(key) as { signature: string } | undefined;
      if (saved && saved.signature !== signature) fail('REQUEST_REUSED', '请继续原来的拖入请求。');
      if (!saved) wb.put(key, { signature });
      const child = `desktop_${digest(p.requestId)}`;
      if (p.source.kind === 'recipe')
        return this.install(
          wb,
          { operation: 'template', requestId: child, recipeId: p.source.id, bounds: p.bounds },
          true,
        );
      const preset = WORKFLOW_PRESETS.find((item) => item.id === p.source.id);
      if (!preset) fail('COMPONENT_NOT_FOUND', '此组件不存在。');
      const installed = this.install(
        wb,
        {
          operation: 'instantiate',
          requestId: child,
          presetId: p.source.id,
          position: { x: p.bounds.x + 420, y: p.bounds.y },
        },
        true,
      );
      const document = desktopPresetDocument(installed.node!, preset.name, preset.description);
      const object = wb.create(
        `desktop_flow_${digest(p.requestId)}`,
        `${filename(document.name)}.flow.json`,
        Buffer.from(JSON.stringify(document, null, 2) + '\n'),
        p.bounds,
      );
      if (wb.object(object.id).archived)
        fail('COMPONENT_ARCHIVED', '本次拖入的工具已在回收站，请恢复后继续。');
      return { object, document, objects: installed.objects };
    }
    const read = (id: string, revision?: number) => {
      const object = wb.object(id);
      if (object.archived) fail('OBJECT_ARCHIVED', '组件定义已移入回收站。');
      if (object.kind !== 'file') fail('COMPONENT_FORMAT', '请选择 .component.json 组件文件。');
      const content = FileContent.parse(
        revision && revision !== object.revision
          ? wb.history(id, revision).content
          : object.content,
      );
      if (!/\.component\.json$/i.test(content.fileName) || content.size > WORKFLOW_BYTE_LIMIT)
        fail('COMPONENT_FORMAT', '组件定义需要是不超过 1 MiB 的 .component.json 文件。');
      const bytes = wb.load(content.assetHash);
      if (bytes.length > WORKFLOW_BYTE_LIMIT) fail('COMPONENT_FORMAT', '组件定义超过 1 MiB。');
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        fail('COMPONENT_FORMAT', '组件定义必须是有效的 UTF-8 JSON。');
      }
      const parsed = WorkflowComponentSchema.safeParse(raw);
      if (!parsed.success) fail('COMPONENT_FORMAT', '组件定义格式不受支持。');
      return { object, revision: revision ?? object.revision, definition: parsed.data };
    };
    if (p.operation === 'read') return read(p.objectId, p.revision);
    if (p.operation === 'duplicate_source') {
      const signature = JSON.stringify(p),
        key = `workflow-source-copy:${digest(p.requestId)}`;
      let copy = wb.get(key) as
        | { signature: string; assetHash: string; fileName: string }
        | undefined;
      if (copy && copy.signature !== signature)
        fail('REQUEST_REUSED', '此复制请求已用于另一份文件。');
      if (!copy) {
        const object = wb.object(p.objectId);
        this.api.assertReady(w, p.objectId, auth.owner);
        if (object.archived) fail('OBJECT_ARCHIVED', '源码已移入回收站。');
        if (object.revision !== p.expectedRevision)
          fail('REVISION_CONFLICT', '源码已更新，请刷新后复制。');
        const content = FileContent.parse(object.content);
        if (!/\.(py|txt)$/i.test(content.fileName))
          fail('COMPONENT_FORMAT', '仅可独立复制 Python 源码和依赖文件。');
        copy = {
          signature,
          assetHash: content.assetHash,
          fileName: content.fileName.replace(/(\.[^.]+)$/, '-副本$1'),
        };
        wb.put(key, copy);
      }
      return {
        object: wb.create(
          `source_${digest(p.requestId)}`,
          copy.fileName,
          wb.load(copy.assetHash),
          p.bounds ?? { x: 240, y: 180, width: 350, height: 260 },
        ),
      };
    }
    if (p.operation === 'usages') {
      const source = wb.object(p.objectId),
        usages: {
          objectId: string;
          title: string;
          nodeId: string;
          label: string;
          relation: string;
        }[] = [],
        issues: { objectId: string; message: string }[] = [];
      const candidates = wb
        .objects()
        .filter(
          (item) =>
            !item.archived &&
            item.kind === 'file' &&
            /\.(flow|component)\.json$/i.test(
              (item.content as { fileName?: string }).fileName ?? '',
            ),
        );
      for (const object of candidates.slice(0, 300))
        try {
          const content = FileContent.parse(object.content);
          if (content.size > WORKFLOW_BYTE_LIMIT) continue;
          const raw = JSON.parse(wb.load(content.assetHash).toString('utf8'));
          const flow = WorkflowDocumentSchema.safeParse(raw),
            component = flow.success ? null : WorkflowComponentSchema.safeParse(raw);
          const nodes = flow.success
            ? flow.data.nodes
            : component?.success
              ? component.data.schemaVersion === 1
                ? [component.data.node]
                : component.data.document.nodes
              : [];
          for (const node of nodes) {
            for (const [key, relation] of [
              ['codeObjectId', '源码'],
              ['requirementsObjectId', '依赖文件'],
            ] as const)
              if (node.config[key] === p.objectId)
                usages.push({
                  objectId: object.id,
                  title: object.title,
                  nodeId: node.id,
                  label: node.label,
                  relation,
                });
          }
        } catch (error) {
          issues.push({
            objectId: object.id,
            message: error instanceof Error ? error.message : '无法读取',
          });
        }
      return { source, usages, issues, truncated: candidates.length > 300 };
    }
    if (p.operation === 'source_compare' || p.operation === 'source_restore') {
      const object = wb.object(p.objectId);
      if (object.archived) fail('OBJECT_ARCHIVED', '源码已移入回收站。');
      const current = FileContent.parse(object.content),
        past = FileContent.parse(wb.history(p.objectId, p.revision).content);
      if (!/\.(py|txt)$/i.test(current.fileName) || !/(?:\.py|\.txt)$/i.test(past.fileName))
        fail('COMPONENT_FORMAT', '请选择 Python 源码或依赖文件。');
      if (current.size > WORKFLOW_BYTE_LIMIT || past.size > WORKFLOW_BYTE_LIMIT)
        fail('COMPONENT_LIMIT', '源码版本预览最大支持 1 MiB。');
      if (p.operation === 'source_compare') {
        const before = wb.load(current.assetHash).toString('utf8'),
          after = wb.load(past.assetHash).toString('utf8');
        return {
          object,
          revision: p.revision,
          before: before.slice(0, 100000),
          after: after.slice(0, 100000),
          identical: current.assetHash === past.assetHash,
          truncated: before.length > 100000 || after.length > 100000,
        };
      }
      this.api.assertReady(w, p.objectId, auth.owner);
      return {
        object: wb.save(
          p.requestId,
          p.objectId,
          p.expectedRevision,
          wb.load(past.assetHash),
          `将组件源码恢复到 v${p.revision} 的内容`,
          { type: 'workflow-source-restore', sourceRevision: p.revision },
        ),
      };
    }
    if (p.operation === 'list') {
      const objects = wb
        .objects()
        .filter(
          (o) =>
            !o.archived &&
            o.kind === 'file' &&
            /\.component\.json$/i.test((o.content as { fileName?: string }).fileName ?? ''),
        );
      const components: ReturnType<typeof read>[] = [],
        issues: { objectId: string; message: string }[] = [];
      for (const object of objects.slice(0, 200)) {
        try {
          components.push(read(object.id));
        } catch (error) {
          issues.push({
            objectId: object.id,
            message: error instanceof Error ? error.message : '无法读取组件定义',
          });
        }
      }
      return { components, issues, truncated: objects.length > 200 };
    }
    const definition = WorkflowComponentSchema.parse(
      p.operation === 'create_bundle' || p.operation === 'save_bundle'
        ? p.definition
        : { schemaVersion: 1, kind: 'ai-desktop-component', name: p.name, node: p.node },
    );
    const bytes = Buffer.from(JSON.stringify(definition, null, 2) + '\n');
    if (bytes.length > WORKFLOW_BYTE_LIMIT) fail('COMPONENT_LIMIT', '组件定义不能超过 1 MiB。');
    if (p.operation === 'create' || p.operation === 'create_bundle') {
      const name = definition.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100);
      return {
        object: wb.create(
          p.requestId,
          `${name}.component.json`,
          bytes,
          p.bounds ?? { x: 180, y: 180, width: 360, height: 260 },
        ),
        definition,
      };
    }
    read(p.objectId);
    this.api.assertReady(w, p.objectId, auth.owner);
    return {
      object: wb.save(p.requestId, p.objectId, p.expectedRevision, bytes, '保存可复用组件定义', {
        type: 'workflow-component',
      }),
      definition,
    };
  }

  /** Freeze the request before creating files. Each child import has a stable receipt;
   * a lost response or partial creation can be resumed without executing any code. */
  private install(
    wb: WorkbenchAPI,
    p: Extract<z.infer<typeof Action>, { operation: 'instantiate' | 'template' }>,
    desktop = false,
  ) {
    const batch = digest(p.requestId),
      key = `workflow-install:${batch}`,
      signature = JSON.stringify(p);
    let installation = wb.get(key) as Installation | undefined;
    if (installation && installation.signature !== signature)
      fail('REQUEST_REUSED', '该创建请求已用于其他组件，请继续原请求或重新添加。');
    if (!installation) {
      const recipe =
        p.operation === 'template'
          ? WORKFLOW_RECIPES.find((item) => item.id === p.recipeId)
          : undefined;
      if (p.operation === 'template' && !recipe)
        fail('COMPONENT_NOT_FOUND', '此流程模板不存在，请重新打开组件库。');
      const items =
        p.operation === 'instantiate'
          ? [{ key: 'component', presetId: p.presetId }]
          : recipe!.nodes;
      const nodes = items.map((item, index) => {
        const preset = WORKFLOW_PRESETS.find((value) => value.id === item.presetId);
        if (!preset) fail('COMPONENT_NOT_FOUND', '此内置组件不存在，请重新打开组件库。');
        const node = WorkflowNodeSchema.parse({
          ...structuredClone(preset.node),
          id: `node_${digest(`${batch}:${item.key}`).slice(0, 28)}`,
          position: p.operation === 'instantiate' ? p.position : { x: 100 + index * 310, y: 150 },
          config: {
            ...structuredClone(preset.node.config),
            ...structuredClone('config' in item ? (item.config ?? {}) : {}),
          },
        });
        return {
          key: item.key,
          node,
          ...(preset.pythonSource ? { source: preset.pythonSource } : {}),
        };
      });
      const bounds =
        p.operation === 'template'
          ? (p.bounds ?? { x: 120, y: 100, width: 380, height: 265 })
          : { x: 160, y: 150, width: 360, height: 260 };
      installation = {
        signature,
        nodes,
        bounds,
        ...(recipe
          ? {
              recipe: {
                name: recipe.name,
                description: recipe.description,
                edges: recipe.edges.map((edge, index) => {
                  const source = nodes.find((item) => item.key === edge.source),
                    target = nodes.find((item) => item.key === edge.target);
                  if (!source || !target) fail('COMPONENT_TEMPLATE', '模板连线包含未知组件。');
                  return {
                    ...edge,
                    id: `edge_${digest(`${batch}:${index}`).slice(0, 28)}`,
                    source: source.node.id,
                    target: target.node.id,
                  };
                }),
              },
            }
          : {}),
      };
      wb.put(key, installation);
    }
    const nodes: WorkflowNode[] = [],
      objects: ReturnType<WorkbenchAPI['create']>[] = [];
    const folder = `流程素材/${filename(installation.recipe?.name ?? installation.nodes[0].node.label)}-${batch.slice(0, 8)}`;
    for (const [index, item] of installation.nodes.entries()) {
      const node = structuredClone(item.node),
        bounds = {
          x: installation.bounds.x + 420 + (index % 3) * 390,
          y: installation.bounds.y + Math.floor(index / 3) * 300,
          width: 350,
          height: 245,
        };
      const createFile = (suffix: string, name: string, text: string) => {
        const object = wb.create(
          `preset_${digest(`${batch}:${item.key}:${suffix}`)}`,
          name,
          Buffer.from(text, 'utf8'),
          bounds,
          `${folder}/${name}`,
        );
        if (wb.object(object.id).archived)
          fail('COMPONENT_ARCHIVED', '本次创建的文件已移入回收站，请恢复该文件后继续原请求。');
        objects.push(object);
        return object.id;
      };
      if (item.source)
        node.config.codeObjectId = createFile(
          'source',
          `${index + 1}-${filename(node.label)}.py`,
          item.source,
        );
      if (node.type === 'output' && !node.config.targetObjectId) {
        const requested = node.config.outputName ?? '处理结果.md',
          name = filename(requested);
        if (!/\.(?:md|txt|json|csv|html|svg)$/i.test(name))
          fail('COMPONENT_OUTPUT', '预设输出需要文本、JSON、CSV、Markdown、HTML 或 SVG 文件。');
        const initial = /\.json$/i.test(name)
          ? 'null\n'
          : /\.html$/i.test(name)
            ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>处理结果</title><body></body></html>\n'
            : /\.svg$/i.test(name)
              ? '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>\n'
              : '';
        node.config.targetObjectId = createFile('output', name, initial);
      }
      nodes.push(WorkflowNodeSchema.parse(node));
    }
    if (!installation.recipe) return { node: nodes[0], object: objects[0], objects };
    let document = WorkflowDocumentSchema.parse({
      schemaVersion: 2,
      kind: 'ai-desktop-flow',
      name: installation.recipe.name,
      description: installation.recipe.description,
      nodes,
      edges: installation.recipe.edges,
    });
    if (desktop) document = desktopToolDocument(document);
    const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n');
    if (bytes.length > WORKFLOW_BYTE_LIMIT) fail('WORKFLOW_LIMIT', '模板工作流超过 1 MiB。');
    const object = wb.create(
      `preset_${digest(`${batch}:flow`)}`,
      `${filename(document.name)}.flow.json`,
      bytes,
      installation.bounds,
    );
    if (wb.object(object.id).archived)
      fail('COMPONENT_ARCHIVED', '本次创建的流程已移入回收站，请恢复该文件后继续原请求。');
    return { object, document, objects };
  }
}
