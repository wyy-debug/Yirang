import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { DesktopObject } from '../../../../packages/contracts/index.js';
import './native-history.css';
type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export function NativeFileHistory({
  object,
  from,
  to,
  action,
  disabled,
  applied,
}: {
  object: DesktopObject;
  from: number;
  to: number;
  action: Action;
  disabled: boolean;
  applied: () => Promise<void>;
}) {
  useUiLocale();
  const [diff, setDiff] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setDiff(null);
    setSelected([]);
    setError('');
    setBusy(true);
    void action('native_workbench', {
      operation: 'native_diff',
      objectId: object.id,
      fromRevision: from,
      toRevision: to,
    })
      .then((value) => {
        if (live) setDiff(value);
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [object.id, object.revision, from, to]);
  const pending = useRef<{ signature: string; request: Record<string, unknown> } | null>(null);
  async function undo() {
    if (busy || !selected.length) return;
    setBusy(true);
    try {
      const signature = JSON.stringify([
        object.id,
        object.revision,
        from,
        to,
        [...selected].sort(),
      ]);
      if (pending.current?.signature !== signature)
        pending.current = {
          signature,
          request: {
            operation: 'native_undo',
            objectId: object.id,
            fromRevision: from,
            toRevision: to,
            expectedRevision: object.revision,
            requestId: crypto.randomUUID(),
            keys: [...selected],
          },
        };
      await action('native_workbench', pending.current.request);
      await applied();
      pending.current = null;
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="native-history">
      <header>
        <strong>
          {uiText('文件内容差异 · v')}
          {from} → v{to}
        </strong>
        {to === from + 1 && (
          <button disabled={busy || disabled || !selected.length} onClick={() => void undo()}>
            {uiText('撤销选中的')}
            {selected.length} {uiText('项修改')}
          </button>
        )}
      </header>
      <p>
        {uiText(
          '只撤销所选位置；已有后续修改或结构变化时停止。格式和复杂部件可查看记录，必要时恢复整份版本。',
        )}
      </p>
      {busy && <p>{uiText('正在读取文件版本…')}</p>}
      {error && <p role="alert">{error}</p>}
      {diff?.truncated && (
        <p>
          {uiText('显示前 500 项，共')}
          {diff.total} {uiText('项。请导出版本查看完整变化。')}
        </p>
      )}
      {diff?.entries.map((entry: any) => (
        <details key={entry.key} open={diff.entries.length < 10}>
          <summary>
            <input
              aria-label={uiText('选择撤销 {0}', { '0': entry.label })}
              type="checkbox"
              disabled={disabled || busy || !entry.undoable || to !== from + 1}
              checked={selected.includes(entry.key)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                setSelected((values) =>
                  e.target.checked ? [...values, entry.key] : values.filter((v) => v !== entry.key),
                )
              }
            />
            {entry.label}
            {!entry.undoable && <small> {uiText('· 仅比较')}</small>}
          </summary>
          <div className="native-history-pair">
            <pre>{entry.before || uiText('（空）')}</pre>
            <pre>{entry.after || uiText('（空）')}</pre>
          </div>
        </details>
      ))}
      {diff && !diff.entries.length && <p>{uiText('可比较内容未发生变化。')}</p>}
    </section>
  );
}
