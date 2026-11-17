// A successful CLI turn is not proof that requested files were delivered.
// Infer only explicit output formats; arbitrary semantic quality is not guessed.
const formats = {
  ppt: ['ppt', 'pptx'], pptx: ['ppt', 'pptx'], svg: ['svg'],
  pdf: ['pdf'], docx: ['docx'], xlsx: ['xlsx'], csv: ['csv'],
  png: ['png'], jpg: ['jpg', 'jpeg'], jpeg: ['jpg', 'jpeg'],
  html: ['html', 'htm'], md: ['md'], txt: ['txt'],
};
function outputText(requirement = {}) {
  const explicit = String(requirement.deliverables || '');
  const clauses = String(requirement.goal || '').split(/[，。；;\n]/).flatMap(clause => {
    if (/(?:不要|不用|无需|不需要).*(?:生成|制作|创建|输出|导出)/.test(clause)) return [];
    const action = /(?:生成|制作|创建|输出|导出|保存|写入|修复|修改|做一个|做一份|做个|提供|交付|create|generate|export|write|repair|save)/i.exec(clause);
    // Formats before the action are usually sources (e.g. 根据 SVG 生成 PPT).
    return action ? [clause.slice(action.index)] : [];
  });
  return explicit + '\n' + clauses.join('\n');
}
// A deictic edit of selected files needs writeback evidence, not a successful text reply.
function editedSources(requirement = {}) {
  const goal = String(requirement.goal || '');
  if (/只(?:回答|解释|分析)|不要(?:修改|执行)/.test(goal)) return [];
  if (!/(?:修复|修好|修改|改好)\s*(?:这个|这份|它|他|选中)|(?:这个|这份|选中).{0,12}(?:修复|修好|修改|改好)/.test(goal)) return [];
  return (requirement.sources || []).filter(source => source.objectId && Number.isFinite(source.revision));
}
export function expectedDeliveryFormats(requirement = {}) {
  return [...new Set((outputText(requirement) + '\n' + editedSources(requirement).map(source => source.title || '').join('\n')).match(/\b(?:pptx?|svg|pdf|docx|xlsx|csv|png|jpe?g|html|md|txt)\b/gi) || [])]
    .map(format => format.toLowerCase()).filter((format, index, all) =>
      all.findIndex(other => formats[other].join() === formats[format].join()) === index);
}
export function reviseDeliveryFormats(previous, amendment, replacement) {
  if (replacement) return expectedDeliveryFormats(replacement);
  const required = new Set(previous.delivery?.formats || expectedDeliveryFormats(previous));
  for (const format of expectedDeliveryFormats({goal: amendment})) required.add(format);
  for (const clause of String(amendment || '').split(/[，。；;\n]/)) {
    if (!/(?:不要|不用|无需|不需要|取消)/.test(clause)) continue;
    for (const token of clause.match(/\b(?:pptx?|svg|pdf|docx|xlsx|csv|png|jpe?g|html|md|txt)\b/gi) || []) {
      for (const format of required) if (formats[format].join() === formats[token.toLowerCase()].join()) required.delete(format);
    }
  }
  return [...required];
}
export function missingDeliveries(management, artifacts) {
  const requirement = management?.requirements?.at(-1) || {};
  const current = (artifacts || []).filter(file => file.validity === 'current');
  const unique = [...new Map(current.map((file, index) => [file.objectId || index, file])).values()];
  const names = unique.map(file =>
    String(file.fileName || file.title || '').toLowerCase().split('.').at(-1));
  const requested = outputText(requirement).toLowerCase();
  const missingEdits = editedSources(requirement).filter(source => !unique.some(file =>
    file.objectId === source.objectId && file.revision > source.revision)).map(source => source.title || source.objectId);
  const missingFormats = (requirement.delivery?.formats || expectedDeliveryFormats(requirement)).flatMap(format => {
    const extensions = formats[format];
    const filenames = [...new Set(requested.match(/[a-z0-9_-]+\.(?:pptx?|svg|pdf|docx|xlsx|csv|png|jpe?g|html|md|txt)\b/g) || [])]
      .filter(name => extensions.includes(name.split('.').at(-1)));
    const quantities = [...requested.matchAll(new RegExp(`([1-9][0-9]*|两|二|三|四|五)\\s*(?:个|份|张)\\s*(?:${extensions.join('|')})\\b`, 'g'))]
      .map(match => Number(match[1]) || ({两:2,二:2,三:3,四:4,五:5}[match[1]]));
    const expected = Math.max(1, filenames.length, ...quantities);
    const found = names.filter(name => extensions.includes(name)).length;
    const deliveredNames = unique.map(file => String(file.fileName || file.title || '').toLowerCase().split(/[\\/]/).at(-1));
    const absentNames = filenames.filter(name => !deliveredNames.includes(name));
    if (absentNames.length) return absentNames;
    return found < expected ? [expected === 1 ? format : `${format}（缺 ${expected-found} 份）`] : [];
  });
  return [...new Set([...missingEdits, ...missingFormats])];
}
