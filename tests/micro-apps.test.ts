import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  wireSchema,
  checkMicroPackage,
  finalizeOutputs,
  judge,
  judgeExample,
  regressionSummary,
  renderPrompt,
  // @ts-ignore -- JavaScript module has no declaration file.
} from '../apps/electron/micro/micro-apps.mjs';
// @ts-ignore
import { createLightAppsCore } from '../apps/electron/light-apps/light-apps-core.mjs';

const rowSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['project', 'owner', 'status', 'hours', 'note'],
  properties: {
    project: { type: 'string' },
    owner: { type: 'string' },
    status: { enum: ['done', 'doing', 'blocked'] },
    hours: { type: 'number', minimum: 0 },
    note: { type: ['string', 'null'] },
  },
};
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'summary'],
  properties: { rows: { type: 'array', items: rowSchema }, summary: { type: 'string' } },
};
function project(extra: any = {}, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'micro-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(
    join(dir, 'prompts', 'summarize.md'),
    files.prompt ?? '整理 {{input.week}} 的周报。\n{{materials}}',
  );
  const manifest = {
    schemaVersion: 1,
    id: 'user.weekly',
    name: '周报',
    version: '0.1.0',
    minHostApi: 3,
    runtime: { kind: 'micro' },
    capabilities: [
      {
        name: 'summarize',
        title: '生成周报',
        prompt: 'prompts/summarize.md',
        inputSchema: {
          type: 'object',
          properties: { week: { type: 'string' } },
          required: ['week'],
        },
        outputSchema,
        materials: { min: 0, max: 3 },
        outputs: [
          { kind: 'csv', from: 'rows', name: '周报-{week}.csv' },
          { kind: 'md', name: '周报-{week}.md' },
        ],
      },
    ],
    ...extra,
  };
  writeFileSync(join(dir, 'yirang.app.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files))
    if (name !== 'prompt') {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
  return dir;
}
const good = {
  rows: [{ project: 'A', owner: '甲', status: 'done', hours: 3, note: null }],
  summary: 'ok',
};

test('wire schema accepts table rows, null unions and enums; strips constraints', () => {
  const wire = wireSchema(outputSchema);
  assert.equal(wire.properties.rows.items.properties.hours.minimum, undefined);
  assert.deepEqual(wire.properties.rows.items.properties.note.type, ['string', 'null']);
});
test('wire schema rejects open objects, anyOf and optional fields with location (A03/A23)', () => {
  assert.throws(
    () =>
      wireSchema({
        type: 'object',
        additionalProperties: false,
        required: ['a'],
        properties: { a: { type: 'object' } },
      }),
    /\$\.a: 开放对象/,
  );
  assert.throws(
    () =>
      wireSchema({
        type: 'object',
        additionalProperties: false,
        required: ['a'],
        properties: { a: { anyOf: [{ type: 'string' }] } },
      }),
    /\$\.a: 不支持 anyOf/,
  );
  assert.throws(
    () =>
      wireSchema({
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: { a: { type: 'string' } },
      }),
    /\$\.a: 字段必须列在 required/,
  );
  assert.throws(
    () => wireSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }),
    /additionalProperties/,
  );
});
test('package rejects backend files, oversize and autoPublish (A02/A18)', () => {
  const read = (d: string) => JSON.parse(readFileSync(join(d, 'yirang.app.json'), 'utf8'));
  let d = project({}, { 'backend/main.py': 'print(1)' });
  assert.throws(() => checkMicroPackage(d, read(d)), /backend\/main\.py/);
  d = project({}, { 'ui/big.js': 'x'.repeat(2 * 1024 * 1024 + 1) });
  assert.throws(() => checkMicroPackage(d, read(d)), /2 MiB/);
  d = project({ evolution: { autoPublish: 'always' } });
  assert.throws(() => checkMicroPackage(d, read(d)), /autoPublish/);
  d = project({}, { prompt: '{{config.secret}}' });
  assert.throws(() => checkMicroPackage(d, read(d)), /只能引用/);
});
test('oversized materials are refused without truncation (A06)', () => {
  const d = project(),
    c = checkMicroPackage(d, JSON.parse(readFileSync(join(d, 'yirang.app.json'), 'utf8')))
      .capabilities[0];
  assert.throws(
    () => renderPrompt(c, { week: 'W1' }, [{ id: 'm', title: 'x', text: '字'.repeat(30000) }]),
    /上下文限额/,
  );
});

