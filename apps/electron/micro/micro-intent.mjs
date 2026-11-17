// Bot -> micro app: only a complete explicit invocation ("运行/跑一下 <名称>") selects a micro app.
// Anything else returns {hit:'none'} so existing Bot routing stays unchanged.
const LIMIT = 12;
const RUN =
  /^(?:请|麻烦)?(?:你)?(?:帮我|给我|帮忙)?(?:运行|执行|调用|启动|跑一下|跑一跑|跑个|跑)(?:一下|一次|下)?(.{1,40}?)(?:吧|呗)?[。！!]?$/u;
const SUFFIX = /(?:微应用|小工具|应用|工具|一下|一次)$/u;
const strip = (s) => {
  let v = s;
  for (let i = 0; i < 3 && SUFFIX.test(v); i++) v = v.replace(SUFFIX, '');
  return v;
};
// Names may carry decorations like "（零代码示例）"; the user's text must not: brackets or leftover words there are extra requirements.
const nameKey = (s) =>
  strip(
    String(s || '')
      .toLowerCase()
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\s「」『』“”"'《》·]/g, ''),
  );
const targetKey = (s) =>
  strip(
    String(s || '')
      .toLowerCase()
      .replace(/^\s+|\s+$/g, '')
      .replace(/^[「『“"'《]|[」』”"'》]$/g, '')
      .replace(/^(?:这个|那个)/, ''),
  );
export function microRunTarget(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 50 || /\n/.test(s)) return null;
  const m = s.match(RUN);
  if (!m) return null;
  const target = targetKey(m[1]);
  return target.length >= 2 ? target : null;
}
// apps: [{instanceId,name,aliases?,capabilities:[{name,title}]}]. All apps are searched; only the displayed list is capped.
export function matchMicroApp(text, apps = []) {
  const target = microRunTarget(text);
  if (!target) return { hit: 'none' };
  const hits = apps.filter((a) =>
    [a.name, ...(a.aliases || [])].some((k) => {
      const key = nameKey(k);
      return key.length >= 2 && key === target;
    }),
  );
  const options = hits.flatMap((a) =>
    (a.capabilities || []).map((c) => ({
      instanceId: a.instanceId,
      name: a.name,
      capability: c.name,
      title: a.capabilities.length > 1 ? `${a.name} · ${c.title || c.name}` : a.name,
    })),
  );
  if (!options.length) return { hit: 'none' };
  if (options.length === 1) return { hit: 'run', target: options[0] };
  return {
    hit: 'ambiguous',
    candidates: options.slice(0, LIMIT),
    truncated: options.length > LIMIT,
  };
}
// Builds input from schema defaults only; the Bot never invents values for required fields.
export function prepareMicroRun(capability, materialCount = 0) {
  const schema = capability?.inputSchema || {},
    props = schema.properties || {},
    required = schema.required || [],
    input = {},
    missing = [];
  for (const [key, p] of Object.entries(props))
    if (p && Object.hasOwn(p, 'default')) input[key] = structuredClone(p.default);
  for (const key of required)
    if (!Object.hasOwn(input, key)) missing.push(props[key]?.title || key);
  const min = capability?.materials?.min ?? 0,
    max = capability?.materials?.max ?? 10;
  const materials =
    materialCount < min
      ? `需要至少 ${min} 份材料，请先在桌面上选中材料`
      : materialCount > max
        ? `最多 ${max} 份材料`
        : null;
  return { input, missing, materials, ready: !missing.length && !materials };
}
