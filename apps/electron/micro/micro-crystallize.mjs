// Crystallization: accepted Bot work -> micro-app draft. Pure helpers; Electron main supplies I/O.
import { createHash } from 'node:crypto';
import { wireSchema } from './micro-apps.mjs';

const json = (v) => JSON.stringify(v),
  sha = (v) => createHash('sha256').update(v).digest('hex');
const DAY = 86400000;
export const CRYSTAL = {
  windowDays: 60,
  declineDays: 30,
  minWorks: 3,
  maxExamples: 5,
  minSimilarity: 0.7,
};

// Only work the user (or an objective check) accepted, in this workspace, within the window.
export function acceptedWorks(tasks, now = Date.now()) {
  const out = [];
  for (const t of tasks || []) {
    const m = t.management;
    if (!m || t.archived || m.parentTaskId) continue;
    const acceptance = [...(m.acceptances || [])]
      .reverse()
      .find((a) => a.requirementsRevision === m.currentRequirementsRevision);
    if (!acceptance || now - Date.parse(acceptance.at) > CRYSTAL.windowDays * DAY) continue;
    const req =
      m.requirements.find((r) => r.revision === acceptance.requirementsRevision) ||
      m.requirements.at(-1);
    const texts = (acceptance.textResults || [])
      .map((r) => m.runs.find((x) => x.id === r.runId && x.resultHash === r.hash)?.resultText)
      .filter(Boolean);
    out.push({
      id: t.id,
      title: t.title,
      goal: String(req.goal || '').slice(0, 4000),
      constraints: String(req.constraints || '').slice(0, 2000),
      deliverables: String(req.deliverables || '').slice(0, 2000),
      sources: (req.sources || []).map((s) => ({ objectId: s.objectId, revision: s.revision })),
      artifacts: acceptance.artifacts || [],
      textResults: texts,
      acceptedAt: acceptance.at,
      multiFile: (acceptance.artifacts || []).length > 1,
      provider: m.provider || 'codex',
    });
  }
  return out;
}

export const similarityWire = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'label',
          'workIds',
          'similarity',
          'commonFields',
          'materialsToResult',
          'externalWorkIds',
          'reason',
        ],
        properties: {
          label: { type: 'string' },
          workIds: { type: 'array', items: { type: 'string' } },
          similarity: { type: 'number' },
          commonFields: { type: 'array', items: { type: 'string' } },
          materialsToResult: { type: 'boolean', description: '主要是“材料→结构化或文本成果”' },
          externalWorkIds: {
            type: 'array',
            items: { type: 'string' },
            description: '依赖外部系统、命令执行或多文件写回的工作',
          },
          reason: { type: 'string' },
        },
      },
    },
  },
};
export function similarityPrompt(works) {
  return (
    '判断下面这些已验收工作中哪些属于同一类重复工作（同样的要求、同样形态的成果，只是输入变化）。只把真正同类的工作放在一组；similarity 取 0–1。若工作需要外部系统、执行命令或多文件写回，列入 externalWorkIds。\n\n' +
    json(
      works.map((w) => ({
        id: w.id,
        title: w.title,
        goal: w.goal.slice(0, 1200),
        constraints: w.constraints.slice(0, 600),
        deliverables: w.deliverables.slice(0, 600),
        artifactCount: w.artifacts.length,
        hasTextResult: w.textResults.length > 0,
      })),
    )
  );
}

// One suggestion at a time; declined classes stay quiet for 30 days; existing apps cover their class.
export function pickSuggestion({ groups, works, records = [], now = Date.now() }) {
  const byId = new Map(works.map((w) => [w.id, w]));
  const overlaps = (a, b) => a.filter((x) => b.includes(x)).length >= 2;
  if (records.some((r) => r.status === 'suggested')) return null;
  for (const g of [...groups].sort((a, b) => b.similarity - a.similarity)) {
    const ids = [...new Set(g.workIds)].filter((id) => byId.has(id));
    if (
      ids.length < CRYSTAL.minWorks ||
      g.similarity < CRYSTAL.minSimilarity ||
      !g.materialsToResult
    )
      continue;
    if (
      g.externalWorkIds.some((id) => ids.includes(id)) ||
      ids.some((id) => byId.get(id).multiFile)
    )
      continue;
    const blocked = records.some(
      (r) =>
        (overlaps(r.workIds, ids) || r.label === g.label) &&
        (['accepted', 'published'].includes(r.status) ||
          (r.status === 'declined' && now - r.decidedAt < CRYSTAL.declineDays * DAY)),
    );
    if (blocked) continue;
    return {
      label: g.label.slice(0, 120),
      workIds: ids,
      similarity: g.similarity,
      commonFields: g.commonFields.slice(0, 20),
      reason: g.reason.slice(0, 1000),
    };
  }
  return null;
}