async function setup(dir = project()) {
  const home = mkdtempSync(join(tmpdir(), 'micro-host-')),
    core = createLightAppsCore({ directory: home });
  const app = await core.command('w', 'register', { path: dir }),
    v = await core.command('w', 'instance_create', { appId: app.id });
  return { core, v, dir, home };
}
const submit = (core: any, v: any, extra: any = {}) =>
  core.command('w', 'micro_submit', {
    instanceId: v.id,
    capability: 'summarize',
    input: { week: 'W44' },
    materials: [{ id: 'm1', title: '表', text: '内容' }],
    requestId: 'r1',
    ...extra,
  });

test('micro runs need AI grant, dedupe by fingerprint, and re-grant after prompt change (A01/A05/A08/A27/A34)', async () => {
  const { core, v, dir } = await setup();
  try {
    const page = await core.command('w', 'open', { instanceId: v.id });
    assert.match(page.url, /^http:\/\/127\.0\.0\.1/); // no code authorization (A01)
    await assert.rejects(submit(core, v), /授权/);
    const info = await core.command('w', 'micro_info', { instanceId: v.id });
    await core.command('w', 'ai_grant', { instanceId: v.id, digest: info.aiGrantDigest });
    const run = await submit(core, v);
    assert.equal(run.state, 'queued');
    assert.equal(run.snapshot.materials[0].sha256.length, 64);
    assert.equal((await submit(core, v)).id, run.id);
    await assert.rejects(
      submit(core, v, { materials: [{ id: 'm1', title: '表', text: '改过' }] }),
      /请求参数已改变/,
    );
    await assert.rejects(submit(core, v, { input: { week: 'W45' } }), /请求参数已改变/);
    writeFileSync(join(dir, 'prompts', 'summarize.md'), '新提示词 {{input.week}}');
    assert.equal((await core.command('w', 'micro_info', { instanceId: v.id })).granted, false);
    await assert.rejects(submit(core, v, { requestId: 'r2' }), /授权/);
  } finally {
    core.close();
  }
});

test('execution lifecycle: invalid output fails, unknown blocks next run, late result only recorded (A04/A25/A26/A33)', async () => {
  const { core, v } = await setup();
  try {
    const info = await core.command('w', 'micro_info', { instanceId: v.id });
    await core.command('w', 'ai_grant', { instanceId: v.id, digest: info.aiGrantDigest });
    let run = await submit(core, v);
    let claim = await core.command('w', 'micro_claim');
    assert.equal(claim.run.id, run.id);
    assert.ok(claim.prompt.includes('W44'));
    let done = await core.command('w', 'micro_result', {
      runId: run.id,
      status: 'completed',
      text: '{"rows":',
    });
    assert.equal(done.state, 'failed');
    assert.equal(done.raw, '{"rows":');
    run = await submit(core, v, { requestId: 'r2' });
    claim = await core.command('w', 'micro_claim');
    done = await core.command('w', 'micro_result', {
      runId: run.id,
      notStarted: true,
      error: 'model rejected',
    });
    assert.equal(done.state, 'failed');
    assert.equal(done.exec.endReason, 'not_started');
    run = await submit(core, v, { requestId: 'r3' });
    await core.command('w', 'micro_claim');
    await core.command('w', 'micro_exec', {
      runId: run.id,
      verifying: true,
      exec: { state: 'unknown', threadId: 't', turnId: 'u' },
    });
    assert.equal(
      (await core.command('w', 'runs_get', { instanceId: v.id, runId: run.id }))[0].state,
      'verifying',
    );
    const next = await submit(core, v, { requestId: 'r4' });
    assert.equal(await core.command('w', 'micro_claim'), null); // slot stays occupied
    await core.command('w', 'micro_abandon', { instanceId: v.id, runId: run.id });
    assert.equal(await core.command('w', 'micro_claim'), null);
    const late = await core.command('w', 'micro_result', {
      runId: run.id,
      status: 'completed',
      text: JSON.stringify(good),
    });
    assert.equal(late.state, 'cancelled');
    assert.ok(late.lateResult);
    assert.equal(late.outputs.length, 0);
    claim = await core.command('w', 'micro_claim');
    assert.equal(claim.run.id, next.id);
  } finally {
    core.close();
  }
});

