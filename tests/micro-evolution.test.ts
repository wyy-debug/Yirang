import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
// @ts-ignore
import { createLightAppsCore } from '../apps/electron/light-apps/light-apps-core.mjs';
import {
  checkMicroPackage,
  hashValue,
  diffValues,
  judge,
  // @ts-ignore -- JavaScript module has no declaration file.
} from '../apps/electron/micro/micro-apps.mjs';
import {
  createEvolution,
  triggerFor,
  compareRegression,
  EVOLUTION,
  // @ts-ignore -- JavaScript module has no declaration file.
} from '../apps/electron/micro/micro-evolution.mjs';
import {
  exportPlan,
  buildExport,
  upgradeFiles,
  templateFiles,
  writeFiles,
  MICRO_TEMPLATES,
  createMicroShare,
  // @ts-ignore -- JavaScript module has no declaration file.
} from '../apps/electron/micro/micro-share.mjs';

const row = {
  type: 'object',
  additionalProperties: false,
  required: ['project', 'owner', 'hours'],
  properties: { project: { type: 'string' }, owner: { type: 'string' }, hours: { type: 'number' } },
};
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'summary'],
  properties: { rows: { type: 'array', items: row }, summary: { type: 'string' } },
};
const evaluation = {
  rows: { key: 'project', fields: { owner: 'exact', hours: { tolerance: 0.5 } }, order: 'ignore' },
  summary: 'ignore',
};
function project(extra: any = {}, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'micro-evo-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(
    join(dir, 'prompts', 'run.md'),
    files.prompt ?? '整理 {{input.week}} 的周报。\n{{materials}}',
  );
  writeFileSync(
    join(dir, 'yirang.app.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'user.weekly',
      name: '周报',
      version: '0.1.0',
      minHostApi: 3,
      runtime: { kind: 'micro' },
      capabilities: [
        {
          name: 'run',
          title: '生成周报',
          prompt: 'prompts/run.md',
          inputSchema: {
            type: 'object',
            properties: { week: { type: 'string' } },
            required: ['week'],
          },
          outputSchema,
          evaluation,
          materials: { min: 0, max: 3 },
          outputs: [{ kind: 'json', name: '周报-{week}.json' }],
        },
      ],
      ...extra,
    }),
  );
  for (const [name, content] of Object.entries(files))
    if (name !== 'prompt') {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
  return dir;
}
const expected = (week: string) => ({
  rows: [{ project: 'P-' + week, owner: '甲', hours: 3 }],
  summary: 'ok',
});
async function setup(dir = project()) {
  const home = mkdtempSync(join(tmpdir(), 'micro-evo-host-')),
    core = createLightAppsCore({ directory: home });
  const app = await core.command('w', 'register', { path: dir }),
    v = await core.command('w', 'instance_create', { appId: app.id });
  const info = await core.command('w', 'micro_info', { instanceId: v.id });
  await core.command('w', 'ai_grant', { instanceId: v.id, digest: info.aiGrantDigest });
  return { core, v, dir };
}
let serial = 0;
async function completedRun(
  core: any,
  v: any,
  week: string,
  output: any = expected(week),
  material = '材料 ' + week,
) {
  const run = await core.command('w', 'micro_submit', {
    instanceId: v.id,
    capability: 'run',
    input: { week },
    materials: [{ id: 'obj-' + week, title: week, text: material }],
    requestId: 'q' + ++serial,
  });
  await core.command('w', 'micro_claim');
  return core.command('w', 'micro_result', {
    runId: run.id,
    status: 'completed',
    text: JSON.stringify(output),
  });
}

