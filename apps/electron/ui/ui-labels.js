import { subscribeUiLanguage, t } from '../../../packages/components/ui-language.js';
const bindings = new Set(),
  nodeBindings = new WeakMap();
// Bind only explicitly authored labels. Never scan messages, file contents, or input values.
export function bindUiLabel(node, attribute, source, values = {}) {
  let record = nodeBindings.get(node);
  if (!record) {
    record = new Map();
    nodeBindings.set(node, record);
    bindings.add({ node: new WeakRef(node), attributes: record });
  }
  const value = t(source, values);
  record.set(attribute, { source, values, last: value });
  if (attribute === 'textContent') node.textContent = value;
  else node.setAttribute(attribute, value);
  return value;
}
subscribeUiLanguage(() => {
  for (const entry of bindings) {
    const node = entry.node.deref(),
      attributes = entry.attributes;
    if (!node) {
      bindings.delete(entry);
      continue;
    }
    if (!node.isConnected) continue;
    for (const [attribute, binding] of attributes) {
      const current = attribute === 'textContent' ? node.textContent : node.getAttribute(attribute);
      if (current !== binding.last) {
        attributes.delete(attribute);
        continue;
      }
      const value = t(binding.source, binding.values);
      if (attribute === 'textContent') node.textContent = value;
      else node.setAttribute(attribute, value);
      binding.last = value;
    }
  }
});
