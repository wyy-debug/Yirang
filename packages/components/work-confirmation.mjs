// Only an explicit request for a delivery review creates a review step.
// Permission checks and publishing approvals are separate runtime operations.
export function confirmationPolicy(text, previous = { required: false }, sourceRequestId) {
  let policy = { ...previous };
  for (const clause of String(text || '').split(/[，。；;\n]/)) {
    if (/(?:不需要|不必|不用|无需|取消)(?:再|我|人工|用户|进行|等待|做)*\s*(?:确认|验收|审核)|无需我确认/i.test(clause)) {
      policy = { required: false, sourceRequestId, reason: clause.trim() };
    } else if (/(?:等我|由我|让我|需要我|人工|用户)(?:先)?(?:确认|验收|审核)|(?:确认|验收|审核)(?:通过)?后(?:再)?(?:发布|发送|提交|执行)|先预览|先给我看|wait for (?:my|user) (?:approval|review)/i.test(clause)) {
      policy = { required: true, sourceRequestId, reason: clause.trim() };
    }
  }
  return policy;
}

export function requiresDeliveryConfirmation(management) {
  let policy = { required: false };
  for (const [index, requirement] of (management?.requirements || []).entries()) {
    policy = requirement.confirmation || confirmationPolicy(
      index && requirement.reason ? requirement.reason : [requirement.goal, requirement.constraints].filter(Boolean).join('\n'),
      policy, requirement.sourceRequestId);
  }
  return policy.required;
}
