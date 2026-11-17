// M5: whitelisted micro-app export, built-in templates, and upgrade to a light-app draft.
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hashValue, microPage } from './micro-apps.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const obj = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const table = (key, fields) => ({ key, fields, order: 'ignore' });
export const MICRO_TEMPLATES = [
  {
    id: 'meeting-todos',
    name: '会议纪要 → 待办',
    description: '从会议纪要提取待办事项、负责人和截止时间。',
    capability: {
      name: 'extract',
      title: '整理待办',
      prompt:
        '从会议纪要中提取待办事项。\n\n- 每条待办写清事项、负责人、截止时间（原文没有则为 null）和优先级。\n- summary 用一句话概括会议结论。\n\n{{materials}}\n',
      inputSchema: obj({ meeting: { type: 'string', title: '会议名称' } }),
      outputSchema: obj({
        todos: {
          type: 'array',
          items: obj({
            task: { type: 'string' },
            owner: { type: ['string', 'null'] },
            due: { type: ['string', 'null'] },
            priority: { enum: ['high', 'medium', 'low'] },
          }),
        },
        summary: { type: 'string' },
      }),
      evaluation: {
        todos: table('task', { task: 'exact', owner: 'exact', due: 'exact', priority: 'exact' }),
        summary: 'review',
      },
      materials: { min: 1, max: 5 },
      outputs: [
        { kind: 'xlsx', from: 'todos', name: '{meeting}-待办.xlsx' },
        { kind: 'md', name: '{meeting}-待办.md' },
      ],
    },
  },
  {
    id: 'table-compare',
    name: '表格对比',
    description: '比较两份表格或清单，列出新增、删除和变化的行。',
    capability: {
      name: 'compare',
      title: '对比表格',
      prompt:
        '比较下面两份材料（第一份是旧版本，第二份是新版本）。按「{{input.key}}」对齐每一行，列出新增、删除和内容变化的行；变化要写明哪个字段从什么变成什么。summary 用两三句话说明主要差异。\n\n{{materials}}\n',
      inputSchema: obj({ key: { type: 'string', title: '用来对齐的列名' } }),
      outputSchema: obj({
        changes: {
          type: 'array',
          items: obj({
            key: { type: 'string' },
            change: { enum: ['added', 'removed', 'modified'] },
            field: { type: ['string', 'null'] },
            before: { type: ['string', 'null'] },
            after: { type: ['string', 'null'] },
          }),
        },
        summary: { type: 'string' },
      }),
      evaluation: {
        changes: table(['key', 'field'], {
          key: 'exact',
          change: 'exact',
          field: 'exact',
          before: 'exact',
          after: 'exact',
        }),
        summary: 'review',
      },
      materials: { min: 2, max: 2 },
      outputs: [{ kind: 'xlsx', from: 'changes', name: '表格对比.xlsx' }],
    },
  },
  {
    id: 'contract-points',
    name: '合同要点提取',
    description: '提取合同主体、金额、期限、关键义务和风险条款。',
    capability: {
      name: 'extract',
      title: '提取要点',
      prompt:
        '阅读合同，提取要点。只写合同中明确写出的内容，没有的写 null；风险条款要引用原文条款号。不提供法律意见。\n\n{{materials}}\n',
      inputSchema: obj({}),
      outputSchema: obj({
        parties: {
          type: 'array',
          items: obj({ role: { type: 'string' }, name: { type: 'string' } }),
        },
        amount: { type: ['string', 'null'] },
        term: { type: ['string', 'null'] },
        obligations: {
          type: 'array',
          items: obj({ party: { type: 'string' }, duty: { type: 'string' } }),
        },
        risks: {
          type: 'array',
          items: obj({ clause: { type: 'string' }, note: { type: 'string' } }),
        },
      }),
      evaluation: {
        parties: table('role', { role: 'exact', name: 'exact' }),
        amount: 'exact',
        term: 'exact',
        obligations: 'review',
        risks: 'review',
      },
      materials: { min: 1, max: 1 },
      outputs: [{ kind: 'docx', name: '合同要点.docx' }],
    },
  },
];
export function templateFiles(template, appId) {
  const c = template.capability;
  const manifest = {
    schemaVersion: 1,
    id: appId,
    name: template.name,
    version: '0.1.0',
    minHostApi: 3,
    description: template.description,
    runtime: { kind: 'micro' },
    capabilities: [
      {
        name: c.name,
        title: c.title,
        prompt: `prompts/${c.name}.md`,
        inputSchema: c.inputSchema,
        outputSchema: c.outputSchema,
        evaluation: c.evaluation,
        materials: c.materials,
        outputs: c.outputs,
        timeoutMs: 120000,
      },
    ],
    evolution: { autoPropose: true, autoPublish: 'never' },
  };
  return {
    'yirang.app.json': json(manifest),
    [`prompts/${c.name}.md`]: c.prompt,
    'README.md': `# ${template.name}\n\n${template.description}\n\n由一壤内置模板创建，可直接运行，也可修改提示词和输出结构。\n`,
  };
}

