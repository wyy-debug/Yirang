import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useEffect, useState } from 'react';
import type { AnnotationDraftSummary, Workspace } from '../../../packages/contracts/index.js';

export function AnnotationRecovery({
  workspace,
  action,
  close,
  open,
}: {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  close: () => void;
  open: (id: string) => void;
}) {
  useUiLocale();
  const [items, setItems] = useState<AnnotationDraftSummary[]>([]),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    action('annotation_drafts')
      .then((rows: AnnotationDraftSummary[]) => {
        if (alive) setItems(rows);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspace.id, refresh]);
  return (
    <section className="annotation-recovery-desk" role="dialog" aria-label={uiText('批注草稿恢复')}>
      <header>
        <button onClick={close}>{uiText('返回桌面')}</button>
        <div>
          <strong>{uiText('批注草稿')}</strong>
          <small>{uiText('继续上次未完成的编辑')}</small>
        </div>
        <button disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {uiText('刷新')}
        </button>
      </header>
      <p>
        {uiText(
          '暂存草稿与正式图片分开保存。打开后可以恢复、比较当前版本，再决定保存或放弃。重开面板不会自动提交草稿。',
        )}
      </p>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <div className="annotation-recovery-list">
        {loading ? (
          <p>{uiText('正在读取本地草稿…')}</p>
        ) : items.length === 0 ? (
          <p>{uiText('没有未完成的批注草稿。')}</p>
        ) : (
          items.map((item) => {
            const available = workspace.objects.some((object) => object.id === item.objectId);
            return (
              <article key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.annotationCount} {uiText('条批注')}
                  </span>
                  <small>
                    {new Date(item.updatedAt).toLocaleString(interfaceLocale())}
                    {item.pending ? uiText(' · 保存结果待确认') : ''}
                  </small>
                  {!available ? (
                    <small>{uiText('图片已归档，请先到材料库恢复图片。')}</small>
                  ) : !item.own && item.leaseUntil > Date.now() ? (
                    <small>{uiText('另一面板仍持有编辑租约，离开后约 30 秒可恢复。')}</small>
                  ) : (
                    <small>{uiText('恢复后会检查当前图片版本。')}</small>
                  )}
                </div>
                <button disabled={!available} onClick={() => open(item.objectId)}>
                  {uiText('打开并恢复')}
                </button>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
