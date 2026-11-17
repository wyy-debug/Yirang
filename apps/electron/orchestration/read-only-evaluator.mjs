// Bounded, ephemeral, read-only turns used for independent completion review.
// Jobs run one at a time so the shared capacity ledger holds at most one slot.
export const createReadOnlyEvaluator = ({ call, request, capacity, cwd }) => {
  const queue = [],
    turns = new Map();
  let draining = false;
  const run = async (w, prepared) => {
    const deadline = Date.now() + prepared.timeoutMs;
    const bounded = (promise) => {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('审阅初始化超时')),
            Math.max(1, deadline - Date.now()),
          );
          timer.unref();
        }),
      ]).finally(() => clearTimeout(timer));
    };
    const { config } = await bounded(request('config/read', { includeLayers: false, cwd }));
    const disabled = Object.fromEntries(
      Object.keys(config?.mcp_servers || {}).map((name) => [`mcp_servers.${name}.enabled`, false]),
    );
    const created = await bounded(
      request('thread/start', {
        model: prepared.profile.model,
        cwd,
        ephemeral: true,
        allowProviderModelFallback: false,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        config: {
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
          ...disabled,
        },
        baseInstructions: prepared.instructions,
      }),
    );
    const id = created.thread.id;
    // The persisted capacity role keeps its historical name.
    capacity.role(id, 'router', w);
    let yes, no;
    const promise = new Promise((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    const job = {
      id,
      text: '',
      usage: null,
      resolve: (value) =>
        bounded(Promise.resolve(capacity.settled?.(id))).then(() => yes(value), no),
      reject: no,
      abandoned: false,
      turnId: null,
      streamBytes: 0,
    };
    turns.set(id, job);
    job.timer = setTimeout(
      () => {
        job.abandoned = true;
        job.reject(Error('审阅超时'));
        if (job.turnId)
          void request('turn/interrupt', { threadId: id, turnId: job.turnId }).catch(() => {});
      },
      Math.max(1, deadline - Date.now()),
    );
    job.timer.unref();
    void request('turn/start', {
      threadId: id,
      effort: prepared.profile.effort,
      input: [{ type: 'text', text: JSON.stringify(prepared.input) }],
      outputSchema: prepared.wireSchema,
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'never',
    })
      .then((result) => {
        job.turnId = result.turn.id;
        if (job.abandoned)
          void request('turn/interrupt', { threadId: id, turnId: job.turnId }).catch(() => {});
      })
      .catch((error) => {
        clearTimeout(job.timer);
        job.abandoned = true;
        job.reject(error);
        if (error.rpcRejected || error.beforeSend) turns.delete(id);
      });
    return promise;
  };
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        try {
          const occupied = await call(item.workspaceId, { operation: 'capacity_read' });
          if (occupied.slots.some((s) => s.role === 'router'))
            throw Error('审阅暂不可用，旧回合仍待核实');
          item.resolve(await run(item.workspaceId, item.prepared));
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      draining = false;
    }
  }
  const notification = (method, params) => {
    const job = turns.get(params?.threadId);
    if (!job) return false;
    if (method === 'turn/started') {
      job.turnId = params.turn?.id;
      if (job.abandoned && job.turnId)
        void request('turn/interrupt', { threadId: job.id, turnId: job.turnId }).catch(() => {});
    }
    if (method === 'thread/tokenUsage/updated') job.usage = params.tokenUsage?.last || null;
    if (method === 'item/completed' && params.item?.type === 'agentMessage')
      job.text = params.item.text || '';
    if (
      method === 'item/agentMessage/delta' &&
      (job.streamBytes += Buffer.byteLength(params.delta || '')) > 16384
    ) {
      job.abandoned = true;
      job.reject(Error('审阅输出超过大小限制'));
      if (job.turnId)
        void request('turn/interrupt', { threadId: job.id, turnId: job.turnId }).catch(() => {});
    }
    if (method === 'turn/completed') {
      clearTimeout(job.timer);
      turns.delete(job.id);
      if (params.turn?.status === 'completed' && !job.abandoned) {
        const text =
          (params.turn.items || []).filter((i) => i.type === 'agentMessage').at(-1)?.text ||
          job.text;
        job.resolve({ text, usage: job.usage });
      } else job.reject(Error(params.turn?.error?.message || '审阅未完成'));
    }
    return true;
  };
  const evaluate = (workspaceId, prepared) =>
    new Promise((resolve, reject) => {
      queue.push({ workspaceId, prepared, resolve, reject });
      if (!draining) void drain();
    });
  return { evaluate, notification, owns: (id) => turns.has(id) };
};