test('valid result is finalized into per-run output directories (A24/A38) and examples need host confirmation (A28)', async () => {
  const { core, v, home } = await setup();
  try {
    const info = await core.command('w', 'micro_info', { instanceId: v.id });
    await core.command('w', 'ai_grant', { instanceId: v.id, digest: info.aiGrantDigest });
    const ids = [];
    for (const id of ['a', 'b']) {
      const run = await submit(core, v, { requestId: id });
      await core.command('w', 'micro_claim');
      const done = await core.command('w', 'micro_result', {
        runId: run.id,
        status: 'completed',
        text: JSON.stringify(good),
      });
      assert.equal(done.state, 'completed');
      assert.equal(done.outputs.length, 2);
      assert.equal(done.outputs[0].path, `${run.id}/0/周报-W44.csv`);
      ids.push(done);
    }
    for (const done of ids) assert.ok(existsSync(join(done.outputDir, done.outputs[0].path)));
    const candidate = await core.command('w', 'example_candidate', {
      instanceId: v.id,
      runId: ids[0].id,
    });
    assert.equal(candidate.status, 'candidate');
    const confirmed = await core.command('w', 'example_confirm', {
      instanceId: v.id,
      id: candidate.id,
    });
    assert.equal(confirmed.status, 'user-confirmed');
    assert.equal(confirmed.confirmedVia, 'host-ui');
    assert.ok(home);
  } finally {
    core.close();
  }
});

test('output recovery: registers, regenerates missing, preserves modified files (A37/A39/A40)', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'micro-out-')),
    capability = {
      outputs: [
        { kind: 'json', name: 'a-{week}', from: 'rows' },
        { kind: 'md', name: 'b' },
      ],
    },
    run = { id: 'run1', input: { week: 'W1' }, result: good };
  let failSecond = true;
  const render = async (spec: any, result: any) => {
    if (spec.kind === 'md' && failSecond) throw Error('boom');
    return Buffer.from(JSON.stringify(spec.from ? result[spec.from] : result));
  };
  let r = await finalizeOutputs({ outputDir, run, capability, render });
  assert.equal(r.complete, false);
  assert.equal(r.outputs.length, 1);
  rmSync(join(outputDir, r.outputs[0].path));
  failSecond = false;
  r = await finalizeOutputs({ outputDir, run, capability, registered: r.outputs, render });
  assert.equal(r.complete, true);
  assert.equal(r.outputs.length, 2);
  writeFileSync(join(outputDir, r.outputs[0].path), 'edited');
  const again = await finalizeOutputs({
    outputDir,
    run,
    capability,
    registered: r.outputs,
    render,
    now: () => 7,
  });
  assert.equal(again.complete, true);
  assert.ok(again.diagnostics.some((d: any) => d.type === 'conflict'));
  assert.ok(readdirSync(join(outputDir, 'run1', '0')).includes('a-W1.json.modified-7'));
  // A file written before registration is adopted without rewriting.
  const fresh = await finalizeOutputs({
    outputDir,
    run: { ...run, id: 'run2' },
    capability,
    render,
  });
  rmSync(join(outputDir, 'run2', '1'), { recursive: true });
  const adopted = await finalizeOutputs({
    outputDir,
    run: { ...run, id: 'run2' },
    capability,
    registered: [],
    render,
  });
  assert.equal(adopted.complete, true);
  assert.equal(adopted.diagnostics.length, 0);
  assert.ok(fresh);
});