test('core records failure, schema, edit and repeated-note signals per version (9.1)', async () => {
  const { core, v } = await setup();
  try {
    let run = await core.command('w', 'micro_submit', {
      instanceId: v.id,
      capability: 'run',
      input: { week: 'W1' },
      materials: [],
      requestId: 'f1',
    });
    await core.command('w', 'micro_claim');
    await core.command('w', 'micro_result', {
      runId: run.id,
      status: 'completed',
      text: '{"rows":',
    });
    run = await core.command('w', 'micro_submit', {
      instanceId: v.id,
      capability: 'run',
      input: { week: 'W1' },
      materials: [],
      requestId: 'f2',
    });
    await core.command('w', 'micro_claim');
    await core.command('w', 'micro_result', {
      runId: run.id,
      notStarted: true,
      error: 'model rejected',
    });
    const done = await completedRun(core, v, 'W1');
    assert.equal(done.state, 'completed');
    const edited = { ...done.result, rows: [{ ...done.result.rows[0], owner: '乙' }] };
    assert.ok(
      (await core.command('w', 'result_edit', { instanceId: v.id, runId: done.id, output: edited }))
        .signalId,
    );
    assert.equal(
      (await core.command('w', 'result_edit', { instanceId: v.id, runId: done.id, output: edited }))
        .signalId,
      null,
      'same edit twice records once',
    );
    await assert.rejects(
      core.command('w', 'result_edit', { instanceId: v.id, runId: done.id, output: { rows: 'x' } }),
      /不符合/,
    );
    await core.command('w', 'feedback', {
      instanceId: v.id,
      runId: done.id,
      verdict: 'wrong',
      note: '漏了周三',
    });
    const signals = await core.command('w', 'signals_list', { instanceId: v.id });
    assert.deepEqual(
      signals.map((s: any) => s.type + ':' + (s.category || '')),
      ['failure:schema', 'failure:not-started', 'edit:', 'feedback:'],
    );
    assert.ok(signals.every((s: any) => s.appVersion === '0.1.0' && s.capability === 'run'));
    assert.deepEqual(signals[2].changes, [
      { path: '$.rows[0].owner', before: '"甲"', after: '"乙"' },
    ]);
    assert.equal(
      (await core.command('w', 'runs_get', { instanceId: v.id, runId: done.id }))[0].editedResult
        .output.rows[0].owner,
      '乙',
    );
  } finally {
    core.close();
  }
});
test('same supplemental text in three runs becomes one repeat-note signal', async () => {
  const dir = project({
    capabilities: [
      {
        name: 'run',
        title: 't',
        prompt: 'prompts/run.md',
        inputSchema: {
          type: 'object',
          properties: { week: { type: 'string' }, note: { type: 'string' } },
          required: ['week'],
        },
        outputSchema,
        evaluation,
      },
    ],
  });
  const { core, v } = await setup(dir);
  try {
    for (let i = 0; i < 4; i++)
      await core.command('w', 'micro_submit', {
        instanceId: v.id,
        capability: 'run',
        input: { week: 'W' + i, note: '  金额保留两位小数 ' },
        materials: [],
        requestId: 'n' + i,
      });
    const notes = (await core.command('w', 'signals_list', { instanceId: v.id })).filter(
      (s: any) => s.type === 'repeat-note',
    );
    assert.equal(notes.length, 1);
    assert.equal(notes[0].field, 'note');
    assert.equal(notes[0].note, '金额保留两位小数');
  } finally {
    core.close();
  }
});
test('keyed table rows compare undeclared key columns exactly', () => {
  const rule = { key: 'project', fields: { owner: 'exact' }, order: 'ignore' };
  assert.equal(
    judge(rule, [{ project: 'A', owner: '甲' }], [{ project: 'A', owner: '甲' }]),
    'pass',
  );
  assert.equal(
    judge(rule, [{ project: 'A', owner: '甲' }], [{ project: 'A', owner: '乙' }]),
    'fail',
  );
});
test('diffValues lists changed paths only', () => {
  assert.deepEqual(
    diffValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3], c: null }).map((d: any) => d.path),
    ['$.b[1]', '$.c'],
  );
});

