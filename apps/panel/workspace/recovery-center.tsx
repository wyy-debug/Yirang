import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useTransientNotice } from '../ui/use-transient-notice.js';
import React, { useEffect, useState } from 'react';
import { DESKTOP_VERSION } from '../../../packages/contracts/version.js';
import { isIntegratedDesktop } from './workspace-mode.js';
export function RecoveryCenter({
  action,
}: {
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
}) {
  useUiLocale();
  const [info, setInfo] = useState<any>(null),
    [plan, setPlan] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useTransientNotice();
  const appName = isIntegratedDesktop ? uiText('一壤') : 'Codex';
  async function load() {
    setInfo(await action('native_workbench', { operation: 'maintenance', command: 'inspect' }));
  }
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, []);
  async function run(command: string, snapshot?: string) {
    setBusy(true);
    setError('');
    try {
      const value = await action('native_workbench', {
        operation: 'maintenance',
        command,
        snapshot,
      });
      if (command === 'snapshot') {
        setNotice(uiText('恢复副本已创建。'));
        await load();
      } else setPlan(value);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="recovery-center">
      {info && (
        <>
          <div className="storage-setting-row">
            <div>
              <h3>{uiText('恢复副本')}</h3>
              <p>{uiText('数据出现问题时用来恢复。日常备份请使用「工作区与备份」。')}</p>
            </div>
            <button disabled={busy} onClick={() => void run('snapshot')}>
              {uiText('创建恢复副本')}
            </button>
          </div>
          <details>
            <summary>
              {uiText('已有恢复副本（')}
              {info.snapshots.length}）
            </summary>
            {info.snapshots.map((snapshot: any) => (
              <div className="storage-setting-row" key={snapshot.name}>
                <span>
                  {new Date(snapshot.at).toLocaleString(interfaceLocale())}
                  <small>{(snapshot.bytes / 1024 / 1024).toFixed(1)} MB</small>
                </span>
                <button disabled={busy} onClick={() => void run('plan', snapshot.name)}>
                  {uiText('查看恢复步骤')}
                </button>
              </div>
            ))}
            {!info.snapshots.length && <p>{uiText('尚未创建恢复副本。')}</p>}
          </details>
          {info.serviceVersion !== DESKTOP_VERSION && (
            <p role="alert">
              {uiText('版本更新尚未完全加载，请关闭并重新打开')}
              {appName}。
            </p>
          )}
          <details className="storage-diagnostics">
            <summary>{uiText('故障排查信息')}</summary>
            <dl>
              <div>
                <dt>{uiText('应用版本')}</dt>
                <dd>{DESKTOP_VERSION}</dd>
              </div>
              <div>
                <dt>{uiText('服务版本')}</dt>
                <dd>{info.serviceVersion}</dd>
              </div>
              <div>
                <dt>{uiText('数据格式')}</dt>
                <dd>{info.schema}</dd>
              </div>
              <div>
                <dt>{uiText('运行环境')}</dt>
                <dd>
                  {info.node} · {info.platform}
                </dd>
              </div>
              <div>
                <dt>{uiText('数据位置')}</dt>
                <dd>{info.dataDirectory}</dd>
              </div>
              <div>
                <dt>{uiText('诊断记录')}</dt>
                <dd>{info.diagnostics}</dd>
              </div>
            </dl>
            <details>
              <summary>{uiText('安装与升级记录')}</summary>
              {info.history.length ? (
                info.history
                  .slice()
                  .reverse()
                  .map((entry: any, i: number) => (
                    <p key={i}>
                      {new Date(entry.at).toLocaleString(interfaceLocale())} ·{' '}
                      {entry.previousVersion ?? uiText('首次安装')} → {entry.version}
                    </p>
                  ))
              ) : (
                <p>{uiText('暂无记录。')}</p>
              )}
            </details>
          </details>
        </>
      )}
      {plan && (
        <div className="storage-cleanup-plan">
          <h4>{uiText('恢复步骤')}</h4>
          <p>
            {uiText('恢复需要关闭')}
            {appName}
            {uiText('后手动执行，不会直接覆盖正在使用的数据。')}
          </p>
          <ol>
            {plan.instructions.map((step: string) => (
              <li key={step}>
                {isIntegratedDesktop ? step.replaceAll('Codex', uiText('一壤')) : step}
              </li>
            ))}
          </ol>
          <details>
            <summary>{uiText('查看恢复命令')}</summary>
            <strong>{uiText('预览')}</strong>
            <pre>{plan.previewCommand}</pre>
            <strong>{uiText('执行恢复')}</strong>
            <pre>{plan.applyCommand}</pre>
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(`${plan.previewCommand}\n\n${plan.applyCommand}`)
                  .then(() =>
                    setNotice(uiText('命令已复制，请先关闭{0}再执行。', { '0': appName })),
                  )
                  .catch((e) => setError(String(e)))
              }
            >
              {uiText('复制命令')}
            </button>
          </details>
          <button onClick={() => setPlan(null)}>{uiText('收起')}</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
