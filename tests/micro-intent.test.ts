import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchMicroApp,
  microRunTarget,
  prepareMicroRun,
  // @ts-ignore -- JavaScript module has no declaration file.
} from '../apps/electron/micro/micro-intent.mjs';

const app = (instanceId: string, name: string, aliases: string[] = []) => ({
  instanceId,
  name,
  aliases,
  capabilities: [{ name: 'summarize', title: '生成周报' }],
});
const weekly = app('w1', '周报汇总（零代码示例）', ['周报', '周报工具']);

test('explicit run verb with an exact name/alias hit invokes directly (A14)', () => {
  for (const text of [
    '跑一下周报',
    '运行周报工具',
    '请帮我执行周报汇总',
    '运行「周报」',
    '跑一下周报吧。',
  ])
    assert.deepEqual(
      matchMicroApp(text, [weekly, app('x', '发票整理')]),
      {
        hit: 'run',
        target: {
          instanceId: 'w1',
          name: weekly.name,
          capability: 'summarize',
          title: weekly.name,
        },
      },
      text,
    );
});
test('two apps answering to the same name ask instead of guessing (A15)', () => {
  const r = matchMicroApp('跑一下周报', [
    app('a', '周报汇总', ['周报']),
    app('b', '周报生成', ['周报']),
  ]);
  assert.equal(r.hit, 'ambiguous');
  assert.deepEqual(
    r.candidates.map((c: any) => c.instanceId),
    ['a', 'b'],
  );
  assert.equal(
    matchMicroApp('运行周报汇总', [app('a', '周报汇总', ['周报']), app('b', '周报生成', ['周报'])])
      .target.instanceId,
    'a',
  );
  assert.deepEqual(
    matchMicroApp('跑一下周报', [app('a', '周报汇总'), app('b', '周报生成')]),
    { hit: 'none' },
    'prefix is not a hit',
  );
});
test('extra requirements or multiple intents never hit', () => {
  for (const text of [
    '运行周报但不要生成文件',
    '运行周报，然后整理发票',
    '运行周报然后整理发票',
    '运行周报（只要摘要）',
    '用周报生成上周的报告',
    '用周报工具生成本周周报',
    '跑一下周报和发票',
    '运行周报 再发给我',
  ])
    assert.deepEqual(matchMicroApp(text, [weekly, app('i', '发票')]), { hit: 'none' }, text);
});
test('all apps are searched; candidates capped at 12 and never unique when truncated', () => {
  const many = Array.from({ length: 60 }, (_, i) => app('a' + i, '其他' + i));
  assert.equal(matchMicroApp('跑一下周报', [...many, weekly]).hit, 'run');
  const r = matchMicroApp(
    '跑一下周报',
    Array.from({ length: 20 }, (_, i) => app('a' + i, '周报' + i, ['周报'])),
  );
  assert.equal(r.hit, 'ambiguous');
  assert.equal(r.candidates.length, 12);
  assert.equal(r.truncated, true);
});
test('no run verb or no name hit keeps existing Bot routing', () => {
  for (const text of ['周报', '帮我写一下本周周报', '周报里第二段改短一点', '把周报发给我'])
    assert.deepEqual(matchMicroApp(text, [weekly]), { hit: 'none' }, text);
  assert.deepEqual(matchMicroApp('跑一下发票整理', [weekly]), { hit: 'none' });
  assert.equal(microRunTarget('跑一下周报\n然后再写个总结'), null);
});
test('missing required input or materials prevents the run', () => {
  const c = {
    inputSchema: {
      type: 'object',
      properties: {
        week: { type: 'string', title: '周次' },
        tone: { type: 'string', default: '正式' },
      },
      required: ['week', 'tone'],
    },
    materials: { min: 1, max: 10 },
  };
  assert.deepEqual(prepareMicroRun(c, 1), {
    input: { tone: '正式' },
    missing: ['周次'],
    materials: null,
    ready: false,
  });
  const d = {
    ...c,
    inputSchema: {
      ...c.inputSchema,
      properties: { ...c.inputSchema.properties, week: { type: 'string', default: '本周' } },
    },
  };
  assert.equal(prepareMicroRun(d, 0).ready, false);
  assert.match(prepareMicroRun(d, 0).materials, /至少 1 份/);
  assert.deepEqual(prepareMicroRun(d, 2), {
    input: { tone: '正式', week: '本周' },
    missing: [],
    materials: null,
    ready: true,
  });
});
