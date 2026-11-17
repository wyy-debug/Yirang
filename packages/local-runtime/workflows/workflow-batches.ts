// Run preparation and batch installation for workflows: frozen run planning,
// idempotent batch/retry creation, batch views and batch execution gating.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fail, FileContent, type DesktopObject } from '../../contracts/index.js';
import {
  WorkflowDocumentSchema,
  WORKFLOW_BYTE_LIMIT,
  planWorkflow,
  workflowParameterFileIds,
  type WorkflowDocument,
  type WorkflowRun,
  type WorkflowBatch,
} from '../../contracts/workflows.js';
import type { ExecutionAuth } from '../files/native-tasks.js';
import { time, sha, terminal, type WorkflowRecordsMethods } from './workflow-records.js';
import type { WorkflowMaterialsMethods } from './workflow-materials.js';
import type { WorkflowGraphMethods } from './workflow-graph.js';
import type { Api, WorkflowAction } from './workflows.js';

/** The Workflows surface the batch cluster relies on. */
export type WorkflowBatchesHost = {
  db: DatabaseSync;
  api: Pick<Api, 'workbench' | 'object' | 'load' | 'assertReady' | 'tx' | 'event'>;
} & Pick<WorkflowRecordsMethods, 'get' | 'put' | 'run'> &
  Pick<WorkflowMaterialsMethods, 'bytes' | 'read' | 'fileValues' | 'file'> &
  Pick<WorkflowGraphMethods, 'node' | 'skipBranches'>;

/** Batch record enriched with live per-item run state. */
export type WorkflowBatchView = WorkflowBatch & {
  items: (WorkflowBatch["items"][number] & {
    status: WorkflowRun['status'];
    nodes: WorkflowRun['nodes'];
    resultObjectIds: string[];
    objectIds: string[];
    expectedRevisions: Record<string, number>;
  })[];
};

type BatchInstallation = {
  signature: string;
  batch: WorkflowBatch;
  document: WorkflowDocument;
  expectedRevisions: Record<string, number>;
  plans: { itemId: string; inputId: string; runId: string; attempt: number; slot: number }[];
  previousBatch?: string;
  complete?: boolean;
};

export interface WorkflowBatchesMethods {
  prepareRun(
    w: string,
    auth: ExecutionAuth,
    object: DesktopObject,
    document: WorkflowDocument,
  ): WorkflowRun;
  savePrepared(w: string, run: WorkflowRun): {
    run: WorkflowRun;
    objectIds: string[];
    expectedRevisions: Record<string, number>;
  };
  batchView(w: string, batch: WorkflowBatch): WorkflowBatchView;
  applyPartial(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    fromRunId: string,
    nodeIds: string[],
    includeDownstream: boolean,
  ): void;
  batchChild(
    w: string,
    c: string,
    s: string | null,
    auth: ExecutionAuth,
    object: DesktopObject,
    document: WorkflowDocument,
    batchId: string,
    itemId: string,
    inputId: string,
    attempt: number,
    slot: number,
    runId: string,
  ): WorkflowRun;
  batchAction(
    w: string,
    c: string,
    s: string | null,
    auth: ExecutionAuth,
    p: Extract<z.infer<typeof WorkflowAction>, { operation: 'prepare_batch' | 'retry_batch' }>,
  ): { batch: WorkflowBatchView; runs: WorkflowRun[]; note?: string };
  batchGate(w: string, run: WorkflowRun): void;
}