const sig = (id: string, type: string, extra: any = {}) => ({
  id,
  type,
  capability: 'run',
  appVersion: '1',
  createdAt: 0,
  ...extra,
});
test('draft trigger: 5 signals or 3 same failures, 24h gap, one open draft, not-started ignored (9.2/A16)', () => {
  const now = 10 * EVOLUTION.gapMs,
    five = [1, 2, 3, 4, 5].map((n) => sig('s' + n, 'feedback'));
  assert.equal(triggerFor(five.slice(0, 4), [], { version: '1', now }), null);
  assert.equal(triggerFor(five, [], { version: '1', now }).signals.length, 5);
  assert.equal(
    triggerFor(five, [], { version: '2', now }),
    null,
    'signals belong to their version',
  );
  assert.equal(
    triggerFor(five, [{ state: 'held', createdAt: 0 }], { version: '1', now }),
    null,
    'one unprocessed draft at a time',
  );
  assert.equal(
    triggerFor(five, [{ state: 'discarded', createdAt: now - 1000 }], { version: '1', now }),
    null,
    '24h since last draft',
  );
  assert.equal(
    triggerFor(five, [{ state: 'discarded', createdAt: 0, signalIds: ['s1'] }], {
      version: '1',
      now,
    }),
    null,
    'used signals need new evidence',
  );
  const failures = [1, 2, 3].map((n) => sig('f' + n, 'failure', { category: 'schema' }));
  assert.match(triggerFor(failures, [], { version: '1', now }).reason, /3 次同类失败/);
  assert.equal(
    triggerFor(
      [1, 2, 3].map((n) => sig('x' + n, 'failure', { category: 'not-started' })),
      [],
      { version: '1', now },
    ),
    null,
  );
  assert.equal(
    triggerFor(
      [
        sig('a', 'failure', { category: 'schema' }),
        sig('b', 'failure', { category: 'schema' }),
        sig('c', 'failure', { category: 'execution' }),
      ],
      [],
      { version: '1', now },
    ),
    null,
  );
});
const r = (id: string, verdict: string | null, extra: any = {}) => ({
  exampleId: id,
  available: true,
  source: 'user-confirmed',
  verdict,
  ...extra,
});
test('regression comparison gates (A17/A19/A30/A36)', () => {
  assert.equal(
    compareRegression(
      [r('1', 'pass'), r('2', 'pass'), r('3', 'pass')],
      [r('1', 'pass'), r('2', 'fail'), r('3', 'pass')],
    ).conclusion,
    'pass',
  );
  const worse = compareRegression(
    [r('1', 'fail'), r('2', 'pass'), r('3', 'pass'), r('4', 'pass')],
    [r('1', 'pass'), r('2', 'fail'), r('3', 'fail'), r('4', 'fail')],
  );
  assert.equal(worse.conclusion, 'fail');
  assert.deepEqual(worse.regressions, ['1']);
  assert.equal(
    compareRegression([r('1', 'pass'), r('2', 'pass')], [r('1', 'pass'), r('2', 'pass')])
      .conclusion,
    'undecided',
  );
  assert.equal(
    compareRegression(
      [r('1', 'pass'), r('2', 'pass'), r('3', 'pass')].map((x) => ({ ...x, source: 'synthetic' })),
      [],
    ).conclusion,
    'undecided',
  );
  assert.equal(
    compareRegression(
      [r('1', 'pass'), r('2', 'pass'), r('3', 'pass')],
      [r('1', 'pass'), r('2', null, { baselineUnavailable: true }), r('3', 'pass')],
    ).conclusion,
    'undecided',
  );
  assert.equal(
    compareRegression(
      [r('1', 'pass'), r('2', 'pass'), r('3', 'pass'), r('4', null)],
      [r('1', 'pass'), r('2', 'pass'), r('3', 'pass'), r('4', null)],
    ).conclusion,
    'undecided',
  );
  assert.equal(
    compareRegression(
      [r('1', 'pass'), r('2', 'pass'), r('3', 'pass'), r('4', 'undecided')],
      [r('1', 'pass'), r('2', 'pass'), r('3', 'pass'), r('4', 'undecided')],
    ).conclusion,
    'undecided',
  );
  assert.equal(
    compareRegression(
      [
        r('1', 'fail', { error: '结果不符合 outputSchema' }),
        r('2', 'pass'),
        r('3', 'pass'),
        r('4', 'pass'),
      ],
      [r('1', 'fail'), r('2', 'pass'), r('3', 'pass'), r('4', 'pass')],
    ).conclusion,
    'fail',
  );
});