test('7.4 judging: sets, tolerance, ignore, review and duplicate keys (A30/A31/A35)', () => {
  const evaluation = {
    rows: {
      key: 'project',
      fields: {
        project: 'exact',
        owner: 'exact',
        status: 'exact',
        hours: { tolerance: 0.5 },
        note: 'ignore',
      },
      order: 'ignore',
    },
    summary: 'ignore',
  };
  const exp = {
    rows: [
      { project: 'A', owner: '甲', status: 'done', hours: 3, note: 'x' },
      { project: 'B', owner: '乙', status: 'doing', hours: 1, note: null },
    ],
    summary: 's',
  };
  const act = {
    rows: [
      { project: 'B', owner: '乙', status: 'doing', hours: 1.4, note: 'other' },
      { project: 'A', owner: ' 甲 ', status: 'done', hours: 3, note: null },
    ],
    summary: 't',
  };
  assert.equal(judgeExample(evaluation, exp, act).verdict, 'pass');
  assert.equal(judgeExample(evaluation, exp, { ...act, rows: act.rows.slice(1) }).verdict, 'fail');
  const dup = { rows: [{ ...exp.rows[0] }, { ...exp.rows[1], project: 'A' }], summary: 's' };
  assert.equal(judge(evaluation.rows, dup.rows, dup.rows), 'undecided');
  const combo = { ...evaluation.rows, key: ['project', 'owner'] };
  assert.equal(judge(combo, dup.rows, dup.rows), 'pass');
  assert.equal(judgeExample({ ...evaluation, summary: 'review' }, exp, act).verdict, 'undecided');
  assert.equal(
    regressionSummary([{ verdict: 'pass' }, { verdict: 'pass' }]).conclusion,
    'undecided',
  );
  assert.equal(
    regressionSummary([{ verdict: 'pass' }, { verdict: 'pass' }, { verdict: 'pass' }]).conclusion,
    'pass',
  );
  assert.equal(
    regressionSummary([
      { verdict: 'pass' },
      { verdict: 'pass' },
      { verdict: 'pass' },
      { verdict: 'undecided' },
    ]).conclusion,
    'undecided',
  );
});

// @ts-ignore
import { createMicroRunner } from '../apps/electron/micro/micro-runner.mjs';
test('runner: rejected start fails, capacity wait requeues, completion reports result', async () => {
  const calls: any[] = [];
  let mode = 'reject';
  const claims = [{ run: { id: 'r1' }, prompt: 'p', wire: {}, timeoutMs: 60000 }];
  const send = async (w: string, op: string, p: any = {}) => {
    calls.push([op, p]);
    if (op === 'micro_claim') return claims.shift() || null;
    if (op === 'micro_active') return [];
    return {};
  };
  const request = async (method: string) => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 't1' } };
    if (method === 'turn/start') {
      if (mode === 'reject') throw Object.assign(Error('bad model'), { rpcRejected: true });
      if (mode === 'full') throw Object.assign(Error('full'), { beforeSend: true });
      return { turn: { id: 'u1' } };
    }
    return {};
  };
  const runner = createMicroRunner({
    workspaces: async () => ['w'],
    send,
    request,
    capacity: { role() {} },
    cwd: '.',
    readTurn: async () => null,
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await runner.kick();
  await settle();
  assert.ok(calls.some(([op, p]) => op === 'micro_result' && p.notStarted));
  mode = 'full';
  claims.push({ run: { id: 'r2' }, prompt: 'p', wire: {}, timeoutMs: 60000 });
  await runner.kick();
  await settle();
  assert.ok(calls.some(([op, p]) => op === 'micro_result' && p.requeue && p.runId === 'r2'));
  mode = 'ok';
  claims.push({ run: { id: 'r3' }, prompt: 'p', wire: {}, timeoutMs: 60000 });
  await runner.kick();
  await settle();
  assert.equal(runner.owns('t1'), true);
  runner.notification('turn/completed', {
    threadId: 't1',
    turn: { id: 'u1', status: 'completed', items: [{ type: 'agentMessage', text: '{"a":1}' }] },
  });
  await settle();
  assert.ok(
    calls.some(
      ([op, p]) =>
        op === 'micro_result' &&
        p.runId === 'r3' &&
        p.status === 'completed' &&
        p.text === '{"a":1}',
    ),
  );
});

