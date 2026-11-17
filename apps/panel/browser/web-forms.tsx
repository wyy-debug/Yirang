import { useState } from 'react';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { Icon } from '../ui/icons.js';
import {
  webFieldSensitive,
  type WebCapture,
  type WebField,
  type WebFormDraft,
  type WebPage,
} from '../../../packages/contracts/web-workspace.js';
import {
  Empty,
  message,
  useDraft,
} from './web-workbench-shared.js';
import type { Dirty, Mutate, WebTaskRequest } from './web-workbench-shared.js';

export function FormField({
  field,
  value,
  change,
  disabled,
}: {
  field: WebField;
  value: string | boolean | string[] | undefined;
  change: (value: string | boolean | string[]) => void;
  disabled: boolean;
}) {
  useUiLocale();
  const label = field.label || field.name || field.key,
    locked = disabled || field.disabled;
  if (field.type === 'checkbox')
    return (
      <label className="ww-form-field ww-checkbox">
        <input
          disabled={locked}
          type="checkbox"
          checked={value === true}
          onChange={(event) => change(event.target.checked)}
        />
        {label}
        {field.required && <em>*</em>}
      </label>
    );
  return (
    <label className="ww-form-field">
      <span>
        {label}
        {field.required && <em>*</em>}
        {field.disabled && <small>{uiText('页面禁用此字段')}</small>}
      </span>
      {field.options?.length ? (
        <select
          disabled={locked}
          multiple={field.type === 'select-multiple'}
          value={
            field.type === 'select-multiple'
              ? Array.isArray(value)
                ? value
                : []
              : typeof value === 'string'
                ? value
                : ''
          }
          onChange={(event) =>
            change(
              field.type === 'select-multiple'
                ? Array.from(event.target.selectedOptions, (option) => option.value)
                : event.target.value,
            )
          }
        >
          {field.type !== 'select-multiple' && <option value="">{uiText('请选择')}</option>}
          {field.options.map((option, index) => (
            <option value={option} key={`${index}:${option}`}>
              {option}
            </option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea
          disabled={locked}
          value={typeof value === 'string' ? value : ''}
          maxLength={4000}
          placeholder={field.placeholder}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <input
          disabled={locked}
          type={
            ['email', 'url', 'date', 'datetime-local', 'number', 'time', 'tel'].includes(field.type)
              ? field.type
              : 'text'
          }
          value={typeof value === 'string' ? value : ''}
          maxLength={4000}
          placeholder={field.placeholder}
          onChange={(event) => change(event.target.value)}
        />
      )}
    </label>
  );
}

export function FormsPanel({
  workspaceId,
  page,
  capture,
  drafts,
  mutate,
  disabled,
  dirty,
  run,
  canSend,
}: {
  workspaceId: string;
  page: WebPage;
  capture?: WebCapture;
  drafts: WebFormDraft[];
  mutate: Mutate;
  disabled: boolean;
  dirty: Dirty;
  run: (request: WebTaskRequest) => Promise<boolean>;
  canSend: boolean;
}) {
  useUiLocale();
  const [draft, setDraft, storageError] = useDraft<{
      name: string;
      values: WebFormDraft['values'];
      formId?: string;
    }>(
      `ai-desktop:web-form-draft:${workspaceId}:${page.id}:${capture?.id ?? 'none'}`,
      () => ({ name: uiText('填写草稿'), values: {} }),
      dirty,
    ),
    [error, setError] = useState('');
  const fields = capture?.fields.filter((field) => !webFieldSensitive(field)) ?? [],
    saved = drafts.filter((item) => item.captureId === capture?.id),
    known = saved.find((item) => item.id === draft.formId),
    changed =
      !known ||
      known.name !== draft.name ||
      JSON.stringify(known.values) !== JSON.stringify(draft.values);
  async function save() {
    if (!capture) return null;
    setError('');
    const missing = fields.find(
      (field) =>
        field.required &&
        !field.disabled &&
        (draft.values[field.key] === undefined ||
          draft.values[field.key] === '' ||
          draft.values[field.key] === false ||
          (Array.isArray(draft.values[field.key]) &&
            !(draft.values[field.key] as string[]).length)),
    );
    if (missing) {
      setError(uiText('请填写 {0}。', { '0': missing.label || missing.key }));
      return null;
    }
    const result = await mutate(
      {
        operation: 'form',
        action: 'save',
        pageId: page.id,
        expectedRevision: page.revision,
        captureId: capture.id,
        ...(draft.formId ? { formId: draft.formId } : {}),
        name: draft.name.trim() || uiText('填写草稿'),
        values: draft.values,
      },
      uiText('表单草稿'),
    );
    if (result?.form)
      setDraft({ name: result.form.name, values: result.form.values, formId: result.form.id });
    return result;
  }
  async function send() {
    if (!capture) return;
    const result = changed ? await save() : null;
    if (changed && !result) return;
    await run({
      pageId: page.id,
      expectedRevision: result?.page.revision ?? page.revision,
      captureId: capture.id,
      formDraftId: result?.form.id ?? draft.formId,
      mode: 'fill',
      instruction: uiText(
        '按照已保存的表单草稿填写对应网页。填好后停在提交之前，将填写结果与需要我确认的内容回报到 Web 工作区。',
      ),
    });
  }
  if (!capture || !fields.length)
    return (
      <Empty icon="sheet" title={uiText('这个快照还没有可填写字段')}>
        {uiText('捕获包含表单的网页，或粘贴页面 HTML 后，普通字段会显示在这里。')}
      </Empty>
    );
  return (
    <div className="ww-forms">
      <header>
        <div>
          <h2>{uiText('在桌面准备，再交给浏览器')}</h2>
          <p>{uiText('保存字段草稿后，可以发起填写任务。提交由你决定。')}</p>
        </div>
        <select
          aria-label={uiText('选择表单草稿')}
          value={draft.formId ?? ''}
          onChange={(event) => {
            const item = saved.find((form) => form.id === event.target.value);
            setDraft(
              item
                ? { name: item.name, values: item.values, formId: item.id }
                : { name: uiText('填写草稿'), values: {} },
            );
          }}
        >
          <option value="">{uiText('新建草稿')}</option>
          {saved.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </header>
      <label className="ww-draft-name">
        {uiText('草稿名称')}
        <input
          maxLength={100}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <div className="ww-fields">
        {fields.map((field) => (
          <FormField
            key={field.key}
            field={field}
            disabled={disabled}
            value={draft.values[field.key]}
            change={(value) =>
              setDraft({ ...draft, values: { ...draft.values, [field.key]: value } })
            }
          />
        ))}
      </div>
      {(error || storageError) && <p className="ww-inline-error">{error || storageError}</p>}
      {!!capture.excludedFieldCount && (
        <p className="ww-muted">
          {uiText('此快照有')}
          {capture.excludedFieldCount} {uiText('个不适合持久保存的字段未纳入草稿。')}
        </p>
      )}
      <footer>
        <span>
          {changed ? uiText('本机编辑草稿') : uiText('已保存到工作区')} · {fields.length}{' '}
          {uiText('个字段')}
        </span>
        {draft.formId && (
          <button
            disabled={disabled}
            onClick={async () => {
              const result = await mutate(
                {
                  operation: 'form',
                  action: 'delete',
                  pageId: page.id,
                  expectedRevision: page.revision,
                  formId: draft.formId,
                },
                uiText('删除表单草稿'),
              );
              if (result) setDraft({ name: uiText('填写草稿'), values: {} });
            }}
          >
            <Icon name="trash" size={14} />
            {uiText('删除')}
          </button>
        )}
        <button disabled={disabled} onClick={() => void save()}>
          {uiText('保存草稿')}
        </button>
        <button disabled={disabled || !canSend} className="ww-primary" onClick={() => void send()}>
          <Icon name="play" size={13} />
          {uiText('交给浏览器填写')}
        </button>
      </footer>
    </div>
  );
}