function walk(root) {
  const out = [];
  const go = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name),
        s = lstatSync(p);
      if (s.isDirectory()) go(p);
      else if (s.isFile()) out.push(relative(root, p).replaceAll('\\', '/'));
    }
  };
  go(root);
  return out;
}
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const sourceInfo = ['crystallizedFrom'];
const cleanManifest = (manifest) => {
  const clean = { ...manifest };
  for (const k of sourceInfo) delete clean[k];
  delete clean.actions;
  return clean;
};
const leaves = (v) =>
  typeof v === 'string'
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(leaves)
      : v && typeof v === 'object'
        ? Object.values(v).flatMap(leaves)
        : [];
const mapLeaves = (v, f) =>
  typeof v === 'string'
    ? f(v)
    : Array.isArray(v)
      ? v.map((x) => mapLeaves(x, f))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapLeaves(x, f)]))
        : v;
const textFile = (path) => /\.(md|txt|html?|css|m?js|json|svg)$/i.test(path);
// Pattern hits are prompts for review, not a guarantee: the user still decides each one.
export const SENSITIVE_PATTERNS = [
  ['邮箱', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ['固定电话', /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g],
  ['身份证号', /(?<!\d)\d{17}[\dXx](?![\dXx])/g],
  ['长数字（银行卡号等）', /(?<!\d)\d{16,19}(?!\d)/g],
  [
    '密钥或令牌',
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/g,
  ],
  ['本机用户路径', /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+|\/(?:Users|home)\/[^/\s"'<>]+/g],
];
const fragments = (text) =>
  String(text || '')
    .split(/[\n\r。！？；!?;]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 12);

// Everything the user might share by accident is opt-in: real examples and their materials. Text that
// will be exported (prompts, README, page, manifest, synthetic examples) is scanned for prompt text copied
// from earlier work (anchors), fragments of real examples or materials, and contact/ID/secret patterns;
// each hit must be kept or replaced. Synthetic examples are exported by default.
export function exportPlan({
  root,
  manifest,
  anchors = [],
  confirmedExamples = [],
  materialTexts = [],
}) {
  const files = walk(root),
    prompts = files.filter((p) => /^prompts\/[^/]+\.md$/.test(p));
  const packaged = files
    .filter((p) => /^examples\/[^/]+\.json$/.test(p))
    .map((path) => ({ path, value: readJson(join(root, path)) }))
    .filter((e) => e.value);
  const real = [
    ...packaged
      .filter((e) => !['synthetic'].includes(e.value.source))
      .map((e) => ({
        key: 'file:' + e.path,
        source: e.value.source || 'unknown',
        input: e.value.input,
        output: e.value.output,
        materials: (e.value.materials || []).map((m) => ({ id: m.id, title: m.title })),
      })),
    ...confirmedExamples.map((e) => ({
      key: 'confirmed:' + e.id,
      source: 'user-confirmed',
      input: e.snapshot.input,
      output: e.output,
      materials: (e.snapshot.materials || []).map((m) => ({ id: m.id, title: m.title })),
    })),
  ];
  const included = files.filter(
    (p) =>
      p === 'yirang.app.json' ||
      p === 'README.md' ||
      p.startsWith('ui/') ||
      prompts.includes(p) ||
      packaged.some((e) => e.path === p && e.value.source === 'synthetic'),
  );
  const texts = Object.fromEntries(
    included
      .filter((p) => p !== 'yirang.app.json' && textFile(p))
      .map((p) => [p, readFileSync(join(root, p), 'utf8')]),
  );
  const manifestText = leaves(cleanManifest(manifest)).join('\n');
  const where = (quote) => [
    ...(manifestText.includes(quote) ? ['yirang.app.json'] : []),
    ...Object.keys(texts).filter((p) => texts[p].includes(quote)),
  ];
  const found = [],
    seen = new Set();
  const note = (kind, label, quote) => {
    if (!quote || seen.has(quote)) return;
    const at = where(quote);
    if (!at.length) return;
    seen.add(quote);
    found.push({ index: found.length, kind, label, quote, files: at });
  };
  for (const a of anchors) note('history', '来自历史工作的原文', a.quote);
  for (const e of real) {
    for (const v of leaves([e.input, e.output]))
      if (v.trim().length >= 6) note('example', '与真实样例相同的内容', v.trim());
    for (const m of e.materials)
      if (String(m.title || '').trim().length >= 4)
        note('example', '真实样例的材料标题', m.title.trim());
  }
  for (const m of materialTexts)
    for (const piece of fragments(m.text)) note('material', `材料「${m.title}」中的原文`, piece);
  const all = [manifestText, ...Object.values(texts)].join('\n');
  for (const [label, pattern] of SENSITIVE_PATTERNS)
    for (const [quote] of all.matchAll(pattern)) note('pattern', label, quote);
  const excluded = files
    .filter((p) => !included.includes(p))
    .map((path) => ({
      path,
      reason: path.startsWith('examples/') ? '真实样例，默认不导出' : '不在导出白名单内',
    }));
  const stripped = sourceInfo.filter((k) => manifest[k] !== undefined);
  const fileHashes = Object.fromEntries(
    included
      .filter((p) => p !== 'yirang.app.json')
      .map((p) => [p, sha(readFileSync(join(root, p)))]),
  );
  // Decisions are bound to exactly what was reviewed; any change to files, manifest, hits, examples or material text changes it.
  const digest = hashValue({
    files: fileHashes,
    manifest: cleanManifest(manifest),
    anchors: found,
    examples: real,
    materials: materialTexts.map((m) => [m.id, m.title, sha(m.text)]),
    stripped,
  });
  return {
    name: manifest.name,
    version: manifest.version,
    files: included,
    excluded,
    anchors: found,
    examples: real,
    stripped,
    fileHashes,
    digest,
  };
}

export function buildExport({ root, manifest, plan, decisions = {}, readMaterial }) {
  if (decisions.digest !== plan.digest)
    throw Error('导出内容在审阅后发生了变化，请重新打开导出清单并逐条确认');
  const anchors = decisions.anchors || {};
  for (const a of plan.anchors) {
    const d = anchors[a.index];
    if (!d || !(d.action === 'keep' || (d.action === 'replace' && typeof d.text === 'string')))
      throw Error(`提示词片段 ${a.index + 1} 尚未确认保留或替换，不能导出`);
  }
  const picked = new Set(decisions.examples || []),
    withMaterials = new Set(decisions.materials || []);
  if (withMaterials.size && decisions.materialsConfirmed !== true)
    throw Error('导出材料文件需要再次确认');
  for (const key of withMaterials) if (!picked.has(key)) throw Error('只能为已勾选的样例附带材料');
  const files = [];
  const add = (path, data) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    files.push({ path, data: bytes.toString('base64'), sha256: sha(bytes), size: bytes.length });
  };
  const replacements = plan.anchors
    .filter((a) => anchors[a.index].action === 'replace')
    .map((a) => [a.quote, anchors[a.index].text]);
  const scrub = (text) => replacements.reduce((t, [quote, to]) => t.split(quote).join(to), text);
  for (const path of plan.files) {
    if (path === 'yirang.app.json') {
      add(path, json(mapLeaves(cleanManifest(manifest), scrub)));
      continue;
    }
    const bytes = readFileSync(join(root, path));
    if (plan.fileHashes?.[path] !== sha(bytes))
      throw Error(`文件 ${path} 在审阅后发生了变化，请重新审阅`);
    add(path, textFile(path) ? Buffer.from(scrub(bytes.toString('utf8'))) : bytes);
  }
  return (async () => {
    let n = 0;
    for (const e of plan.examples.filter((x) => picked.has(x.key))) {
      const materials = [];
      for (const m of e.materials) {
        if (withMaterials.has(e.key)) {
          const o = await readMaterial(m.id);
          if (!o) throw Error(`样例材料「${m.title}」已不可读，不能附带`);
          if (m.sha256 && sha(o.text) !== m.sha256)
            throw Error(`样例材料「${m.title}」在审阅后发生了变化，请重新审阅`);
          materials.push({ title: m.title, text: o.text, sha256: sha(o.text) });
        } else materials.push({ title: m.title });
      }
      while (plan.files.includes(`examples/shared-${++n}.json`));
      add(
        `examples/shared-${n}.json`,
        json({
          id: randomUUID(),
          source: 'shared',
          input: e.input,
          materials,
          output: e.output,
          outputHash: hashValue(e.output),
        }),
      );
    }
    return {
      bundle: {
        format: 'micro',
        schemaVersion: 1,
        minHostApi: 3,
        name: manifest.name,
        version: manifest.version,
        files: files.map(({ size, ...f }) => f),
      },
      manifest: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
    };
  })();
}

// The light-app draft keeps the AI capabilities as host calls (yirang.ai.run) and adds an empty backend.
export function upgradeFiles({
  root,
  manifest,
  capabilities,
  id = (manifest.id + '.light').slice(0, 80),
}) {
  const out = {};
  const next = {
    schemaVersion: 1,
    id,
    name: (manifest.name + '（轻应用）').slice(0, 120),
    version: manifest.version || '0.1.0',
    minHostApi: 3,
    description: manifest.description,
    runtime: { kind: 'node', entry: 'backend/main.mjs' },
    ui: { entry: 'ui/index.html' },
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    actions: [],
    capabilities: manifest.capabilities,
    upgradedFrom: { appId: manifest.id, version: manifest.version || null },
  };
  for (const path of walk(root)) {
    if (path.startsWith('prompts/') || path.startsWith('ui/') || path === 'README.md')
      out[path] = readFileSync(join(root, path));
  }
  if (!manifest.ui?.entry) out['ui/index.html'] = microPage(manifest, capabilities);
  else if (manifest.ui.entry !== 'ui/index.html') next.ui.entry = manifest.ui.entry;
  out['yirang.app.json'] = json(next);
  out['backend/main.mjs'] = `import {createInterface} from 'node:readline';
// AI capabilities stay host calls: the page uses yirang.ai.run(name, input, {materials}).
// Add backend actions here (declare them in yirang.app.json "actions"), e.g. scheduled jobs or external APIs.
async function dispatch(action,input,context){
  throw Error('Unknown action: '+action);
}
for await(const line of createInterface({input:process.stdin})){
  let request={};
  try{request=JSON.parse(line);const result=await dispatch(request.action,request.input,request.context);process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');}
  catch(error){console.error(error);process.stdout.write(JSON.stringify({id:request.id,error:error.message})+'\\n');}
}
`;
  out['package.json'] = json({
    name: id,
    version: '0.1.0',
    private: true,
    type: 'module',
    dependencies: {},
  });
  out['package-lock.json'] = json({
    name: id,
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: id, version: '0.1.0' } },
  });
  out['UPGRADE.md'] =
    `# 从微应用升级\n\n来源：${manifest.name}（${manifest.id} ${manifest.version || ''}）。原微应用和它的版本保持不变。\n\n- AI 能力仍由一壤宿主调用，页面通过 yirang.ai.run 使用，首次运行需要 AI 授权。\n- 后端入口 backend/main.mjs 目前没有动作；需要定时任务或外部系统时在这里添加，并在 yirang.app.json 声明 actions。\n- 轻应用运行本机代码，打开前需要代码授权。\n- 样例、信号和运行记录没有复制。\n`;
  return out;
}
export function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const p = join(dir, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, { flag: 'wx' });
  }
  return dir;
}

