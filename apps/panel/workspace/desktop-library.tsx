import { getUiLanguage as interfaceLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React from 'react';
import type { DesktopObject } from '../../../packages/contracts/index.js';
import type { DesktopLibrary } from '../../../packages/contracts/canvas-preview.js';
import { Icon, FileBadge } from '../ui/icons.js';

export function DesktopLibraryView({
  mode,
  objects,
  library,
  open,
  locate,
  favorite,
  close,
}: {
  mode: 'recent' | 'favorites';
  objects: DesktopObject[];
  library: DesktopLibrary;
  open: (id: string) => void;
  locate: (ids: string[]) => void;
  favorite: (id: string, value: boolean) => void;
  close: () => void;
}) {
  useUiLocale();
  const ids = mode === 'recent' ? library.recentIds : library.favoriteIds,
    items = ids
      .map((id) => objects.find((o) => o.id === id))
      .filter((o): o is DesktopObject => !!o);
  return (
    <aside
      className="desktop-collection"
      role="dialog"
      aria-label={mode === 'recent' ? uiText('最近使用') : uiText('收藏')}
    >
      <header>
        <div>
          <strong>{mode === 'recent' ? uiText('最近使用') : uiText('收藏')}</strong>
          <small>
            {items.length} {uiText('份材料')}
          </small>
        </div>
        <button aria-label={uiText('关闭材料列表')} onClick={close}>
          <Icon name="close" size={17} />
        </button>
      </header>
      <div className="collection-items">
        {items.map((o) => (
          <article key={o.id}>
            <FileBadge
              kind={o.kind}
              fileName={o.kind === 'file' ? (o.content as { fileName: string }).fileName : ''}
            />
            <button className="collection-open" onClick={() => open(o.id)}>
              <strong>{o.title}</strong>
              <small>
                v{o.revision} · {new Date(o.updatedAt).toLocaleDateString(interfaceLocale())}
              </small>
            </button>
            <button
              title={uiText('在画布定位')}
              aria-label={uiText('定位 {0}', { '0': o.title })}
              onClick={() => locate([o.id])}
            >
              <Icon name="fit" size={15} />
            </button>
            <button
              className={library.favoriteIds.includes(o.id) ? 'is-favorite' : ''}
              title={library.favoriteIds.includes(o.id) ? uiText('取消收藏') : uiText('收藏')}
              aria-label={`${library.favoriteIds.includes(o.id) ? uiText('取消收藏') : uiText('收藏')} ${o.title}`}
              aria-pressed={library.favoriteIds.includes(o.id)}
              onClick={() => favorite(o.id, !library.favoriteIds.includes(o.id))}
            >
              <Icon name="star" size={16} />
            </button>
          </article>
        ))}
      </div>
      {!items.length && (
        <div className="collection-empty">
          <Icon name={mode === 'recent' ? 'history' : 'star'} size={30} />
          <p>
            {mode === 'recent'
              ? uiText('打开过的材料会显示在这里。')
              : uiText('将常用材料收藏，方便下次找到。')}
          </p>
          <small>
            {mode === 'favorites'
              ? uiText('将鼠标移到文件名旁，点击星标。')
              : uiText('双击画布上的文件即可展开。')}
          </small>
        </div>
      )}
    </aside>
  );
}
