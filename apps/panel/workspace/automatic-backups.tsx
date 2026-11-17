import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';
import { isIntegratedDesktop } from './workspace-mode.js';
type Action = (name: string, payload?: Record<string, unknown>) => Promise<any>;
export function useAutomaticBackups(workspaceId: string | undefined, action: Action) {
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => {
    if (!workspaceId) return;
    let last = Date.now(),
      busy = false,
      alive = true,
      hostBusy = false;
    const touch = () => {
        last = Date.now();
      },
      host = (e: MessageEvent) => {
        if (e.source === window.parent && e.data?.type === 'ai-desktop:host-busy')
          hostBusy = e.data.busy;
      };
    window.addEventListener('keydown', touch);
    window.addEventListener('pointerdown', touch);
    window.addEventListener('message', host);
    if (isIntegratedDesktop)
      window.parent.postMessage({ type: 'ai-desktop:host-state-request' }, '*');
    const timer = setInterval(() => {
      if (busy || hostBusy || Date.now() - last < 60000) return;
      const active = document.activeElement;
      if (active?.matches('input,textarea,[contenteditable="true"]')) return;
      busy = true;
      void latest
        .current('backup_auto')
        .then((result) => {
          if (alive && result.issues?.length)
            window.dispatchEvent(
              new CustomEvent('ai-desktop:backup-notice', {
                detail: uiText('自动备份已保存，部分过期备份未能清理。'),
              }),
            );
        })
        .catch((error) => {
          if (alive)
            window.dispatchEvent(
              new CustomEvent('ai-desktop:backup-notice', {
                detail: uiText('自动备份未完成：{0}', { '0': String(error) }),
              }),
            );
        })
        .finally(() => {
          busy = false;
        });
    }, 60000);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('keydown', touch);
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('message', host);
    };
  }, [workspaceId]);
}
export function BackupPolicy({
  action,
  refresh,
  selectedId,
}: {
  action: Action;
  refresh: () => Promise<void>;
  selectedId?: string;
}) {
  useUiLocale();
  const [policy, setPolicy] = useState<any>(null),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void action('backup_policy')
      .then(setPolicy)
      .catch((error) => setNotice(String(error)));
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  };
  async function transfer(command: 'import' | 'export') {
    const path = await browserCommand<string | null>('backup-directory', { command });
    if (!path) return;
    const result = await action('backup_transfer', {
      command,
      path,
      ...(command === 'export' ? { id: selectedId } : {}),
    });
    await refresh();
    setNotice(
      command === 'import'
        ? uiText('已导入备份，请在列表预览后恢复为新工作区。')
        : uiText('迁移备份已导出：{0}', { '0': result.path }),
    );
  }
  return (
    <section className="backup-policy">
      <h3>{uiText('自动备份与换机迁移')}</h3>
      {policy && (
        <>
          <label>
            <input
              type="checkbox"
              checked={policy.enabled}
              disabled={busy}
              onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })}
            />
            {uiText('空闲时自动备份')}
          </label>
          <label>
            {uiText('间隔（分钟）')}
            <input
              type="number"
              min={15}
              max={1440}
              value={policy.minutes}
              onChange={(e) => setPolicy({ ...policy, minutes: Number(e.target.value) })}
            />
          </label>
          <label>
            {uiText('保留自动备份数量')}
            <input
              type="number"
              min={3}
              max={90}
              value={policy.keep}
              onChange={(e) => setPolicy({ ...policy, keep: Number(e.target.value) })}
            />
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setPolicy(
                  await action('backup_policy', {
                    command: 'save',
                    enabled: policy.enabled,
                    minutes: policy.minutes,
                    keep: policy.keep,
                  }),
                );
                setNotice(uiText('策略已保存；手动备份不会自动清理。'));
              })
            }
          >
            {uiText('保存策略')}
          </button>
          <small>{uiText('备份已保存内容和已同步草稿，编辑时延后执行。')}</small>
        </>
      )}
      {isIntegratedDesktop && (
        <>
          <button disabled={busy || !selectedId} onClick={() => void run(() => transfer('export'))}>
            {uiText('导出所选备份到迁移目录')}
          </button>
          <button disabled={busy} onClick={() => void run(() => transfer('import'))}>
            {uiText('导入其他电脑的备份')}
          </button>
        </>
      )}
      <p role="status">{notice}</p>
    </section>
  );
}
