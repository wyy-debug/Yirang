import { z } from 'zod';
export const WorkModelSettings = z
  .object({
    model: z.string().min(1).max(160),
    effort: z.string().max(80).nullable(),
    childModel: z.string().min(1).max(160),
    childEffort: z.string().max(80).nullable(),
  })
  .strict();
export type WorkModelSettingsValue = z.infer<typeof WorkModelSettings>;
export const WorkSchedule = z
  .object({
    priority: z.number().int().min(0).max(3).default(1),
    dueAt: z.string().datetime({ offset: true }).nullable().default(null),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    notBefore: z.string().datetime({ offset: true }).nullable().default(null),
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, '无效时区')
      .default('Asia/Shanghai'),
    timeText: z.string().max(500).default(''),
  })
  .strict();
export type WorkScheduleValue = z.infer<typeof WorkSchedule>;
export type WorkState =
  | 'queued'
  | 'scheduled'
  | 'waiting'
  | 'running'
  | 'revising'
  | 'review'
  | 'paused'
  | 'attention'
  | 'completed'
  | 'cancelled'
  | 'pausing'
  | 'cancelling';
export type WorkRun = {
  modelSettings?: WorkModelSettingsValue;
  id: string;
  taskId: string;
  threadId: string;
  provider: string;
  turnId?: string;
  dispatchKey: string;
  submission?: { operationId: string; attemptId: string; requestDigest: string;
    state: 'prepared' | 'possibly_sent' | 'received' | 'not_received'; turnId?: string };
  generation: number;
  requirementsRevision: number;
  appliedRequirementsRevision: number | null;
  submittedRequirementsRevision?: number;
  reception?: { turnId: string; receivedAt: string };
  state:
    | 'starting'
    | 'running'
    | 'waiting'
    | 'stopping'
    | 'succeeded'
    | 'failed'
    | 'interrupted'
    | 'unknown';
  createdAt: string;
  endedAt?: string;
  waitingSince?: string;
  waitingMs?: number;
  activeMs?: number;
  activitySegments?: Record<string, number>;
  activityUnobserved?: boolean;
  reason?: string;
  batchId?: string;
  resultText?: string;
  resultHash?: string;
  controlled?: boolean;
  outputDirectory?: string;
  restartRequestedAt?: string;
};
export type WorkArtifact = {
  fileName?: string;
  objectId: string;
  revision: number;
  runId: string;
  outputBatchId?: string;
  validity: 'current' | 'stale';
  title: string;
};
export type WorkRevision = {
  confirmation?: { required: boolean; sourceRequestId?: string; reason?: string };
  delivery?: { formats: string[]; sourceRequestId: string };
  sources?: { objectId: string; revision: number; selection?: unknown }[];
  revision: number;
  goal: string;
  constraints: string;
  deliverables: string;
  acceptanceCriteria: string;
  sourceRequestId: string;
  reason: string;
  at: string;
  anchor?: { objectId: string; revision: number; range?: unknown };
};
export type WorkManagement = {
  responsibilityVersion?: 6;
  continuation?: import('./work-completion.js').Continuation;
  version: 1;
  restoredHistory?: boolean;
  revisionWindow?: { openedAt: number; lastAt: number; readyAt: number };
  modelSettings?: WorkModelSettingsValue;
  originThreadId?: string;
  parentTaskId?: string;
  parentRequirementsRevision?: number;
  afterTasks?: string[];
  delegation?: {
    revision: number;
    children: string[];
    phase: 'waiting' | 'integrating';
    poolPlanId?: string;
  };
  question?: string;
  questionId?: string;
  /** The running agent's own one-line status; only present while its run is current. */
  progress?: { text: string; step?: number; total?: number; at: string; runId: string };
  /** What the agent last reported before its run stopped blocked. */
  lastReport?: string;
  answeredQuestions?: { question: string; answer: string; revision: number }[];
  executionMode?: 'isolated' | 'serial';
  provider?: string;
  handoffFrom?: string;
  derivedFrom?: string;
  dueNotice?: string;
  state: WorkState;
  currentRequirementsRevision: number;
  generation: number;
  goalId?: string;
  schedule: WorkScheduleValue;
  reason: string;
  requirements: WorkRevision[];
  runs: WorkRun[];
  artifacts: WorkArtifact[];
  acceptances: {
    requirementsRevision: number;
    artifacts: { objectId: string; revision: number }[];
    textResults?: { runId: string; hash: string }[];
    evidence: string;
    criteriaChecks?: string[];
    scopeConfirmed?: boolean;
    actor: 'human' | 'objective';
    at: string;
  }[];
  dependencies: {
    taskId: string;
    revision: number;
    condition: 'accepted' | 'artifact';
    objectId?: string;
    objectRevision?: number;
  }[];
  events: {
    id: string;
    sequence: number;
    type: string;
    at: string;
    runId?: string;
    requirementsRevision: number;
    detail: string;
  }[];
  requestIds: string[];
  threadId?: string;
  acceptancePolicy: 'manual';
  objectiveCheck?: {
    objectId: string;
    baseRevision: number;
    requirementsRevision: number;
    expectedHash: string;
  };
  legacy?: boolean;
};
export type WorkGoal = {
  id: string;
  title: string;
  criteria: string;
  description?: string;
  scope?: string;
  deadline?: string;
  budget?: number;
  reviewAfter?: string;
  review?: {
    at: string;
    criteria: string[];
    evidenceTasks: string[];
    blockers: string[];
    suggestion: string;
  };
  nextStep: string;
  state: 'active' | 'paused' | 'achieved' | 'archived';
  revision: number;
  history: { at: string; description: string }[];
  evidence: (
    | { taskId: string; objectId: string; revision: number }
    | { taskId: string; runId: string; hash: string }
  )[];
};
export const WorkCommand = z
  .object({
    operation: z.enum([
      'cancel_request',
      'orchestration',
      'pool',
      'delegate',
      'objective_policy',
      'detail',
      'review',
      'goal_review',
      'execution_policy',
      'notice_read',
      'configure',
      'consult_bind',
      'consult_unbind',
      'voice_bind',
      'remind',
      'wait',
      'prepare',
      'list',
      'reports',
      'intake',
      'revise',
      'control',
      'schedule',
      'dependencies',
      'accept',
      'goal_save',
      'goal_link',
      'reassign',
      'handoff',
      'dispatch',
      'ack',
      'finish',
      'recover',
      'reconcile',
      'completion_prepare',
      'recovery_budget',
      'suspend_for_exit',
      'execution_activity',
      'progress',
      'bot_events',
    ]),
    requestId: z.string().min(1).max(160).optional(),
    taskId: z.string().max(160).optional(),
    expectedRevision: z.number().int().positive().optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
