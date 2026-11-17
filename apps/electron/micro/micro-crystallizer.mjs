// Drives crystallization and draft regression. All model calls go through the tool-less ask().
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import {
  acceptedWorks,
  similarityWire,
  similarityPrompt,
  pickSuggestion,
  draftWire,
  draftPrompt,
  buildDraft,
  extractionPrompt,
  materialHash,
  CRYSTAL,
} from './micro-crystallize.mjs';
import {
  checkMicroPackage,
  renderPrompt,
  parseResult,
  judgeExample,
  regressionSummary,
  hashValue,
} from './micro-apps.mjs';

const validator = (schema) => {
  const check = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
  return Object.assign((v) => check(v), {
    errorsText: () => JSON.stringify(check.errors || []).slice(0, 500),
  });
};

export function createCrystallizer({
  ask,
  store,
  tasks,
  readObject,
  register,
  directory,
  emit = () => {},
  model = async () => null,
  now = Date.now,
  scanIntervalMs = 3600000,
}) {
  const lastScan = new Map(),
    busy = new Set();
  const guard = async (key, fn) => {
    if (busy.has(key)) throw Error('该操作正在进行，请稍后');
    busy.add(key);
    try {
      return await fn();
    } finally {
      busy.delete(key);
    }
  };
  const record = async (w, id) => {
    const r = (await store.list(w, 'crystal')).find((x) => x.id === id);
    if (!r) throw Error('结晶建议不存在');
    return r;
  };
  const structured = async (w, prompt, wire) => {
    const { text, usage } = await ask({ w, prompt, wire, model: await model() });
    return { value: parseResult(text, validator(wire)), usage };
  };

  async function scan(w, { force = false } = {}) {
    if (!force && now() - (lastScan.get(w) || 0) < scanIntervalMs) return null;
    lastScan.set(w, now());
    const works = acceptedWorks(await tasks(w), now());
    if (works.length < CRYSTAL.minWorks) return null;
    const records = await store.list(w, 'crystal');
    if (records.some((r) => r.status === 'suggested')) return null;
    const { value, usage } = await structured(w, similarityPrompt(works), similarityWire);
    const picked = pickSuggestion({ groups: value.groups, works, records, now: now() });
    if (!picked) return null;
    const suggestion = await store.put(w, 'crystal', {
      id: randomUUID(),
      workspaceId: w,
      status: 'suggested',
      ...picked,
      similarityUsage: usage,
      createdAt: now(),
    });
    emit({
      workspaceId: w,
      type: 'micro-crystal-suggestion',
      id: suggestion.id,
      label: suggestion.label,
    });
    return suggestion;
  }
  async function decline(w, id) {
    const r = await record(w, id);
    if (r.status !== 'suggested') throw Error('建议已处理');
    return store.put(w, 'crystal', { ...r, status: 'declined', decidedAt: now() });
  }

  // Materials are frozen by object revision + content hash; a version we cannot read now is not used.
  async function freeze(sources) {
    const out = [];
    for (const s of sources) {
      const o = await readObject(s.objectId).catch(() => null);
      if (!o || o.revision !== s.revision) return null;
      out.push({
        id: s.objectId,
        title: o.title,
        revision: s.revision,
        sha256: materialHash(o.text),
      });
    }
    return out;
  }
  async function acceptedText(work) {
    if (work.textResults.length) return work.textResults.join('\n\n');
    const parts = [];
    for (const a of work.artifacts) {
      const o = await readObject(a.objectId).catch(() => null);
      if (!o || o.revision !== a.revision) return null;
      parts.push(o.text);
    }
    return parts.join('\n\n') || null;
  }
  async function accept(w, id) {
    return guard('accept:' + id, async () => {
      const r = await record(w, id);
      if (r.status !== 'suggested') throw Error('建议已处理');
      const works = acceptedWorks(await tasks(w), now()).filter((x) => r.workIds.includes(x.id));
      const { value: draft, usage } = await structured(w, draftPrompt(r, works), draftWire);
      const draftId = randomUUID(),
        appId = 'user.micro-' + draftId.slice(0, 8),
        built = buildDraft(r, draft, { appId }),
        root = join(typeof directory === 'function' ? directory() : directory, draftId);
      mkdirSync(join(root, 'prompts'), { recursive: true });
      mkdirSync(join(root, 'examples'), { recursive: true });
      writeFileSync(join(root, 'yirang.app.json'), JSON.stringify(built.manifest, null, 2));
      writeFileSync(join(root, 'prompts', 'run.md'), built.prompt);
      const capability = checkMicroPackage(root, built.manifest).capabilities[0],
        skipped = [];
      let n = 0;
      for (const example of built.examples) {
        const work = works.find((x) => x.id === example.workId),
          materials = work && (await freeze(work.sources)),
          text = work && (await acceptedText(work));
        if (!work || !materials || !text) {
          skipped.push({ workId: example.workId, reason: '无法取得验收时的材料或成果版本' });
          continue;
        }
        let output;
        try {
          output = (await structured(w, extractionPrompt(work, text), capability.wire)).value;
          validator(capability.outputSchema)(output) || (output = null);
        } catch {
          output = null;
        }
        if (!output) {
          skipped.push({ workId: work.id, reason: '成果无法整理为输出结构' });
          continue;
        }
        writeFileSync(
          join(root, 'examples', `${++n}.json`),
          JSON.stringify(
            {
              id: randomUUID(),
              capability: 'run',
              source: 'accepted-work',
              workId: work.id,
              acceptedAt: work.acceptedAt,
              input: example.input,
              materials,
              output,
              outputHash: hashValue(output),
            },
            null,
            2,
          ),
        );
      }
      const saved = await store.put(w, 'draft', {
        id: draftId,
        workspaceId: w,
        suggestionId: r.id,
        root,
        appId,
        name: built.manifest.name,
        status: 'draft',
        fallback: built.fallback,
        anchors: built.anchors,
        skipped,
        draftUsage: usage,
        createdAt: now(),
      });
      await store.put(w, 'crystal', { ...r, status: 'accepted', decidedAt: now(), draftId });
      return regress(w, saved.id);
    });
  }
  const examplesAt = (root) =>
    existsSync(join(root, 'examples'))
      ? readdirSync(join(root, 'examples'))
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => JSON.parse(readFileSync(join(root, 'examples', f), 'utf8')))
      : [];
  async function regress(w, draftId) {
    return guard('regress:' + draftId, async () => {
      const d = (await store.list(w, 'draft')).find((x) => x.id === draftId);
      if (!d) throw Error('草稿不存在');
      const manifest = JSON.parse(readFileSync(join(d.root, 'yirang.app.json'), 'utf8')),
        capability = checkMicroPackage(d.root, manifest).capabilities[0],
        results = [];
      for (const e of examplesAt(d.root)) {
        const base = {
          exampleId: e.id,
          workId: e.workId,
          source: e.source,
          input: e.input,
          expected: e.output,
        };
        const materials = [];
        let available = true;
        for (const m of e.materials || []) {
          const o = await readObject(m.id).catch(() => null);
          if (!o || o.revision !== m.revision || materialHash(o.text) !== m.sha256) {
            available = false;
            break;
          }
          materials.push({ id: m.id, title: m.title, text: o.text });
        }
        if (!available) {
          results.push({ ...base, available: false, reason: '样例材料已修改或删除，不参与回归' });
          continue;
        }
        try {
          const prompt = renderPrompt(capability, e.input, materials),
            { value, usage } = await structured(w, prompt, capability.wire);
          validator(capability.outputSchema)(value) ||
            (() => {
              throw Error('结果不符合 outputSchema');
            })();
          const judged = judgeExample(capability.evaluation, e.output, value);
          results.push({
            ...base,
            available: true,
            actual: value,
            verdict: judged.verdict,
            fields: judged.fields,
            usage,
          });
        } catch (error) {
          results.push({ ...base, available: true, verdict: 'fail', error: error.message });
        }
      }
      const summary = regressionSummary(results);
      return store.put(w, 'draft', {
        ...d,
        regression: {
          at: now(),
          definitionHash: capability.definitionHash,
          evaluation: capability.evaluation,
          results,
          summary,
        },
      });
    });
  }
  async function publish(w, draftId) {
    const d = (await store.list(w, 'draft')).find((x) => x.id === draftId);
    if (!d || d.status !== 'draft') throw Error('草稿不存在或已发布');
    const instance = await register(w, d.root);
    const saved = await store.put(w, 'draft', {
      ...d,
      status: 'published',
      instanceId: instance.id,
      publishedAt: now(),
    });
    const r = (await store.list(w, 'crystal')).find((x) => x.id === d.suggestionId);
    if (r) await store.put(w, 'crystal', { ...r, status: 'published' });
    return saved;
  }
  return {
    scan,
    decline,
    accept,
    regress,
    publish,
    list: async (w) => ({
      suggestions: await store.list(w, 'crystal'),
      drafts: await store.list(w, 'draft'),
    }),
  };
}
