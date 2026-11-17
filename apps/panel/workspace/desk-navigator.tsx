import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { useWorkspaceRefresh, retainEqual } from './workspace-refresh.js';
import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import { contentText, kindIcons, kindLabels } from '../../../packages/components/content.js';
import { isIntegratedDesktop } from './workspace-mode.js';
import { Icon } from '../ui/icons.js';
import { regionMemberIds } from '../../../packages/components/canvas-folders.js';

type Props = {
  workspace: Workspace;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  locate: (ids: string[]) => void;
  openObject: (id: string) => void;
  close: () => void;
};
function searchText(object: DesktopObject) {
  // Search only stored object text. Never read binary attachment paths.
  return contentText(object.content);
}
export function DeskNavigator({
  workspace,
  action,
  updated,
  locate,
  openObject,
  close,
}: Props) {
  useUiLocale();
  const dataRevision = useWorkspaceRefresh(workspace.id, 'search');
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [groupId, setGroupId] = useState('');
  const [error, setError] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [nativeHits, setNativeHits] = useState<any[]>([]),
    [indexing, setIndexing] = useState(false);
  const actions = useRef(action);
  actions.current = action;
  useEffect(() => {
    let live = true;
    if (!deferredQuery) {
      setNativeHits([]);
      setIndexing(false);
      return;
    }
    const timer = setTimeout(() => {
      setIndexing(true);
      void actions
        .current('native_workbench', { operation: 'search', query: deferredQuery })
        .then((r) => {
          if (live) {
            setNativeHits((previous) => retainEqual(previous, r.hits));
            if (r.issues.length)
              setError(uiText('{0} 个文件暂不能提取正文。', { '0': r.issues.length }));
          }
        })
        .catch((e) => {
          if (live) setError(String(e));
        })
        .finally(() => {
          if (live) setIndexing(false);
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspace.id, deferredQuery, dataRevision]);
  const groups = workspace.groups.items;
  const currentGroup = groups.find((g) => g.id === groupId);
  const results = useMemo(() => {
    const rows = workspace.objects.filter(
      (o) =>
        (!groupId ||
          (groupId === 'ungrouped'
            ? !groups.some((g) => regionMemberIds(g).includes(o.id))
            : !!currentGroup && regionMemberIds(currentGroup).includes(o.id))) &&
        (kind === 'all' || o.kind === kind),
    );
    return rows.flatMap((object) => {
      if (!deferredQuery) return [{ object, excerpt: '' }];
      const titleMatch = object.title.toLocaleLowerCase().includes(deferredQuery);
      const text = searchText(object),
        index = text.toLocaleLowerCase().indexOf(deferredQuery);
      if (!titleMatch && index < 0) return [];
      const start = Math.max(0, index - 24);
      return [
        {
          object,
          excerpt:
            index < 0
              ? ''
              : `${start ? '…' : ''}${text.slice(start, start + 110).replace(/\s+/g, ' ')}${text.length > start + 110 ? '…' : ''}`,
        },
      ];
    });
  }, [workspace.objects, groups, currentGroup, groupId, kind, deferredQuery, getUiLocale()]);
  async function openHit(hit: any) {
    try {
      const target = await action('native_workbench', {
        operation: 'search_locate',
        hitId: hit.hitId,
      });
      sessionStorage.setItem(`native-focus:${hit.objectId}`, JSON.stringify(target.target ?? {}));
      locate([hit.objectId]);
      openObject(hit.objectId);
    } catch (error) {
      setError(String(error));
    }
  }
  return (
    <section
      className="desk-navigator"
      role="dialog"
      aria-label={uiText('查找桌面材料')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <header>
        <strong>{uiText('查找桌面材料')}</strong>
        <button
          onClick={close}
          aria-label={uiText('关闭')}
          title={uiText('关闭')}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      {isIntegratedDesktop && (
        <button
          className="navigator-semantic"
          onClick={() => window.parent.postMessage({ type: 'ai-desktop:open-search' }, '*')}
        >
          {uiText('语义搜索与向量服务设置')}
          <span className="ui-chevron right" aria-hidden="true" />
        </button>
      )}
      {error && (
        <div className="navigator-error" role="alert">
          <span>{error}</span>
          <button onClick={() => void updated().catch((e) => setError(String(e)))}>
            {uiText('刷新记录')}
          </button>
        </div>
      )}
      <div className="navigator-search">
        <input
          autoFocus
          aria-label={uiText('搜索桌面材料')}
          placeholder={uiText('搜索名称或内容…')}
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              results.length === 1 &&
              query.trim().toLocaleLowerCase() === deferredQuery
            ) {
              e.preventDefault();
              locate([results[0].object.id]);
            }
          }}
        />
        <select
          aria-label={uiText('筛选材料类型')}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="all">{uiText('所有类型')}</option>
          {Object.entries(kindLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="navigator-groups">
        <button className={!groupId ? 'chosen' : ''} onClick={() => setGroupId('')}>
          {uiText('全部')}
          <small>{workspace.objects.length}</small>
        </button>
        <button
          className={groupId === 'ungrouped' ? 'chosen' : ''}
          onClick={() => setGroupId('ungrouped')}
        >
          {uiText('未归入区域')}
        </button>
        {groups.map((g) => (
          <button
            key={g.id}
            className={`${g.id === groupId ? 'chosen' : ''} color-${g.color}`}
            onClick={() => setGroupId(g.id)}
          >
            <i />
            {g.name}
            <small>
              {regionMemberIds(g).filter((id) => workspace.objects.some((o) => o.id === id)).length}
            </small>
          </button>
        ))}
      </div>
      {currentGroup && (
        <div className="navigator-group-tools">
          <button
            disabled={
              !regionMemberIds(currentGroup).some((id) => workspace.objects.some((o) => o.id === id))
            }
            onClick={() => locate(regionMemberIds(currentGroup))}
          >
            {uiText('定位区域材料')}
          </button>
        </div>
      )}
      {(indexing || nativeHits.length > 0) && (
        <section className="navigator-native">
          <strong>{indexing ? uiText('正在搜索文件正文…') : uiText('文件正文匹配')}</strong>
          {nativeHits
            .filter((h) => kind === 'all' || kind === 'file')
            .filter(
              (h) =>
                !groupId ||
                (groupId === 'ungrouped'
                  ? !groups.some((g) => regionMemberIds(g).includes(h.objectId))
                  : !!currentGroup && regionMemberIds(currentGroup).includes(h.objectId)),
            )
            .map((h, i) => (
              <article key={`${h.objectId}:${i}`}>
                <b>
                  {h.title} · {h.location}
                </b>
                <p>{h.text}</p>
                <button onClick={() => void openHit(h)}>{uiText('打开匹配位置')}</button>
              </article>
            ))}
        </section>
      )}
      <div
        className="navigator-results"
        aria-busy={query.trim().toLocaleLowerCase() !== deferredQuery}
      >
        <span className="navigator-result-count">
          {results.length} {uiText('份材料')}
          {query ? uiText(' · 搜索已保存内容') : ''}
        </span>
        {results.map(({ object, excerpt }) => (
          <article key={object.id}>
            <span className="navigator-kind">{kindIcons[object.kind]}</span>
            <div>
              <strong>{object.title}</strong>
              <small>
                {kindLabels[object.kind]} · v{object.revision}
                {object.policy?.private ? uiText(' · 仅自己可见') : ''}
              </small>
              {excerpt && <p>{excerpt}</p>}
              <div>
                <button onClick={() => locate([object.id])}>{uiText('定位并选中')}</button>
                <button onClick={() => openObject(object.id)}>{uiText('展开')}</button>
              </div>
            </div>
          </article>
        ))}
        {!results.length && (
          <p className="navigator-empty">
            {uiText('没有找到材料。可以更换关键词、类型或区域。')}
          </p>
        )}
      </div>
      <footer className="navigator-help">
        <details>
          <summary>{uiText('画布快捷操作')}</summary>
          <span>{uiText('Ctrl / ⌘ K 查找 · Ctrl / ⌘ G 创建区域')}</span>
          <span>{uiText('Ctrl / ⌘ A 全选材料 · F 适合选区')}</span>
          <span>{uiText('Enter 展开所选材料 · Esc 清除选区')}</span>
        </details>
      </footer>
    </section>
  );
}
