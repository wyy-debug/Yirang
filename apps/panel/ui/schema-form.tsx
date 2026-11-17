import React from 'react';
type Props = {
  schema: any;
  value: any;
  onChange: (v: any) => void;
  label?: string;
  required?: boolean;
  depth?: number;
};
export function SchemaForm({
  schema = {},
  value,
  onChange,
  label = '配置',
  required = false,
  depth = 0,
}: Props) {
  const type = Array.isArray(schema.type)
    ? schema.type.find((v: string) => v !== 'null')
    : schema.type;
  const name = label + (required ? ' *' : '');
  if (schema.enum)
    return (
      <label className="app-schema-field">
        {name}
        <select
          value={value === undefined ? '' : JSON.stringify(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : JSON.parse(e.target.value))}
        >
          <option value="">请选择</option>
          {schema.enum.map((v: any) => (
            <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      </label>
    );
  if ((type === 'object' || schema.properties) && schema.properties) {
    return (
      <fieldset className={`app-schema ${depth ? 'app-schema-nested' : 'app-schema-root'}`}>
        <legend>{name}</legend>
        {schema.description && <p className="app-schema-description">{schema.description}</p>}
        {Object.entries(schema.properties).map(([key, s]: [string, any]) => (
          <SchemaForm
            key={key}
            schema={s}
            value={value?.[key] === undefined ? s.default : value[key]}
            label={s.title || key}
            depth={depth + 1}
            required={schema.required?.includes(key)}
            onChange={(v) => {
              const next = { ...(value || {}) };
              if (v === undefined) delete next[key];
              else next[key] = v;
              onChange(next);
            }}
          />
        ))}
      </fieldset>
    );
  }
  if (type === 'array' && schema.items && !Array.isArray(schema.items)) {
    const items = Array.isArray(value) ? value : [];
    return (
      <fieldset className="app-schema-collection">
        <legend>
          {name}
          <span>{items.length} 项</span>
        </legend>
        {schema.description && <small>{schema.description}</small>}
        {!items.length && <p className="app-schema-empty">尚未添加</p>}
        {items.map((item: any, index: number) => (
          <div className="app-schema-item" key={index}>
            <div className="app-schema-item-body">
              <SchemaForm
                schema={schema.items}
                value={item}
                depth={depth + 1}
                label={`${label} ${index + 1}`}
                onChange={(next) =>
                  onChange(items.map((v: any, i: number) => (i === index ? next : v)))
                }
              />
            </div>
            <button
              type="button"
              className="app-schema-remove"
              aria-label={`删除${label}第 ${index + 1} 项`}
              disabled={items.length <= (schema.minItems ?? 0)}
              onClick={() => onChange(items.filter((_: any, i: number) => i !== index))}
            >
              移除
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={items.length >= (schema.maxItems ?? 1000)}
          onClick={() => {
            const t = schema.items.type;
            onChange([
              ...items,
              schema.items.default ??
                (t === 'object'
                  ? {}
                  : t === 'array'
                    ? []
                    : t === 'boolean'
                      ? false
                      : t === 'number' || t === 'integer'
                        ? 0
                        : ''),
            ]);
          }}
        >
          ＋ 添加一项
        </button>
      </fieldset>
    );
  }
  if (type === 'boolean')
    return (
      <label className="app-schema-field app-schema-toggle">
        <span>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />{' '}
          {name}
        </span>
        {schema.description && <small>{schema.description}</small>}
      </label>
    );
  if (['string', 'number', 'integer'].includes(type))
    return (
      <label className="app-schema-field">
        {name}
        <input
          required={required}
          type={
            type === 'string'
              ? schema.format === 'password' || schema.writeOnly
                ? 'password'
                : 'text'
              : 'number'
          }
          autoComplete={
            schema.format === 'password' || schema.writeOnly ? 'new-password' : undefined
          }
          min={schema.minimum}
          max={schema.maximum}
          step={type === 'integer' ? 1 : 'any'}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          placeholder={schema.examples?.[0] !== undefined ? String(schema.examples[0]) : undefined}
          value={value ?? ''}
          onChange={(e) =>
            onChange(
              e.target.value === ''
                ? undefined
                : type === 'string'
                  ? e.target.value
                  : Number(e.target.value),
            )
          }
        />
        {schema.description && <small>{schema.description}</small>}
      </label>
    );
  return (
    <JsonField
      label={name}
      value={value}
      type={type}
      description={schema.description}
      onChange={onChange}
    />
  );
}
function JsonField({ label, value, type, description, onChange }: any) {
  const format = (v: any) => (v == null ? '' : JSON.stringify(v, null, 2));
  const [text, setText] = React.useState(format(value)),
    [error, setError] = React.useState('');
  const focused = React.useRef(false);
  React.useEffect(() => {
    if (!focused.current) {
      setText(format(value));
      setError('');
    }
  }, [value]);
  return (
    <label className="app-schema-field app-schema-json">
      {label}
      <small>
        {description ||
          (type === 'object'
            ? '键值配置，使用 JSON 对象填写'
            : type === 'array'
              ? '使用 JSON 数组填写'
              : '高级结构配置（JSON）')}
      </small>
      <textarea
        rows={3}
        placeholder={type === 'array' ? '[]' : '{}'}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          if (!error) setText(format(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            onChange(undefined);
            setError('');
            return;
          }
          try {
            const next = JSON.parse(e.target.value);
            if (type === 'array' && !Array.isArray(next)) throw Error('需要数组格式，例如 []');
            if (type === 'object' && (!next || Array.isArray(next) || typeof next !== 'object'))
              throw Error('需要对象格式，例如 {}');
            onChange(next);
            setError('');
          } catch (e) {
            setError(e instanceof SyntaxError ? 'JSON 格式尚未完整，修改完成后再保存' : String(e));
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
    </label>
  );
}
