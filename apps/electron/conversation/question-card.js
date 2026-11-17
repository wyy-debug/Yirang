import { t } from '../../../packages/components/ui-language.js';

// Keep user questions separate from permission grants: choosing an answer is
// never an approval, and a failed send must preserve the user's draft.
export function createQuestionCard(payload, { respond, onSettled, onError, approval = true }) {
  const form = document.createElement('form');
  form.className = `${approval ? 'approval ' : ''}codex-question-card`;
  if (payload.workTitle) {
    const scope = document.createElement('p');
    scope.className = 'question-work';
    scope.textContent = payload.workTitle;
    form.append(scope);
  }
  const fields = (payload.params?.questions || []).map((question, index) => {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = question.question;
    group.append(legend);
    const choices = [];
    for (const [optionIndex, option] of (question.options || []).entries()) {
      const label = document.createElement('label');
      label.className = 'question-choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `question-${payload.id}-${index}`;
      radio.value = option.value ?? option.label;
      radio.checked = !question.requireChoice && optionIndex === 0;
      choices.push(radio);
      const text = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = option.label;
      text.append(title);
      if (option.description) {
        const description = document.createElement('span');
        description.className = 'question-description';
        description.textContent = option.description;
        text.append(description);
      }
      label.append(radio, text);
      group.append(label);
    }
    const input = document.createElement(question.isSecret ? 'input' : 'textarea');
    if (question.isSecret) input.type = 'password';
    else input.rows = 2;
    input.setAttribute('aria-label', choices.length ? t('补充说明') : question.question);
    input.placeholder = choices.length ? t('补充说明') : t('输入你的回答');
    if (choices.length && question.allowSupplement !== false) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = t('补充说明');
      details.append(summary, input);
      group.append(details);
    } else if (!choices.length) group.append(input);
    form.append(group);
    return { id: question.id, choices, input };
  });
  const errorLine = document.createElement('p');
  errorLine.className = 'question-error';
  errorLine.setAttribute('role', 'alert');
  errorLine.hidden = true;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'question-submit';
  submit.textContent = t('确认并继续') + ' →';
  let pending = false;
  const update = () => {
    submit.disabled = pending || !fields.length || fields.some(field =>
      !field.choices.some(choice => choice.checked) && !field.input.value.trim());
  };
  form.addEventListener('input', update);
  form.append(errorLine, submit);
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled || pending) return;
    const answers = Object.fromEntries(fields.map(field => [field.id, [
      field.choices.find(choice => choice.checked)?.value,
      field.input.value.trim(),
    ].filter(Boolean)]));
    pending = true;
    update();
    errorLine.hidden = true;
    try {
      await respond(payload.id, { answers });
      form.remove();
      onSettled?.();
    } catch (error) {
      errorLine.textContent = error.message;
      errorLine.hidden = false;
      onError?.(error);
    } finally {
      pending = false;
      update();
    }
  };
  update();
  return form;
}
