// Bounded, synthetic executor probe. Does not enable the product Agent Pool.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

if (!process.argv.includes('--live'))
  throw Error('Explicit --live requires an approved idle window.');
const startTime = Date.now(),
  root = resolve('test-results/agent-pool-m0-' + startTime);
await mkdir(join(root, 'empty'), { recursive: true });
const preferences = JSON.parse(
  await readFile(join(process.env.APPDATA, 'ai-desktop/desktop-preferences.json'), 'utf8'),
);
const { resolveCodexRuntime } = await import('../../apps/electron/cli/codex-runtime.mjs');
const binary = preferences.codexPath || (await resolveCodexRuntime(preferences)).path,
  model = 'gpt-6-luna',
  effort = 'medium';
const report = {
  startedAt: new Date().toISOString(),
  model,
  effort,
  certified: false,
  scope: 'executor initial measurement; no product scheduler or UI certification',
  limits: {
    wallMs: 900000,
    executionMs: 7200000,
    starts: 300,
    inputTokens: 2000000,
    outputTokens: 50000,
    segmentMs: 90000,
  },
  thresholds: {
    successRate: 0.95,
    degradation: 0.02,
    startupP95Ms: 5000,
    followupP95Ms: 30000,
    memoryRatio: 0.85,
  },
  machine: {
    platform: os.platform(),
    release: os.release(),
    cpus: os.cpus().length,
    memory: os.totalmem(),
  },
  rounds: [],
  rows: [],
  resources: [],
  unknown: [],
  rejectedServerRequests: [],
  uiResponseMeasured: false,
};
const persist = () => writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
report.cliVersion = execFileSync(binary, ['--version'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim();
report.binarySha256 = createHash('sha256')
  .update(await readFile(binary))
  .digest('hex');
await writeFile(
  join(root, 'fixture.json'),
  JSON.stringify({ values: Array.from({ length: 100 }, (_, i) => i + 1), sum: 5050 }),
);
const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map(),
  jobs = new Map();
let id = 0,
  failed,
  cpuHighSince,
  sampling;
const send = (value) => {
  if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n');
};
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const key = ++id,
      timer = setTimeout(() => {
        pending.delete(key);
        reject(Error('RPC timeout: ' + method));
      }, 20000);
    pending.set(key, { resolve, reject, timer });
    send({ id: key, method, params });
  });
