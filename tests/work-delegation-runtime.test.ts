import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopStore } from '../packages/local-runtime/store.js';

function setup(t: any) {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const advance = () => {
    clock += 5001;
  };
  const directory = mkdtempSync(join(tmpdir(), 'work-delegation-')),
    store = new DesktopStore(directory);
  store.createWorkspace('delegation');
  const w = (store.open('delegation') as any).binding.workspaceId;
  let sequence = 0;
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const cmd = (operation: string, taskId?: string, payload: any = {}, extra: any = {}) =>
    store.workManagement.command(
      w,
      {
        operation,
        taskId,
        ...(taskId
          ? {
              expectedRevision: (
                store.workManagement.command(w, { operation: 'detail', taskId }, true) as any
              ).revision,
            }
          : {}),
        requestId: 'command-' + sequence++,
        payload,
        ...extra,
      },
      true,
    ) as any;
  const root = cmd('intake', undefined, {
    text: '分析销售数据并准备一份报告',
    threadId: 'bot-entry',
  }).task;
  const start = (id: string) =>
    cmd('dispatch', id, {
      threadId: 'thread-' + id,
      provider: 'codex',
      dispatchKey: 'dispatch-' + sequence,
      controlled: true,
    });
  const finish = (id: string, runId: string, text = '已核对原始数据，提供具体分析及来源') =>
    cmd('finish', id, { runId, state: 'succeeded', resultText: text });
  const delegate = (
    jobs: any[] = [
      { title: '分析', instructions: '核对数据', after: [] },
      { title: '起草', instructions: '依据分析起草', after: [0] },
    ],
  ) => {
    const execution = start(root.id);
    const value = cmd('delegate', root.id, { runId: execution.run.id, jobs });
    return { execution, children: value.children };
  };
  return { store, w, cmd, root, start, finish, delegate, advance };
}

test('ordinary delivery completes without invented acceptance and remains revisable', t => {
  const {cmd,root,start,finish,advance}=setup(t);
  const execution=start(root.id);
  const done=finish(root.id,execution.run.id);
  assert.equal(done.management.state,'completed');
  assert.equal(done.management.acceptances.length,0);
  assert.equal(cmd('detail',root.id).management.state,'completed');
  cmd('revise',root.id,{text:'补充最新数据'});
  advance();
  const next=start(root.id);
  assert.notEqual(next.run.id,execution.run.id);
  assert.equal(cmd('list').tasks.filter((item:any)=>item.id===root.id).length,1);
});

test('a successful turn without the requested native files remains incomplete and can continue', t => {
  const {cmd,start,finish,advance}=setup(t);
  const task=cmd('intake',undefined,{text:'生成 SVG 和 PPT'}).task;
  const execution=start(task.id);
  const result=finish(task.id,execution.run.id,'只完成说明，文件未生成');
  assert.equal(result.management.state,'attention');
  assert.match(result.management.reason,/SVG、PPT/);
  assert.equal(result.management.acceptances.length,0);
  cmd('revise',task.id,{text:'继续完成文件'});
  advance();
  assert.notEqual(start(task.id).run.id,execution.run.id);
});

test('explicit review persists across revisions and can be cancelled without changing permission', t => {
  const {cmd,start,finish,advance}=setup(t);
  const task=cmd('intake',undefined,{text:'说明方案，先给我看'}).task;
  finish(task.id,start(task.id).run.id);
  cmd('revise',task.id,{text:'语气简洁一点',goal:'简洁说明方案'});
  advance();
  assert.equal(finish(task.id,start(task.id).run.id).management.state,'review');
  cmd('revise',task.id,{text:'不用再确认，直接完成说明'});
  advance();
  const done=finish(task.id,start(task.id).run.id);
  assert.equal(done.management.state,'completed');
  assert.equal(done.management.requirements.at(-1).confirmation.required,false);
  assert.equal(done.management.acceptances.length,0);
});

