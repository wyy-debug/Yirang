import { z } from 'zod';
import type { CanvasBoard } from './canvas-board.js';
export {
  CanvasMarkSchema,
  CanvasLinkSchema,
  CanvasBoardSchema,
  CanvasBoardAction,
  emptyCanvasBoard,
} from './canvas-board.js';
export type { CanvasMark, CanvasLink, CanvasBoard, CanvasBoardInput } from './canvas-board.js';

export const Id = z.string().min(1).max(150);
export const Bounds = z
  .object({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
    width: z.number().min(100).max(3000),
    height: z.number().min(80).max(3000),
  })
  .strict();
export const Viewport = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().min(0.1).max(4),
  })
  .strict();
export const Annotation = z
  .object({
    id: Id,
    type: z.enum(['rect', 'ellipse', 'arrow', 'pen', 'text']),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
    note: z.string().max(1000),
    points: z
      .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict())
      .max(500)
      .optional(),
  })
  .strict()
  .refine((a) => a.x + a.width <= 1.001 && a.y + a.height <= 1.001);
export const FileContent = z
  .object({
    assetHash: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.string().max(120),
    size: z.number().int().nonnegative(),
    fileName: z.string().min(1).max(120),
    storage: z.literal('native').optional(),
    sourceRelativePath: z.string().max(1024).optional(),
    sourceModifiedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export const RelativeFilePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => {
    const parts = path.split('/');
    return (
      parts.length <= 32 &&
      parts.every(
        (part) =>
          part.length > 0 &&
          part.length <= 120 &&
          part !== '.' &&
          part !== '..' &&
          !/[\\:\u0000-\u001f]/.test(part),
      )
    );
  }, '请使用有效的文件夹相对路径。');
export const FolderName = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (name) =>
      name.trim().length > 0 && name !== '.' && name !== '..' && !/[\\/:\u0000-\u001f]/.test(name),
  );
export const FileTreeSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    folders: z
      .array(z.object({ id: Id, name: FolderName, parentId: Id.nullable() }).strict())
      .max(1000),
    locations: z.record(Id, Id),
  })
  .strict();
export type FileTree = z.infer<typeof FileTreeSchema>;
export const SelectionRange = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('native'),
      selectionId: Id,
      baseRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('file_text'),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      baseRevision: z.number().int().positive(),
    })
    .strict()
    .refine((r) => r.end > r.start && r.end - r.start <= 24000),
  z
    .object({
      type: z.enum(['text', 'code']),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      baseRevision: z.number().int().positive(),
    })
    .strict()
    .refine((r) => r.end > r.start),
  z
    .object({
      type: z.literal('cells'),
      rowIds: z.array(Id).min(1).max(500),
      columnIds: z.array(Id).min(1).max(50),
      baseRevision: z.number().int().positive(),
    })
    .strict(),
]);
export type MaterialRange = z.infer<typeof SelectionRange>;
const uniqueIds = (max: number) =>
  z
    .array(Id)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, '范围内的 ID 必须唯一。');
export const ProtectionRange = z.union([
  SelectionRange,
  z
    .object({
      type: z.literal('diagram'),
      nodeIds: uniqueIds(100),
      edgeIds: uniqueIds(200),
      baseRevision: z.number().int().positive(),
    })
    .strict()
    .refine((range) => range.nodeIds.length + range.edgeIds.length > 0, '请选择节点或连线。'),
  z
    .object({
      type: z.literal('slides'),
      slideIds: uniqueIds(50).refine((ids) => ids.length > 0),
      baseRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sheets'),
      sheetIds: uniqueIds(12).refine((ids) => ids.length > 0),
      baseRevision: z.number().int().positive(),
    })
    .strict(),
]);
export type ProtectionTarget = z.infer<typeof ProtectionRange>;
export const ProtectedRange = z
  .object({
    id: Id,
    range: ProtectionRange,
    note: z.string().max(500),
    stale: z.boolean().default(false),
  })
  .strict();
export const ObjectPolicy = z
  .object({
    private: z.boolean(),
    locked: z.boolean(),
    note: z.string().max(2000),
    revision: z.number().int().nonnegative(),
    protectedRanges: z.array(ProtectedRange).max(40).default([]),
  })
  .strict();
