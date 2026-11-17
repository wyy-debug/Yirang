import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useWorkspaceRefresh, retainEqual } from '../workspace/workspace-refresh.js';
import React, { useEffect, useState } from 'react';
import type { ArtifactRecord, Workspace } from '../../../packages/contracts/index.js';
export function ArtifactLibrary({
  workspace,
  action,
  close,
  openSource,
}: {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  close: () => void;
  openSource: (id: string) => void;
}) {
  useUiLocale();
  const dataRevision = useWorkspaceRefresh(workspace.id, 'artifacts');
  const [items, setItems] = useState<ArtifactRecord[]>([]),
    [error, setError] = useState(''),
    [format, setFormat] = useState('all'),
    [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    action('artifact_list')
      .then((r) => {
        if (!cancelled) setItems((previous) => retainEqual(previous, r));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, dataRevision]);
  const item = items.find((a) => a.id === selected),
    object = item && workspace.objects.find((o) => o.id === item.objectId);
  return (
    <section className="artifact-library" role="dialog" aria-label={uiText('导出文件')}>
      <header className="section-header">
        <button onClick={close}>{uiText('返回桌面')}</button>
        <div>
          <strong>{uiText('导出文件')}</strong>
          <small>{uiText('每一份文件，都能回到它的来源')}</small>
        </div>
        <span>
          {items.length} {uiText('份文件')}
        </span>
      </header>
      {error && <div className="banner error">{error}</div>}
      <div className="artifact-filter">
        {['all', 'pptx', 'xlsx', 'svg', 'png'].map((f) => (
          <button key={f} className={format === f ? 'active' : ''} onClick={() => setFormat(f)}>
            {f === 'all' ? uiText('全部文件') : f.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="artifact-body">
        <div className="artifact-list">
          {items
            .filter((a) => format === 'all' || a.format === format)
            .map((a) => {
              const source = workspace.objects.find((o) => o.id === a.objectId);
              return (
                <button
                  key={a.id}
                  className={selected === a.id ? 'chosen' : ''}
                  onClick={() => setSelected(a.id)}
                >
                  <span className="artifact-format">{a.format.toUpperCase()}</span>
                  <div>
                    <strong>
                      {source?.title ?? uiText('已归档来源')} · v{a.sourceRevision}
                    </strong>
                    <small>
                      {(a.bytes / 1024).toFixed(1)} KB ·{' '}
                      {new Date(a.createdAt).toLocaleString(interfaceLocale())}
                    </small>
                  </div>
                  <span
                    className={
                      source?.revision === a.sourceRevision ? 'artifact-current' : 'artifact-old'
                    }
                  >
                    {!source
                      ? uiText('来源已归档')
                      : source.revision === a.sourceRevision
                        ? uiText('当前版本')
                        : uiText('基于旧版本')}
                  </span>
                </button>
              );
            })}
          {!items.length && (
            <div className="artifact-empty">
              <span>▱</span>
              <h2>{uiText('从内容，到可使用的文件。')}</h2>
              <p>
                {uiText('展开图形、演示文稿或工作簿，选择对应导出入口。')}
                <br />
                {uiText('生成后，文件路径、哈希与来源会记录在这里。')}
              </p>
            </div>
          )}
        </div>
        {item && (
          <aside className="artifact-details">
            <span className="eyebrow">
              {item.format.toUpperCase()} {uiText('产物')}
            </span>
            <h2>{object?.title ?? uiText('来源已归档')}</h2>
            <dl>
              <dt>{uiText('源版本')}</dt>
              <dd>
                v{item.sourceRevision}
                {object && object.revision !== item.sourceRevision
                  ? uiText(' · 当前已是 v{0}', { '0': object.revision })
                  : ''}
              </dd>
              <dt>{uiText('生成器')}</dt>
              <dd>{item.generator}</dd>
              <dt>{uiText('执行方式')}</dt>
              <dd>
                {uiText('本地固定格式生成器')}
                <br />
                {uiText('没有运行用户代码')}
              </dd>
              <dt>{uiText('计算状态')}</dt>
              <dd>
                {item.calculation === 'not_calculated'
                  ? uiText('公式未计算')
                  : uiText('不涉及公式计算')}
              </dd>
              <dt>{uiText('字节数')}</dt>
              <dd>{item.bytes.toLocaleString(interfaceLocale())}</dd>
              <dt>SHA-256</dt>
              <dd className="artifact-hash">{item.sha256}</dd>
            </dl>
            <label>
              {uiText('本地文件路径')}
              <input readOnly value={item.path} onFocus={(e) => e.target.select()} />
            </label>
            <p>
              {uiText('可复制路径到本地文件管理器打开。文件由生成器写出，本轮没有进行格式验收。')}
            </p>
            {object && (
              <button onClick={() => openSource(item.objectId)}>{uiText('回到源对象')}</button>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