test('explicit delivery review is retained and failures never become completion', t => {
  const {cmd,start,finish}=setup(t);
  const task=cmd('intake',undefined,{text:'生成报告，先给我看，确认后再发布'}).task;
  const execution=start(task.id);
  const pending=finish(task.id,execution.run.id);
  assert.equal(pending.management.state,'review');
  assert.equal(pending.management.acceptances.length,0);
  const failed=cmd('intake',undefined,{text:'生成另一份报告'}).task;
  const run=start(failed.id).run;
  const result=cmd('finish',failed.id,{runId:run.id,state:'failed',reason:'文件生成失败'});
  assert.equal(result.management.state,'attention');
});

test('accepted work persists model choices and delegates with the captured child model', (t) => {
  const { cmd, start, finish } = setup(t),
    settings = {
      model: 'main-model',
      effort: 'high',
      childModel: 'worker-model',
      childEffort: 'medium',
    };
  const task = cmd('intake', undefined, { text: '核对并写报告', modelSettings: settings }).task;
  settings.model = 'new-preference';
  const execution = start(task.id);
  assert.equal(execution.run.modelSettings.model, 'main-model');
  const { children } = cmd('delegate', task.id, {
    runId: execution.run.id,
    jobs: [
      { title: '核对', instructions: '核对材料', after: [] },
      { title: '起草', instructions: '起草结果', after: [] },
    ],
  });
  finish(task.id, execution.run.id);
  for (const id of children) {
    const run = start(id);
    assert.equal(run.run.modelSettings.model, 'worker-model');
    assert.equal(run.run.modelSettings.effort, 'medium');
    finish(id, run.run.id);
  }
  const integrated = start(task.id);
  assert.equal(integrated.run.modelSettings.model, 'main-model');
  assert.equal(integrated.run.modelSettings.effort, 'high');
});
test('dependency workers wait, share no write authority, and root integrates current results', (t) => {
  const { store, w, cmd, root, start, finish, delegate } = setup(t),
    { execution, children } = delegate();
  assert.equal(cmd('detail', root.id).management.originThreadId, 'bot-entry');
  assert.equal(start(children[0]).waiting, true);
  finish(root.id, execution.run.id);
  assert.equal(start(children[1]).waiting, true);
  const first = start(children[0]);
  assert.ok(first.run);
  assert.throws(() => store.workManagement.guardWrite(w, 'thread-' + children[0], []), /子任务/);
  assert.throws(
    () => store.workManagement.guardTool('thread-' + children[0], 'desktop_commit_changes', {}),
    /子任务/,
  );
  finish(children[0], first.run.id, '统计结果：12 个项目');
  assert.equal(start(root.id).waiting, true);
  const second = start(children[1]);
  finish(children[1], second.run.id, '依据 12 个项目的报告草稿');
  const integration = start(root.id);
  assert.equal(integration.task.management.delegation.phase, 'integrating');
  const prepared = cmd('prepare', root.id);
  assert.equal(prepared.collaboration.length, 2);
  assert.match(prepared.collaboration[0].text, /12 个项目/);
  const done = finish(root.id, integration.run.id, '最终报告已核对两项分工');
  assert.equal(done.management.state, 'completed');
  assert.equal(done.management.acceptances.length, 0, 'execution completion is not user acceptance');
  assert.equal(done.management.runs.filter((r: any) => r.resultHash).length, 1);
});

