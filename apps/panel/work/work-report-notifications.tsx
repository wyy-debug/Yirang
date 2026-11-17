import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/icons.js';
import { useWorkbenchLayer } from '../ui/workbench-layers.js';
import { t } from '../../../packages/components/ui-language.js';
import './work-report-notifications.css';

type Report = {
  taskId: string; title: string; at?: string; label: string; tone: string; reason: string;
  artifacts: { objectId: string; title: string; revision: number }[];
};
const post = (value: object) => window.parent.postMessage(value, '*');

// Reuses the host's persisted work projection. No polling, model calls or second task ledger.
export function WorkReportNotifications({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<{ workspaceId: string; reports: Report[] } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useWorkbenchLayer(expanded, root, () => setExpanded(false), 'menu', trigger);
  useEffect(() => setExpanded(false), [workspaceId]);
  useEffect(() => {
    setData(null);
    setFailed(false);
    const timeout = window.setTimeout(() => setFailed(true), 10000);
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== 'yirang:work-reports' ||
          event.data.workspaceId !== workspaceId || !Array.isArray(event.data.reports)) return;
      window.clearTimeout(timeout);
      setFailed(false);
      setData(event.data);
    };
    window.addEventListener('message', receive);
    post({ type: 'yirang:work-stream-request' });
    return () => { window.clearTimeout(timeout); window.removeEventListener('message', receive); };
  }, [workspaceId, attempt]);
  const reports = data?.workspaceId === workspaceId ? data.reports : [];
  const attention = reports.filter(report => ['ask', 'blocked'].includes(report.tone)).length;
  const close = () => { setExpanded(false); trigger.current?.focus(); };
  return <div ref={root} className="app-notification-bar work-report-notifications"
    data-desktop-overlay={expanded ? 'work-reports' : undefined}>
    <button ref={trigger} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <Icon name="tasks" size={15} /><span>{t('工作汇报')}</span>
      {attention > 0 && <b aria-label={t('需要处理')}>{attention}</b>}
    </button>
    {expanded && <section className="app-notification-list work-report-list" aria-label={t('工作汇报')}>
      <header><strong>{t('工作汇报')}</strong><button aria-label={t('关闭')} onClick={close}>×</button></header>
      {!data ? <p role="status">{failed ? <button onClick={() => setAttempt(value => value + 1)}>{t('加载失败，点击重试')}</button> : t('正在加载…')}</p> : !reports.length ? <p>{t('暂无工作汇报')}</p> :
        [...reports].sort((a, b) => (b.at || '').localeCompare(a.at || '')).map(report =>
          <article className="work-report-notice" key={report.taskId}>
            <button className="app-notification-item" onClick={() => {
              close(); post({ type: 'yirang:focus-work', workspaceId, taskId: report.taskId });
            }}>
              <small data-tone={report.tone}>{t(report.label)}</small>
              <strong>{report.title}</strong>
              {report.reason && <span>{t(report.reason)}</span>}
              {report.at && <time dateTime={report.at}>{new Date(report.at).toLocaleString()}</time>}
            </button>
            {report.artifacts.length > 0 && <div className="work-report-files">
              {report.artifacts.map(file => <button key={file.objectId} title={t('定位桌面')}
                onClick={() => { close(); post({ type: 'ai-desktop:locate-outputs', workspaceId, objectIds: [file.objectId] }); }}>
                <Icon name="document" size={14} /><span>{file.title}</span>
              </button>)}
            </div>}
          </article>)}
    </section>}
  </div>;
}