export const workflowBatches: WorkflowBatchesMethods &
  ThisType<WorkflowBatchesHost & WorkflowBatchesMethods> = {
  prepareRun(
    w: string,
    auth: ExecutionAuth,
    object: DesktopObject,
    document: WorkflowDocument,
  ): WorkflowRun {
    const plan = planWorkflow(document);
    if (!plan.valid) fail('WORKFLOW_INVALID', plan.issues.join('\n'));
    const nestedIds = new Set<string>();
    const visit = (flow: WorkflowDocument, chain: string[]) => {
      if (chain.length > 4) fail('WORKFLOW_DEPTH', '子流程最多嵌套 4 层');
      for (const node of flow.nodes)
        if (node.type === 'subflow' || node.type === 'repeat') {
          const id = node.config.flowObjectId!;
          if (chain.includes(id))
            fail('WORKFLOW_RECURSION', '子流程不能递归引用自身，请使用有界循环组件');
          const child = this.api.object(w, id);
          if (child.archived || child.policy?.private || child.kind !== 'file')
            fail('PERMISSION_DENIED', '子流程不可用');
          const content = FileContent.parse(child.content);
          if (content.size > WORKFLOW_BYTE_LIMIT) fail('WORKFLOW_LIMIT', '子流程文件过大');
          const parsed = WorkflowDocumentSchema.parse(
              JSON.parse(this.api.load(content.assetHash).toString('utf8')),
            ),
            childPlan = planWorkflow(parsed);
          if (!childPlan.valid) fail('WORKFLOW_INVALID', childPlan.issues.join('\n'));
          nestedIds.add(id);
          for (const input of childPlan.objectIds) nestedIds.add(input);
          visit(parsed, [...chain, id]);
        }
    };
    visit(document, [object.id]);
    const objectIds = [...new Set([object.id, ...plan.objectIds, ...nestedIds])];
    if (objectIds.length > 10)
      fail('WORKFLOW_LIMIT', '工作流、子流程、代码、输入和结果材料合计不能超过 10 份。');
    const expectedRevisions: Record<string, number> = {},
      frozenFiles: NonNullable<WorkflowRun['frozenFiles']> = {};
    for (const id of objectIds) {
      const item = this.api.object(w, id);
      if (item.archived || item.policy?.private)
        fail('PERMISSION_DENIED', '工作流引用了已删除或禁止交给 AI 的材料。');
      this.api.assertReady(w, id, auth.owner);
      expectedRevisions[id] = item.revision;
      if (item.kind === 'file') {
        const content = FileContent.parse(item.content);
        frozenFiles[id] = {
          objectId: id,
          revision: item.revision,
          fileName: content.fileName,
          assetHash: content.assetHash,
          size: content.size,
        };
      }
    }
    for (const node of document.nodes) {
      if (node.type === 'output') {
        const target = this.api.object(w, node.config.targetObjectId!);
        if (target.id === object.id)
          fail('WORKFLOW_OUTPUT', '结果不能覆盖工作流自身，请选择其他桌面材料。');
        if (target.policy?.locked || target.policy?.protectedRanges.length)
          fail('PERMISSION_DENIED', `${node.label} 的回写对象被锁定或包含保护范围。`);
      }
      if (node.type === 'python') {
        const code = frozenFiles[node.config.codeObjectId!];
        if (!code || !/\.py$/i.test(code.fileName))
          fail('WORKFLOW_PYTHON_SOURCE', `${node.label}：请选择原生 .py 文件。`);
        if (node.config.requirementsObjectId && !frozenFiles[node.config.requirementsObjectId])
          fail('WORKFLOW_PYTHON_SOURCE', '依赖清单必须是原生文本文件。');
      }
    }
    return {
      id: `flow_run_${randomUUID()}`,
      flowObjectId: object.id,
      flowRevision: object.revision,
      name: document.name,
      createdAt: time(),
      status: 'prepared',
      document,
      order: plan.order,
      objectIds,
      expectedRevisions,
      frozenFiles,
      artifacts: {},
      nodes: Object.fromEntries(
        document.nodes.map((n) => [n.id, { state: 'pending', resultObjectIds: [] }]),
      ),
      logs: [],
      reportSource: 'codex_reported',
      independentlyVerified: false,
    };
  },
  savePrepared(w: string, run: WorkflowRun) {
    this.put(w, `workflow-run:${run.id}`, run);
    this.api.event(w, 'workflow.prepared', run.flowObjectId, run.flowRevision, 'human');
    return { run, objectIds: run.objectIds, expectedRevisions: run.expectedRevisions };
  },
  batchView(w: string, batch: WorkflowBatch) {
    return {
      ...batch,
      items: batch.items.map((item) => {
        const run = this.run(w, item.runId);
        return {
          ...item,
          status: run.status,
          nodes: run.nodes,
          resultObjectIds: [
            ...new Set(Object.values(run.nodes).flatMap((node) => node.resultObjectIds)),
          ],
          objectIds: run.objectIds,
          expectedRevisions: run.expectedRevisions,
        };
      }),
    };
  },
  applyPartial(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    fromRunId: string,
    nodeIds: string[],
    includeDownstream: boolean,
  ) {
    const prior = this.run(w, fromRunId);
    if (prior.restoredAt) fail('WORKFLOW_REUSE', '备份历史不能用作可执行缓存。');
    if (prior.flowObjectId !== run.flowObjectId)
      fail('WORKFLOW_REUSE', '仅可复用同一流程的历史输出。');
    const chosen = new Set(nodeIds);
    for (const id of chosen) this.node(run, id);
    for (const id of chosen)
      if (
        prior.nodes[id] &&
        ['running', 'waiting'].includes(prior.nodes[id].state) &&
        ['mcp', 'browser', 'skill', 'python', 'prompt', 'output', 'subflow', 'repeat'].includes(
          this.node(run, id).type,
        )
      )
        fail('WORKFLOW_REUSE', '所选组件仍在运行或等待，请恢复原执行并明确结束，再决定是否重跑。');
    const active = new Set(chosen),
      todo = [...chosen];
    if (includeDownstream)
      while (todo.length) {
        const current = todo.shift();
        for (const edge of run.document.edges.filter((edge) => edge.source === current))
          if (!active.has(edge.target)) {
            active.add(edge.target);
            todo.push(edge.target);
          }
      }
    for (const node of run.document.nodes)
      if (
        active.has(node.id) &&
        !chosen.has(node.id) &&
        ['mcp', 'browser', 'skill', 'python', 'prompt', 'output', 'subflow', 'repeat'].includes(
          node.type,
        )
      )
        fail('WORKFLOW_REUSE', `${node.label} 可能产生外部效果，请明确选中该组件后重跑。`);
    const needed = new Set<string>(),
      ancestors = [...active];
    while (ancestors.length) {
      const id = ancestors.shift();
      for (const edge of run.document.edges.filter((edge) => edge.target === id))
        if (!active.has(edge.source) && !needed.has(edge.source)) {
          needed.add(edge.source);
          ancestors.push(edge.source);
        }
    }
    for (const node of run.document.nodes) {
      if (active.has(node.id)) continue;
      if (!needed.has(node.id)) {
        run.nodes[node.id] = {
          state: 'skipped',
          skipReason: 'scope',
          summary: '不在本次单步或局部执行范围内。',
          resultObjectIds: [],
        };
        continue;
      }
      const previous = prior.document.nodes.find((item) => item.id === node.id),
        status = prior.nodes[node.id];
      if (run.document.edges.some((edge) => edge.target === node.id && active.has(edge.source)))
        fail(
          'WORKFLOW_REUSE',
          `${node.label} 的上游本次会重新运行，请把此组件也加入执行范围，避免复用过期结果。`,
        );
      const signature = (document: WorkflowDocument, id: string) => {
        const n = document.nodes.find((item) => item.id === id);
        return JSON.stringify({
          type: n?.type,
          config: n?.config,
          edges: document.edges
            .filter((edge) => edge.target === id)
            .map(({ source, sourcePort, targetPort }) => ({ source, sourcePort, targetPort }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        });
      };
      if (!previous || signature(run.document, node.id) !== signature(prior.document, node.id))
        fail('WORKFLOW_REUSE', `${node.label} 的配置或上游连线已改变，请把它加入本次执行范围。`);
      const readIds = [
        ...workflowParameterFileIds(node),
        ...(node.type === 'input'
          ? (node.config.objectIds ?? [])
          : node.type === 'python'
            ? [node.config.codeObjectId, node.config.requirementsObjectId].filter(
                (id): id is string => !!id,
              )
            : []),
      ];
      for (const id of readIds)
        if (prior.expectedRevisions[id] !== run.expectedRevisions[id])
          fail('WORKFLOW_REUSE', `${node.label} 使用的文件或脚本版本已改变，请重新运行此组件。`);
      if (status?.state !== 'succeeded' || !status.outputs)
        fail('WORKFLOW_REUSE', `${node.label} 没有可复用的成功输出，请把它加入本次执行范围。`);
      if (
        node.type === 'browser' ||
        this.fileValues(status.outputs).some((ref) => 'artifactId' in ref) ||
        Object.values(status.outputs).some((value) => value.type === 'browser-session')
      )
        fail(
          'WORKFLOW_REUSE',
          `${node.label} 包含旧执行产物或浏览器会话，请恢复旧运行或明确重新运行。`,
        );
      for (const file of this.fileValues(status.outputs)) {
        if ('objectId' in file && this.api.object(w, file.objectId).revision !== file.revision)
          fail('WORKFLOW_REUSE', `${node.label} 的文件输出已改变，不能复用旧版本。`);
        this.file(w, c, s, run, file);
      }
      run.nodes[node.id] = {
        state: 'succeeded',
        summary: `复用 ${prior.id} 中版本一致的输出。`,
        resultObjectIds: status.resultObjectIds,
        outputs: status.outputs,
        reusedFromRunId: prior.id,
      };
    }
    run.scope = { fromRunId, nodeIds: [...chosen], includeDownstream, reusedNodeIds: [...needed] };
    this.skipBranches(run);
  },
  batchChild(
    w: string,
    c: string,
    s: string | null,
    auth: ExecutionAuth,
    object: DesktopObject,
    document: WorkflowDocument,
    batchId: string,
    itemId: string,
    inputId: string,
    attempt: number,
    slot: number,
    runId: string,
  ) {
    const existing = this.get<WorkflowRun>(w, `workflow-run:${runId}`);
    if (existing) return existing;
    const wb = this.api.workbench(w, c, s),
      copy = structuredClone(document);
    delete copy.batch;
    const input = copy.nodes.find((node) => node.id === document.batch?.inputNodeId);
    if (!input) fail('WORKFLOW_BATCH', '请选择批处理文件输入。');
    input.config.objectIds = [inputId];
    const source = this.api.object(w, inputId),
      sourceName =
        source.kind === 'file' ? FileContent.parse(source.content).fileName : source.title;
    const targets = new Map<string, string>();
    for (const node of copy.nodes.filter((node) => node.type === 'output')) {
      const oldId = node.config.targetObjectId!;
      if (targets.has(oldId)) {
        node.config.targetObjectId = targets.get(oldId);
        continue;
      }
      const target = this.api.object(w, oldId);
      if (target.kind !== 'file')
        fail('WORKFLOW_BATCH', '批处理结果目标需要原生文件，每份输入将生成独立结果副本。');
      if (
        target.archived ||
        target.policy?.private ||
        target.policy?.locked ||
        target.policy?.protectedRanges.length
      )
        fail('PERMISSION_DENIED', '批处理结果模板不能是已删除、私有或受保护对象。');
      this.api.assertReady(w, oldId, auth.owner);
      const content = FileContent.parse(target.content),
        name =
          `${sourceName.replace(/\.[^.]+$/, '').slice(0, 60)}-${attempt > 1 ? `retry${attempt}-` : ''}${content.fileName}`.slice(
            -220,
          );
      const created = wb.create(
        `batch_${sha(`${batchId}:${itemId}:${attempt}:${oldId}`).slice(0, 48)}`,
        name,
        wb.load(content.assetHash),
        {
          ...target.bounds,
          x: Math.min(
            99000,
            target.bounds.x + 48 * attempt + (slot % 3) * (target.bounds.width + 24),
          ),
          y: Math.min(
            99000,
            target.bounds.y + 48 + Math.floor(slot / 3) * (target.bounds.height + 24),
          ),
        },
      );
      targets.set(oldId, created.id);
      node.config.targetObjectId = created.id;
    }
    const run = this.prepareRun(w, auth, object, copy);
    run.id = runId;
    run.batch = { batchId, itemId, attempt };
    this.api.tx(() => this.savePrepared(w, run));
    return run;
  },
  /** Creation crosses independent native-file transactions. Persist the frozen plan first;
   * stable per-file receipts resume a partial creation without duplicate result objects. */
  batchAction(
    w: string,
    c: string,
    s: string | null,
    auth: ExecutionAuth,
    p: Extract<z.infer<typeof WorkflowAction>, { operation: 'prepare_batch' | 'retry_batch' }>,
  ): { batch: WorkflowBatchView; runs: WorkflowRun[]; note?: string } {
    const key = `workflow-batch-install:${sha(p.requestId)}`,
      signature = JSON.stringify(p);
    let installation = this.get<BatchInstallation>(w, key);
    if (installation && installation.signature !== signature)
      fail('REQUEST_REUSED', '此批处理请求已用于不同参数，请继续原请求。');
    if (!installation) {
      if (p.operation === 'prepare_batch') {
        const { object, document } = this.read(w, c, s, p.objectId);
        if (object.revision !== p.expectedRevision)
          fail('REVISION_CONFLICT', '流程已改变，请先保存最新版。');
        const frozen = this.prepareRun(w, auth, object, document);
        const input = document.nodes.find((node) => node.id === document.batch?.inputNodeId);
        if (input?.type !== 'input' || (input.config.inputMode ?? 'files') !== 'files')
          fail('WORKFLOW_BATCH', '请在流程中配置批处理的文件输入。');
        const inputIds = [...new Set(input.config.objectIds ?? [])];
        if (!inputIds.length) fail('WORKFLOW_BATCH', '请添加批处理文件。');
        const batch: WorkflowBatch = {
          id: `flow_batch_${sha(p.requestId).slice(0, 36)}`,
          flowObjectId: object.id,
          flowRevision: object.revision,
          createdAt: time(),
          continueOnError: document.batch?.continueOnError ?? false,
          items: [],
        };
        const plans = inputIds.map((inputId, slot) => {
          const itemId = `item_${sha(`${p.requestId}:${slot}`).slice(0, 36)}`,
            runId = `flow_run_${sha(`${p.requestId}:${itemId}`).slice(0, 36)}`,
            item = this.api.object(w, inputId);
          batch.items.push({
            id: itemId,
            objectId: inputId,
            fileName: item.kind === 'file' ? FileContent.parse(item.content).fileName : item.title,
            runId,
            attempt: 1,
            previousRunIds: [],
          });
          return { itemId, inputId, runId, attempt: 1, slot };
        });
        installation = {
          signature,
          batch,
          document,
          expectedRevisions: frozen.expectedRevisions,
          plans,
        };
      } else {
        const previous = this.get<WorkflowBatch>(w, `workflow-batch:${p.batchId}`);
        if (!previous) fail('NOT_FOUND', '批处理记录不存在。');
        if (previous.restoredAt) fail('WORKFLOW_RECOVERY', '备份批处理仅供查看，请创建新批处理。');
        const pending = this.get<{ requestId: string }>(w, `workflow-batch-pending:${p.batchId}`);
        if (pending && pending.requestId !== p.requestId) {
          const previousInstall = this.get<BatchInstallation>(
              w,
              `workflow-batch-install:${sha(pending.requestId)}`,
            ),
            previousRequest = previousInstall
              ? (JSON.parse(previousInstall.signature) as { itemIds?: string[] })
              : undefined;
          if (
            previousRequest?.itemIds &&
            JSON.stringify([...new Set(previousRequest.itemIds)].sort()) ===
              JSON.stringify([...new Set(p.itemIds)].sort())
          )
            return this.batchAction(w, c, s, auth, { ...p, requestId: pending.requestId });
          fail(
            'WORKFLOW_BATCH_PENDING',
            '另一些失败项目的重试创建尚未完成，请先对相同项目继续重试，避免重复创建结果。',
          );
        }
        const { object, document } = this.read(w, c, s, previous.flowObjectId);
        if (object.revision !== previous.flowRevision)
          fail('REVISION_CONFLICT', '流程已更新，请创建新的批处理。');
        const frozen = this.prepareRun(w, auth, object, document),
          batch = structuredClone(previous);
        const plans = [...new Set(p.itemIds)].map((itemId) => {
          const slot = batch.items.findIndex((item) => item.id === itemId),
            item = batch.items[slot];
          if (!item) fail('NOT_FOUND', '批处理项目不存在。');
          const run = this.run(w, item.runId);
          if (run.restoredAt) fail('WORKFLOW_RECOVERY', '备份运行不能直接重试。');
          if (run.status !== 'failed')
            fail('WORKFLOW_BATCH', '仅失败项目可以显式重试，等待中请恢复原运行。');
          for (const id of run.objectIds) {
            if (
              id === run.flowObjectId ||
              run.document.nodes.some(
                (node) => node.type === 'output' && node.config.targetObjectId === id,
              )
            )
              continue;
            if (this.api.object(w, id).revision !== run.expectedRevisions[id])
              fail('REVISION_CONFLICT', '输入或脚本已改变，请创建新批处理。');
          }
          item.previousRunIds.push(item.runId);
          item.attempt++;
          item.runId = `flow_run_${sha(`${p.requestId}:${item.id}`).slice(0, 36)}`;
          return {
            itemId: item.id,
            inputId: item.objectId,
            runId: item.runId,
            attempt: item.attempt,
            slot,
          };
        });
        installation = {
          signature,
          batch,
          document,
          expectedRevisions: frozen.expectedRevisions,
          plans,
          previousBatch: JSON.stringify(previous),
        };
      }
      const frozen = installation;
      this.api.tx(() => {
        this.put(w, key, frozen);
        if (p.operation === 'retry_batch')
          this.put(w, `workflow-batch-pending:${p.batchId}`, { requestId: p.requestId });
      });
    }
    if (installation.complete) {
      const batch =
        this.get<WorkflowBatch>(w, `workflow-batch:${installation.batch.id}`) ?? installation.batch;
      return {
        batch: this.batchView(w, batch),
        runs: installation.plans.map((plan) => this.run(w, plan.runId)),
      };
    }
    for (const [id, revision] of Object.entries(installation.expectedRevisions)) {
      const item = this.api.object(w, id);
      if (item.archived || item.policy?.private)
        fail('PERMISSION_DENIED', '批处理创建中的材料不可用。');
      this.api.assertReady(w, id, auth.owner);
      if (item.revision !== revision) {
        if (p.operation === 'retry_batch')
          this.db
            .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
            .run(w, `workflow-batch-pending:${p.batchId}`);
        fail(
          'REVISION_CONFLICT',
          '创建尚未完成时原材料已改变；已创建文件保留，请重新准备新的批处理。',
        );
      }
    }
    const object = this.api.object(w, installation.batch.flowObjectId),
      runs = installation.plans.map((plan) =>
        this.batchChild(
          w,
          c,
          s,
          auth,
          object,
          installation!.document,
          installation!.batch.id,
          plan.itemId,
          plan.inputId,
          plan.attempt,
          plan.slot,
          plan.runId,
        ),
      );
    const complete = installation;
    this.api.tx(() => {
      if (
        complete.previousBatch &&
        JSON.stringify(this.get<WorkflowBatch>(w, `workflow-batch:${complete.batch.id}`)) !==
          complete.previousBatch
      )
        fail('WORKFLOW_CONFLICT', '批处理历史已变化，保留本次创建的文件，请刷新记录。');
      this.put(w, `workflow-batch:${complete.batch.id}`, complete.batch);
      complete.complete = true;
      this.put(w, key, complete);
      if (p.operation === 'retry_batch')
        this.db
          .prepare('DELETE FROM settings WHERE workspace=? AND key=?')
          .run(w, `workflow-batch-pending:${p.batchId}`);
    });
    return {
      batch: this.batchView(w, installation.batch),
      runs,
      note:
        p.operation === 'retry_batch'
          ? '用户显式重试；执行前核对旧运行可能已经产生的外部效果。'
          : '批处理已准备，尚未执行。',
    };
  },
  batchGate(w: string, run: WorkflowRun) {
    if (!run.batch) return;
    const batch = this.get<WorkflowBatch>(w, `workflow-batch:${run.batch.batchId}`);
    if (!batch) fail('WORKFLOW_BATCH', '找不到本次批处理记录。');
    if (batch.restoredAt) fail('WORKFLOW_RECOVERY', '恢复的批处理仅供查看，请创建新运行。');
    const index = batch.items.findIndex((item) => item.id === run.batch!.itemId);
    if (index < 0 || batch.items[index].runId !== run.id)
      fail('WORKFLOW_BATCH', '此运行已由用户显式重试替代，请查看最新项目。');
    for (const item of batch.items.slice(0, index)) {
      const previous = this.run(w, item.runId);
      if (!terminal(previous.status))
        fail('WORKFLOW_BATCH_WAIT', '批处理按文件顺序执行，请先完成前面的文件。');
      if (previous.status === 'failed' && !batch.continueOnError)
        fail('WORKFLOW_BATCH_STOPPED', '前面的文件失败；当前设置为遇错停止，请处理失败项后继续。');
    }
  }
};
