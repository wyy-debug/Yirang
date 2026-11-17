import { t as uiText } from '../../../packages/components/ui-language.js';
import { bindUiLabel } from '../ui/ui-labels.js';
import { createQuestionCard } from './question-card.js';

export function createApprovalCard(payload, { respond, openLink, onSettled, onError }) {
  if (payload.method === 'item/tool/requestUserInput')
    return createQuestionCard(payload, { respond, onSettled, onError });
  const box = document.createElement('div');
  box.className = 'approval';
  const p = document.createElement('p'),
    params = payload.params || {},
    method = payload.method;
  p.textContent =
    method === 'item/permissions/requestApproval'
        ? uiText('Codex 请求额外权限：{0}', {
            0: params.reason || JSON.stringify(params.permissions),
          })
        : method === 'mcpServer/elicitation/request'
          ? uiText('{0} 请求信息：{1}', {
              0: params.serverName || uiText('工具'),
              1: params.message || '',
            })
          : uiText('Codex 请求批准：{0}', { 0: params.command || params.reason || method });
  if (payload.workTitle) p.textContent = payload.workTitle + ' · ' + p.textContent;
  box.append(p);
  const fields = [];
  if (method === 'mcpServer/elicitation/request' && params.mode !== 'url')
    for (const [name, schema] of Object.entries(params.requestedSchema?.properties || {})) {
      const label = document.createElement('label');
      label.textContent = name;
      label.style.display = 'block';
      label.style.marginBottom = '10px';
      const field = document.createElement('input');
      field.type =
        schema?.type === 'boolean' ? 'checkbox' : schema?.type === 'number' ? 'number' : 'text';
      field.style.cssText =
        'display:block;width:100%;margin-top:5px;padding:7px;border:1px solid #d7dce5;border-radius:8px';
      label.append(field);
      box.append(label);
      fields.push([name, field]);
    }
  if (method === 'mcpServer/elicitation/request' && params.mode === 'url' && params.url) {
    const link = document.createElement('button');
    bindUiLabel(link, 'textContent', '打开授权页面');
    link.onclick = () => void openLink(params.url);
    box.append(link);
  }
  const actions = document.createElement('div');
  for (const [label, decision] of [
    [uiText('允许一次'), 'accept'],
    [uiText('拒绝'), 'decline'],
  ]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = async () => {
      try {
        let response = { decision };
        if (method === 'mcpServer/elicitation/request' && decision === 'accept')
          response = {
            decision,
            content: Object.fromEntries(
              fields.map(([id, field]) => [
                id,
                field.type === 'checkbox'
                  ? field.checked
                  : field.type === 'number'
                    ? Number(field.value)
                    : field.value,
              ]),
            ),
          };
        await respond(payload.id, response);
        box.remove();
        onSettled();
      } catch (error) {
        onError(error);
      }
    };
    actions.append(button);
  }
  box.append(actions);
  return box;
}
