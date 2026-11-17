import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useTransientNotice } from '../ui/use-transient-notice.js';
import React, { useEffect, useState } from 'react';
import { RecoveryCenter } from './recovery-center.js';
function formatSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function Storage({
  action,
}: {
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
}) {
  useUiLocale();
  const [info, setInfo] = useState<any>(null),
    [plan, setPlan] = useState<any>(null),
    [keep, setKeep] = useState(50),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useTransientNotice(),
    [advanced, setAdvanced] = useState(false);
  const validKeep = Number.isInteger(keep) && keep >= 5 && keep <= 10000;
  async function call(operation: string) {
    if (operation !== 'inspect' && !validKeep) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await action('native_workbench', {
        operation: 'storage',
        command: { operation, keep, ...(operation === 'apply' ? { token: plan.token } : {}) },
      });
      if (operation === 'inspect') setInfo(r);
      if (operation === 'preview') setPlan(r);
      if (operation === 'apply') {
        setPlan(null);
        setNotice(uiText('已清理 {0} 个历史版本。', { '0': r.removedRevisions }));
        if (r.deferredAssets)
          setError(uiText('有 {0} 个文件未移入回收目录，请重新预览后重试。', { '0': r.deferredAssets }));
        setInfo(
          await action('native_workbench', {
            operation: 'storage',
            command: { operation: 'inspect' },
          }),
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void call('inspect');
  }, []);
  return (
    <section className="storage-settings" aria-label={uiText('存储管理')}>
      <div className="storage-setting-row">
        <div>
          <h3>{uiText('已用空间')}</h3>
          <p>{uiText('桌面文件和历史版本在本机占用的空间。')}</p>
        </div>
        <strong className="storage-size">
          {info ? formatSize(info.bytes) : uiText('正在读取…')}
        </strong>
      </div>
      <div className="storage-setting-row">
        <div>
          <h3>{uiText('清理旧版本')}</h3>
          <p>
            {info
              ? uiText('当前工作区共 {0} 个历史版本。', { '0': info.revisions })
              : uiText('管理文件的历史版本。')}
          </p>
        </div>
        <button disabled={busy || !info || !validKeep} onClick={() => void call('preview')}>
          {uiText('查看可清理内容')}
        </button>
      </div>
      <label className="storage-keep">
        <span>{uiText('每个文件至少保留')}</span>
        <input
          aria-label={uiText('每个文件保留的历史版本数')}
          type="number"
          min="5"
          max="10000"
          step="1"
          value={Number.isNaN(keep) ? '' : keep}
          disabled={busy}
          onChange={(e) => {
            setKeep(e.target.value === '' ? NaN : Number(e.target.value));
            setPlan(null);
          }}
        />
        <span>{uiText('个最近版本')}</span>
      </label>
      {!validKeep && <p role="alert">{uiText('请输入 5 到 10000 之间的整数。')}</p>}
      <p className="storage-hint">
        {uiText('初始版本、当前版本及正在使用的版本会保留。先预览，再决定是否清理。')}
      </p>
      {plan && (
        <div className="storage-cleanup-plan">
          <h4>
            {plan.remove.length
              ? uiText('可清理 {0} 个旧版本', { '0': plan.remove.length })
              : uiText('没有需要清理的旧版本')}
          </h4>
          {plan.remove.length > 0 && (
            <p>
              {uiText('涉及 {0} 个文件。', {
                '0': new Set(plan.remove.map((r: any) => r.objectId)).size,
              })}
            </p>
          )}
          {plan.orphanCount > 0 && (
            <p>
              {uiText('{0} 个不再使用的文件会移到本机的回收文件夹。', { '0': plan.orphanCount })}
            </p>
          )}
          {(plan.remove.length > 0 || plan.orphanCount > 0) && (
            <>
              <p>{uiText('清理后无法撤销，建议先在「工作区与备份」中创建备份。')}</p>
              <button disabled={busy} onClick={() => void call('apply')}>
                {uiText('确认清理')}
              </button>
            </>
          )}
          <button disabled={busy} onClick={() => setPlan(null)}>
            {uiText('取消')}
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <details
        className="storage-advanced"
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary>
          {uiText('高级维护')}
          <span>{uiText('恢复副本与故障排查')}</span>
        </summary>
        {advanced && <RecoveryCenter action={action} />}
      </details>
    </section>
  );
}