export const TextContent = z
  .object({
    blocks: z.array(z.object({ id: Id, text: z.string().max(50000) }).strict()).length(1),
  })
  .strict()
  .refine((c) => new Set(c.blocks.map((b) => b.id)).size === c.blocks.length);
export const CodeContent = z
  .object({
    code: z.string().max(200000),
    language: z.enum([
      'text',
      'javascript',
      'typescript',
      'python',
      'json',
      'html',
      'css',
      'markdown',
    ]),
  })
  .strict();
export const TableContent = z
  .object({
    columns: z
      .array(z.object({ id: Id, label: z.string().max(500) }).strict())
      .min(1)
      .max(50),
    rows: z
      .array(z.object({ id: Id, cells: z.array(z.string().max(4000)).max(50) }).strict())
      .max(500),
  })
  .strict()
  .refine(
    (t) =>
      new Set(t.columns.map((c) => c.id)).size === t.columns.length &&
      new Set(t.rows.map((r) => r.id)).size === t.rows.length &&
      t.rows.every((r) => r.cells.length === t.columns.length),
    '表格行列 ID 必须唯一，每行的单元格数量必须与列数相同。',
  )
  .refine((t) => JSON.stringify(t).length <= 1000000, '表格内容超过 1 MB 限制。');
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const DiagramContent = z
  .object({
    width: z.number().int().min(400).max(2000),
    height: z.number().int().min(300).max(1600),
    nodes: z
      .array(
        z
          .object({
            id: Id,
            text: z.string().max(500),
            x: z.number().min(0).max(2000),
            y: z.number().min(0).max(1600),
            width: z.number().min(60).max(600),
            height: z.number().min(40).max(400),
            shape: z.enum(['box', 'ellipse', 'diamond']),
            color: Color,
          })
          .strict(),
      )
      .max(100),
    edges: z
      .array(z.object({ id: Id, from: Id, to: Id, label: z.string().max(100) }).strict())
      .max(200),
  })
  .strict()
  .refine(
    (d) =>
      new Set(d.nodes.map((n) => n.id)).size === d.nodes.length &&
      new Set(d.edges.map((e) => e.id)).size === d.edges.length &&
      d.nodes.every((n) => n.x + n.width <= d.width && n.y + n.height <= d.height) &&
      d.edges.every(
        (e) =>
          e.from !== e.to &&
          d.nodes.some((n) => n.id === e.from) &&
          d.nodes.some((n) => n.id === e.to),
      ),
    '图形节点与连线无效。',
  );