const cpuTotals = () =>
  os.cpus().reduce(
    (v, c) => ({
      idle: v.idle + c.times.idle,
      total: v.total + Object.values(c.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
let previousCpu = cpuTotals();
const stop = (reason) => {
  failed ||= reason;
};
const usage = () =>
  report.rows.reduce(
    (v, r) => ({
      input: v.input + (r.usage?.inputTokens || 0),
      output: v.output + (r.usage?.outputTokens || 0),
    }),
    { input: 0, output: 0 },
  );
const sample = () => {
  const now = Date.now(),
    c = cpuTotals(),
    cpu = 1 - (c.idle - previousCpu.idle) / Math.max(1, c.total - previousCpu.total);
  previousCpu = c;
  const memory = 1 - os.freemem() / os.totalmem();
  report.resources.push({ at: now, cpu, memory });
  if (memory > 0.85) stop('Physical memory above 85%');
  if (cpu > 0.9) {
    cpuHighSince ||= now;
    if (now - cpuHighSince >= 30000) stop('CPU above 90% for 30 seconds');
  } else cpuHighSince = undefined;
  const u = usage(),
    execution = report.rows.reduce((s, r) => s + (r.started ? (r.ended || now) - r.started : 0), 0);
  if (
    now - startTime >= report.limits.wallMs ||
    execution >= report.limits.executionMs ||
    u.input >= 2000000 ||
    u.output >= 50000
  )
    stop('Probe budget reached');
  for (const r of jobs.values())
    if (r.sent && !r.ended && now - r.sent >= 90000) stop('Segment deadline reached');
};
const handleTool = async (event) => {
  const r = jobs.get(event.params?.threadId);
  if (
    event.method !== 'item/tool/call' ||
    event.params.tool !== 'read_fixture' ||
    !r ||
    r.kind !== 'tool'
  ) {
    report.rejectedServerRequests.push({ method: event.method });
    send({ id: event.id, error: { code: -32601, message: 'Probe denies this request' } });
    stop('Unexpected server tool or approval');
    return;
  }
  r.toolCalls = (r.toolCalls || 0) + 1;
  if (r.toolCalls !== 1) {
    stop('Repeated fixture tool');
    send({ id: event.id, result: { success: false, contentItems: [] } });
    return;
  }
  // The only allowed tool reads a fixed synthetic fixture; no model-supplied path.
  const content = await readFile(join(root, 'fixture.json'), 'utf8');
  send({
    id: event.id,
    result: { success: true, contentItems: [{ type: 'inputText', text: content }] },
  });
};
createInterface({ input: child.stdout }).on('line', (line) => {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e.id !== undefined && e.method) {
    void handleTool(e).catch((error) => stop(error.message));
    return;
  }
  if (e.id !== undefined) {
    const p = pending.get(e.id);
    if (!p) return;
    pending.delete(e.id);
    clearTimeout(p.timer);
    e.error ? p.reject(Error(JSON.stringify(e.error))) : p.resolve(e.result);
    return;
  }
  const r = jobs.get(e.params?.threadId);
  if (!r) return;
  r.events.push({ method: e.method, at: Date.now() });
  if (e.method === 'turn/started') {
    r.started = Date.now();
    r.turnId = e.params.turn.id;
  }
  if (e.method === 'thread/tokenUsage/updated') r.usage = e.params.tokenUsage?.total;
  if (e.method === 'item/completed' && e.params.item?.type === 'agentMessage')
    r.text = e.params.item.text;
  if (e.method === 'error') {
    r.error = e.params.error;
    stop('Executor error: ' + JSON.stringify(r.error));
  }
  if (e.method === 'turn/completed') {
    r.ended = Date.now();
    r.status = e.params.turn.status;
    r.error = e.params.turn.error || r.error;
  }
});
report.stderrTail = [];
createInterface({ input: child.stderr }).on('line', (line) => {
  report.stderrTail.push(line.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g, '[REDACTED]'));
  if (report.stderrTail.length > 12) report.stderrTail.shift();
});
child.on('error', (error) => {
  stop(error.message);
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
});
child.on('exit', (code) => {
  if (!report.finishedAt) stop('App server exited: ' + code);
});
const quantile = (values) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
const waitTick = () => new Promise((resolve) => setTimeout(resolve, 100));
let lean;
const prepare = async (b, kind, round, index) => {
  if (failed) throw Error(failed);
  const r = { b, kind, round, index, nonce: randomUUID(), events: [] };
  report.rows.push(r);
  const t = await rpc('thread/start', {
    model,
    cwd: join(root, 'empty'),
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: lean,
    baseInstructions:
      'Synthetic benchmark. Follow the user. Never access network, files, shell or other tools except the explicit read_fixture tool. Return only JSON.',
    ...(kind === 'tool'
      ? {
          dynamicTools: [
            {
              type: 'function',
              name: 'read_fixture',
              description: 'Read synthetic numeric fixture',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
        }
      : {}),
  });
  r.threadId = t.thread.id;
  jobs.set(r.threadId, r);
  return r;
};
const launch = async (r) => {
  r.sent = Date.now();
  const prompt =
    r.kind === 'tool'
      ? 'Call read_fixture exactly once, verify the sum of values, and return {"sum":5050,"marker":"original"}.'
      : 'Compute the sum of integers 1 through 100. Return {"sum":5050,"marker":"original"}. Do not call tools.';
  const turn = await rpc('turn/start', {
    threadId: r.threadId,
    model,
    effort,
    input: [{ type: 'text', text: prompt }],
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'never',
  });
  r.turnId = turn.turn.id;
  if (r.ended) {
    r.steerTooLate = true;
    return;
  }
  r.steerSent = Date.now();
  try {
    r.steerResponse = await rpc('turn/steer', {
      threadId: r.threadId,
      expectedTurnId: r.turnId,
      input: [
        {
          type: 'text',
          text: 'Correction: marker must be "' + r.nonce + '". Preserve the sum requirement.',
        },
      ],
    });
    r.steerAckAt = Date.now();
  } catch (error) {
    r.steerError = error.message;
    stop('Steer failed');
  }
};
const evaluate = (rows) => {
  for (const r of rows) {
    try {
      const value = JSON.parse(r.text);
      r.correct = value.sum === 5050 && value.marker === r.nonce;
    } catch {
      r.correct = false;
    }
    r.passed =
      r.status === 'completed' &&
      r.correct &&
      !!r.usage &&
      (r.kind !== 'tool' || r.toolCalls === 1);
  }
  const overlap =
    Math.min(...rows.map((r) => r.ended || 0)) -
    Math.max(...rows.map((r) => r.started || Infinity));
  return {
    successRate: rows.filter((r) => r.passed).length / rows.length,
    startP95Ms: quantile(rows.filter((r) => r.started).map((r) => r.started - r.sent)),
    followupP95Ms: quantile(
      rows.filter((r) => r.correct && r.steerSent).map((r) => r.ended - r.steerSent),
    ),
    overlapMs: overlap,
  };
};
try {
  await rpc('initialize', {
    clientInfo: { name: 'agent_pool_m0', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  send({ method: 'initialized' });
  const { config } = await rpc('config/read', { includeLayers: false });
  lean = {
    ...Object.fromEntries(
      Object.keys(config?.mcp_servers || {}).map((k) => ['mcp_servers.' + k + '.enabled', false]),
    ),
    'features.apps': false,
    'features.multi_agent': false,
    'features.plugins': false,
    'features.shell_tool': false,
    'features.memories': false,
    'features.goals': false,
    'features.hooks': false,
    'features.remote_plugin': false,
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    'skills.bundled.enabled': false,
  };
  sampling = setInterval(sample, 500);
  sample();
  const only = process.argv.find((a) => a.startsWith('--levels='));
  for (const b of only
    ? only
        .slice(9)
        .split(',')
        .map(Number)
        .filter((n) => [5, 10, 15, 20].includes(n))
    : [5, 10, 15, 20]) {
    for (const kind of ['short', 'tool'])
      for (let round = 1; round <= 3; round++) {
        if (failed) break;
        const rows = [];
        for (let i = 0; i < b; i++) rows.push(await prepare(b, kind, round, i));
        const sent = await Promise.allSettled(rows.map(launch));
        for (const s of sent) if (s.status === 'rejected') stop(s.reason.message);
        while (!failed && rows.some((r) => !r.ended)) await waitTick();
        const summary = { b, kind, round, ...evaluate(rows) };
        report.rounds.push(summary);
        console.log(JSON.stringify(summary));
        await persist();
        if (
          summary.successRate < 0.95 ||
          summary.startP95Ms > 5000 ||
          summary.followupP95Ms > 30000 ||
          summary.overlapMs < 1000
        )
          stop('Round gate not met; do not escalate');
      }
    if (failed) break;
  }
} catch (error) {
  stop(error.message);
} finally {
  clearInterval(sampling);
  const active = report.rows.filter((r) => r.sent && !r.ended);
  await Promise.allSettled(
    active
      .filter((r) => r.turnId)
      .map((r) => rpc('turn/interrupt', { threadId: r.threadId, turnId: r.turnId })),
  );
  const until = Date.now() + 10000;
  while (Date.now() < until && active.some((r) => !r.ended)) await waitTick();
  report.unknown = active
    .filter((r) => !r.ended)
    .map((r) => ({ threadId: r.threadId, turnId: r.turnId }));
  report.stopReason =
    failed || 'All executor rounds completed; UI/product certification outstanding';
  report.usage = usage();
  report.finishedAt = new Date().toISOString();
  await persist();
  console.log(
    JSON.stringify({
      report: join(root, 'report.json'),
      stopReason: report.stopReason,
      usage: report.usage,
      unknown: report.unknown,
    }),
  );
  child.kill();
  for (const p of pending.values()) clearTimeout(p.timer);
}
