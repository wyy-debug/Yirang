import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useState } from 'react';
export function NativeMerge({
  objectId,
  baseRevision,
  format,
  edits,
  operations,
  action,
  apply,
}: {
  objectId: string;
  baseRevision: number;
  format: 'xlsx' | 'office';
  edits: any[];
  operations?: any[];
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  apply: (revision: number, edits: any[]) => void;
}) {
  useUiLocale();
  const [result, setResult] = useState<any>(null),
    [choices, setChoices] = useState<Record<string, boolean>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function compare() {
    setBusy(true);
    try {
      setResult(
        await action('native_workbench', {
          operation: 'merge',
          objectId,
          baseRevision,
          format,
          edits,
          operations,
        }),
      );
      setChoices({});
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="native-merge">
      <button disabled={busy} onClick={() => void compare()}>
        {busy ? uiText('正在比较…') : uiText('比较并合并最新版本')}
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>
            {result.accepted.length} {uiText('处修改可合并，')}
            {result.conflicts.length} {uiText('处需要选择。采用后仍需点击保存。')}
          </p>
          {result.conflicts.map((c: any) => (
            <article key={c.id}>
              <strong>{c.id}</strong>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <pre>
                  {uiText('当前版本：')}
                  {JSON.stringify(c.current, null, 2)}
                </pre>
                <pre>
                  {uiText('我的修改：')}
                  {JSON.stringify(c.edit, null, 2)}
                </pre>
              </div>
              <select
                value={choices[c.id] === undefined ? '' : choices[c.id] ? 'mine' : 'current'}
                onChange={(e) => setChoices((v) => ({ ...v, [c.id]: e.target.value === 'mine' }))}
              >
                <option disabled value="">
                  {uiText('选择此处内容')}
                </option>
                <option value="current">{uiText('保留当前版本')}</option>
                <option value="mine">{uiText('采用我的修改')}</option>
              </select>
            </article>
          ))}
          <button
            disabled={result.conflicts.some((c: any) => choices[c.id] === undefined)}
            onClick={() => {
              apply(result.revision, [
                ...result.accepted,
                ...result.conflicts.filter((c: any) => choices[c.id]).map((c: any) => c.edit),
              ]);
              setResult(null);
            }}
          >
            {uiText('采用合并草稿')}
          </button>
        </>
      )}
    </section>
  );
}