const field = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'title', 'type', 'enumValues', 'columns'],
  properties: {
    name: { type: 'string' },
    title: { type: 'string' },
    type: {
      enum: [
        'string',
        'text',
        'number',
        'integer',
        'boolean',
        'enum',
        'table',
        'string_or_null',
        'number_or_null',
      ],
    },
    enumValues: { type: 'array', items: { type: 'string' } },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'enumValues'],
        properties: {
          name: { type: 'string' },
          type: {
            enum: [
              'string',
              'number',
              'integer',
              'boolean',
              'enum',
              'string_or_null',
              'number_or_null',
            ],
          },
          enumValues: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};
export const draftWire = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'description',
    'inputFields',
    'prompt',
    'outputFields',
    'outputKinds',
    'examples',
    'promptAnchors',
  ],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    inputFields: { type: 'array', items: field },
    prompt: {
      type: 'string',
      description: 'Markdown 模板，只能用 {{input.字段}} 与 {{materials}}',
    },
    outputFields: { type: 'array', items: field },
    outputKinds: { type: 'array', items: { enum: ['xlsx', 'docx', 'md', 'csv', 'json'] } },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['workId', 'input'],
        properties: {
          workId: { type: 'string' },
          input: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'value'],
              properties: { key: { type: 'string' }, value: { type: 'string' } },
            },
          },
        },
      },
    },
    promptAnchors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['workId', 'quote'],
        properties: { workId: { type: 'string' }, quote: { type: 'string' } },
      },
      description: '提示词中来自历史要求原文的片段',
    },
  },
};
export function draftPrompt(suggestion, works) {
  const picked = works.filter((w) => suggestion.workIds.includes(w.id));
  return (
    '把下面这类重复工作做成一个“微应用”能力。inputFields 只放每次变化的部分（如周次、项目名），固定要求写进 prompt；保留历史要求中的稳定限制。outputFields 是历史成果的共同结构，表格用 type=table 并给出 columns；无法稳定归纳时只给一个 name=summary 的 text 字段。字段名用英文小写加下划线。examples 为每项工作给出它当时的输入取值。\n类别：' +
    suggestion.label +
    '\n共同字段：' +
    suggestion.commonFields.join('、') +
    '\n\n' +
    json(
      picked.map((w) => ({
        id: w.id,
        title: w.title,
        goal: w.goal,
        constraints: w.constraints,
        deliverables: w.deliverables,
        result: w.textResults.join('\n').slice(0, 3000),
      })),
    )
  );
}

const ident = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'field';
function prop(f) {
  const t = f.type,
    enums = f.enumValues?.length ? [...new Set(f.enumValues.map(String))] : null;
  if (t === 'enum') return enums ? { enum: enums } : { type: 'string' };
  if (t === 'text' || t === 'string') return { type: 'string' };
  if (t === 'string_or_null') return { type: ['string', 'null'] };
  if (t === 'number_or_null') return { type: ['number', 'null'] };
  if (['number', 'integer', 'boolean'].includes(t)) return { type: t };
  if (t === 'table') {
    const cols = uniq((f.columns || []).map((c) => ({ ...c, name: ident(c.name) })));
    if (!cols.length) return { type: 'array', items: { type: 'string' } };
    return {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: cols.map((c) => c.name),
        properties: Object.fromEntries(cols.map((c) => [c.name, prop(c)])),
      },
    };
  }
  return { type: 'string' };
}
const uniq = (list) => {
  const seen = new Set();
  return list.filter((x) => !seen.has(x.name) && seen.add(x.name));
};
const ruleFor = (f) => {
  if (f.type === 'table') {
    const cols = uniq((f.columns || []).map((c) => ({ ...c, name: ident(c.name) })));
    const key = cols.find((c) => c.type === 'string');
    return {
      ...(key ? { key: key.name, order: 'ignore' } : {}),
      fields: Object.fromEntries(cols.map((c) => [c.name, ruleFor(c)])),
    };
  }
  if (['enum', 'boolean', 'integer'].includes(f.type)) return 'exact';
  if (['number', 'number_or_null'].includes(f.type)) return { tolerance: 0 };
  if (f.type === 'string') return 'exact';
  return 'review';
};

