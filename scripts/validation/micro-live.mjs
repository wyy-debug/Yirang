// Real Codex calls for micro-app wire schemas. Requires --live (uses account quota).
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { wireSchema } from '../../apps/electron/micro/micro-apps.mjs';
import { createMicroRunner } from '../../apps/electron/micro/micro-runner.mjs';

const args = process.argv.slice(2),
  option = (key, fallback) => {
    const i = args.indexOf('--' + key);
    return i < 0 ? fallback : args[i + 1];
  };
if (!args.includes('--live')) throw Error('Explicit --live is required for real account usage.');
const destination = resolve(option('output', 'test-results/micro-live-' + Date.now()));
await mkdir(join(destination, 'empty'), { recursive: true });
const preferences = await readFile(
  option('preferences', join(process.env.APPDATA, 'ai-desktop/desktop-preferences.json')),
  'utf8',
).then(JSON.parse, () => ({}));
const binary = option('cli', preferences.codexPath),
  cliVersion = execFileSync(binary, ['--version'], { windowsHide: true, encoding: 'utf8' }).trim();
const model = {
  model: option('model', preferences.model) || null,
  effort: option('effort', preferences.effort || 'low'),
};
const row = {
  type: 'object',
  additionalProperties: false,
  required: ['project', 'owner', 'status', 'hours', 'note'],
  properties: {
    project: { type: 'string' },
    owner: { type: 'string' },
    status: { enum: ['done', 'doing', 'blocked'] },
    hours: { type: 'number' },
    note: { type: ['string', 'null'] },
  },
};
const cases = [
  {
    name: 'table-rows',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['rows'],
      properties: { rows: { type: 'array', items: row } },
    },
    prompt:
      '把以下记录整理成表格：A 项目 张三 已完成 3 小时；B 项目 李四 进行中 2.5 小时 备注：等待评审。',
  },
  {
    name: 'nested-object',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['meeting'],
      properties: {
        meeting: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'owner'],
          properties: {
            title: { type: 'string' },
            owner: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'team'],
              properties: { name: { type: 'string' }, team: { type: 'string' } },
            },
          },
        },
      },
    },
    prompt: '会议“季度复盘”，负责人王五，属于财务组。',
  },
  {
    name: 'null-union',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['due', 'note'],
      properties: { due: { type: ['string', 'null'] }, note: { type: ['string', 'null'] } },
    },
    prompt: '任务：整理发票。原文没有截止日期，也没有备注。',
  },
  {
    name: 'enum',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['priority', 'score'],
      properties: {
        priority: { enum: ['high', 'medium', 'low'] },
        score: { type: 'integer', minimum: 0, maximum: 10 },
      },
    },
    prompt: '这件事非常紧急，重要程度 9 分。',
  },
];
const report = {
  purpose: 'micro-app-wire-live',
  startedAt: new Date().toISOString(),
  cliVersion,
  model,
  binarySha256: createHash('sha256')
    .update(await readFile(binary))
    .digest('hex'),
  cases: [],
  serverRequests: [],
  threadStartConfig: null,
};
const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stderr.resume();
const pending = new Map();
let sequence = 0,
  runner;
const rpc = (method, params) =>
  new Promise((ok, no) => {
    const id = ++sequence,
      timer = setTimeout(() => {
        pending.delete(id);
        no(Error('RPC timeout: ' + method));
      }, 60000);
    pending.set(id, { ok, no, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
createInterface({ input: child.stdout }).on('line', (line) => {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e.method && e.id !== undefined) {
    report.serverRequests.push({ method: e.method, threadId: e.params?.threadId });
    child.stdin.write(
      JSON.stringify({
        id: e.id,
        error: { code: -32601, message: 'Micro capabilities do not execute tools' },
      }) + '\n',
    );
    return;
  }
  if (e.id !== undefined) {
    const p = pending.get(e.id);
    if (!p) return;
    pending.delete(e.id);
    clearTimeout(p.timer);
    e.error ? p.no(Object.assign(Error(e.error.message), { rpcRejected: true })) : p.ok(e.result);
    return;
  }
  if (e.method === 'item/started' || e.method === 'item/completed') {
    const t = e.params?.item?.type;
    if (t && !['agentMessage', 'userMessage', 'reasoning'].includes(t))
      report.cases.at(-1)?.items.push(t);
  }
  runner?.notification(e.method, e.params);
});
try {
  await rpc('initialize', {
    clientInfo: { name: 'yirang_micro_live', title: 'Yirang micro live', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const request = (method, p) => {
    if (method === 'thread/start') report.threadStartConfig = p.config;
    return rpc(method, p);
  };
  runner = createMicroRunner({
    workspaces: async () => [],
    send: async () => null,
    request,
    capacity: { role() {} },
    cwd: join(destination, 'empty'),
    readTurn: async () => null,
  });
  for (const c of cases) {
    const wire = wireSchema(c.schema),
      entry = {
        name: c.name,
        wireHash: createHash('sha256').update(JSON.stringify(wire)).digest('hex'),
        items: [],
      };
    report.cases.push(entry);
    try {
      const { text, usage } = await runner.ask({
        w: 'live',
        prompt: c.prompt,
        wire,
        timeoutMs: 180000,
        model,
      });
      entry.raw = text;
      entry.usage = usage;
      const value = JSON.parse(text),
        check = new Ajv({ strict: false }).compile(c.schema);
      entry.valid = check(value);
      entry.errors = check.errors;
      entry.value = value;
    } catch (error) {
      entry.error = error.message;
    }
    console.log(c.name, entry.valid ? 'valid' : 'INVALID', entry.error || '');
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.toolItems = report.cases.flatMap((c) => c.items);
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2));
  child.kill();
}
console.log(
  'report',
  join(destination, 'report.json'),
  'serverRequests',
  report.serverRequests.length,
  'toolItems',
  report.toolItems.length,
);