test('trusted batch bookkeeping does not grant child write access', (t) => {
  const { store, w, root, start } = setup(t);
  start(root.id);
  const previous = process.env.AI_DESKTOP_WORK_HOST;
  try {
    delete process.env.AI_DESKTOP_WORK_HOST;
    assert.throws(
      () =>
        store.workManagement.guardTool('thread-' + root.id, 'desktop_generated_files', {
          operation: 'begin',
        }),
      /尚未接入/,
    );
    process.env.AI_DESKTOP_WORK_HOST = '1';
    assert.doesNotThrow(() =>
      store.workManagement.guardTool('thread-' + root.id, 'desktop_generated_files', {
        operation: 'begin',
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.AI_DESKTOP_WORK_HOST;
    else process.env.AI_DESKTOP_WORK_HOST = previous;
  }
});

test('execution capacity is bounded and uncontrolled writes stay serial', (t) => {
  const { cmd, root, start, finish } = setup(t);
  assert.throws(() => cmd('configure', undefined, { maxConcurrent: 7 }));
  cmd('configure', undefined, { maxConcurrent: 5 });
  const running = [];
  for (let i = 0; i < 5; i++) {
    const task = i ? cmd('intake', undefined, { text: '独立事项 ' + i }).task : root;
    running.push({ task, run: start(task.id).run });
    assert.ok(running.at(-1)!.run);
  }
  const extra = cmd('intake', undefined, { text: '超过容量的事项' }).task;
  assert.equal(start(extra.id).waiting, true);
  for (const { task, run } of running) finish(task.id, run.id);
  const serial = cmd('dispatch', extra.id, {
    threadId: 'serial-thread',
    provider: 'codex',
    dispatchKey: 'serial',
    controlled: false,
  });
  assert.ok(serial.run);
  const next = cmd('intake', undefined, { text: '等待外部写入结束' }).task;
  assert.equal(start(next.id).waiting, true);
});
test('revision cancels old workers, rejects old delegation, and never reuses stale results', (t) => {
  const { cmd, root, start, finish, delegate } = setup(t),
    { execution, children } = delegate();
  finish(root.id, execution.run.id);
  const child = start(children[0]);
  const detail = cmd('detail', root.id);
  cmd('revise', root.id, { text: '改用本月数据' }, { expectedRevision: detail.revision });
  const revised = cmd('detail', root.id);
  assert.equal(revised.management.delegation, undefined);
  assert.equal(cmd('detail', children[0]).management.state, 'cancelling');
  finish(children[0], child.run.id, '旧数据结论');
  assert.equal(cmd('detail', children[0]).management.state, 'cancelled');
  assert.throws(() => cmd('delegate', root.id, { runId: execution.run.id, jobs: [] }), /执行/);
  assert.equal(cmd('prepare', root.id).collaboration.length, 0);
});
test('clarification, cycle rejection, pause and resume keep execution bounded', (t) => {
  const { cmd, root, start, finish, delegate, advance } = setup(t),
    first = start(root.id);
  assert.throws(
    () =>
      cmd('delegate', root.id, {
        runId: first.run.id,
        jobs: [
          { title: 'A', instructions: 'A', after: [1] },
          { title: 'B', instructions: 'B', after: [] },
        ],
      }),
    /依赖/,
  );
  cmd('delegate', root.id, {
    runId: first.run.id,
    operation: 'clarify',
    question: '需要哪一个月份的数据？',
  });
  finish(root.id, first.run.id, '等待月份');
  assert.equal(cmd('detail', root.id).management.state, 'attention');
  cmd('revise', root.id, { text: '使用十月份数据' });
  advance();
  const { execution, children } = delegate();
  finish(root.id, execution.run.id);
  const child = start(children[0]);
  cmd('control', root.id, { action: 'pause' });
  assert.equal(cmd('detail', children[0]).management.state, 'pausing');
  cmd('finish', children[0], { runId: child.run.id, state: 'interrupted' });
  cmd('control', root.id, { action: 'resume' });
  assert.equal(cmd('detail', children[0]).management.state, 'queued');
});
test('a family cannot occupy all slots and host delegation needs no stale UI revision', (t) => {
  const { store, w, cmd, root, start, finish } = setup(t),
    execution = start(root.id);
  const delegated = store.workManagement.command(
    w,
    {
      operation: 'delegate',
      taskId: root.id,
      requestId: 'host-delegate',
      payload: {
        runId: execution.run.id,
        jobs: [0, 1, 2, 3].map((i) => ({
          title: '分工' + i,
          instructions: '独立分析' + i,
          after: [],
        })),
      },
    },
    true,
  ) as any;
  assert.throws(() => store.workManagement.guardWrite(w, 'thread-' + root.id, []), /让出/);
  finish(root.id, execution.run.id);
  for (const child of delegated.children.slice(0, 3)) assert.ok(start(child).run);
  assert.equal(start(delegated.children[3]).waiting, true);
  const other = cmd('intake', undefined, { text: '准备独立邮件' }).task;
  assert.ok(start(other.id).run);
  assert.throws(
    () =>
      store.workManagement.command(
        w,
        { operation: 'delegate', taskId: other.id, requestId: 'not-host', payload: {} },
        false,
      ),
    /可信宿主/,
  );
});

test('answering before the question turn ends preserves the answer and prevents a repeat', (t) => {
  const { cmd, root, start, finish, advance } = setup(t),
    first = start(root.id);
  cmd('delegate', root.id, {
    runId: first.run.id,
    operation: 'clarify',
    question: '对方的名字是什么？',
  });
  cmd('revise', root.id, { text: '小林' });
  cmd('finish', root.id, { runId: first.run.id, state: 'interrupted' });
  advance();
  const next = start(root.id),
    response = cmd('delegate', root.id, {
      runId: next.run.id,
      operation: 'clarify',
      question: '对方的名字是什么?',
    });
  assert.equal(response.state, 'answered');
  assert.equal(response.answer, '小林');
  assert.equal(cmd('detail', root.id).management.question, undefined);
  const acknowledgement = cmd('delegate', root.id, {
    runId: next.run.id,
    operation: 'clarify',
    question: '名字已收到：小林。我会直接写一句生日祝福。',
  });
  assert.equal(acknowledgement.state, 'continue');
  assert.equal(cmd('detail', root.id).management.question, undefined);
  const result = finish(root.id, next.run.id, '祝小林生日快乐');
  assert.equal(result.management.state, 'completed');
  assert.ok(result.management.runs.at(-1).resultHash);
});

test('with Agent Pool enabled, delegation runs workers as pool nodes and the root integrates their results', (t) => {
  const previous = process.env.YIRANG_AGENT_POOL;
  process.env.YIRANG_AGENT_POOL = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.YIRANG_AGENT_POOL;
    else process.env.YIRANG_AGENT_POOL = previous;
  });
  const s = setup(t),
    { cmd, root, start, finish, advance } = s;
  markMode(s, 'daily');
  const { execution, children } = s.delegate();
  assert.deepEqual(children, []);
  const planId = cmd('detail', root.id).management.delegation.poolPlanId;
  assert.ok(planId);
  const pool = (payload: any) => cmd('orchestration', undefined, payload);
  finish(root.id, execution.run.id);
  assert.equal(start(root.id).waiting, true);
  const result = (summary: string) => ({
    summary,
    evidence: [],
    warnings: [],
    conflicts: [],
    next: [],
    question: null,
    handled: [],
  });
  for (const summary of ['统计结果：12 个项目', '依据 12 个项目的报告草稿']) {
    let claim = pool({ operation: 'pool_claim' });
    for (let i = 0; !claim && i < 5; i++) {
      advance();
      pool({ operation: 'pool_tick' });
      claim = pool({ operation: 'pool_claim' });
    }
    assert.ok(
      claim,
      'worker should be claimable ' +
        JSON.stringify(
          pool({ operation: 'pool_detail', planId }).nodes.map((n: any) => [n.state, n.reason]),
        ),
    );
    const key = claim.lease.dispatchKey;
    pool({ operation: 'pool_sending', dispatchKey: key, threadId: 'pool-thread-' + key });
    pool({ operation: 'pool_ack', dispatchKey: key, turnId: 'turn-' + key });
    pool({
      operation: 'pool_finish',
      dispatchKey: key,
      turnId: 'turn-' + key,
      status: 'completed',
      result: result(summary),
      usage: null,
    });
  }
  const integration = start(root.id);
  assert.equal(integration.task.management.delegation.phase, 'integrating');
  const prepared = cmd('prepare', root.id);
  assert.equal(prepared.collaboration.length, 2);
  assert.match(prepared.collaboration.map((c: any) => c.text).join('\n'), /12 个项目的报告草稿/);
});

test('panel pool commands are limited to user actions', (t) => {
  const { store, w } = setup(t);
  assert.deepEqual(
    store.workManagement.command(w, {
      operation: 'pool',
      requestId: 'pool-list',
      payload: { operation: 'pool_list' },
    }),
    [],
  );
  assert.throws(
    () =>
      store.workManagement.command(w, {
        operation: 'pool',
        requestId: 'pool-claim',
        payload: { operation: 'pool_claim' },
      }),
    /可信宿主/,
  );
  assert.throws(
    () =>
      store.workManagement.command(w, {
        operation: 'orchestration',
        requestId: 'pool-orch',
        payload: { operation: 'pool_list' },
      }),
    /可信宿主/,
  );
});

function markMode({ store, w, root }: any, mode: string) {
  const db = (store.workManagement as any).db,
    ids = (store.workManagement.command(w, { operation: 'detail', taskId: root.id }, true) as any)
      .management.requestIds;
  assert.ok(ids.length);
  ids.forEach((requestId: string, i: number) => {
    const existing = db
        .prepare('SELECT idempotency_key FROM work_requests WHERE workspace=? AND id=?')
        .get(w, requestId),
      key = existing?.idempotency_key || 'effect-' + i;
    if (!existing)
      db.prepare('INSERT INTO work_requests VALUES(?,?,?,?)').run(w, requestId, key, '{}');
    db.prepare('INSERT INTO bot_requests VALUES(?,?,?,?)').run(
      w,
      'req-' + i,
      1000 + i,
      JSON.stringify({ id: 'req-' + i, text: 'x', mode }),
    );
    db.prepare('INSERT INTO bot_effects VALUES(?,?,?,?)').run(w, key, 'req-' + i, '{}');
  });
}
test('professional-mode work keeps the original Codex delegation even with Agent Pool enabled', (t) => {
  const previous = process.env.YIRANG_AGENT_POOL;
  process.env.YIRANG_AGENT_POOL = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.YIRANG_AGENT_POOL;
    else process.env.YIRANG_AGENT_POOL = previous;
  });
  const s = setup(t);
  markMode(s, 'professional');
  const { children } = s.delegate();
  assert.equal(children.length, 2);
  assert.equal(s.cmd('detail', s.root.id).management.delegation.poolPlanId, undefined);
});
test('work without a recorded mode keeps the original Codex delegation', (t) => {
  const previous = process.env.YIRANG_AGENT_POOL;
  process.env.YIRANG_AGENT_POOL = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.YIRANG_AGENT_POOL;
    else process.env.YIRANG_AGENT_POOL = previous;
  });
  const { children } = setup(t).delegate();
  assert.equal(children.length, 2);
});