test('full loop: signals -> draft -> regression with old baseline -> publish -> rollback keeps records (A16/A20/A36/A08)', async () => {
  const { core, v } = await setup();
  let clock = EVOLUTION.gapMs * 2,
    model = 'm1';
  const calls: string[] = [];
  const weeks = ['W1', 'W2', 'W3'],
    objects = new Map(weeks.map((w) => ['obj-' + w, { text: '材料 ' + w, revision: 1 }]));
  // New prompt (contains V2) answers every example correctly; the old one gets W1's owner wrong.
  const ask = async ({ prompt }: any) => {
    if (prompt.startsWith('你在改进')) {
      calls.push('improve');
      return {
        text: JSON.stringify({
          prompt: 'V2 整理 {{input.week}} 的周报，负责人照抄材料。\n{{materials}}',
          outputSchemaJson: null,
          outputsJson: null,
          rationale: '用户多次指出负责人错误',
        }),
        usage: { input: 1, output: 1 },
      };
    }
    const week = /输入：\{"week":"(W\d)"\}/.exec(prompt)![1],
      v2 = prompt.startsWith('V2');
    calls.push((v2 ? 'new:' : 'old:') + week);
    return {
      text: JSON.stringify(
        !v2 && week === 'W1'
          ? { ...expected(week), rows: [{ ...expected(week).rows[0], owner: '错' }] }
          : expected(week),
      ),
      usage: { input: 1, output: 1 },
    };
  };
  const evo = createEvolution({
    send: (w: string, op: string, p: any = {}) => core.command(w, op, p),
    ask,
    readObject: async (id: string) => objects.get(id) || null,
    model: async () => ({ model }),
    cliVersion: () => 'cli-1',
    now: () => clock,
  });
  try {
    for (const week of weeks) {
      const run = await completedRun(core, v, week);
      const e = await core.command('w', 'example_candidate', { instanceId: v.id, runId: run.id });
      await core.command('w', 'example_confirm', { instanceId: v.id, id: e.id });
    }
    assert.deepEqual(await evo.check('w'), [], 'no signals yet');
    const last = (await core.command('w', 'runs_get', { instanceId: v.id }))[0];
    for (let i = 0; i < 5; i++)
      await core.command('w', 'feedback', {
        instanceId: v.id,
        runId: last.id,
        verdict: 'wrong',
        note: '负责人不对 ' + i,
      });
    const [made] = await evo.check('w');
    assert.equal(made.state, 'proposed', made.regression?.comparison?.reason || made.error);
    assert.equal(made.version, '0.1.1');
    assert.equal(made.regression.comparison.new.passed, 3);
    assert.equal(made.regression.comparison.old.passed, 2);
    assert.deepEqual(calls.filter((c) => c !== 'improve').sort(), [
      'new:W1',
      'new:W2',
      'new:W3',
      'old:W1',
      'old:W2',
      'old:W3',
    ]);
    assert.equal(made.signalIds.length, 5);
    assert.deepEqual(await evo.check('w'), [], 'one unprocessed draft at a time');
    await assert.rejects(evo.regress('w', made.id), /只有未处理|最多回归一次/);
    await evo.publish('w', made.id);
    const after = await core.command('w', 'describe', { instanceId: v.id });
    assert.equal(after.manifest.version, '0.1.1');
    assert.match(after.micro.capabilities[0].prompt, /^V2/);
    assert.equal(
      (await core.command('w', 'micro_info', { instanceId: v.id })).granted,
      false,
      'prompt change asks for AI grant again',
    );
    await evo.rollback('w', made.id);
    assert.equal(
      (await core.command('w', 'describe', { instanceId: v.id })).manifest.version,
      '0.1.0',
    );
    const listed = await evo.list('w', v.id);
    assert.equal(listed.improvements[0].state, 'rolled-back');
    assert.equal(listed.signals.length, 5, 'signals survive rollback');

    // Second draft: same conditions reuse old results; a model change re-runs the old version.
    clock += EVOLUTION.gapMs + 1;
    calls.length = 0;
    for (let i = 0; i < 5; i++)
      await core.command('w', 'feedback', {
        instanceId: v.id,
        runId: last.id,
        verdict: 'wrong',
        note: '再次 ' + i,
      });
    const [second] = await evo.check('w');
    assert.equal(second.state, 'proposed');
    assert.ok(
      !calls.some((c) => c.startsWith('old:')),
      'baseline reused under identical conditions',
    );
    assert.ok(second.regression.baseline.every((b: any) => b.reused));
    await evo.discard('w', second.id);
    clock += EVOLUTION.gapMs + 1;
    calls.length = 0;
    model = 'm2';
    for (let i = 0; i < 5; i++)
      await core.command('w', 'feedback', {
        instanceId: v.id,
        runId: last.id,
        verdict: 'wrong',
        note: '第三次 ' + i,
      });
    const [third] = await evo.check('w');
    assert.equal(third.regression.conditions.model.model, 'm2');
    assert.equal(
      calls.filter((c) => c.startsWith('old:')).length,
      3,
      'model change re-runs the old version',
    );
    // A changed example material makes it unavailable instead of using new content.
    await evo.discard('w', third.id);
    clock += EVOLUTION.gapMs + 1;
    objects.set('obj-W2', { text: '改过', revision: 2 });
    for (let i = 0; i < 5; i++)
      await core.command('w', 'feedback', {
        instanceId: v.id,
        runId: last.id,
        verdict: 'wrong',
        note: '第四次 ' + i,
      });
    const [fourth] = await evo.check('w');
    assert.equal(fourth.state, 'held');
    assert.equal(fourth.regression.comparison.new.unavailable, 1);
    assert.equal(fourth.regression.comparison.conclusion, 'undecided');
  } finally {
    core.close();
  }
});
test('a draft that makes a confirmed example worse is held, not proposed (A17)', async () => {
  const { core, v } = await setup();
  const ask = async ({ prompt }: any) => {
    if (prompt.startsWith('你在改进'))
      return {
        text: JSON.stringify({
          prompt: 'V2 {{input.week}}\n{{materials}}',
          outputSchemaJson: null,
          outputsJson: null,
          rationale: 'r',
        }),
      };
    const week = /"week":"(W\d)"/.exec(prompt)![1];
    return {
      text: JSON.stringify(
        prompt.startsWith('V2') && week === 'W1' ? { rows: [], summary: 'x' } : expected(week),
      ),
    };
  };
  const evo = createEvolution({
    send: (w: string, op: string, p: any = {}) => core.command(w, op, p),
    ask,
    readObject: async (id: string) => ({ text: '材料 ' + id.slice(4), revision: 1 }),
    now: () => EVOLUTION.gapMs * 3,
  });
  try {
    for (const week of ['W1', 'W2', 'W3']) {
      const run = await completedRun(core, v, week);
      const e = await core.command('w', 'example_candidate', { instanceId: v.id, runId: run.id });
      await core.command('w', 'example_confirm', { instanceId: v.id, id: e.id });
    }
    const last = (await core.command('w', 'runs_get', { instanceId: v.id }))[0];
    for (let i = 0; i < 5; i++)
      await core.command('w', 'feedback', { instanceId: v.id, runId: last.id, note: String(i) });
    const [made] = await evo.check('w');
    assert.equal(made.state, 'held');
    assert.equal(made.regression.comparison.conclusion, 'fail');
    assert.match(made.regression.comparison.reason, /旧版本通过/);
  } finally {
    core.close();
  }
});
test('one regression batch uses the model captured at its start for every old and new call', async () => {
  const { core, v } = await setup();
  let n = 0;
  const used: string[] = [];
  const ask = async ({ prompt, model }: any) => {
    if (prompt.startsWith('你在改进'))
      return {
        text: JSON.stringify({
          prompt: 'V2 {{input.week}}\n{{materials}}',
          outputSchemaJson: null,
          outputsJson: null,
          rationale: 'r',
        }),
      };
    used.push(model?.model);
    const week = /"week":"(W\d)"/.exec(prompt)![1];
    return { text: JSON.stringify(expected(week)) };
  };
  const evo = createEvolution({
    send: (w: string, op: string, p: any = {}) => core.command(w, op, p),
    ask,
    readObject: async (id: string) => ({ text: '材料 ' + id.slice(4), revision: 1 }),
    model: async () => ({ model: 'm' + ++n }),
    now: () => EVOLUTION.gapMs * 3,
  });
  try {
    for (const week of ['W1', 'W2', 'W3']) {
      const run = await completedRun(core, v, week);
      const e = await core.command('w', 'example_candidate', { instanceId: v.id, runId: run.id });
      await core.command('w', 'example_confirm', { instanceId: v.id, id: e.id });
    }
    const last = (await core.command('w', 'runs_get', { instanceId: v.id }))[0];
    for (let i = 0; i < 5; i++)
      await core.command('w', 'feedback', { instanceId: v.id, runId: last.id, note: String(i) });
    const [made] = await evo.check('w');
    assert.equal(used.length, 6);
    assert.deepEqual([...new Set(used)], [made.regression.conditions.model.model]);
  } finally {
    core.close();
  }
});
test('autoPropose off stops new drafts; schema outside the subset is refused (U09/9.3)', async () => {
  const { core, v } = await setup();
  const ask = async () => ({
    text: JSON.stringify({
      prompt: 'p {{materials}}',
      outputSchemaJson: JSON.stringify({ type: 'object', properties: { a: { type: 'string' } } }),
      outputsJson: null,
      rationale: 'r',
    }),
  });
  const evo = createEvolution({
    send: (w: string, op: string, p: any = {}) => core.command(w, op, p),
    ask,
    readObject: async () => null,
    now: () => EVOLUTION.gapMs * 3,
  });
  try {
    const run = await completedRun(core, v, 'W1');
    for (let i = 0; i < 5; i++)
      await core.command('w', 'feedback', { instanceId: v.id, runId: run.id, note: String(i) });
    await core.command('w', 'evolution_settings', { instanceId: v.id, autoPropose: false });
    assert.deepEqual(await evo.check('w'), []);
    await core.command('w', 'evolution_settings', { instanceId: v.id, autoPropose: true });
    const [made] = await evo.check('w');
    assert.equal(made.state, 'failed');
    assert.match(made.error, /子集/);
    assert.equal(
      (await core.command('w', 'describe', { instanceId: v.id })).manifest.version,
      '0.1.0',
    );
  } finally {
    core.close();
  }
});

