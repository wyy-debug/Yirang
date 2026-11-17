// Preserve the user's clauses verbatim. Do not let the reviewer rewrite the goal.
export const criteriaReviewInstructions = '另对 criteria 中每项原始要求逐项返回 id/status/reason/evidence，不得遗漏或改写标准。先根据 requirements 中先后补充关系判断适用范围：例如先说暂不修改，后明确要求开始修改，旧的暂不修改已被后续授权替代；该项 reason 必须明确指出覆盖关系，以本次实际成果引用证明最终要求，不得把旧的临时限制当作仍有效的交付条件。不冲突的原始要求仍然有效。evidence 只引用本次 files 的 objectId/revision/hash 及逐字 quote；跨文件要求列出全部必要证据。只有要求确实涉及视觉比较或外部回执时才要求相应证据；不要凭空增加验收标准。所需证据缺失必须 unknown，不能因为某一文件通过就推断整项要求通过。';
export function reviewCriteria(requirement) {
  return ['goal', 'constraints', 'deliverables', 'acceptanceCriteria'].flatMap(source => {
    const value = requirement?.[source];
    if (typeof value !== 'string') return [];
    return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      .map((description, index) => ({ id: `${source}:${index}`, source: `requirements.${source}`, description }));
  });
}