test('pool workers inherit readable sources, constraints and the current requirement version', (t) => {
  const previous = process.env.YIRANG_AGENT_POOL;
  process.env.YIRANG_AGENT_POOL = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.YIRANG_AGENT_POOL;
    else process.env.YIRANG_AGENT_POOL = previous;
  });
  const s = setup(t),
    api = (s.store.workManagement as any).api,
    original = api.object.bind(api);
  const fake: any = {
    'mat-a': {
      id: 'mat-a',
      kind: 'text',
      title: '销售表',
      revision: 3,
      content: { blocks: [{ text: '数据' }] },
    },
    'mat-private': {
      id: 'mat-private',
      kind: 'text',
      title: '私密',
      revision: 1,
      policy: { private: true },
      content: {},
    },
  };
  api.object = (w: string, id: string) => fake[id] || original(w, id);
  markMode(s, 'daily');
  const execution = s.start(s.root.id);
  assert.ok(execution.run);
  const wm = s.store.workManagement as any;
  const task = wm.task(s.w, s.root.id);
  task.goal = '按材料写分析';
  task.management.requirements.at(-1).goal = '按材料写分析';
  task.management.requirements.at(-1).acceptanceCriteria = '列出来源';
  task.sources = [
    { objectId: 'mat-a', title: '销售表', kind: 'text', revision: 3 },
    { objectId: 'mat-private', title: '私密', kind: 'text', revision: 1 },
  ];
  task.constraints = '只用表内数据';
  wm.save(s.w, task, 'test_sources');
  s.cmd('delegate', task.id, {
    runId: execution.run.id,
    jobs: [
      { title: '分析', instructions: '分析材料', after: [] },
      { title: '起草', instructions: '起草', after: [0] },
    ],
  });
  const planId = s.cmd('detail', task.id).management.delegation.poolPlanId,
    plan = (s.store.workManagement as any).pool.detail(s.w, planId);
  for (const n of plan.spec.nodes)
    assert.deepEqual(n.inputRefs, [{ objectId: 'mat-a', revision: 3 }]);
  assert.match(plan.spec.scope, /原始目标：按材料写分析/);
  assert.match(plan.spec.scope, /验收标准：列出来源/);
  assert.match(plan.spec.scope, /约束：只用表内数据/);
  assert.match(plan.spec.scope, /要求版本：v1/);
});

