// Node execution lifecycle for workflows: execution-ref guards, builtin
// finish records, native builtin runs and subflow/repeat nesting.
import { fail } from '../../contracts/index.js';
import {
  WorkflowDocumentSchema,
  workflowField,
  type WorkflowRun,
  type WorkflowNode,
  type WorkflowValue,
  type WorkflowExecutionRef,
} from '../../contracts/workflows.js';
import type { ExecutionAuth } from '../files/native-tasks.js';
import { time, terminal, type Binding, type WorkflowRecordsMethods } from './workflow-records.js';
import type { WorkflowMaterialsMethods } from './workflow-materials.js';
import type { WorkflowGraphMethods } from './workflow-graph.js';
import type { WorkflowResolveMethods } from './workflow-resolve.js';
import type { WorkflowBatchesMethods } from './workflow-batches.js';
import type { Api } from './workflows.js';

/** The Workflows surface the execution cluster relies on. */
export type WorkflowExecutionHost = {
  api: Pick<Api, 'auth' | 'tx' | 'once' | 'event' | 'object'>;
} & Pick<WorkflowRecordsMethods, 'get' | 'put' | 'run'> &
  Pick<WorkflowMaterialsMethods, 'source' | 'file'> &
  Pick<WorkflowGraphMethods, 'dependency' | 'skipBranches'> &
  Pick<WorkflowResolveMethods, 'resolved' | 'validateOutputs'> &
  Pick<WorkflowBatchesMethods, 'prepareRun' | 'batchGate'>;

/** Result of finishing a builtin node. */
export type WorkflowBuiltinFinish = {
  run: WorkflowRun;
  outputs: Record<string, WorkflowValue>;
  reportSource: string;
  independentlyVerified: boolean;
};

/** Result of preparing or collecting a subflow/repeat child run. */
export type WorkflowNestedResult = {
  run: WorkflowRun;
  childRun?: WorkflowRun;
  nextAction?: string;
  alreadyCollected?: boolean;
  note?: string;
  iteration?: number;
  reused?: boolean;
};

export interface WorkflowExecutionMethods {
  execution(
    node: WorkflowNode,
    previous: WorkflowExecutionRef | undefined,
    next: WorkflowExecutionRef | undefined,
  ): WorkflowExecutionRef | undefined;
  finishBuiltin(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
    requestId: string,
    outputs: Record<string, WorkflowValue>,
    summary: string,
  ): WorkflowBuiltinFinish;
  nativeBuiltin(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
    requestId: string,
    owner: string,
  ): Promise<unknown>;
  nested(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
    auth: ExecutionAuth,
    operation: string,
    requestId: string,
  ): WorkflowNestedResult | WorkflowBuiltinFinish;
}

