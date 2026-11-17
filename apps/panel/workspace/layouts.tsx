import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useTransientNotice } from '../ui/use-transient-notice.js';
import React, { useEffect, useState } from 'react';
import type { LayoutLibrary, Workspace } from '../../../packages/contracts/index.js';
type Props = {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  flush: () => Promise<void>;
  current: () => Workspace;
  updated: () => Promise<void>;
  restore: (workspace: Workspace) => Promise<void>;
  close: () => void;
};
export function Layouts({ workspace, action, flush, current, updated, restore, close }: Props) {
  useUiLocale();
  const [library, setLibrary] = useState<LayoutLibrary | null>(null),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useTransientNotice();
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void action('layouts', { operation: 'list' })
      .then((value) => {
        if (active) setLibrary(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [workspace.id]);
  async function operate(operation: 'save' | 'restore' | 'delete', id?: string) {
    if (!library || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await flush();
      await updated();
      const w = current();
      const result = await action('layouts', {
        operation,
        requestId: crypto.randomUUID(),
        revision: library.revision,
        expectedView: w.viewRevision,
        expectedGroups: w.groups.revision,
        ...(id ? { id } : {}),
        ...(operation === 'save' ? { name } : {}),
      });
      if (operation === 'restore') {
        await restore(result.workspace);
        setLibrary(result.library);
        setNotice(
          uiText('已恢复 {0} 份材料的位置{1}。新增材料保留。', {
            '0': result.restored,
            '1': result.skipped
              ? uiText('，跳过 {0} 份已归档或不存在的材料', { '0': result.skipped })
              : '',
          }),
        );
      } else {
        setLibrary(result);
        setNotice(
          operation === 'save' ? uiText('布局已保存。') : uiText('布局记录已删除，桌面内容保留。'),
        );
        if (operation === 'save') setName('');
      }
      setConfirm(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="layout-library" role="dialog" aria-label={uiText('保存与恢复桌面布局')}>
      <header>
        <div>
          <strong>{uiText('桌面布局')}</strong>
        </div>
        <button disabled={busy} onClick={close}>
          {uiText('返回桌面')}
        </button>
      </header>
      <p>
        {uiText(
          '移动与缩放会自动保存。给当前布局起个名称，之后可以恢复；文件内容和文件夹位置保持当前版本。',
        )}
      </p>
      {error && (
        <div className="navigator-error" role="alert">
          {error}
          <button
            disabled={busy}
            onClick={() =>
              void action('layouts', { operation: 'list' })
                .then(setLibrary)
                .catch((e) => setError(String(e)))
            }
          >
            {uiText('刷新记录')}
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="import-notice">
          {notice}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void operate('save');
        }}
      >
        <input
          aria-label={uiText('布局名称')}
          placeholder={uiText('例如：数据分析、资料整理')}
          maxLength={80}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="primary"
          disabled={busy || !library || !name.trim() || library.items.length >= 20}
        >
          {uiText('保存当前布局')}
        </button>
      </form>
      <div className="layout-list">
        {library?.items
          .slice()
          .reverse()
          .map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>
                  {item.objects.length} {uiText('份材料 ·')}
                  {item.groups.length} {uiText('个区域 ·')}
                  {new Date(item.createdAt).toLocaleString(interfaceLocale())}
                </small>
              </div>
              <button disabled={busy} onClick={() => void operate('restore', item.id)}>
                {uiText('恢复布局')}
              </button>
              {confirm === item.id ? (
                <>
                  <button disabled={busy} onClick={() => void operate('delete', item.id)}>
                    {uiText('删除这条记录')}
                  </button>
                  <button disabled={busy} onClick={() => setConfirm(null)}>
                    {uiText('取消')}
                  </button>
                </>
              ) : (
                <button disabled={busy} onClick={() => setConfirm(item.id)}>
                  {uiText('删除')}
                </button>
              )}
            </article>
          ))}
        {library && !library.items.length && (
          <p className="editor-empty">
            {uiText('还没有命名布局。上次自动保存的位置仍会在重新打开桌面时恢复。')}
          </p>
        )}
      </div>
      <footer>
        {library?.items.length ?? 0} {uiText('/ 20 套布局 · 只恢复桌面排布，不回退文件内容。')}
      </footer>
    </section>
  );
}