// Builds the package deterministically so the result always lands inside the 5.1 subset.
export function buildDraft(suggestion, draft, { appId }) {
  const inputs = uniq(draft.inputFields.map((f) => ({ ...f, name: ident(f.name) })));
  let outputs = uniq(draft.outputFields.map((f) => ({ ...f, name: ident(f.name) })));
  let fallback = false;
  if (!outputs.length) {
    outputs = [{ name: 'summary', title: '结果', type: 'text', enumValues: [], columns: [] }];
    fallback = true;
  }
  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    required: outputs.map((f) => f.name),
    properties: Object.fromEntries(
      outputs.map((f) => [f.name, { ...prop(f), ...(f.title ? { description: f.title } : {}) }]),
    ),
  };
  try {
    wireSchema(outputSchema);
  } catch {
    outputs = [{ name: 'summary', title: '结果', type: 'text', enumValues: [], columns: [] }];
    fallback = true;
  }
  const finalSchema = fallback
    ? {
        type: 'object',
        additionalProperties: false,
        required: ['summary'],
        properties: { summary: { type: 'string' } },
      }
    : outputSchema;
  const inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: inputs.map((f) => f.name),
    properties: Object.fromEntries(
      inputs.map((f) => [
        f.name,
        { ...prop({ ...f, type: f.type === 'table' ? 'text' : f.type }), title: f.title || f.name },
      ]),
    ),
  };
  const known = new Set(inputs.map((f) => f.name));
  const prompt =
    draft.prompt
      .replace(/\{\{\s*([^}]*?)\s*\}\}/g, (all, name) =>
        name === 'materials' || (name.startsWith('input.') && known.has(name.slice(6))) ? all : '',
      )
      .trim() || '根据输入与材料完成任务。\n{{materials}}';
  const table = outputs.find((f) => f.type === 'table');
  const kinds = [...new Set(draft.outputKinds)]
    .filter((k) => (k !== 'xlsx' && k !== 'csv') || table)
    .slice(0, 3);
  const nameField = inputs.find((f) => f.type === 'string');
  const fileOutputs = kinds.map((kind) => ({
    kind,
    name: draft.name.slice(0, 60) + (nameField ? `-{${nameField.name}}` : ''),
    ...(['xlsx', 'csv'].includes(kind) ? { from: table.name } : {}),
  }));
  const evaluation = Object.fromEntries(outputs.map((f) => [f.name, ruleFor(f)]));
  const manifest = {
    schemaVersion: 1,
    id: appId,
    name: draft.name.slice(0, 80) || suggestion.label,
    version: '0.1.0',
    minHostApi: 3,
    description: draft.description.slice(0, 500),
    runtime: { kind: 'micro' },
    capabilities: [
      {
        name: 'run',
        title: draft.name.slice(0, 80) || suggestion.label,
        prompt: 'prompts/run.md',
        inputSchema,
        outputSchema: finalSchema,
        evaluation,
        materials: { min: 0, max: 10 },
        outputs: fileOutputs,
        timeoutMs: 180000,
      },
    ],
    examples: 'examples/',
    evolution: { autoPropose: true, autoPublish: 'never' },
    crystallizedFrom: { workIds: suggestion.workIds, label: suggestion.label },
  };
  const examples = draft.examples
    .filter((e) => suggestion.workIds.includes(e.workId))
    .slice(0, CRYSTAL.maxExamples)
    .map((e) => ({
      workId: e.workId,
      input: Object.fromEntries(
        inputs.map((f) => {
          const v = e.input.find((x) => ident(x.key) === f.name)?.value ?? null;
          return [f.name, coerce(f.type, v)];
        }),
      ),
    }));
  return {
    manifest,
    prompt,
    examples,
    fallback,
    anchors: draft.promptAnchors
      .filter((a) => suggestion.workIds.includes(a.workId) && a.quote && prompt.includes(a.quote))
      .slice(0, 50),
  };
}
function coerce(type, v) {
  if (v === null || v === undefined)
    return ['string_or_null', 'number_or_null'].includes(type)
      ? null
      : type === 'boolean'
        ? false
        : ['number', 'integer'].includes(type)
          ? 0
          : '';
  if (['number', 'integer', 'number_or_null'].includes(type)) {
    const n = Number(v);
    return Number.isFinite(n)
      ? type === 'integer'
        ? Math.round(n)
        : n
      : type === 'number_or_null'
        ? null
        : 0;
  }
  if (type === 'boolean') return /^(true|是|yes|1)$/i.test(String(v));
  return String(v);
}

export function extractionPrompt(work, resultText) {
  return (
    '下面是一项已验收工作的成果原文。把成果原样整理为给定 JSON schema 的结构，只做格式转换，不补充、不改写内容；原文没有的字段填 null 或空值。\n工作：' +
    work.title +
    '\n成果：\n' +
    resultText.slice(0, 60000)
  );
}
export const materialHash = (text) => sha(String(text));