import {
  acceptedWorks,
  pickSuggestion,
  buildDraft,
  // @ts-ignore -- JavaScript module has no declaration file.
} from '../apps/electron/micro/micro-crystallize.mjs';
// @ts-ignore
import { createCrystallizer } from '../apps/electron/micro/micro-crystallizer.mjs';
// @ts-ignore
import { renderOutput } from '../apps/electron/micro/micro-apps.mjs';

const day = 86400000,
  now = Date.parse('2026-11-01T00:00:00Z');
const task = (
  id: string,
  {
    ago = 1,
    artifacts = [{ objectId: 'o-' + id, revision: 1 }],
    sources = [{ objectId: 's-' + id, revision: 1 }],
  }: any = {},
) => ({
  id,
  title: '周报 ' + id,
  archived: false,
  management: {
    currentRequirementsRevision: 1,
    requirements: [
      { revision: 1, goal: '整理周报 ' + id, constraints: '', deliverables: '表格', sources },
    ],
    runs: [],
    acceptances: [
      {
        requirementsRevision: 1,
        artifacts,
        textResults: [],
        at: new Date(now - ago * day).toISOString(),
        actor: 'human',
      },
    ],
  },
});
const group = (ids: string[], extra: any = {}) => ({
  label: '周报',
  workIds: ids,
  similarity: 0.9,
  commonFields: ['week'],
  materialsToResult: true,
  externalWorkIds: [],
  reason: '同类',
  ...extra,
});

test('crystallization suggestions: 3 accepted works, 60-day window, external work excluded, 30-day decline (A09/A10)', () => {
  const works = acceptedWorks([task('a'), task('b'), task('c'), task('old', { ago: 61 })], now);
  assert.deepEqual(
    works.map((w: any) => w.id),
    ['a', 'b', 'c'],
  );
  assert.equal(pickSuggestion({ groups: [group(['a', 'b'])], works, now }), null);
  assert.ok(pickSuggestion({ groups: [group(['a', 'b', 'c'])], works, now }));
  assert.equal(
    pickSuggestion({ groups: [group(['a', 'b', 'c'], { externalWorkIds: ['b'] })], works, now }),
    null,
  );
  const declined = [
    { status: 'declined', workIds: ['a', 'b', 'c'], label: '周报', decidedAt: now - 10 * day },
  ];
  assert.equal(
    pickSuggestion({ groups: [group(['a', 'b', 'c'])], works, records: declined, now }),
    null,
  );
  assert.ok(
    pickSuggestion({
      groups: [group(['a', 'b', 'c'])],
      works,
      records: [{ ...declined[0], decidedAt: now - 31 * day }],
      now,
    }),
  );
  const multi = acceptedWorks(
    [
      task('a'),
      task('b'),
      task('c', {
        artifacts: [
          { objectId: 'x', revision: 1 },
          { objectId: 'y', revision: 1 },
        ],
      }),
    ],
    now,
  );
  assert.equal(pickSuggestion({ groups: [group(['a', 'b', 'c'])], works: multi, now }), null);
});

