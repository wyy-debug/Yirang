export const workDelegationTool = {
  type: 'function',
  name: 'organize_work',
  description:
    'Organize this assigned work only. For a complex clear request, delegate 2–4 independent read-only analyses or drafts; after contains zero-based indices of earlier jobs. End this turn immediately after delegation; the host runs workers and resumes you with their results for final integration. Simple work should be completed directly. If essential information is missing, clarify with one concise UNANSWERED question and end the turn. NEVER use clarify to acknowledge an answer, report progress, or repeat a question that the user already answered; progress goes to report_status. A yirang.work-earlier-conversation block is the earlier execution of this same work: continue from where it stopped and do not redo finished steps. Read the supplied answered-question records and continue directly once the information is available. Never use delegation to broaden the request. read_result retrieves a long worker result during integration. If an assigned input belongs elsewhere, use return_assignment with sourceRequestId from the context and a specific reason; then stop. Never redirect or replay effects yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['delegate', 'clarify', 'read_result', 'return_assignment'],
      },
      question: { type: 'string' },
      sourceRequestId: { type: 'string' },
      reason: { type: 'string' },
      taskId: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      jobs: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            instructions: { type: 'string' },
            after: { type: 'array', items: { type: 'integer', minimum: 0 } },
          },
          required: ['title', 'instructions', 'after'],
          additionalProperties: false,
        },
      },
    },
    required: ['operation'],
    additionalProperties: false,
  },
};

// The one line the user reads about this work. The host keeps it only while
// this run is current, so it never outlives the execution it describes.
export const workStatusTool = {
  type: 'function',
  name: 'report_status',
  description:
    'Tell the user, in one short sentence in their language, what you are doing right now on this work, e.g. "正在把图转成可编辑的形状". Call it when you start, whenever you move to a different step, and before a long step; give step/total when the work has countable parts. Write for the person, not for a log: no tool names, paths or internal ids. If you cannot continue, report why and what the user can do next in the same sentence, e.g. "缺少原始数据文件，请补充后点继续", before ending the turn. This never asks the user anything and never ends the turn; keep working after it. To ask a question use organize_work clarify instead. A yirang.work-earlier-conversation block is the earlier execution of this same work: continue from where it stopped and do not redo finished steps.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 80 },
      step: { type: 'integer', minimum: 0 },
      total: { type: 'integer', minimum: 1 },
    },
    required: ['text'],
    additionalProperties: false,
  },
};