export const workflowExecution: WorkflowExecutionMethods &
  ThisType<WorkflowExecutionHost & WorkflowExecutionMethods> = {
  execution(
    node: WorkflowNode,
    previous: WorkflowExecutionRef | undefined,
    next: WorkflowExecutionRef | undefined,
  ) {
    if (previous && next && JSON.stringify(previous) !== JSON.stringify(next))
      fail('WORKFLOW_EXECUTION', '组件已有真实执行引用，请恢复原会话，不能替换为另一轮执行。');
    const ref = next ?? previous;
    if (
      (ref && node.type === 'python' && ref.kind !== 'python') ||
      (ref && node.type === 'browser' && ref.kind !== 'browser')
    )
      fail('WORKFLOW_EXECUTION', '执行引用类型与组件不一致。');
    return ref;
  },
  finishBuiltin(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
    requestId: string,
    outputs: Record<string, WorkflowValue>,
    summary: string,
  ) {
    const value = this.validateOutputs(w, c, s, run, node, outputs),
      at = time();
    run.nodes[node.id] = {
      ...run.nodes[node.id],
      state: 'succeeded',
      outputs: value,
      resultObjectIds: [],
      summary,
      reportedAt: at,
      builtinRequestId: requestId,
    };
    run.status = 'running';
    run.reportedAt = at;
    run.logs.push({
      nodeId: node.id,
      state: 'succeeded',
      summary,
      reportedAt: at,
      resultObjectIds: [],
    });
    this.skipBranches(run);
    this.put(w, `workflow-run:${run.id}`, run);
    this.api.event(w, 'workflow.reported', run.flowObjectId, run.flowRevision, 'ai');
    return { run, outputs: value, reportSource: 'codex_reported', independentlyVerified: false };
  },
  async nativeBuiltin(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
    requestId: string,
    owner: string,
  ) {
    if (run.nodes[node.id].builtinRequestId === requestId && terminal(run.nodes[node.id].state))
      return { run, outputs: run.nodes[node.id].outputs, reused: true };
    if (terminal(run.status) || terminal(run.nodes[node.id].state))
      fail('WORKFLOW_NODE_FINISHED', '内置组件已结束，不能覆盖终态。');
    if (run.logs.length >= 400) fail('WORKFLOW_LIMIT', '本次工作流回报已达到 400 条上限。');
    this.batchGate(w, run);
    const resolved = this.resolved(w, c, s, run, node),
      state = JSON.stringify(run.nodes[node.id]);
    const files = new Map<string, { fileName: string; bytes: Uint8Array }>();
    for (const ref of resolved.fileReferences) {
      const file = this.file(w, c, s, run, ref);
      files.set('objectId' in ref ? ref.objectId : ref.artifactId, {
        fileName: file.fileName,
        bytes: file.data,
      });
    }
    let outputs: Record<string, WorkflowValue> = {},
      error: string | undefined;
    try {
      const helper = await import('./workflow-native.js');
      outputs = await helper.executeNativeWorkflowNode(
        { ...node, config: { ...node.config, parameters: resolved.parameters } },
        resolved.inputs,
        files,
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return this.api.tx(() =>
      this.api.once(
        w,
        requestId,
        { type: 'workflow.execute_builtin', owner, runId: run.id, nodeId: node.id, requestId },
        () => {
          const auth = this.api.auth(w, c, s, 'execution'),
            binding = this.get<Binding>(w, `workflow-binding:run:${run.id}`),
            latest = this.run(w, run.id);
          if (
            auth.status !== 'active' ||
            auth.owner !== owner ||
            binding?.owner !== owner ||
            binding.session !== s
          )
            fail('PERMISSION_DENIED', '内置组件完成前执行授权已改变，请恢复原运行。');
          if (JSON.stringify(latest.nodes[node.id]) !== state || terminal(latest.status))
            fail('WORKFLOW_CONFLICT', '组件状态在解析期间已改变，请读取最新记录。');
          if (latest.logs.length >= 400)
            fail('WORKFLOW_LIMIT', '本次工作流回报已达到 400 条上限。');
          for (const id of latest.objectIds) {
            const item = this.api.object(w, id);
            if (!auth.scope.includes(id) || item.archived || item.policy?.private)
              fail('PERMISSION_DENIED', '解析期间材料权限发生变化。');
          }
          if (!error) {
            try {
              return this.finishBuiltin(
                w,
                c,
                s,
                latest,
                node,
                requestId,
                outputs,
                node.type === 'extract' ? '原生文件提取完成。' : '图表已生成 SVG 输出。',
              );
            } catch (cause) {
              error = cause instanceof Error ? cause.message : String(cause);
            }
          }
          const at = time(),
            summary = (error ?? '内置组件处理失败。').slice(0, 4000);
          latest.nodes[node.id] = {
            ...latest.nodes[node.id],
            state: 'failed',
            summary,
            reportedAt: at,
            builtinRequestId: requestId,
          };
          latest.status = 'failed';
          latest.reportedAt = at;
          latest.logs.push({
            nodeId: node.id,
            state: 'failed',
            summary,
            reportedAt: at,
            resultObjectIds: [],
          });
          this.put(w, `workflow-run:${latest.id}`, latest);
          this.api.event(w, 'workflow.reported', latest.flowObjectId, latest.flowRevision, 'ai');
          return { run: latest, error: summary };
        },
      ),
    );
  },
  nested(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    node: WorkflowNode,
    auth: ExecutionAuth,
    operation: string,
    requestId: string,
  ) {
    if (node.type !== 'subflow' && node.type !== 'repeat')
      fail('WORKFLOW_SUBFLOW', '请选择子流程或有界循环组件');
    const status = run.nodes[node.id];
    if (terminal(status.state)) fail('WORKFLOW_FINISHED', '此组件已结束');
    this.dependency(run, node);
    const childIds = (status.childRunIds ??= []),
      lastId = childIds.at(-1),
      child = lastId ? this.run(w, lastId) : undefined;
    if (operation === 'collect_subflow') {
      if (!child) fail('WORKFLOW_SUBFLOW', '请先准备子流程');
      if (status.collectedChildId === child.id)
        return { run, childRun: child, nextAction: 'prepare_subflow', alreadyCollected: true };
      if (!terminal(child.status))
        return {
          run,
          childRun: child,
          nextAction: 'continue_child',
          note: '先恢复该子流程，不要另起一次执行',
        };
      if (child.status !== 'succeeded') {
        status.state = 'failed';
        status.summary = `子流程第 ${childIds.length} 次执行失败`;
        run.status = 'failed';
        this.put(w, `workflow-run:${run.id}`, run);
        return { run, childRun: child };
      }
      const value =
        child.nodes[node.config.childResultNodeId!]?.outputs?.[
          node.config.childResultPort || 'result'
        ];
      if (!value) fail('WORKFLOW_SUBFLOW', '子流程结果端口没有实际输出');
      run.artifacts = {
        ...run.artifacts,
        ...Object.fromEntries(
          Object.entries(child.artifacts ?? {}).map(([id, item]) => [
            id,
            { ...item, ownerRunId: item.ownerRunId ?? child.id },
          ]),
        ),
      };
      const unchanged =
          childIds.length > 1 &&
          JSON.stringify(status.lastChildValue) === JSON.stringify(value.value),
        stopped = node.config.stopWhenPath
          ? Boolean(workflowField(value.value, node.config.stopWhenPath))
          : false;
      status.collectedChildId = child.id;
      status.lastChildValue = value.value;
      if (
        node.type === 'subflow' ||
        childIds.length >= (node.config.maxIterations ?? 3) ||
        stopped ||
        unchanged
      )
        return this.finishBuiltin(
          w,
          c,
          s,
          run,
          node,
          requestId,
          { result: { type: 'json', value: value.value } },
          `子流程已完成 ${childIds.length} 次${unchanged ? '，结果未变化，停止循环' : stopped ? '，达到停止条件' : ''}`,
        );
      status.summary = `第 ${childIds.length} 次已完成，可继续下一次`;
      this.put(w, `workflow-run:${run.id}`, run);
      return { run, nextAction: 'prepare_subflow', iteration: childIds.length + 1 };
    }
    if (child && status.collectedChildId !== child.id)
      return {
        run,
        childRun: child,
        nextAction: terminal(child.status) ? 'collect_subflow' : 'continue_child',
        reused: true,
      };
    const rootId = run.parent?.rootRunId ?? run.id,
      depth = (run.parent?.depth ?? 0) + 1;
    if (depth > 4) fail('WORKFLOW_DEPTH', '最多嵌套 4 层');
    const counter = this.get<number>(w, `workflow-child-count:${rootId}`) ?? 0;
    if (counter >= 120) fail('WORKFLOW_BUDGET', '本次任务已达到 120 个子流程执行上限');
    const source = this.source(w, c, s, run, node.config.flowObjectId!),
      object = this.api.object(w, source.objectId);
    if (object.revision !== source.revision)
      fail('REVISION_CONFLICT', '子流程文件已变化，请重新准备主流程');
    const document = WorkflowDocumentSchema.parse(JSON.parse(source.data.toString('utf8'))),
      input = document.nodes.find((item) => item.id === node.config.childInputNodeId);
    if (!input || input.type !== 'input' || input.config.inputMode !== 'json')
      fail('WORKFLOW_SUBFLOW', '子流程入口必须是 JSON 输入组件');
    const initial = this.resolved(w, c, s, run, node).values.input;
    input.config.value = child ? status.lastChildValue : initial;
    const next = this.prepareRun(w, auth, object, document);
    if (next.objectIds.some((id) => !run.objectIds.includes(id) || !auth.scope.includes(id)))
      fail('PERMISSION_DENIED', '子流程不能扩大已确认的材料范围');
    next.parent = {
      runId: run.id,
      nodeId: node.id,
      iteration: childIds.length + 1,
      rootRunId: rootId,
      depth,
    };
    next.artifacts = Object.fromEntries(
      Object.entries(run.artifacts ?? {}).map(([id, item]) => [
        id,
        { ...item, ownerRunId: item.ownerRunId ?? run.id },
      ]),
    );
    status.childRunIds = [...childIds, next.id];
    status.state = 'running';
    status.summary = `正在执行子流程 · 第 ${status.childRunIds.length} 次`;
    run.status = 'running';
    this.put(w, `workflow-run:${next.id}`, next);
    this.put(w, `workflow-run:${run.id}`, run);
    this.put(w, `workflow-child-count:${rootId}`, counter + 1);
    this.api.event(w, 'workflow.prepared', run.flowObjectId, run.flowRevision, 'ai');
    return {
      run,
      childRun: next,
      nextAction: 'execute_child',
      note: '使用同一凭据，以 childRun.id 调用流程工具。完成后回到父节点 collect_subflow。',
    };
  }
};