export function createMicroShare({ send, readObject, directory, register }) {
  const dir = () => (typeof directory === 'function' ? directory() : directory);
  async function context(w, instanceId) {
    const d = await send(w, 'describe', { instanceId });
    if (!d.micro) throw Error('只有微应用可以按微应用格式导出');
    const drafts = await send(w, 'micro_store_list', { kind: 'draft' }),
      crystal = drafts.find((x) => x.appId === d.manifest.id);
    const confirmed = (await send(w, 'examples_list', { instanceId })).filter(
      (e) => e.status === 'user-confirmed',
    );
    const first = exportPlan({
      root: d.root,
      manifest: d.manifest,
      anchors: crystal?.anchors || [],
      confirmedExamples: confirmed,
    });
    const materialTexts = [];
    for (const m of first.examples.flatMap((e) => e.materials)) {
      const o = m.id && readObject ? await readObject(m.id).catch(() => null) : null;
      if (o?.text) materialTexts.push({ id: m.id, title: m.title, text: o.text });
    }
    const plan = exportPlan({
      root: d.root,
      manifest: d.manifest,
      anchors: crystal?.anchors || [],
      confirmedExamples: confirmed,
      materialTexts,
    });
    const hashes = new Map(materialTexts.map((m) => [m.id, sha(m.text)]));
    for (const e of plan.examples)
      e.materials = e.materials.map((m) =>
        hashes.has(m.id) ? { ...m, sha256: hashes.get(m.id) } : m,
      );
    return { d, plan };
  }
  return {
    templates: () =>
      MICRO_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })),
    async createFromTemplate(w, templateId) {
      const t = MICRO_TEMPLATES.find((x) => x.id === templateId);
      if (!t) throw Error('模板不存在');
      const id = randomUUID(),
        root = writeFiles(
          join(dir(), 'templates', id),
          templateFiles(t, `user.${t.id}-${id.slice(0, 8)}`),
        );
      return register(w, root);
    },
    exportPlan: async (w, instanceId) => (await context(w, instanceId)).plan,
    async exportPackage(w, instanceId, decisions) {
      const { d, plan } = await context(w, instanceId);
      const { bundle, manifest } = await buildExport({
        root: d.root,
        manifest: d.manifest,
        plan,
        decisions,
        readMaterial: readObject,
      });
      const path = join(dir(), 'exports', randomUUID() + '.yirang-app');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(bundle));
      const record = await send(w, 'micro_store_put', {
        kind: 'export',
        value: {
          id: randomUUID(),
          workspaceId: w,
          instanceId,
          version: d.manifest.version,
          files: manifest,
          examples: decisions?.examples || [],
          materials: decisions?.materials || [],
          path,
          createdAt: Date.now(),
        },
      });
      return { path, manifest, recordId: record.id };
    },
    async upgrade(w, instanceId) {
      const d = await send(w, 'describe', { instanceId });
      if (!d.micro) throw Error('只有微应用可以升级为轻应用');
      // Each upgrade is a new app; repeated upgrades of the same micro app must not collide on the manifest id.
      const taken = new Set(((await send(w, 'list', {})).apps || []).map((a) => a.manifest?.id));
      const base = (d.manifest.id + '.light').slice(0, 76);
      let id = base;
      for (let n = 2; taken.has(id); n++) id = base + '-' + n;
      const root = writeFiles(
        join(dir(), 'upgrades', randomUUID()),
        upgradeFiles({
          root: d.root,
          manifest: d.manifest,
          capabilities: d.micro.capabilities,
          id,
        }),
      );
      try {
        return { path: root, ...(await register(w, root)) };
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
