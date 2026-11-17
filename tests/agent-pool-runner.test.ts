import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentPoolRunner,
  isolatedConfig,
  resultSchema,
  unknownReason,
} from '../apps/electron/orchestration/agent-pool-runner.mjs';

function harness(claims: any[]) {
  const calls: any[] = [],
    requests: any[] = [];
  const call = async (_w: string, p: any) => {
    calls.push(p);
    if (p.operation === 'pool_claim') return claims.shift() || null;
    if (
      p.operation === 'pool_list' ||
      p.operation === 'pool_interrupts' ||
      p.operation === 'pool_leases'
    )
      return [];
    return {};
  };
  const request = async (method: string, params: any) => {
    requests.push({ method, params });
    if (method === 'config/read')
      return { config: { mcp_servers: { ai_desktop: {}, browser: {} } } };
    if (method === 'thread/start') return { thread: { id: 't1' } };
    if (method === 'turn/start') return { turn: { id: 'u1' } };
    return {};
  };
  const runner = createAgentPoolRunner({
    call,
    request,
    cwd: 'C:/w',
    workspaces: async () => ['w1'],
    readTurn: async () => null,
  });
  return { runner, calls, requests };
}
const claim = {
  lease: { dispatchKey: 'd1' },
  context: { node: { id: 'n1', type: 'write', modelProfile: { model: 'm', effort: 'low' } } },
};

test('every node, including write nodes, runs read-only with tools, MCP and network disabled', async () => {
  const { runner, requests, calls } = harness([claim]);
  await runner.step();
  const start = requests.find((r) => r.method === 'thread/start').params,
    turn = requests.find((r) => r.method === 'turn/start').params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.config['web_search'], 'disabled');
  assert.equal(start.config['mcp_servers.ai_desktop.enabled'], false);
  assert.equal(start.config['mcp_servers.browser.enabled'], false);
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.outputSchema, resultSchema);
  assert.deepEqual(
    calls.filter((c) => ['pool_sending', 'pool_ack'].includes(c.operation)).map((c) => c.operation),
    ['pool_sending', 'pool_ack'],
  );
  assert.equal(runner.owns('t1'), true);
});
test('structured output is committed; invalid output fails instead of being trusted', async () => {
  for (const [text, status] of [
    [
      JSON.stringify({
        summary: 's',
        evidence: [],
        warnings: [],
        conflicts: [],
        next: [],
        question: null,
        handled: [],
      }),
      'completed',
    ],
    ['写入了 C:/x.txt', 'failed'],
  ] as const) {
    const { runner, calls } = harness([claim]);
    await runner.step();
    runner.notification('turn/completed', {
      threadId: 't1',
      turn: { id: 'u1', status: 'completed', items: [{ type: 'agentMessage', text }] },
    });
    await new Promise((r) => setTimeout(r, 10));
    const fin = calls.find((c) => c.operation === 'pool_finish');
    assert.equal(fin.status, status);
    assert.equal(runner.owns('t1'), false);
  }
});
test('isolated config disables every configured MCP server', () => {
  const c = isolatedConfig(['a', 'b']);
  assert.equal(c['mcp_servers.a.enabled'], false);
  assert.equal(c['features.multi_agent'], false);
});

test('unknown sent leases are read back by turn id and committed, never re-sent', async () => {
  const calls: any[] = [],
    requests: any[] = [];
  const call = async (_w: string, p: any) => {
    calls.push(p);
    if (p.operation === 'pool_list') return [{ spec: { id: 'p1' }, nodes: [] }];
    if (p.operation === 'pool_leases')
      return [{ state: 'unknown', dispatchKey: 'd9', threadId: 't9', turnId: 'u9' }];
    if (p.operation === 'pool_claim' || p.operation === 'pool_interrupts')
      return p.operation === 'pool_claim' ? null : [];
    return {};
  };
  const text = JSON.stringify({
    summary: 's',
    evidence: [],
    warnings: [],
    conflicts: [],
    next: [],
    question: null,
    handled: [],
  });
  const runner = createAgentPoolRunner({
    call,
    request: async (m: string, p: any) => {
      requests.push(m);
      return {};
    },
    cwd: 'C:/w',
    workspaces: async () => ['w1'],
    readTurn: async (threadId: string, turnId: string) => ({
      id: turnId,
      status: 'completed',
      items: [{ type: 'agentMessage', text }],
    }),
  });
  await runner.step();
  const fin = calls.find((c) => c.operation === 'pool_finish');
  assert.equal(fin.dispatchKey, 'd9');
  assert.equal(fin.status, 'completed');
  assert.equal(requests.includes('turn/start'), false);
});

