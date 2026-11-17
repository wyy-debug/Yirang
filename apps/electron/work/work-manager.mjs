import { randomUUID } from 'node:crypto';
import { createActivityClock } from './activity-clock.mjs';
import { createFollowupDelivery } from './work-followup.mjs';
import { createWorkRecovery } from './work-recovery.mjs';
import { executionEvidence } from './execution-evidence.mjs';
import { remainingRepairMs } from '../../../packages/components/work-continuation-config.mjs';
import { retryAfterMs, canRetrySubmission } from '../../../packages/components/work-retry.mjs';

// Execution ownership is captured before starting a CLI, never inferred from the visible chat.
export function createWorkManager({
  call,
  emit,
  ready,
  run,
  interrupt,
  readRun,
  recoverRun,
  controlled,
  captureModels,
  providerReady = () => true,
  steer,
  reviewCompletion,
  reattachRun,
}) {
  const recovered = new Set(),
    active = new Map(),
    revisionTimers = new Map();
  let cursor = 0,
    budgeting = false,
    pumping = false,
    exiting = false,
    enabled = process.env.YIRANG_WORK_MANAGEMENT !== '0';
  let finishRun;
  const invoke = async (workspaceId, operation, taskId, payload = {}, expectedRevision) => {
    if (['finish', 'reconcile'].includes(operation) && payload.state === 'succeeded' && reviewCompletion) {
      try {
        const prepared = await call({ workspaceId, command: {
          operation: 'completion_prepare', taskId, payload, requestId: randomUUID(),
        } });
        payload = { ...payload, semanticReview: await reviewCompletion(workspaceId,
          prepared && { ...prepared, executionEvidence: payload.executionEvidence }) };
      } catch (error) {
        // Persist a bounded diagnostic, not user/file content or an optimistic success.
        payload = { ...payload, semanticReviewError: error.rpcRejected ? 'schema_rejected'
          : /timeout|超时/i.test(error.message) ? 'review_timeout' : 'review_unavailable' };
      }
    }
    return call({
      workspaceId,
      command: { operation, taskId, payload, expectedRevision, requestId: randomUUID() },
    });
  };
  const changed = () => emit('work-management-changed', {});
  const flushActivity = async entry => {
    entry.activity ||= createActivityClock();
    entry.segment ||= randomUUID();
    const elapsedMs = entry.activity.sample();
    await invoke(entry.workspaceId, 'execution_activity', entry.taskId,
      { runId: entry.runId, segment: entry.segment, elapsedMs });
    entry.lastActivityFlush = performance.now();
  };
  const reconcileUnknown = createWorkRecovery({ readRun, recoverRun, invoke, changed,
    reserveBudget: async (workspaceId, task, old) => {
      const key = randomUUID();
      const value = await invoke(workspaceId, 'recovery_budget', task.id,
        { action: 'reserve', runId: old.id, key });
      return value ? { ...value, requestKey: key } : null;
    },
    settleBudget: (workspaceId, task, old, budget, elapsedMs) => invoke(workspaceId, 'recovery_budget', task.id,
      { action: 'settle', runId: old.id, key: budget.requestKey, elapsedMs }),
    reattach: reattachRun && (async (workspaceId, task, old) => {
      const restored = await invoke(workspaceId, 'ack', task.id, {
        runId: old.id, threadId: old.threadId, turnId: old.turnId, reconnect: true,
      });
      if (!restored.management.runs.some(r => r.id === old.id && r.state === 'running')) throw Error('recovery_not_active');
      const elapsed = Math.max(0, old.activeMs || 0);
      const remaining = Math.min(restored.budget.maxMinutes * 60000,
        restored.management.continuation?.next === 'repair'
          ? remainingRepairMs(restored.management.continuation) : Infinity) - elapsed;
      const entry = { workspaceId, taskId: task.id, parentTaskId: task.management.parentTaskId,
        runId: old.id, threadId: old.threadId, turnId: old.turnId, deadline: performance.now() + Math.max(0, remaining), requestSent: true,
        waitingSince: old.waitingSince ? performance.now() : null };
      active.set(task.id, entry);
      entry.activity = createActivityClock();
      entry.activity.waiting(!!old.waitingSince);
      try {
        await reattachRun(old);
        // The turn can finish between the first observation and resume. Re-read
        // after subscribing; the same finish latch handles notification races.
        const actual = await readRun(old);
        if (actual && ['completed', 'failed', 'interrupted'].includes(actual.status)) {
          const batch = await recoverRun?.(old, actual);
          await finishRun(old.threadId, actual, batch);
        }
      }
      catch (error) {
        active.delete(task.id);
        await invoke(workspaceId, 'finish', task.id, { runId: old.id, state: 'unknown', reason: '原执行重新连接失败，保留执行身份' });
        throw error;
      }
    }),
  });
  const deliverFollowup = createFollowupDelivery({ invoke, steer, changed,
    reconcileEnded: async old => {
      const entry = active.get(old.taskId);
      if (!entry || entry.runId !== old.id) return false;
      const actual = await readRun(old).catch(() => null);
      if (actual?.id !== old.turnId ||
          !['completed', 'failed', 'interrupted'].includes(actual.status)) return false;
      const batch = await recoverRun?.(old, actual);
      await finishRun(old.threadId, actual, batch);
      return true;
    },
  });
  async function command(args) {
    if (
      args.command.operation === 'intake' &&
      args.command.payload?.intent !== 'consult' &&
      !args.command.payload?.modelSettings &&
      captureModels
    ) {
      const modelSettings = await captureModels(args.command.payload?.provider);
      if (modelSettings)
        args = {
          ...args,
          command: { ...args.command, payload: { ...args.command.payload, modelSettings } },
        };
    }
    if (!enabled && !['list', 'detail', 'review', 'reports'].includes(args.command.operation))
      throw Error('工作调度已停用，历史记录仍可查看');
    if (args.command.operation === 'resolve_unknown') {
      const snapshot = await call({
          workspaceId: args.workspaceId,
          command: { operation: 'list', payload: { compact: true } },
        }),
        task = snapshot.tasks.find((t) => t.id === args.command.taskId);
      if (!task || task.revision !== args.command.expectedRevision)
        throw Error('工作已变化，请刷新');
      const { confirmedStopped, note } = args.command.payload || {};
      if (confirmedStopped !== true || typeof note !== 'string' || !note.trim())
        throw Error('先确认执行器已停止并填写核实依据');
      for (const old of task.management.runs.filter((r) => r.state === 'unknown')) {
        const actual = await readRun(old).catch(() => null);
        if (actual && !['completed', 'failed', 'interrupted'].includes(actual.status))
          throw Error('原执行器仍在运行，请先停止');
        await invoke(snapshot.workspaceId, 'reconcile', task.id, {
          runId: old.id,
          state: 'interrupted',
          reason: '用户确认执行器已停止；未确认成功，不自动重放。核实依据：' + note.slice(0, 5000),
        });
      }
      changed();
      return { receipt: '已保留已有成果并结束未知执行；不会自动重试，请检查后手动继续' };
    }
    if (args.command.operation === 'check_run') {
      const snapshot = await call({
          workspaceId: args.workspaceId,
          command: { operation: 'list', payload: { compact: true } },
        }),
        task = snapshot.tasks.find((t) => t.id === args.command.taskId);
      if (!task) throw Error('工作不存在');
      const pending = task.management.runs.filter((r) => r.state === 'unknown');
      for (const old of pending) {
        const actual = await readRun(old);
        if (!actual || !['completed', 'failed', 'interrupted'].includes(actual.status))
          throw Error('执行器尚未提供明确结束记录，保留写入资格，不会重放任务');
        const batch = await recoverRun?.(old, actual);
        await invoke(snapshot.workspaceId, 'reconcile', task.id, {
          runId: old.id,
          batchId: batch?.id,
          executionEvidence: executionEvidence(actual, old.turnId),
          artifacts: (batch?.files || [])
            .filter((f) => f.objectId && f.revision)
            .map((f) => ({ objectId: f.objectId, revision: f.revision })),
          resultText: (actual.items || [])
            .filter((i) => i.type === 'agentMessage')
            .map((i) => i.text || '')
            .join('\n')
            .slice(0, 100000),
          state: actual.status === 'completed' ? 'succeeded' : actual.status,
          reason: '已按执行器的原回合记录核实；请检查已有成果',
        });
      }
      changed();
      return { receipt: pending.length ? '上次执行已核实，请检查成果后继续' : '没有待核实的执行' };
    }
    const value = await call(args),
      op = args.command.operation,
      sub = args.command.payload?.operation;
    const readOnly =
      ['list', 'detail', 'review', 'reports'].includes(op) ||
      (op === 'orchestration' &&
        [
          'read',
          'transcript',
          'lookup',
          'list',
          'pending',
          'capacity_read',
          'host_workspaces',
          'context_read',
          'context_original',
        ].includes(sub));
    if (op === 'list') value.enabled = enabled;
    else if (!readOnly) changed();
    const effects =
      op === 'orchestration'
        ? sub === 'apply'
          ? [value]
          : sub === 'return_assignment'
            ? value.actions || []
            : []
        : [];
    const commands = effects.length
      ? effects
          .filter((e) => e?.state === 'acknowledged')
          .map((e) => ({ command: e.command, result: e.result }))
      : [{ command: args.command, result: value }];
    for (const { command: c, result } of commands) {
      if (c.operation === 'revise' && c.payload?.continueRun &&
          result?.management?.runs.some(r => r.state === 'running')) {
        await deliverFollowup(args.workspaceId, c.taskId);
        continue;
      }
      if (c.operation === 'control' || c.operation === 'revise') {
        if (['pause', 'cancel'].includes(c.payload?.action) || c.operation === 'revise')
          for (const entry of active.values())
            if (
              (entry.taskId === c.taskId || entry.parentTaskId === c.taskId) &&
              entry.threadId &&
              !entry.interruptRequested
            ) {
              entry.interruptRequested = true;
              try {
                await interrupt(entry.threadId);
              } catch (error) {
                entry.interruptRequested = false;
                emit('notice', '要求已保存，旧执行的停止状态待核实');
              }
            }
      }
      if (c.operation === 'revise') {
        const deadline = result?.management?.revisionWindow?.readyAt;
        if (deadline) {
          clearTimeout(revisionTimers.get(c.taskId));
          const timer = setTimeout(
            () => {
              revisionTimers.delete(c.taskId);
              void pump();
            },
            Math.max(0, deadline - Date.now()) + 1,
          );
          timer.unref();
          revisionTimers.set(c.taskId, timer);
        }
      }
    }
    if (!readOnly && !(op === 'orchestration' && sub === 'consult_result')) void pump();
    return value;
  }
  async function enforceBudgets() {
    if (budgeting) return;
    budgeting = true;
    try {
      for (const entry of [...active.values()]) {
        if (performance.now() - (entry.lastActivityFlush || 0) >= 10000) {
          try { await flushActivity(entry); } catch { /* Next cumulative sample retries. */ }
        }
        if (entry.waitingSince || performance.now() < entry.deadline || entry.budgetStopped) continue;
        try {
          const snapshot = await call({
              workspaceId: entry.workspaceId,
              command: { operation: 'list', payload: { compact: true } },
            }),
            task = snapshot.tasks.find((t) => t.id === entry.taskId);
          if (
            task &&
            !['pausing', 'cancelling', 'paused', 'cancelled'].includes(task.management.state)
          )
            await invoke(
              entry.workspaceId,
              'control',
              entry.taskId,
              { action: 'pause', reason: '执行时间预算已用完' },
              task.revision,
            );
          if (entry.threadId && !entry.interruptRequested) {
            entry.interruptRequested = true;
            try {
              await interrupt(entry.threadId);
            } catch (error) {
              entry.interruptRequested = false;
              throw error;
            }
          }
          entry.budgetStopped = true;
          changed();
        } catch (error) {
          if (Date.now() - (entry.lastBudgetNotice || 0) > 30000) {
            entry.lastBudgetNotice = Date.now();
            emit('notice', '预算停止尚未确认：' + error.message);
          }
        }
      }
    } finally {
      budgeting = false;
    }
  }
  const budgetTimer = setInterval(() => void enforceBudgets(), 1000);
  budgetTimer.unref();
  async function pump() {
    if (pumping || exiting || !enabled) return;
    pumping = true;
    try {
      const { workspaces } = await call({
        command: { operation: 'orchestration', payload: { operation: 'host_workspaces' } },
      });
      const ordered = [...workspaces.slice(cursor), ...workspaces.slice(0, cursor)];
      cursor = workspaces.length ? (cursor + 1) % workspaces.length : 0;
      const snapshots = [];
      for (const { id: w } of ordered) {
        if (!recovered.has(w)) {
          await invoke(w, 'recover');
          recovered.add(w);
          changed();
        }
        let snapshot = await call({
            workspaceId: w,
            command: { operation: 'list', payload: { compact: true } },
          });
        // starting() persists possibly_sent before turn/start. A still-prepared
        // run with no turnId therefore never crossed the CLI submission point.
        // Settle it through the normal not_received path, which releases claims
        // and schedules the bounded transport retry for controlled work.
        let settledPrepared = false;
        for (const task of snapshot.tasks)
          for (const old of task.management.runs.filter(r =>
            r.state === 'unknown' && r.submission?.state === 'prepared' && !r.turnId)) {
            await invoke(w, 'reconcile', task.id, { runId: old.id, state: 'failed',
              notReceived: true, retryableTransport: true,
              reason: '宿主重启前尚未提交执行回合；确认未发送后安排重试' });
            settledPrepared = true;
          }
        if (settledPrepared) {
          snapshot = await call({ workspaceId: w,
            command: { operation: 'list', payload: { compact: true } } });
          changed();
        }
        // Recovery is read/collection only and cannot hold up unrelated dispatch.
        if (ready()) void reconcileUnknown(snapshot).then(() => {}).catch(() => {});
        snapshots.push(snapshot);
      }
      // The local host must mark interrupted process ownership unknown even if
      // Codex cannot start. Only CLI observation and new dispatch require ready().
      if (!ready()) return;
      const owners = new Map(snapshots.flatMap((s) => s.tasks.map((t) => [t.id, s.workspaceId])));
      const candidates = snapshots
        .flatMap((s) => s.tasks)
        .filter(
          (t) =>
            providerReady(t) &&
            !t.management.legacy &&
            !t.management.runs.some((r) =>
              ['starting', 'running', 'waiting', 'stopping', 'unknown'].includes(r.state),
            ) &&
            (['queued', 'waiting', 'scheduled', 'revising'].includes(t.management.state) ||
              (t.management.delegation?.phase === 'waiting' && t.management.state === 'attention')),
        );
      const priority = (t) =>
        t.management.schedule.priority +
        Math.floor((Date.now() - Date.parse(t.createdAt)) / 300000);
      const familyCount = (t) =>
        [...active.values()].filter(
          (e) => (e.parentTaskId || e.taskId) === (t.management.parentTaskId || t.id),
        ).length;
      const workspaceCount = (t) =>
        [...active.values()].filter((e) => e.workspaceId === owners.get(t.id)).length;
      while (candidates.length) {
        candidates.sort(
          (a, b) =>
            workspaceCount(a) - workspaceCount(b) ||
            familyCount(a) - familyCount(b) ||
            priority(b) - priority(a) ||
            (a.management.schedule.dueAt || a.management.schedule.dueDate || '9999').localeCompare(
              b.management.schedule.dueAt || b.management.schedule.dueDate || '9999',
            ) ||
            a.createdAt.localeCompare(b.createdAt),
        );
        const task = candidates.shift(),
          w = owners.get(task.id);
        if (!ready() || exiting) break;
        if (!providerReady(task)) continue;
        if (
          task.management.schedule.notBefore &&
          Date.parse(task.management.schedule.notBefore) > Date.now()
        )
          continue;
        let dispatched;
        try {
          dispatched = await invoke(w, 'dispatch', task.id, {
            threadId: task.management.threadId || 'pending',
            provider: task.management.provider || 'codex',
            dispatchKey: `${task.id}:${task.management.generation}:${task.management.runs.length}`,
            controlled:
              task.management.executionMode !== 'serial' && (await controlled?.(task)) === true,
          });
        } catch (error) {
          emit('notice', `工作「${task.title}」未开始：${error.message}`);
          continue;
        }
        if (!dispatched.run) continue;
        if (exiting) {
          // Dispatch may have crossed the exit boundary while its transaction
          // was pending. No CLI request has been sent: persist that fact and
          // leave the existing work queued for the next host.
          await invoke(w, 'finish', task.id, { runId: dispatched.run.id,
            state: 'failed', notReceived: true, retryableTransport: true,
            reason: 'application_exit_before_submission' });
          changed();
          break;
        }
        const entry = {
          workspaceId: w,
          taskId: task.id,
          parentTaskId: task.management.parentTaskId,
          runId: dispatched.run.id,
          threadId: null,
          deadline: performance.now() + Math.min(task.budget.maxMinutes * 60000,
            task.management.continuation?.next === 'repair'
              ? remainingRepairMs(task.management.continuation) : Infinity),
        };
        active.set(task.id, entry);
        entry.activity = createActivityClock();
        changed();
        try {
          await run(dispatched.task, dispatched.run, w);
        } catch (error) {
          try { await flushActivity(entry); } catch {}
          // A transport error does not prove the CLI did not start. Keep claims for reconciliation.
          await invoke(w, 'finish', task.id, {
            runId: entry.runId,
            state: entry.requestSent && !error.beforeSend && !error.rpcRejected ? 'unknown' : 'failed',
            notReceived: !!(error.beforeSend || error.rpcRejected),
            retryableTransport: canRetrySubmission(error),
            retryAfterMs: retryAfterMs(error),
            reason: (entry.requestSent ? '发送结果待核实：' : '执行尚未启动：') + error.message,
          });
          active.delete(task.id);
          changed();
        }
        if (active.size >= 5) break;
      }
    } catch (error) {
      /* Connection may not exist yet; the UI reports connection status separately. */
    } finally {
      pumping = false;
    }
  }
  const reminders = setInterval(async () => {
    if (!enabled) return;
    try {
      const { workspaces } = await call({
        command: { operation: 'orchestration', payload: { operation: 'host_workspaces' } },
      });
      for (const { id: w } of workspaces) {
        const result = await invoke(w, 'remind');
        for (const notice of result.notices || []) emit('notice', notice);
        if (result.notices?.length) changed();
      }
    } catch {}
  }, 60000);
  reminders.unref();
  const timer = setInterval(() => void pump(), 5000);
  timer.unref();
  return {
    command,
    async suspendForExit() {
      exiting = true;
      await Promise.all([...active.values()].map(async e => {
        await flushActivity(e);
        await invoke(e.workspaceId, 'suspend_for_exit', e.taskId, { runId: e.runId });
      }));
    },
    dispose: () => {
      enabled = false;
      clearInterval(timer);
      clearInterval(reminders);
      clearInterval(budgetTimer);
      for (const timer of revisionTimers.values()) clearTimeout(timer);
    },
    child: (id) => !![...active.values()].find((e) => e.threadId === id)?.parentTaskId,
    async report(threadId, args) {
      const entry = [...active.values()].find((e) => e.threadId === threadId);
      if (!entry) throw Error('此执行已结束，不能再汇报进度');
      const result = await invoke(entry.workspaceId, 'progress', entry.taskId, {
        runId: entry.runId,
        text: args.text,
        step: args.step,
        total: args.total,
      });
      changed();
      return result;
    },
    async organize(threadId, args) {
      const entry = [...active.values()].find((e) => e.threadId === threadId);
      if (!entry || entry.parentTaskId) throw Error('只有当前工作的负责人可以分派');
      if (args.operation === 'return_assignment') {
        const result = await command({
          workspaceId: entry.workspaceId,
          command: {
            operation: 'orchestration',
            payload: {
              operation: 'return_assignment',
              taskId: entry.taskId,
              runId: entry.runId,
              sourceRequestId: args.sourceRequestId,
              reason: args.reason,
            },
          },
        });
        emit('notice', '有一项工作需要确认归属，已暂停并保留结果');
        return result;
      }
      if (args.operation === 'read_result') {
        const root = await invoke(entry.workspaceId, 'detail', entry.taskId),
          current = root.management.runs.find((r) => r.id === entry.runId);
        if (
          !current ||
          current.generation !== root.management.generation ||
          current.requirementsRevision !== root.management.currentRequirementsRevision ||
          !['starting', 'running', 'waiting'].includes(current.state) ||
          root.management.delegation?.phase !== 'integrating'
        )
          throw Error('分工要求已更新，请停止旧执行');
        if (!root.management.delegation?.children.includes(args.taskId))
          throw Error('结果不属于当前工作');
        const child = await invoke(entry.workspaceId, 'detail', args.taskId),
          run = child.management.runs
            .filter(
              (r) =>
                r.state === 'succeeded' &&
                r.requirementsRevision === child.management.currentRequirementsRevision,
            )
            .at(-1);
        const offset = Number.isSafeInteger(args.offset) ? Math.max(0, args.offset) : 0,
          value = run?.resultText || '';
        return {
          text: value.slice(offset, offset + 16000),
          nextOffset: offset + 16000 < value.length ? offset + 16000 : null,
        };
      }
      const result = await invoke(entry.workspaceId, 'delegate', entry.taskId, {
        ...args,
        runId: entry.runId,
      });
      changed();
      return result;
    },
    async waiting(threadId, waiting) {
      const e = [...active.values()].find((e) => e.threadId === threadId);
      if (e) {
        e.activity?.waiting(waiting);
        await flushActivity(e);
        await invoke(e.workspaceId, 'wait', e.taskId, { runId: e.runId, waiting });
        if (waiting && !e.waitingSince) e.waitingSince = performance.now();
        if (!waiting && e.waitingSince) {
          e.deadline += performance.now() - e.waitingSince;
          e.waitingSince = null;
        }
        changed();
      }
    },
    busy: () => active.size > 0,
    owns: (id) => [...active.values()].some((e) => e.threadId === id),
    enabled: (value) => {
      enabled = !!value;
    },
    async starting(taskId) {
      const e = active.get(taskId);
      if (e) {
        await invoke(e.workspaceId, 'ack', taskId, { runId: e.runId, threadId: e.threadId, submitting: true });
        e.requestSent = true;
      }
    },
    async bindThread(taskId, threadId, modelSettings) {
      const entry = active.get(taskId);
      if (entry) {
        if (entry.budgetStopped || performance.now() >= entry.deadline)
          throw Error('执行预算已耗尽，未发送新回合');
        entry.threadId = threadId;
        await invoke(entry.workspaceId, 'ack', taskId, {
          runId: entry.runId,
          threadId,
          ...(modelSettings?.model ? { modelSettings } : {}),
        });
      }
    },
    async directory(taskId, directory) {
      const e = active.get(taskId);
      if (e)
        await invoke(e.workspaceId, 'ack', taskId, {
          runId: e.runId,
          threadId: e.threadId,
          outputDirectory: directory,
        });
    },
    async ack(taskId, threadId, turnId, modelSettings) {
      const e = active.get(taskId);
      if (e) {
        e.turnId = turnId;
        await invoke(e.workspaceId, 'ack', taskId, {
          runId: e.runId,
          threadId,
          turnId,
          ...(modelSettings?.model ? { modelSettings } : {}),
        });
        const pending = e.pendingFinish;
        e.pendingFinish = null;
        if (pending && pending.turn.id === turnId) await finishRun(threadId, pending.turn, pending.batch);
      }
      changed();
    },
    finished: finishRun = async (threadId, turn, batch) => {
      const e = [...active.values()].find((e) => e.threadId === threadId);
      if (!e) return;
      if (!turn.uncertain && !e.turnId) { e.pendingFinish = { turn, batch }; return; }
      if (!turn.uncertain && e.turnId !== turn.id) return;
      if (e.finishing) return e.finishing;
      e.finishing = (async () => {
      await flushActivity(e);
      let actual = turn;
      try {
        // Completion notifications may contain messages but omit tool receipts.
        // Read the canonical turn even when the notification has nonempty items.
        if (!turn.uncertain) {
          const recorded = await readRun({ ...e, turnId: turn.id });
          if (recorded?.id === turn.id && recorded.status === turn.status) actual = recorded;
        }
      } catch {}
      const resultText = (actual.items || [])
        .filter((i) => i.type === 'agentMessage')
        .map((i) => i.text || '')
        .join('\n')
        .slice(0, 100000);
      const artifacts = (batch?.files || [])
        .filter((f) => f.objectId && f.revision)
        .map((f) => ({ objectId: f.objectId, revision: f.revision }));
      const finished = await invoke(e.workspaceId, 'finish', e.taskId, {
        runId: e.runId,
        state: turn.uncertain
          ? 'unknown'
          : turn.status === 'completed'
            ? 'succeeded'
            : turn.status === 'interrupted'
              ? 'interrupted'
              : 'failed',
        batchId: batch?.id,
        artifacts,
        resultText,
        executionEvidence: executionEvidence(actual, e.turnId),
        reason: turn.uncertain
          ? '执行器连接断开，结果待核实，不自动重放'
          : batch?.issues?.length
            ? '部分文件未收回，请检查成果'
            : undefined,
      });
      if (active.get(e.taskId) === e) active.delete(e.taskId);
      changed();
      void pump();
      if (
        !e.parentTaskId &&
        ['review', 'completed', 'attention'].includes(finished.management?.state) &&
        finished.management.runs.find((r) => r.id === e.runId)?.requirementsRevision ===
          finished.management.currentRequirementsRevision
      )
        emit('work-result', {
          workspaceId: e.workspaceId,
          threadId: finished.management?.threadId,
          originThreadId: finished.management?.originThreadId,
          taskId: e.taskId,
          runId: e.runId,
          title: finished.title,
          state: finished.management?.state,
          resultText,
        });
      })();
      try { return await e.finishing; }
      finally { e.finishing = null; }
    },
  };
}