test('native file materials reach pool workers as extracted text of the current revision', async (t) => {
  const previous = process.env.YIRANG_AGENT_POOL;
  process.env.YIRANG_AGENT_POOL = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.YIRANG_AGENT_POOL;
    else process.env.YIRANG_AGENT_POOL = previous;
  });
  const s = setup(t),
    b = (s.store.open('delegation') as any).binding;
  const file = s.store.importAttachment(b.workspaceId, b.credential, 'delegation', {
    requestId: 'md',
    fileName: '笔记.md',
    data: Buffer.from('# 标题\n本季度销售额 120 万').toString('base64'),
    bounds: { x: 0, y: 0, width: 300, height: 200 },
  }) as any;
  assert.equal(file.kind, 'file');
  const pool = (s.store.workManagement as any).pool,
    store = s.store as any;
  pool.create(
    s.w,
    {
      id: 'nf',
      workId: 'w',
      goal: 'g',
      nodes: [
        {
          id: 'a',
          type: 'research',
          title: 'a',
          instructions: '读材料',
          acceptance: '有来源',
          modelProfile: { provider: 'codex', account: 'default', model: 'm', effort: null },
          inputRefs: [{ objectId: file.id, revision: file.revision }],
        },
      ],
      edges: [],
    },
    'r',
  );
  assert.equal(pool.claim(s.w), null);
  assert.deepEqual(pool.pendingMaterials(s.w), [{ objectId: file.id, revision: file.revision }]);
  assert.equal(pool.detail(s.w, 'nf').nodes[0].reason, '正在准备材料正文');
  process.env.AI_DESKTOP_WORK_HOST = '1';
  const session = process.env.AI_DESKTOP_SESSION_REF;
  process.env.AI_DESKTOP_SESSION_REF = 'delegation';
  try {
    await s.store.workHost('delegation', s.w, {
      operation: 'orchestration',
      payload: { operation: 'pool_prepare' },
    });
  } finally {
    delete process.env.AI_DESKTOP_WORK_HOST;
    if (session === undefined) delete process.env.AI_DESKTOP_SESSION_REF;
    else process.env.AI_DESKTOP_SESSION_REF = session;
  }
  s.advance();
  const claim = pool.claim(s.w);
  assert.ok(claim);
  assert.match(claim.context.inputs[0].text, /本季度销售额 120 万/);
  assert.doesNotMatch(JSON.stringify(claim.context.inputs), /assetHash/);
});
test('a running agent reports one status line that never bumps revision and ends with its run', (t) => {
  const { store, w, cmd, root, start, finish } = setup(t),
    execution = start(root.id),
    before = cmd('detail', root.id).revision;
  cmd('progress', root.id, { runId: execution.run.id, text: '正在核对原始数据', step: 1, total: 3 });
  const detail = cmd('detail', root.id);
  assert.equal(detail.revision, before, 'a status line is not a state change');
  assert.equal(detail.management.progress.text, '正在核对原始数据');
  assert.equal(detail.management.progress.total, 3);
  const listed = cmd('list', undefined, { compact: true }).tasks.find((x: any) => x.id === root.id);
  assert.equal(listed.management.progress.step, 1);
  assert.throws(
    () =>
      store.workManagement.command(
        w,
        { operation: 'progress', taskId: root.id, payload: { runId: execution.run.id, text: 'x' } },
        false,
      ),
    /宿主/,
  );
  assert.throws(() => cmd('progress', root.id, { runId: execution.run.id, text: '' }));
  finish(root.id, execution.run.id);
  assert.equal(cmd('detail', root.id).management.progress, undefined, 'finished runs say nothing');
  assert.throws(
    () => cmd('progress', root.id, { runId: execution.run.id, text: '还在做' }),
    /已结束/,
  );
});