const crystallized = () =>
  project(
    { crystallizedFrom: { workIds: ['work-1'], label: '周报' }, examples: 'examples/' },
    {
      prompt: '整理 {{input.week}}。客户A的报价单必须单列。\n{{materials}}',
      'examples/1.json': JSON.stringify({
        id: 'e1',
        source: 'accepted-work',
        workId: 'work-1',
        input: { week: 'W1' },
        materials: [{ id: 'obj-1', title: '客户A报价', sha256: 'x' }],
        output: expected('W1'),
      }),
      'examples/2.json': JSON.stringify({
        id: 'e2',
        source: 'synthetic',
        input: { week: 'W9' },
        materials: [],
        output: expected('W9'),
      }),
    },
  );
const read = (d: string) => JSON.parse(readFileSync(join(d, 'yirang.app.json'), 'utf8'));
test('export: whitelist by default, anchors must be decided, real examples opt-in, imported app needs AI grant (A21/A32)', async () => {
  const root = crystallized(),
    manifest = read(root),
    anchors = [{ workId: 'work-1', quote: '客户A的报价单必须单列。' }];
  const plan = exportPlan({ root, manifest, anchors, confirmedExamples: [] });
  assert.ok(plan.files.includes('examples/2.json'));
  assert.ok(!plan.files.includes('examples/1.json'));
  assert.deepEqual(plan.stripped, ['crystallizedFrom']);
  assert.equal(plan.anchors.length, 1);
  assert.equal(plan.examples.length, 1);
  await assert.rejects(
    async () => buildExport({ root, manifest, plan, decisions: { digest: plan.digest } }),
    /尚未确认/,
  );
  await assert.rejects(
    async () =>
      buildExport({
        root,
        manifest,
        plan,
        decisions: {
          digest: plan.digest,
          anchors: { 0: { action: 'keep' } },
          examples: [plan.examples[0].key],
          materials: [plan.examples[0].key],
        },
      }),
    /再次确认/,
  );
  const { bundle, manifest: list } = await buildExport({
    root,
    manifest,
    plan,
    decisions: {
      digest: plan.digest,
      anchors: { 0: { action: 'replace', text: '指定客户的报价单单列。' } },
    },
  });
  const file = (p: string) =>
    Buffer.from(bundle.files.find((f: any) => f.path === p).data, 'base64').toString('utf8');
  assert.equal(bundle.format, 'micro');
  assert.ok(!file('prompts/run.md').includes('客户A'));
  assert.equal(JSON.parse(file('yirang.app.json')).crystallizedFrom, undefined);
  assert.ok(!bundle.files.some((f: any) => f.path === 'examples/1.json'));
  assert.equal(list.length, bundle.files.length);
  const withExample = await buildExport({
    root,
    manifest,
    plan,
    decisions: {
      digest: plan.digest,
      anchors: { 0: { action: 'keep' } },
      examples: [plan.examples[0].key],
    },
  });
  const shared = JSON.parse(
    Buffer.from(
      withExample.bundle.files.find((f: any) => f.path.startsWith('examples/shared-')).data,
      'base64',
    ).toString('utf8'),
  );
  assert.equal(shared.source, 'shared');
  assert.equal(shared.workId, undefined);
  assert.deepEqual(shared.materials, [{ title: '客户A报价' }]);
  const path = join(mkdtempSync(join(tmpdir(), 'micro-export-')), 'a.yirang-app');
  writeFileSync(path, JSON.stringify(bundle));
  const core = createLightAppsCore({ directory: mkdtempSync(join(tmpdir(), 'micro-import-')) });
  try {
    const imported = await core.command('w2', 'package_import', { path });
    assert.equal(imported.micro, true);
    const v = await core.command('w2', 'instance_create', { appId: imported.appId });
    assert.equal((await core.command('w2', 'micro_info', { instanceId: v.id })).granted, false);
    const bad = {
      ...bundle,
      files: [
        ...bundle.files,
        {
          path: 'backend/main.py',
          data: Buffer.from('x').toString('base64'),
          sha256: hashValue('x'),
        },
      ],
    };
    const badPath = path + '.bad';
    writeFileSync(
      badPath,
      JSON.stringify({
        ...bad,
        files: bad.files.map((f: any) =>
          f.path === 'backend/main.py'
            ? { ...f, sha256: createHash('sha256').update('x').digest('hex') }
            : f,
        ),
      }),
    );
    await assert.rejects(
      core.command('w3', 'package_import', { path: badPath }),
      /backend\/main\.py/,
    );
  } finally {
    core.close();
  }
});
const fakeKey = ['sk', 'abcdefghijklmnop1234'].join('-');
test('export scan flags example and material fragments plus contact, ID, secret and path patterns in any exported text', async () => {
  const root = project(
    { description: '联系 zhang.san@corp.example 获取模板' },
    {
      prompt: '整理 {{input.week}}。项目「华东区年度框架合同」单独列出。\n{{materials}}',
      'README.md':
        '# 周报\n负责人电话 13812345678，备用 021-12345678。\n数据目录 C:\\Users\\zhangsan\\Desktop\\周报\n',
      'ui/index.html':
        '<script>const key="' + fakeKey + '";</script><p>付款账号 6222020200112233445</p>',
      'examples/1.json': JSON.stringify({
        id: 'e1',
        source: 'accepted-work',
        input: { week: 'W1' },
        materials: [{ id: 'obj-1', title: '华东合同原件', sha256: 'x' }],
        output: { rows: [{ project: '华东区年度框架合同', owner: '甲', hours: 3 }], summary: 'ok' },
      }),
      'examples/2.json': JSON.stringify({
        id: 'e2',
        source: 'synthetic',
        input: { week: 'W9' },
        materials: [],
        output: { rows: [], summary: '身份证 110101199003071234 仅示意' },
      }),
    },
  );
  const manifest = read(root);
  const plan = exportPlan({
    root,
    manifest,
    materialTexts: [
      { title: '华东合同原件', text: '第一条 甲方应于每月五日前支付服务费用。\n短句' },
    ],
  });
  const by = (label: string) =>
    plan.anchors.filter((a: any) => a.label === label).map((a: any) => a.quote);
  assert.deepEqual(by('与真实样例相同的内容'), ['华东区年度框架合同']);
  assert.deepEqual(by('邮箱'), ['zhang.san@corp.example']);
  assert.deepEqual(by('手机号'), ['13812345678']);
  assert.deepEqual(by('固定电话'), ['021-12345678']);
  assert.deepEqual(by('身份证号'), ['110101199003071234']);
  assert.deepEqual(by('长数字（银行卡号等）'), ['6222020200112233445']);
  assert.deepEqual(by('密钥或令牌'), [fakeKey]);
  assert.deepEqual(by('本机用户路径'), ['C:\\Users\\zhangsan']);
  assert.equal(plan.anchors.find((a: any) => a.kind === 'example').files[0], 'prompts/run.md');
  assert.equal(by('材料「华东合同原件」中的原文').length, 0);
  writeFileSync(join(root, 'README.md'), '# 周报\n第一条 甲方应于每月五日前支付服务费用\n');
  assert.deepEqual(
    exportPlan({
      root,
      manifest,
      materialTexts: [{ title: '华东合同原件', text: '第一条 甲方应于每月五日前支付服务费用。' }],
    }).anchors.map((a: any) => a.label),
    [
      '与真实样例相同的内容',
      '材料「华东合同原件」中的原文',
      '邮箱',
      '身份证号',
      '长数字（银行卡号等）',
      '密钥或令牌',
    ],
  );
  const p2 = exportPlan({ root, manifest });
  await assert.rejects(
    async () => buildExport({ root, manifest, plan: p2, decisions: { digest: p2.digest } }),
    /尚未确认/,
  );
  const decisions = {
    digest: p2.digest,
    anchors: Object.fromEntries(
      p2.anchors.map((a: any) => [
        a.index,
        a.label === '邮箱'
          ? { action: 'replace', text: 'service@example.com' }
          : { action: 'keep' },
      ]),
    ),
  };
  const { bundle } = await buildExport({ root, manifest, plan: p2, decisions });
  const file = (p: string) =>
    Buffer.from(bundle.files.find((f: any) => f.path === p).data, 'base64').toString('utf8');
  assert.equal(
    JSON.parse(file('yirang.app.json')).description,
    '联系 service@example.com 获取模板',
  );
});
test('built-in templates are valid micro apps', () => {
  assert.equal(MICRO_TEMPLATES.length, 3);
  for (const t of MICRO_TEMPLATES) {
    const dir = writeFiles(
      join(mkdtempSync(join(tmpdir(), 'tpl-')), 'app'),
      templateFiles(t, 'user.' + t.id),
    );
    assert.equal(checkMicroPackage(dir, read(dir)).capabilities.length, 1, t.id);
  }
});
test('export decisions are bound to the reviewed content; any change after review requires a new review', async () => {
  const { core, v, dir } = await setup(
    project({}, { prompt: '整理 {{input.week}}。\n{{materials}}' }),
  );
  const share = createMicroShare({
    send: (w: string, op: string, p: any = {}) => core.command(w, op, p),
    readObject: async () => null,
    directory: mkdtempSync(join(tmpdir(), 'micro-share-')),
    register: async () => null,
  });
  try {
    const plan = await share.exportPlan('w', v.id);
    assert.equal(plan.anchors.length, 0);
    // A sensitive line appears after the user reviewed an empty list: the old (empty) decisions must not export it.
    writeFileSync(
      join(dir, 'prompts', 'run.md'),
      '整理 {{input.week}}。联系 a.b@corp.example\n{{materials}}',
    );
    await assert.rejects(
      share.exportPackage('w', v.id, { digest: plan.digest, anchors: {} }),
      /重新/,
    );
    const fresh = await share.exportPlan('w', v.id);
    assert.notEqual(fresh.digest, plan.digest);
    assert.equal(fresh.anchors[0].label, '邮箱');
    const ok = await share.exportPackage('w', v.id, {
      digest: fresh.digest,
      anchors: { 0: { action: 'replace', text: 'x@example.com' } },
    });
    assert.ok(ok.path);
    const p = exportPlan({ root: dir, manifest: read(dir) });
    writeFileSync(join(dir, 'prompts', 'run.md'), 'changed {{materials}}');
    await assert.rejects(
      async () =>
        buildExport({
          root: dir,
          manifest: read(dir),
          plan: p,
          decisions: {
            digest: p.digest,
            anchors: Object.fromEntries(p.anchors.map((a: any) => [a.index, { action: 'keep' }])),
          },
        }),
      /发生了变化/,
    );
  } finally {
    core.close();
  }
});
test('upgrading the same micro app twice registers two separate light apps', async () => {
  const { core, v } = await setup();
  const share = createMicroShare({
    send: (w: string, op: string, p: any = {}) => core.command(w, op, p),
    readObject: async () => null,
    directory: mkdtempSync(join(tmpdir(), 'micro-share-')),
    register: async (w: string, path: string) => {
      const app = await core.command(w, 'register', { path });
      return core.command(w, 'instance_create', { appId: app.id });
    },
  });
  try {
    const first = await share.upgrade('w', v.id),
      second = await share.upgrade('w', v.id);
    const ids = (await core.command('w', 'list', {})).apps.map((a: any) => a.manifest.id);
    assert.ok(ids.includes('user.weekly.light') && ids.includes('user.weekly.light-2'), ids.join());
    assert.notEqual(first.path, second.path);
  } finally {
    core.close();
  }
});
test('upgrade creates a light-app draft that keeps host AI capabilities; the micro app stays (A22)', async () => {
  const { core, v, dir } = await setup();
  try {
    const d = await core.command('w', 'describe', { instanceId: v.id });
    const root = writeFiles(
      join(mkdtempSync(join(tmpdir(), 'upgrade-')), 'app'),
      upgradeFiles({ root: d.root, manifest: d.manifest, capabilities: d.micro.capabilities }),
    );
    assert.ok(existsSync(join(root, 'backend', 'main.mjs')));
    assert.ok(existsSync(join(root, 'ui', 'index.html')));
    const app = await core.command('w', 'register', { path: root });
    assert.equal(app.manifest.runtime.kind, 'node');
    const light = await core.command('w', 'instance_create', { appId: app.id });
    const info = await core.command('w', 'micro_info', { instanceId: light.id });
    assert.equal(info.micro, false);
    assert.equal(info.capabilities[0].name, 'run');
    await assert.rejects(
      core.command('w', 'open', { instanceId: light.id }),
      /重新授权/,
      'light app needs code authorization',
    );
    assert.equal(
      (await core.command('w', 'describe', { instanceId: v.id })).manifest.runtime.kind,
      'micro',
    );
    assert.ok(existsSync(join(dir, 'yirang.app.json')));
  } finally {
    core.close();
  }
});