export const DeckContent = z
  .object({
    title: z.string().max(200),
    accent: Color,
    footer: z.string().max(120),
    slides: z
      .array(
        z
          .object({
            id: Id,
            layout: z.enum(['title', 'bullets', 'split', 'section']),
            title: z.string().max(200),
            subtitle: z.string().max(500),
            body: z.string().max(6000),
            secondary: z.string().max(6000),
            notes: z.string().max(3000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine((d) => new Set(d.slides.map((s) => s.id)).size === d.slides.length);
export const WorkbookContent = z
  .object({
    title: z.string().max(200),
    formulas: z.boolean().default(false),
    sheets: z
      .array(
        z
          .object({
            id: Id,
            name: z
              .string()
              .min(1)
              .max(31)
              .regex(/^[^\\/*?:[\]]+$/),
            table: TableContent,
            formats: z.record(Id, z.enum(['text', 'number', 'currency', 'percent'])).default({}),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .refine(
    (w) =>
      new Set(w.sheets.map((s) => s.id)).size === w.sheets.length &&
      new Set(w.sheets.map((s) => s.name.toLowerCase())).size === w.sheets.length &&
      JSON.stringify(w).length <= 2000000,
    '工作表名称必须唯一，内容不能超过 2 MB。',
  );
export const Operation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('replace_diagram'), objectId: Id, content: DiagramContent }).strict(),
  z.object({ type: z.literal('replace_deck'), objectId: Id, content: DeckContent }).strict(),
  z
    .object({ type: z.literal('replace_workbook'), objectId: Id, content: WorkbookContent })
    .strict(),
  z
    .object({
      type: z.literal('replace_text_range'),
      objectId: Id,
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      text: z.string().max(50000),
    })
    .strict()
    .refine((o) => o.end > o.start),
  z.object({ type: z.literal('replace_text'), objectId: Id, content: TextContent }).strict(),
  z
    .object({
      type: z.literal('annotate_image'),
      objectId: Id,
      annotations: z
        .array(Annotation)
        .max(100)
        .refine(
          (items) => new Set(items.map((item) => item.id)).size === items.length,
          '批注 ID 必须唯一。',
        ),
    })
    .strict(),
  z.object({ type: z.literal('replace_code'), objectId: Id, content: CodeContent }).strict(),
  z.object({ type: z.literal('replace_table'), objectId: Id, content: TableContent }).strict(),
  z
    .object({
      type: z.literal('update_cells'),
      objectId: Id,
      cells: z
        .array(
          z
            .object({
              rowId: Id,
              columnId: Id,
              value: z.string().max(4000),
            })
            .strict(),
        )
        .min(1)
        .max(1000),
    })
    .strict(),
]);
export const Commit = z
  .object({
    workspaceId: Id,
    credential: Id,
    requestId: Id,
    expectedRevisions: z.record(Id, z.number().int().positive()),
    operations: z.array(Operation).min(1).max(20),
    summary: z.string().max(1000).default('更新内容'),
    annotationDraft: z.object({ id: Id, version: z.number().int().positive() }).strict().optional(),
  })
  .strict();
export const AnnotationList = z
  .array(Annotation)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    '批注 ID 必须唯一。',
  );
export interface AnnotationDraft {
  id: string;
  objectId: string;
  version: number;
  owner: string;
  baseRevision: number;
  before: RectAnnotation[];
  annotations: RectAnnotation[];
  updatedAt: string;
  state: 'editing' | 'saved' | 'discarded';
  savedRevision?: number;
  pending?: { requestId: string; version: number; payloadHash?: string };
}
export interface AnnotationDraftSummary {
  id: string;
  objectId: string;
  title: string;
  version: number;
  baseRevision: number;
  updatedAt: string;
  annotationCount: number;
  leaseUntil: number;
  own: boolean;
  pending: boolean;
}
export type CommitInput = z.infer<typeof Commit>;
export type RectAnnotation = z.infer<typeof Annotation>;
export type Text = z.infer<typeof TextContent>;
export type Code = z.infer<typeof CodeContent>;
export type Table = z.infer<typeof TableContent>;
export type Diagram = z.infer<typeof DiagramContent>;
export type Deck = z.infer<typeof DeckContent>;
export type Workbook = z.infer<typeof WorkbookContent>;
export type EditableContent = Text | Code | Table | Diagram | Deck | Workbook;
export interface GeneratedSource {
  batchId: string;
  taskName: string;
  request?: string;
  anchorSourceId?: string;
  action: 'created' | 'updated';
  sources: { id: string; title: string; revision: number }[];
  relativePath?: string;
  syncError?: string;
  syncPending?: boolean;
  changedSources?: {
    id: string;
    title: string;
    revision: number;
    currentRevision: number | null;
  }[];
}
export interface DesktopObject {
  fileSyncError?: string;
  generation?: GeneratedSource;
  browserSource?: { url: string; at: string };
  selectedText?: string;
  nativeSelection?: { kind: string; [key: string]: unknown };
  selectionWritable?: boolean;
  fileAnnotations?: RectAnnotation[];
  id: string;
  workspaceId: string;
  title: string;
  kind: 'text' | 'image' | 'table' | 'code' | 'file' | 'diagram' | 'deck' | 'workbook';
  content:
    | EditableContent
    | z.infer<typeof FileContent>
    | {
        assetHash: string;
        mime: string;
        width: number;
        height: number;
        annotations: RectAnnotation[];
      };
  revision: number;
  layoutRevision: number;
  bounds: z.infer<typeof Bounds>;
  updatedAt: string;
  lastActor: string;
  dataUrl?: string;
  sourceFileName?: string;
  policy?: z.infer<typeof ObjectPolicy>;
  archived?: boolean;
  selection?: MaterialRange;
}
export interface ArtifactRecord {
  id: string;
  objectId: string;
  sourceRevision: number;
  fileName: string;
  path: string;
  format: string;
  mime: string;
  bytes: number;
  sha256: string;
  generator: string;
  environment: 'local-fixed-generator';
  createdAt: string;
  calculation: 'not_applicable' | 'not_calculated';
}
export interface NativeFileSessionView {
  id: string;
  objectId: string;
  title: string;
  fileName: string;
  baseRevision: number;
  currentRevision: number;
  intent: 'read' | 'edit';
  state: 'prepared' | 'committed' | 'unchanged' | 'discarded';
  createdAt: string;
  conflict: boolean;
  writeBlocked: boolean;
  nextAction: string;
  result?: {
    objectId: string;
    revision: number;
    sha256: string;
    bytes: number;
    changed: boolean;
    committedAt: string;
  };
  lastError?: { code: string; message: string; at: string };
}
export interface Revision {
  revision: number;
  content: DesktopObject['content'];
  actor: string;
  summary: string;
  createdAt: string;
  contribution?: {
    operation: string;
    baseRevision: number;
    requestId: string;
    snapshotId?: string;
    dependencies: { objectId: string; revision: number }[];
    location:
      | { type: 'text'; start: number; end: number }
      | { type: 'cells'; cells: { rowId: string; columnId: string }[] }
      | { type: 'object' }
      | {
          type: 'parts';
          items: {
            kind: 'node' | 'edge' | 'slide' | 'sheet' | 'annotation';
            id: string;
            label: string;
            change: 'added' | 'removed' | 'updated';
            fields: string[];
          }[];
          settings: string[];
          order: string[];
        };
    undoOf?: number;
    execution?: {
      taskId: string;
      participantId: string;
      hostSessionHash: string;
      role: 'writer' | 'reviewer';
      feedbackId?: string;
    };
  };
}
export interface Workspace {
  id: string;
  name: string;
  objects: DesktopObject[];
  cursor: number;
  viewport: z.infer<typeof Viewport>;
  viewRevision: number;
  groups: CanvasGroups;
  fileTree?: FileTree;
  canvasBoard?: CanvasBoard;
}
export const CanvasRegionBounds = z
  .object({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
    width: z.number().min(200).max(200000),
    height: z.number().min(120).max(200000),
  })
  .strict();
export const RegionBackground = z
  .object({
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    image: z
      .string()
      .max(262144)
      .regex(/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/)
      .optional(),
    fit: z.enum(['cover', 'contain']),
    opacity: z.number().min(0).max(1),
  })
  .strict();
export const CanvasGroup = z
  .object({
    background: RegionBackground.optional(),
    id: Id,
    name: z.string().trim().min(1).max(80),
    color: z.enum(['sage', 'blue', 'sand', 'rose']),
    objectIds: z.array(Id).max(2000),
    linkedObjectIds: z.array(Id).max(2000).optional(),
    bounds: CanvasRegionBounds.optional(),
    collapsed: z.boolean().optional(),
    folder: z.boolean().optional(),
    parentId: Id.optional(),
    markIds: z.array(Id).max(2000).optional(),
    layout: z.enum(['free', 'grid', 'list']).optional(),
  })
  .strict();
export const CanvasGroupsSchema = z
  .object({ revision: z.number().int().nonnegative(), items: z.array(CanvasGroup).max(40) })
  .strict();
export type CanvasGroups = z.infer<typeof CanvasGroupsSchema>;
export const LayoutPresetSchema = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(80),
    createdAt: z.string(),
    viewport: Viewport,
    objects: z.array(z.object({ objectId: Id, bounds: Bounds }).strict()).max(2000),
    groups: z.array(CanvasGroup).max(40),
  })
  .strict();
export const LayoutLibrarySchema = z
  .object({ revision: z.number().int().nonnegative(), items: z.array(LayoutPresetSchema).max(20) })
  .strict();
export type LayoutLibrary = z.infer<typeof LayoutLibrarySchema>;
export interface WorkspaceSummary {
  id: string;
  name: string;
  objectCount: number;
  updatedAt: string | null;
  current: boolean;
}
export const WorkTaskStatus = z.enum([
  'queued',
  'working',
  'review',
  'ready',
  'paused',
  'waiting_input',
  'waiting_permission',
  'conflict',
  'failed',
  'cancelled',
  'completed',
]);
export const TaskBudget = z
  .object({
    maxSteps: z.number().int().min(1).max(30).default(6),
    maxMinutes: z.number().int().min(1).max(240).default(30),
    maxTokens: z.number().int().min(1000).max(200000).default(20000),
  })
  .strict();
export const WorkTaskInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(6000),
    constraints: z.string().max(3000),
    objectIds: z.array(Id).max(20),
    expectedRevisions: z.record(Id, z.number().int().positive()),
    ranges: z.record(Id, SelectionRange).default({}),
    budget: TaskBudget.default({ maxSteps: 6, maxMinutes: 30, maxTokens: 20000 }),
    writeObjectIds: z.array(Id).max(20).default([]),
  })
  .strict();
export interface WorkTask {
  management?: import('./work-management.js').WorkManagement;
  id: string;
  title: string;
  goal: string;
  constraints: string;
  revision: number;
  status: z.infer<typeof WorkTaskStatus>;
  step: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  sources: {
    objectId: string;
    title: string;
    kind: DesktopObject['kind'];
    revision: number;
    selection?: MaterialRange;
  }[];
  events: {
    id: string;
    actor: 'human' | 'demo-planner' | 'demo-reviewer' | 'codex-writer' | 'codex-reviewer';
    title: string;
    body: string;
    at: string;
    participantId?: string;
  }[];
  proposal: string;
  budget: z.infer<typeof TaskBudget>;
  writeObjectIds: string[];
  usage: {
    demoSteps: number;
    modelTokens: null;
    executionMs: null;
    readOperations?: number;
    reportedTokens?: number;
  };
  gate?: {
    kind: 'input' | 'permission' | 'failure' | 'conflict' | 'budget';
    reason: string;
    at: string;
  };
  resumeStatus?: z.infer<typeof WorkTaskStatus>;
  retries: number;
  execution?: {
    mode: 'codex';
    originOwner: string;
    phase: 'writing' | 'reviewing' | 'revising' | 'ready' | 'approved';
    startedAt: string;
    deadlineAt: number;
    steps: number;
    writes: number;
    reviewRound: number;
    reviewedWrites: number;
    participants: {
      id: string;
      role: 'writer' | 'reviewer';
      hostSessionHash: string;
      joinedAt: string;
      lastReads: Record<string, number>;
    }[];
    feedbacks: {
      id: string;
      participantId: string;
      body: string;
      decision: 'revise' | 'approve';
      basedOn: Record<string, number>;
      at: string;
    }[];
    currentFeedbackId?: string;
  };
}
export interface PanelBinding {
  workspaceId: string;
  credential: string;
  panelInstanceId: string;
  hostSessionRef: string | null;
  messageRouteAvailable: boolean;
}
export const EnvironmentPlan = z
  .object({
    revision: z.number().int().nonnegative(),
    resources: z
      .array(
        z
          .object({
            id: Id,
            name: z.string().trim().min(1).max(120),
            location: z.string().max(1000),
            kind: z.enum(['directory', 'application', 'network']),
            access: z.enum(['read', 'write', 'operate']),
            duration: z.enum(['session', 'hour', 'persistent']),
            state: z.enum(['requested', 'approved_demo', 'revoked_demo']),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type EnvironmentDesign = z.infer<typeof EnvironmentPlan>;
export type ModelBlock =
  | { type: 'text'; text: string; _meta?: Record<string, unknown> }
  | { type: 'image'; data: string; mimeType: string };
export class DesktopError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DesktopError';
  }
}
export function fail(code: string, message: string): never {
  throw new DesktopError(code, message);
}