const draft = {
  name: '周报',
  description: 'd',
  inputFields: [{ name: 'week', title: '周次', type: 'string', enumValues: [], columns: [] }],
  prompt: '整理 {{input.week}} {{config.x}}\n{{materials}}',
  outputFields: [
    {
      name: 'rows',
      title: '行',
      type: 'table',
      enumValues: [],
      columns: [
        { name: 'project', type: 'string', enumValues: [] },
        { name: 'hours', type: 'number', enumValues: [] },
      ],
    },
    { name: 'summary', title: '摘要', type: 'text', enumValues: [], columns: [] },
  ],
  outputKinds: ['xlsx', 'docx'],
  examples: ['a', 'b', 'c'].map((id) => ({
    workId: id,
    input: [{ key: 'week', value: 'W' + id }],
  })),
  promptAnchors: [{ workId: 'a', quote: '整理' }],
};

test('draft package stays inside the schema subset and prefills evaluation', () => {
  const built = buildDraft({ label: '周报', workIds: ['a', 'b', 'c'] }, draft, {
    appId: 'user.micro-test',
  });
  assert.equal(built.prompt.includes('config'), false);
  const cap = built.manifest.capabilities[0];
  assert.deepEqual(cap.evaluation.rows.key, 'project');
  assert.equal(cap.evaluation.summary, 'review');
  assert.equal(built.examples.length, 3);
  assert.equal(built.anchors.length, 1);
});

test('crystallizer: accept freezes examples, regression judges, changed material makes example unavailable (A11/A12/A29/A30)', async () => {
  const records: any = { crystal: [], draft: [] },
    objects: any = {};
  for (const id of ['a', 'b', 'c']) {
    objects['s-' + id] = { title: '材料' + id, revision: 1, text: '原始' + id };
    objects['o-' + id] = { title: '成果' + id, revision: 1, text: '成果' + id };
  }
  const expected = (id: string) => ({ rows: [{ project: 'P' + id, hours: 1 }], summary: 's' });
  const ask = async ({ prompt }: any) => {
    if (prompt.startsWith('判断'))
      return { text: JSON.stringify({ groups: [group(['a', 'b', 'c'])] }) };
    if (prompt.startsWith('把下面这类')) return { text: JSON.stringify(draft) };
    const m = prompt.match(/成果([abc])/) || prompt.match(/W([abc])/);
    return { text: JSON.stringify(expected(m[1])) };
  };
  const home = mkdtempSync(join(tmpdir(), 'crystal-'));
  const c = createCrystallizer({
    ask,
    store: {
      list: async (w: string, k: string) => records[k],
      put: async (w: string, k: string, v: any) => {
        records[k] = [...records[k].filter((x: any) => x.id !== v.id), v];
        return v;
      },
    },
    tasks: async () => [task('a'), task('b'), task('c')],
    readObject: async (id: string) => objects[id] || null,
    register: async () => ({ id: 'inst' }),
    directory: home,
    now: () => now,
  });
  const s = await c.scan('w');
  assert.equal(s.status, 'suggested');
  assert.equal(await c.scan('w', { force: true }), null);
  const d = await c.accept('w', s.id);
  assert.equal(readdirSync(join(d.root, 'examples')).length, 3);
  assert.equal(d.regression.summary.undecided, 3);
  assert.equal(d.regression.summary.conclusion, 'undecided'); // summary is a review field
  assert.ok(d.regression.results.every((r: any) => r.fields.rows === 'pass'));
  objects['s-b'].text = '被修改';
  const again = await c.regress('w', d.id);
  assert.equal(again.regression.summary.unavailable, 1);
  assert.equal(again.regression.results.find((r: any) => r.workId === 'b').available, false);
  const published = await c.publish('w', d.id);
  assert.equal(published.status, 'published');
  assert.equal(records.crystal[0].status, 'published');
});

test('docx output is a valid zip with document body', async () => {
  const bytes = await renderOutput({ kind: 'docx' }, { rows: [{ a: 1 }], summary: 'x' });
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  // @ts-ignore
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const document = zip.file('word/document.xml');
  assert.ok(document, 'DOCX must contain word/document.xml');
  assert.match(await document.async('string'), /<w:tbl>/);
});