test('a failed sending registration goes to unknown and no turn is started', async () => {
  const calls: any[] = [],
    requests: string[] = [];
  let claimed = false;
  const call = async (_w: string, p: any) => {
    calls.push(p);
    if (p.operation === 'pool_claim') {
      if (claimed) return null;
      claimed = true;
      return claim;
    }
    if (p.operation === 'pool_sending') throw Error('STALE_DISPATCH');
    if (['pool_list', 'pool_interrupts', 'pool_leases'].includes(p.operation)) return [];
    return {};
  };
  const request = async (m: string) => {
    requests.push(m);
    if (m === 'config/read') return { config: {} };
    if (m === 'thread/start') return { thread: { id: 't1' } };
    return { turn: { id: 'u1' } };
  };
  const runner = createAgentPoolRunner({
    call,
    request,
    cwd: 'C:/w',
    workspaces: async () => ['w1'],
    readTurn: async () => null,
  });
  await runner.step();
  const u = calls.find((c) => c.operation === 'pool_unknown');
  assert.equal(u.dispatchKey, 'd1');
  assert.match(u.reason, /STALE_DISPATCH/);
  assert.equal(requests.includes('turn/start'), false);
  assert.equal(runner.owns('t1'), false);
});

for (const [label, error, expected] of [
  ['timeout', Error('RPC timeout: thread/start'), 'pool_unknown'],
  ['disconnect', Object.assign(Error('connection closed'), { code: 'EPIPE' }), 'pool_unknown'],
  [
    'explicit rejection',
    Object.assign(Error('bad request'), { rpcRejected: true, code: 'invalid' }),
    'pool_rejected',
  ],
] as const)
  test(
    'thread/start ' + label + ' -> ' + expected + ' and never replayed in the same step',
    async () => {
      const calls: any[] = [],
        requests: string[] = [];
      let claims = 0;
      const call = async (_w: string, p: any) => {
        calls.push(p);
        if (p.operation === 'pool_claim') return claims++ ? null : claim;
        if (['pool_list', 'pool_interrupts', 'pool_leases'].includes(p.operation)) return [];
        return {};
      };
      const request = async (m: string) => {
        requests.push(m);
        if (m === 'config/read') return { config: {} };
        if (m === 'thread/start') throw error;
        return { turn: { id: 'u1' } };
      };
      const runner = createAgentPoolRunner({
        call,
        request,
        cwd: 'C:/w',
        workspaces: async () => ['w1'],
        readTurn: async () => null,
      });
      await runner.step();
      const outcome = calls.filter((c) => ['pool_unknown', 'pool_rejected'].includes(c.operation));
      assert.deepEqual(
        outcome.map((c) => c.operation),
        [expected],
      );
      assert.equal(outcome[0].dispatchKey, 'd1');
      assert.equal(requests.filter((m) => m === 'thread/start').length, 1);
      assert.equal(requests.includes('turn/start'), false);
    },
  );

