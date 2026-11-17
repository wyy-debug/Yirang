import { readModelCatalog, resolveModelSelection } from './codex-runtime.mjs';

// Capture before queueing. A later preference change must not alter accepted work.
export async function captureModelSettings(request, preferences) {
  const main = await resolveModelSelection(request, preferences);
  const child = preferences.childModel
    ? await resolveModelSelection(request, {
        model: preferences.childModel,
        effort: preferences.childEffort,
      })
    : main;
  return { ...main, childModel: child.model, childEffort: child.effort };
}

export async function validateModelSettings(request, current, patch) {
  const keys = ['model', 'effort', 'childModel', 'childEffort'];
  if (
    keys.some(
      (key) =>
        patch[key] !== undefined &&
        patch[key] !== null &&
        (typeof patch[key] !== 'string' || patch[key].length > 160),
    )
  )
    throw Error('模型设置无效');
  const next = Object.fromEntries(
    keys.map((key) => [key, Object.hasOwn(patch, key) ? patch[key] || null : current[key] || null]),
  );
  const catalog = await readModelCatalog(request);
  for (const [modelKey, effortKey] of [
    ['model', 'effort'],
    ['childModel', 'childEffort'],
  ]) {
    const model = next[modelKey] ? catalog.find((item) => item.model === next[modelKey]) : null;
    if (next[modelKey] && !model) throw Error('请从当前模型列表中选择');
    if (
      next[effortKey] &&
      !model?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === next[effortKey])
    )
      throw Error('模型不支持这个思考强度');
  }
  return next;
}