test('bundled micro examples register (zero-code page and custom page)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'micro-ex-')),
    core = createLightAppsCore({ directory: home });
  try {
    for (const name of ['micro-weekly-report', 'micro-meeting-todos']) {
      const app = await core.command('w', 'register', {
        path: join(process.cwd(), 'examples', name),
      });
      const v = await core.command('w', 'instance_create', { appId: app.id });
      const bundle = await core.command('w', 'ui_bundle', { instanceId: v.id });
      assert.ok(bundle.assets.length >= 1);
    }
  } finally {
    core.close();
  }
});

test('runner reconciles in-memory jobs whose completion notice was lost, and retries failed reports', async () => {
  let t = 0;
  const sent: any[] = [];
  let failSend = true,
    reads = 0;
  const claims = [{ run: { id: 'r9' }, prompt: 'p', wire: {}, timeoutMs: 600000 }];
  const send = async (w: string, op: string, p: any = {}) => {
    if (op === 'micro_claim') return claims.shift() || null;
    if (op === 'micro_active') return [];
    if (op === 'micro_result' && failSend) throw Error('pipe closed');
    sent.push([op, p]);
    return {};
  };
  const request = async (method: string) =>
    method === 'config/read'
      ? { config: {} }
      : method === 'thread/start'
        ? { thread: { id: 't9' } }
        : method === 'turn/start'
          ? { turn: { id: 'u9' } }
          : {};
  const readTurn = async () => {
    reads++;
    return {
      id: 'u9',
      status: 'completed',
      items: [{ type: 'agentMessage', text: '{"ok":true}' }],
    };
  };
  const runner = createMicroRunner({
    workspaces: async () => ['w'],
    send,
    request,
    capacity: { role() {} },
    cwd: '.',
    readTurn,
    now: () => t,
  });
  await runner.kick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.owns('t9'), true);
  t = 60000;
  await runner.verify();
  assert.equal(reads, 1);
  assert.equal(runner.owns('t9'), false);
  assert.equal(runner.pendingReports(), 1);
  failSend = false;
  await runner.verify();
  assert.equal(runner.pendingReports(), 0);
  assert.ok(
    sent.some(([op, p]) => op === 'micro_result' && p.runId === 'r9' && p.status === 'completed'),
  );
});

test('cancelled run keeps the real outcome but delivers no outputs (P2 cancel)', async () => {
  const { core, v } = await setup();
  try {
    const info = await core.command('w', 'micro_info', { instanceId: v.id });
    await core.command('w', 'ai_grant', { instanceId: v.id, digest: info.aiGrantDigest });
    const run = await submit(core, v, { requestId: 'c1' });
    await core.command('w', 'micro_claim');
    assert.equal(
      (await core.command('w', 'cancel', { instanceId: v.id, runId: run.id })).cancelRequested,
      true,
    );
    const done = await core.command('w', 'micro_result', {
      runId: run.id,
      status: 'completed',
      text: JSON.stringify(good),
    });
    assert.equal(done.state, 'cancelled');
    assert.equal(done.outputs.length, 0);
    assert.equal(done.exec.state, 'ended');
    assert.ok(done.lateResult);
  } finally {
    core.close();
  }
});

test('a maximal 256 KiB result fits the host transport limit', () => {
  const host = readFileSync(
      join(process.cwd(), 'apps/electron/light-apps/light-apps-host.mjs'),
      'utf8',
    ),
    limitMatch = /text\.length\s*>\s*(\d+)/.exec(host);
  assert.ok(limitMatch, 'host transport must declare a request size limit');
  const limit = Number(limitMatch[1]);
  const payload = JSON.stringify({
    workspaceId: 'w',
    operation: 'micro_result',
    payload: { runId: 'x'.repeat(64), status: 'completed', text: '"'.repeat(256 * 1024) },
  });
  assert.ok(payload.length < limit);
});
