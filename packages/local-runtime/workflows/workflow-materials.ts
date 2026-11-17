// Frozen-material access for workflow runs: workflow document bytes, native
// file reads, run-write attribution, and file/artifact value extraction.
import { fail, FileContent, type DesktopObject } from '../../contracts/index.js';
import {
  WorkflowDocumentSchema,
  WORKFLOW_BYTE_LIMIT,
  type WorkflowDocument,
  type WorkflowRun,
  type WorkflowFileValue,
} from '../../contracts/workflows.js';
import type { WorkflowPythonRecord, WorkflowPythonSource } from './workflow-python.js';
import { sha, type Binding, type WorkflowRecordsMethods } from './workflow-records.js';
import type { Api } from './workflows.js';

/** The Workflows surface the material cluster relies on. */
export type WorkflowMaterialsHost = {
  api: Pick<Api, 'workbench' | 'object' | 'python'>;
} & Pick<WorkflowRecordsMethods, 'get' | 'run'>;

export interface WorkflowMaterialsMethods {
  bytes(document: WorkflowDocument): Buffer;
  read(
    w: string,
    c: string,
    s: string | null,
    objectId: string,
  ): { object: DesktopObject; document: WorkflowDocument };
  writtenByRun(w: string, run: WorkflowRun, id: string, revision: number): boolean;
  source(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    id: string,
    revision?: number,
  ): WorkflowPythonSource;
  file(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    value: WorkflowFileValue,
  ): WorkflowPythonSource & { path?: string };
  fileValues(value: unknown, depth?: number): WorkflowFileValue[];
}

export const workflowMaterials: WorkflowMaterialsMethods &
  ThisType<WorkflowMaterialsHost & WorkflowMaterialsMethods> = {
  bytes(document: WorkflowDocument) {
    const bytes = Buffer.from(
      JSON.stringify(WorkflowDocumentSchema.parse(document), null, 2) + '\n',
    );
    if (bytes.length > WORKFLOW_BYTE_LIMIT) fail('WORKFLOW_LIMIT', '工作流文件不能超过 1 MiB。');
    return bytes;
  },
  read(w: string, c: string, s: string | null, objectId: string) {
    const wb = this.api.workbench(w, c, s),
      object = wb.object(objectId);
    if (object.archived) fail('OBJECT_ARCHIVED', '工作流已移入回收站。');
    if (object.kind !== 'file') fail('WORKFLOW_FORMAT', '请选择原生 .flow.json 工作流文件。');
    const content = FileContent.parse(object.content);
    if (!/\.flow\.json$/i.test(content.fileName))
      fail('WORKFLOW_FORMAT', '请选择 Yirang .flow.json 文件；其他工作流格式尚未接入。');
    if (content.size > WORKFLOW_BYTE_LIMIT) fail('WORKFLOW_LIMIT', '工作流文件不能超过 1 MiB。');
    const bytes = wb.load(content.assetHash);
    if (bytes.length > WORKFLOW_BYTE_LIMIT) fail('WORKFLOW_LIMIT', '工作流文件不能超过 1 MiB。');
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      fail('WORKFLOW_FORMAT', '工作流必须是有效的 UTF-8 JSON 文件。');
    }
    const parsed = WorkflowDocumentSchema.safeParse(value);
    if (!parsed.success)
      fail('WORKFLOW_FORMAT', '不支持此工作流格式；请选择 Yirang .flow.json 文件。');
    return { object, document: parsed.data };
  },
  writtenByRun(w: string, run: WorkflowRun, id: string, revision: number) {
    const binding = this.get<Binding>(w, `workflow-binding:run:${run.parent?.rootRunId ?? run.id}`),
      contribution = this.get<{ snapshotId?: string }>(w, `contribution:${id}:${revision}`);
    return (
      !!binding &&
      !!contribution?.snapshotId &&
      [binding.owner, ...(binding.previousOwners ?? [])].includes(contribution.snapshotId)
    );
  },
  source(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    id: string,
    revision?: number,
  ): WorkflowPythonSource {
    if (!run.objectIds.includes(id)) fail('PERMISSION_DENIED', '文件不在本工作流授权范围内。');
    const wb = this.api.workbench(w, c, s),
      object = this.api.object(w, id),
      wanted = revision ?? run.expectedRevisions[id];
    if (wanted !== run.expectedRevisions[id] && !this.writtenByRun(w, run, id, wanted))
      fail('WORKFLOW_FILE', '文件版本不属于本次冻结输入或回写结果。');
    const snapshot = wanted === object.revision ? object : wb.history(id, wanted);
    if (object.kind !== 'file')
      return {
        objectId: id,
        revision: wanted,
        fileName: `${id}.json`,
        data: Buffer.from(JSON.stringify(snapshot.content)),
      };
    const content = FileContent.parse(snapshot.content),
      data = wb.load(content.assetHash);
    if (data.length !== content.size || sha(data) !== content.assetHash)
      fail('WORKFLOW_FILE', '原生文件与保存的摘要不一致。');
    const frozen = run.frozenFiles?.[id];
    if (frozen && wanted === frozen.revision && content.assetHash !== frozen.assetHash)
      fail('WORKFLOW_FILE', '组件代码或输入与冻结版本不一致。');
    return { objectId: id, revision: wanted, fileName: content.fileName, data };
  },
  file(
    w: string,
    c: string,
    s: string | null,
    run: WorkflowRun,
    value: WorkflowFileValue,
  ): WorkflowPythonSource & { path?: string } {
    if ('objectId' in value) {
      const file = this.source(w, c, s, run, value.objectId, value.revision);
      if (value.assetHash && sha(file.data) !== value.assetHash)
        fail('WORKFLOW_FILE', '文件端口摘要与实际原生文件不一致。');
      return file;
    }
    const artifact = run.artifacts?.[value.artifactId],
      owner = artifact?.ownerRunId ? this.run(w, artifact.ownerRunId) : run;
    if ((owner.parent?.rootRunId ?? owner.id) !== (run.parent?.rootRunId ?? run.id))
      fail('PERMISSION_DENIED', '文件不属于同一根流程');
    const record =
      artifact && (owner.nodes[artifact.nodeId]?.python as WorkflowPythonRecord | undefined);
    if (
      !artifact ||
      !record ||
      !this.api.python ||
      artifact.sha256 !== value.sha256 ||
      artifact.size !== value.size ||
      artifact.fileName !== value.fileName
    )
      fail('WORKFLOW_FILE', '产物不属于此运行已回收的文件。');
    const file = this.api.python.readArtifact(record, artifact);
    return {
      objectId: artifact.artifactId,
      revision: 1,
      fileName: file.fileName,
      data: file.data,
      path: file.path,
    };
  },
  fileValues(value: unknown, depth = 0): WorkflowFileValue[] {
    if (depth > 32) fail('WORKFLOW_LIMIT', '组件值嵌套不能超过 32 层。');
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((item) => this.fileValues(item, depth + 1));
    const v = value as Record<string, unknown>;
    if (
      typeof v.artifactId === 'string' &&
      typeof v.sha256 === 'string' &&
      typeof v.size === 'number'
    )
      return [v as WorkflowFileValue];
    if (
      typeof v.objectId === 'string' &&
      typeof v.revision === 'number' &&
      Object.keys(v).every((key) => ['objectId', 'revision', 'fileName', 'assetHash'].includes(key))
    )
      return [v as WorkflowFileValue];
    return Object.values(v).flatMap((item) => this.fileValues(item, depth + 1));
  }
};