test('after restart, conversation capacity does not adopt or release Agent Pool slots', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { AgentPoolStore } = await import('../packages/local-runtime/agents/agent-pool.js');
  const { BotCapacityStore } = await import('../packages/local-runtime/bot/bot-capacity.js');
  const capacityPath = '../apps/electron/work/execution-capacity.mjs';
  const { createExecutionCapacity } = await import(capacityPath);
  const db = new DatabaseSync(':memory:');
  let now = 1_000_000;
  const pool = new AgentPoolStore(db, {
    now: () => now,
    object: () => {
      throw Error('NOT_FOUND');
    },
  });
  const model = { provider: 'codex', account: 'default', model: 'm', effort: null };
  pool.create(
    'w',
    {
      id: 'p',
      workId: 'work',
      goal: 'g',
      nodes: [
        {
          id: 'a',
          type: 'research',
          title: 'a',
          instructions: 'x',
          acceptance: 'y',
          modelProfile: model,
        },
      ],
      edges: [],
    } as any,
    'req',
  );
  now += 2001;
  const c = pool.claim('w')!;
  pool.sending(c.lease.dispatchKey, 'pool-thread');
  pool.ack(c.lease.dispatchKey, 'pool-turn');
  pool.recover();
  const capacity = new BotCapacityStore(db),
    reads: string[] = [];
  const exec = createExecutionCapacity({
    call: async (w: string, p: any) => capacity.command(w, p),
    workspace: async () => 'w',
    managed: () => false,
  });
  await exec.reconcile(async (entry: any) => {
    reads.push(entry.threadId);
    return { id: entry.turnId, status: 'completed' };
  });
  assert.deepEqual(reads, []);
  assert.deepEqual(exec.unknown(), []);
  assert.ok(
    db.prepare('SELECT 1 FROM bot_slots WHERE id=?').get(c.lease.dispatchKey),
    'pool slot survives conversation reconcile',
  );
  assert.equal(pool.leases().find((l) => l.dispatchKey === c.lease.dispatchKey)?.state, 'unknown');
});

test('oversized CLI errors are truncated so the unknown transition is accepted by the host limit', async () => {
  const huge = Error('stack '.repeat(5000)),
    calls: any[] = [];
  let claims = 0;
  const call = async (_w: string, p: any) => {
    calls.push(p);
    if (p.operation === 'pool_claim') return claims++ ? null : claim;
    if (p.operation === 'pool_unknown' && p.reason.length > 2000) throw Error('too long');
    if (['pool_list', 'pool_interrupts', 'pool_leases'].includes(p.operation)) return [];
    return {};
  };
  const request = async (m: string) => {
    if (m === 'config/read') return { config: {} };
    throw huge;
  };
  await createAgentPoolRunner({
    call,
    request,
    cwd: 'C:/w',
    workspaces: async () => ['w1'],
    readTurn: async () => null,
  }).step();
  const u = calls.find((c) => c.operation === 'pool_unknown');
  assert.ok(u.reason.length <= 1900);
  assert.match(u.reason, /\[truncated\]$/);
  assert.equal(unknownReason('前缀：', Error('短')), '前缀：短');
});

test('a failed ack registration keeps the turn id so the result can still be read back', async () => {
  const calls: any[] = [];
  let claimed = false;
  const call = async (_w: string, p: any) => {
    calls.push(p);
    if (p.operation === 'pool_claim') {
      if (claimed) return null;
      claimed = true;
      return claim;
    }
    if (p.operation === 'pool_ack' && calls.filter((c) => c.operation === 'pool_ack').length === 1)
      throw Error('database busy');
    if (['pool_list', 'pool_interrupts', 'pool_leases'].includes(p.operation)) return [];
    return {};
  };
  const request = async (m: string) => {
    if (m === 'config/read') return { config: {} };
    if (m === 'thread/start') return { thread: { id: 't1' } };
    return { turn: { id: 'u1' } };
  };
  const runner = createAgentPoolRunner({
    call,
    request,
    cwd: 'C:/w',
    workspaces: async () => ['w1'],
    readTurn: async () => null,
  });
  await runner.step();
  const u = calls.find((c) => c.operation === 'pool_unknown');
  assert.equal(u.dispatchKey, 'd1');
  assert.equal(u.turnId, 'u1');
});

