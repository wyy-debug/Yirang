// Workflow node-graph walking: node lookup, inactive branch detection,
// branch skipping, dependency checks and input-node output construction.
import { fail } from '../../contracts/index.js';
import {
  WorkflowValueSchema,
  workflowPorts,
  workflowPortCompatible,
  type WorkflowDocument,
  type WorkflowRun,
  type WorkflowNode,
  type WorkflowValue,
} from '../../contracts/workflows.js';
import { time } from './workflow-records.js';

/** Pure graph helpers; no store surface needed. */
export type WorkflowGraphHost = Record<string, never>;

export interface WorkflowGraphMethods {
  node(run: WorkflowRun, id?: string): WorkflowNode;
  inactive(run: WorkflowRun, edge: WorkflowDocument['edges'][number]): boolean;
  skipBranches(run: WorkflowRun): void;
  dependency(run: WorkflowRun, node: WorkflowNode): void;
  inputOutputs(run: WorkflowRun, node: WorkflowNode): Record<string, WorkflowValue>;
}

export const workflowGraph: WorkflowGraphMethods &
  ThisType<WorkflowGraphHost & WorkflowGraphMethods> = {
  node(run: WorkflowRun, id?: string) {
    const node = run.document.nodes.find((item) => item.id === id);
    if (!node) fail('NOT_FOUND', '请选择有效的工作流组件 nodeId。');
    return node;
  },
  inactive(run: WorkflowRun, edge: WorkflowDocument['edges'][number]) {
    const source = run.nodes[edge.source],
      node = this.node(run, edge.source);
    return (
      (source?.state === 'skipped' && source.skipReason === 'branch') ||
      (node.type === 'condition' &&
        source.state === 'succeeded' &&
        !source.outputs?.[edge.sourcePort])
    );
  },
  skipBranches(run: WorkflowRun) {
    for (const id of run.order) {
      const status = run.nodes[id];
      if (status.state !== 'pending') continue;
      const node = this.node(run, id),
        edges = run.document.edges.filter((edge) => edge.target === id),
        ports = workflowPorts(node).inputs;
      if (
        edges.some(
          (edge) =>
            this.inactive(run, edge) &&
            ports.some((port) => port.name === edge.targetPort && port.required),
        ) ||
        (edges.length > 0 && edges.every((edge) => this.inactive(run, edge)))
      ) {
        const at = time();
        run.nodes[id] = {
          state: 'skipped',
          skipReason: 'branch',
          summary: '条件未选择此分支。',
          reportedAt: at,
          resultObjectIds: [],
        };
        run.logs.push({
          nodeId: id,
          state: 'skipped',
          summary: '条件未选择此分支。',
          reportedAt: at,
          resultObjectIds: [],
        });
      }
    }
  },
  dependency(run: WorkflowRun, node: WorkflowNode) {
    if (run.nodes[node.id]?.state === 'skipped')
      fail('WORKFLOW_SCOPE', '此组件已被条件分支或本次执行范围排除。');
    for (const edge of run.document.edges.filter((edge) => edge.target === node.id)) {
      if (this.inactive(run, edge)) {
        if (
          workflowPorts(node).inputs.some((port) => port.name === edge.targetPort && port.required)
        )
          fail('WORKFLOW_BRANCH', '此组件属于未选择分支。');
        continue;
      }
      if (run.nodes[edge.source]?.state !== 'succeeded')
        fail('WORKFLOW_DEPENDENCY', '上游组件尚未成功，不能处理当前组件。');
    }
  },
  inputOutputs(run: WorkflowRun, node: WorkflowNode): Record<string, WorkflowValue> {
    const first = workflowPorts(node).outputs[0];
    if (!first) fail('WORKFLOW_INPUT', '输入组件需要一个输出端口。');
    const mode = node.config.inputMode ?? 'files';
    let value: WorkflowValue =
      mode === 'text'
        ? { type: 'text', value: String(node.config.value ?? '') }
        : mode === 'json'
          ? { type: 'json', value: node.config.value as {} | null }
          : {
              type: 'files',
              value: (node.config.objectIds ?? []).map((objectId) => ({
                objectId,
                revision: run.expectedRevisions[objectId],
                ...(run.frozenFiles?.[objectId]
                  ? {
                      fileName: run.frozenFiles[objectId].fileName,
                      assetHash: run.frozenFiles[objectId].assetHash,
                    }
                  : {}),
              })),
            };
    if (mode === 'json' && ['table', 'browser-session'].includes(first.type)) {
      const parsed = WorkflowValueSchema.safeParse({ type: first.type, value: node.config.value });
      if (!parsed.success)
        fail('WORKFLOW_INPUT', `${node.label}：请填写符合 ${first.type} 格式的 JSON。`);
      value = parsed.data;
    }
    if (value.type === 'files' && first.type === 'file') {
      if (value.value.length !== 1) fail('WORKFLOW_INPUT', `${node.label}：请选择一个输入文件。`);
      value = { type: 'file', value: value.value[0] };
    }
    if (!workflowPortCompatible(value.type, first.type))
      fail('WORKFLOW_INPUT', '输入内容与输出端口类型不匹配。');
    return { [first.name]: value };
  }
};
