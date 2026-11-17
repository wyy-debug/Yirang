import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, extname, isAbsolute, delimiter } from 'node:path';

// Adapters expose the same send / cancel / resume / approve / capabilities contract.
export function codexAdapter(request, respond) {
  return {
    kind: 'codex',
    send: (p) => request('turn/start', p),
    cancel: (p) => request('turn/interrupt', p),
    resume: (p) => request('thread/resume', p),
    approve: respond,
    request,
    capabilities: { stream: true, resume: true, approval: true, models: true, usage: true },
  };
}

export async function createCliAdapters({
  directory,
  node,
  cwd,
  mcpServers,
  onMessage,
  onChanged,
}) {
  const path = join(directory, 'ai-tools.json');
  let saved = { tools: {}, chats: [] };
  try {
    saved = { ...saved, ...JSON.parse(await readFile(path, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const chats = new Map(saved.chats.map((c) => [c.id, c])),
    agents = new Map();
  let writing = Promise.resolve();
  for (const c of chats.values())
    for (const turn of c.turns || []) if (turn.status === 'inProgress') turn.status = 'interrupted';
  function persist() {
    const body = JSON.stringify({ tools: saved.tools, chats: [...chats.values()] });
    const work = writing
      .catch(() => {})
      .then(async () => {
        await writeFile(path + '.tmp', body);
        await rename(path + '.tmp', path);
      });
    writing = work;
    return work;
  }
  function saveSoon() {
    void persist().catch((e) => onChanged({ error: e.message }));
  }
  const definitions = [
    {
      id: 'gemini',
      name: 'Gemini CLI',
      package: '@google/gemini-cli',
      bin: 'gemini',
      args: ['--acp'],
      supported: true,
    },
    {
      id: 'claude',
      name: 'Claude Code',
      package: '@anthropic-ai/claude-code',
      bin: 'claude',
      supported: false,
    },
    { id: 'opencode', name: 'OpenCode', package: 'opencode-ai', bin: 'opencode', supported: false },
  ];
  async function catalog() {
    return Promise.all(
      definitions
        .concat([{ id: 'custom-acp', name: '自定义 ACP v1', args: [], supported: true }])
        .map(async (def) => {
          let entry = { ...def, ...saved.tools[def.id] },
            version = null;
          if (def.package) {
            try {
              const base = join(process.env.APPDATA || '', 'npm', 'node_modules', def.package),
                pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
              version = pkg.version;
              entry.path ||= join(base, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[def.bin]);
            } catch {}
          }
          if (!entry.path && def.bin)
            for (const folder of (process.env.PATH || '').split(delimiter)) {
              const candidate = join(
                folder.replace(/^"|"$/g, ''),
                def.bin + (process.platform === 'win32' ? '.exe' : ''),
              );
              if ((await stat(candidate).catch(() => null))?.isFile()) {
                entry.path = candidate;
                break;
              }
            }
          const installed = !!entry.path && (await stat(entry.path).catch(() => null))?.isFile();
          return {
            id: entry.id,
            name: entry.name,
            path: entry.path || '',
            args: entry.args || [],
            version,
            installed: !!installed,
            supported: entry.supported,
            status: [...agents.values()].some((a) => a.tool.id === entry.id && a.session)
              ? '已连接'
              : installed
                ? '已发现 · 首次发送时连接'
                : '未发现',
            error:
              [...agents.values()].find((a) => a.tool.id === entry.id && a.error)?.error || null,
          };
        }),
    );
  }
  async function configure(p) {
    const def =
      definitions.find((d) => d.id === p.id) || (p.id === 'custom-acp' ? { id: p.id } : null);
    if (!def) throw Error('未知 AI 工具');
    if (p.path && (!isAbsolute(p.path) || !(await stat(p.path)).isFile()))
      throw Error('请选择本机可执行文件或 JS 入口');
    if (p.path && !['.exe', '.js', '.mjs', '.cjs', ''].includes(extname(p.path).toLowerCase()))
      throw Error('请选择 exe 或 JS 入口，不支持 shell 脚本');
    if (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string' || a.length > 4096))
      throw Error('启动参数须为字符串数组');
    saved.tools[p.id] = { path: p.path || null, args: p.args };
    await persist();
    return catalog();
  }
  async function create(provider) {
    const tool = (await catalog()).find((t) => t.id === provider);
    if (!tool?.supported || !tool.installed) throw Error('该工具尚未接入或未安装');
    const chat = {
      id: 'acp-' + randomUUID(),
      provider,
      name: tool.name + ' · 新对话',
      turns: [],
      cwd,
      tool: { id: tool.id, name: tool.name, path: tool.path, args: tool.args },
    };
    chats.set(chat.id, chat);
    await persist();
    return chat;
  }
  function get(id) {
    return chats.get(id);
  }
  function info(id) {
    const c = get(id),
      a = agents.get(id);
    return c
      ? {
          id: c.provider,
          name: a?.tool.name || definitions.find((d) => d.id === c.provider)?.name || 'ACP',
          status: a?.session
            ? '已连接'
            : a?.child
              ? '连接中'
              : c.sessionId
                ? '待恢复 · 发送时连接'
                : '首次发送时连接',
          capabilities: a?.capabilities ||
            c.capabilities || { stream: true, approval: true, usage: false, resume: false },
          models: a?.session?.models || null,
          modes: a?.session?.modes || null,
          configOptions: a?.session?.configOptions || [],
          error: a?.error || null,
        }
      : null;
  }
  async function agent(id) {
    if (agents.has(id)) return agents.get(id);
    const c = get(id);
    if (!c) throw Error('对话不存在');
    const tool = c.tool || (await catalog()).find((t) => t.id === c.provider);
    if (!tool?.path || !(await stat(tool.path).catch(() => null))?.isFile())
      throw Error('CLI 路径不存在，请在 AI 工具中配置');
    const a = new AcpAdapter({
      tool,
      chat: c,
      node: await node(),
      mcpServers: await mcpServers(),
      onMessage,
      onChanged: () => {
        saveSoon();
        onChanged({ threadId: id, ...info(id) });
      },
      save: saveSoon,
    });
    agents.set(id, a);
    return a;
  }
  async function request(method, p) {
    const c = get(p.threadId);
    if (!c) throw Error('对话不存在');
    if (method === 'thread/read' || method === 'thread/resume')
      return { thread: { ...c, status: { type: agents.get(c.id)?.turn ? 'active' : 'idle' } } };
    if (method === 'thread/turns/list') {
      const turns = [...c.turns].reverse(),
        offset = p.cursor ? Number(p.cursor) : 0,
        data = turns.slice(offset, offset + (p.limit || 40));
      return {
        data,
        nextCursor: offset + data.length < turns.length ? String(offset + data.length) : null,
      };
    }
    if (method === 'thread/name/set') {
      c.name = String(p.name).slice(0, 120);
      await persist();
      return {};
    }
    const a = await agent(c.id);
    if (method === 'turn/start') return a.send(p);
    if (method === 'turn/interrupt') return a.cancel();
    throw Error('此 CLI 不支持 ' + method);
  }
  return {
    catalog,
    configure,
    create,
    get,
    info,
    list: () => [...chats.values()].map(({ turns, ...c }) => c),
    request,
    owns: (id) => chats.has(id),
    approve: (id, response) => {
      for (const a of agents.values()) if (a.approve(id, response)) return true;
      return false;
    },
    async setOption(id, p) {
      return (await agent(id)).setOption(p);
    },
    async close() {
      for (const a of agents.values()) a.close();
      await persist();
    },
  };
}

class AcpAdapter {
  constructor(options) {
    Object.assign(this, options);
    this.pending = new Map();
    this.permissions = new Map();
    this.serial = 0;
    this.child = null;
    this.turn = null;
    this.session = null;
    this.capabilities = { stream: true, approval: true, usage: false, resume: false };
    this.connecting = null;
    this.text = '';
  }
  write(value) {
    if (!this.child?.stdin.writable) throw Error('CLI 已断开');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  }
  rpc(method, params, timeout = 90000) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(Error('ACP 请求超时：' + method));
          }, timeout)
        : null;
      timer?.unref();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.write({ id, method, params });
      } catch (e) {
        this.pending.get(id).reject(e);
        this.pending.delete(id);
      }
    });
  }
  async connect() {
    if (this.session && this.child) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.initialize()
      .catch((e) => {
        this.error = e.message;
        this.close();
        throw e;
      })
      .finally(() => {
        this.connecting = null;
        this.onChanged();
      });
    return this.connecting;
  }
  async initialize() {
    const js = /\.[cm]?js$/i.test(this.tool.path);
    this.child = spawn(
      js ? this.node : this.tool.path,
      [...(js ? [this.tool.path] : []), ...this.tool.args],
      {
        cwd: this.chat.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );
    const child = this.child;
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr = (stderr + b).slice(-4000);
    });
    child.stdin.on('error', (e) => this.fail(e));
    child.on('error', (e) => this.fail(e));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.session = null;
      this.fail(Error('CLI 已退出 (' + code + ')' + (stderr ? '：' + stderr.slice(-1000) : '')));
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch (e) {
        this.fail(Error('ACP 消息无效：' + e.message));
      }
    });
    const init = await this.rpc('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'yirang', version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (init.protocolVersion !== 1)
      throw Error('此适配器支持 ACP v1，工具返回 ' + init.protocolVersion);
    this.capabilities = {
      stream: true,
      approval: true,
      usage: false,
      resume: !!init.agentCapabilities?.loadSession,
      image: !!init.agentCapabilities?.promptCapabilities?.image,
    };
    this.chat.capabilities = this.capabilities;
    const params = { cwd: this.chat.cwd, mcpServers: this.mcpServers };
    if (this.chat.sessionId) {
      if (!this.capabilities.resume) throw Error('此工具不支持恢复原会话，请新建对话');
      this.loading = true;
      try {
        this.session = await this.rpc('session/load', {
          ...params,
          sessionId: this.chat.sessionId,
        });
      } finally {
        this.loading = false;
      }
    } else {
      this.session = await this.rpc('session/new', params);
      if (!this.session.sessionId) throw Error('ACP 没有返回会话标识');
      this.chat.sessionId = this.session.sessionId;
    }
    this.error = null;
    this.save();
  }
  receive(msg) {
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      const id = 'acp-approval-' + this.chat.id + '-' + msg.id;
      this.permissions.set(id, msg);
      this.onMessage({
        id,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: this.chat.id,
          turnId: this.turn?.id,
          command: msg.params?.toolCall?.title || '工具请求授权',
          reason: '来自 ' + this.tool.name + '；仅批准本次操作',
          availableDecisions: ['accept', 'decline'],
        },
      });
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this.write({
        id: msg.id,
        error: { code: -32601, message: 'Client capability not supported' },
      });
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(Error(msg.error.message || 'ACP 请求失败')) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method !== 'session/update' || this.loading || !this.turn) return;
    const u = msg.params?.update;
    if (!u) return;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      this.text += u.content.text;
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 32);
    }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const old = this.turn.items.find((i) => i.id === u.toolCallId),
        item = {
          ...old,
          id: u.toolCallId,
          type: 'mcpToolCall',
          server: this.tool.name,
          tool: u.title || old?.tool || u.toolCallId,
          status: u.status || 'inProgress',
          result: u.content || old?.result,
        };
      if (old) Object.assign(old, item);
      else this.turn.items.push(item);
      this.event('item/' + (['completed', 'failed'].includes(u.status) ? 'completed' : 'started'), {
        item,
      });
    }
    if (u.sessionUpdate === 'config_option_update') {
      this.session.configOptions = u.configOptions;
      this.onChanged();
    }
    if (u.sessionUpdate === 'current_mode_update') {
      if (this.session.modes) this.session.modes.currentModeId = u.currentModeId;
      this.onChanged();
    }
  }
  event(method, p = {}) {
    this.onMessage({ method, params: { threadId: this.chat.id, turnId: this.turn?.id, ...p } });
  }
  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.text || !this.turn) return;
    const delta = this.text;
    this.text = '';
    let item = this.turn.items.find((i) => i.type === 'agentMessage');
    if (!item) {
      item = { id: randomUUID(), type: 'agentMessage', text: '' };
      this.turn.items.push(item);
    }
    item.text += delta;
    this.event('item/agentMessage/delta', { itemId: item.id, delta });
  }
  send(p) {
    if (this.turn) throw Error('此对话正在运行');
    const turn = {
      id: randomUUID(),
      status: 'inProgress',
      items: [
        {
          id: randomUUID(),
          type: 'userMessage',
          content: p.input.map((b) =>
            b.type === 'text'
              ? { type: 'text', text: b.text.split('\n\n[工作桌面连接说明]')[0] }
              : b,
          ),
        },
      ],
    };
    this.turn = turn;
    this.cancelled = false;
    this.chat.cwd = p.cwd || this.chat.cwd;
    this.chat.turns.push(turn);
    this.chat.name =
      this.tool.name +
      ' · ' +
      (turn.items[0].content.find((b) => b.type === 'text')?.text || '新对话').slice(0, 30);
    this.save();
    // Return a turn receipt before process startup; another chat can be used immediately.
    setTimeout(() => void this.run(p, turn), 0);
    return { turn };
  }
  async run(p, turn) {
    try {
      this.event('turn/started', { turn });
      await this.connect();
      if (this.cancelled) {
        this.finish('interrupted');
        return;
      }
      const prompt = p.input.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'image') {
          if (!this.capabilities.image) throw Error('此 CLI 未声明图片能力，截图未发送');
          const m = /^data:([^;]+);base64,(.*)$/s.exec(b.url);
          if (!m) throw Error('图片格式不支持');
          return { type: 'image', mimeType: m[1], data: m[2] };
        }
        throw Error('不支持的引用类型');
      });
      const result = await this.rpc(
        'session/prompt',
        { sessionId: this.chat.sessionId, prompt },
        0,
      );
      if (this.turn === turn)
        this.finish(
          this.cancelled || result.stopReason === 'cancelled'
            ? 'interrupted'
            : result.stopReason === 'refusal'
              ? 'failed'
              : 'completed',
          result.stopReason === 'refusal' ? '工具拒绝了本轮请求' : undefined,
        );
    } catch (e) {
      if (this.turn === turn) this.finish('failed', e.message);
    }
  }
  finish(status, error) {
    if (!this.turn) return;
    this.flush();
    const turn = this.turn;
    turn.status = status;
    if (error) {
      this.error = error;
      turn.error = { message: error };
      turn.items.push({
        id: randomUUID(),
        type: 'agentMessage',
        text: '连接或执行失败：' + error + '。请检查 AI 工具路径及 CLI 登录状态。',
      });
    }
    this.turn = null;
    clearTimeout(this.cancelTimer);
    for (const [id] of this.permissions) {
      try {
        this.approve(id, { decision: 'decline' });
      } catch {}
    }
    this.permissions.clear();
    this.save();
    this.onChanged();
    this.onMessage({ method: 'turn/completed', params: { threadId: this.chat.id, turn } });
  }
  cancel() {
    this.cancelled = true;
    for (const [id] of this.permissions) this.approve(id, { decision: 'decline' });
    if (this.session)
      this.write({ method: 'session/cancel', params: { sessionId: this.chat.sessionId } });
    clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(() => {
      if (this.turn) {
        this.finish('interrupted');
        this.close();
      }
    }, 5000);
    return {};
  }
  approve(id, response) {
    const msg = this.permissions.get(id);
    if (!msg) return false;
    const options = msg.params.options || [],
      option = options.find(
        (o) => o.kind === (response?.decision === 'accept' ? 'allow_once' : 'reject_once'),
      );
    this.write({
      id: msg.id,
      result: {
        outcome: option
          ? { outcome: 'selected', optionId: option.optionId }
          : { outcome: 'cancelled' },
      },
    });
    this.permissions.delete(id);
    return true;
  }
  async setOption(p) {
    if (this.turn) throw Error('请等待此对话当前回合结束');
    await this.connect();
    if (p.modeId) {
      if (!this.session.modes?.availableModes?.some((m) => m.id === p.modeId))
        throw Error('模式不在工具提供的列表中');
      await this.rpc('session/set_mode', { sessionId: this.chat.sessionId, modeId: p.modeId });
      this.session.modes.currentModeId = p.modeId;
    } else if (p.modelId) {
      if (!this.session.models?.availableModels?.some((m) => m.modelId === p.modelId))
        throw Error('模型不在工具提供的列表中');
      await this.rpc('session/set_model', { sessionId: this.chat.sessionId, modelId: p.modelId });
      this.session.models.currentModelId = p.modelId;
    } else {
      const option = this.session.configOptions?.find((o) => o.id === p.configId);
      if (
        !option ||
        !option.options?.some(
          (o) => o.value === p.value || o.options?.some((v) => v.value === p.value),
        )
      )
        throw Error('配置值不在工具提供的列表中');
      const result = await this.rpc('session/set_config_option', {
        sessionId: this.chat.sessionId,
        configId: p.configId,
        value: p.value,
      });
      this.session.configOptions = result.configOptions;
    }
    this.onChanged();
    return this.session;
  }
  fail(e) {
    this.error = e.message;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    if (this.turn) this.finish('failed', e.message);
    this.close();
    this.onChanged();
  }
  close() {
    clearTimeout(this.flushTimer);
    clearTimeout(this.cancelTimer);
    const child = this.child;
    this.child = null;
    this.session = null;
    if (child?.pid && child.exitCode === null) {
      if (process.platform === 'win32')
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => child.kill());
      else child.kill();
    }
    for (const p of this.pending.values()) p.reject(Error('CLI 已关闭'));
    this.pending.clear();
  }
}