test('after an ack failure a lost completion notice is recovered by reading the turn back, and pause interrupts it', async () => {
  const calls: any[] = [],
    requests: any[] = [];
  let claimed = false,
    reads = 0,
    leaseState = 'running',
    planState = 'running';
  const text = JSON.stringify({
    summary: 's',
    evidence: [],
    warnings: [],
    conflicts: [],
    next: [],
    question: null,
    handled: [],
  });
  const call = async (_w: string, p: any) => {
    calls.push(p);
    if (p.operation === 'pool_claim') {
      if (claimed) return null;
      claimed = true;
      return claim;
    }
    if (p.operation === 'pool_ack' && calls.filter((c) => c.operation === 'pool_ack').length === 1)
      throw Error('database busy');
    if (p.operation === 'pool_unknown') {
      leaseState = 'unknown';
      return {};
    }
    if (p.operation === 'pool_list')
      return [{ spec: { id: 'p1' }, state: planState, nodes: [{ state: 'unknown' }] }];
    if (p.operation === 'pool_leases')
      return [{ state: leaseState, dispatchKey: 'd1', threadId: 't1', turnId: 'u1' }];
    if (p.operation === 'pool_interrupts')
      return planState === 'pausing' ? [{ dispatchKey: 'd1', threadId: 't1', turnId: 'u1' }] : [];
    return {};
  };
  const request = async (m: string, params: any) => {
    requests.push({ m, params });
    if (m === 'config/read') return { config: {} };
    if (m === 'thread/start') return { thread: { id: 't1' } };
    return { turn: { id: 'u1' } };
  };
  let status = 'inProgress';
  const runner = createAgentPoolRunner({
    call,
    request,
    cwd: 'C:/w',
    workspaces: async () => ['w1'],
    readTurn: async (_t: string, id: string) => {
      reads++;
      return { id, status, items: [{ type: 'agentMessage', text }] };
    },
  });
  await runner.step();
  assert.ok(reads >= 1, 'unknown lease with a known turn must be read back');
  assert.equal(
    calls.some((c) => c.operation === 'pool_finish'),
    false,
  );
  planState = 'pausing';
  await runner.step();
  assert.ok(requests.some((r) => r.m === 'turn/interrupt' && r.params.turnId === 'u1'));
});

test('a recovered turn keeps the usage and text the live job already received', async (t) => {
  const calls: any[] = [];
  let claimed = false,
    status = 'inProgress';
  const text = JSON.stringify({
    summary: 's',
    evidence: [],
    warnings: [],
    conflicts: [],
    next: [],
    question: null,
    handled: [],
  });
  const call = async (_w: string, p: any) => {
    calls.push(p);
    if (p.operation === 'pool_claim') {
      if (claimed) return null;
      claimed = true;
      return claim;
    }
    if (p.operation === 'pool_ack' && calls.filter((c) => c.operation === 'pool_ack').length === 1)
      throw Error('database busy');
    if (p.operation === 'pool_list')
      return [{ spec: { id: 'p1' }, state: 'running', nodes: [{ state: 'unknown' }] }];
    if (p.operation === 'pool_leases')
      return calls.some((c) => c.operation === 'pool_unknown')
        ? [{ state: 'unknown', dispatchKey: 'd1', threadId: 't1', turnId: 'u1' }]
        : [];
    return {};
  };
  const request = async (m: string) => {
    if (m === 'config/read') return { config: {} };
    if (m === 'thread/start') return { thread: { id: 't1' } };
    return { turn: { id: 'u1' } };
  };
  const runner = createAgentPoolRunner({
    call,
    request,
    cwd: 'C:/w',
    workspaces: async () => ['w1'],
    readTurn: async () => ({ id: 'u1', status, items: [] }),
  });
  await runner.step();
  runner.notification('item/completed', { threadId: 't1', item: { type: 'agentMessage', text } });
  runner.notification('thread/tokenUsage/updated', {
    threadId: 't1',
    tokenUsage: { last: { inputTokens: 1234, outputTokens: 567, cachedInputTokens: 89 } },
  });
  status = 'completed';
  const real = Date.now(),
    clock = t.mock.method(Date, 'now', () => real + 31000);
  await runner.step();
  clock.mock.restore();
  const fin = calls.find((c) => c.operation === 'pool_finish');
  assert.ok(fin);
  assert.deepEqual(fin.usage, { inputTokens: 1234, outputTokens: 567, cachedInputTokens: 89 });
  assert.equal(fin.result.summary, 's');
});
