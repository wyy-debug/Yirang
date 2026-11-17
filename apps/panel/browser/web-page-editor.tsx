import { useState } from 'react';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { writeDraftNow } from '../documents/draft-storage.js';
import type { WebPage } from '../../../packages/contracts/web-workspace.js';
import { Icon } from '../ui/icons.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import {
  domain,
  message,
  urlFor,
  useDraft,
} from './web-workbench-shared.js';
import type { Dirty, Mutate } from './web-workbench-shared.js';

export function PageEditor({
  workspaceId,
  page,
  mutate,
  disabled,
  close,
  dirty,
  created,
}: {
  workspaceId: string;
  page?: WebPage;
  mutate: Mutate;
  disabled: boolean;
  close: () => void;
  dirty: Dirty;
  created: (page: WebPage) => void;
}) {
  useUiLocale();
  const [draft, setDraft, storageError] = useDraft(
      `ai-desktop:web-page-draft:${workspaceId}:${page?.id ?? 'new'}`,
      () => ({
        title: page?.title ?? '',
        url: page?.url ?? '',
        group: page?.group ?? '',
        tags: page?.tags.join(', ') ?? '',
        favorite: page?.favorite ?? false,
        base: page?.revision,
      }),
      dirty,
    ),
    [error, setError] = useState('');
  async function save() {
    try {
      const url = urlFor(draft.url),
        payload = {
          title: draft.title.trim() || domain(url),
          url,
          group: draft.group.trim(),
          tags: [
            ...new Set(
              draft.tags
                .split(/[,，]/)
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          ],
          favorite: draft.favorite,
        };
      if (payload.tags.length > 20 || payload.tags.some((tag) => tag.length > 40))
        throw new Error(uiText('最多 20 个标签，每个标签不超过 40 个字。'));
      const result = await mutate(
        page
          ? {
              operation: 'update',
              pageId: page.id,
              expectedRevision: draft.base ?? page.revision,
              ...payload,
            }
          : { operation: 'create', ...payload },
        uiText('网页信息'),
      );
      if (result) {
        setDraft({
          ...draft,
          ...payload,
          tags: payload.tags.join(', '),
          base: result.page.revision,
        });
        if (!page)
          setDraft({ title: '', url: '', group: '', tags: '', favorite: false, base: undefined });
        writeDraftNow(`ai-desktop:web-page-draft:${workspaceId}:${page?.id ?? 'new'}`, null);
        dirty(`ai-desktop:web-page-draft:${workspaceId}:${page?.id ?? 'new'}`, false);
        close();
        if (!page) created(result.page);
      }
    } catch (problem) {
      setError(message(problem));
    }
  }
  return (
    <div className="ww-modal-scrim">
      <section className="ww-modal">
        <header>
          <div>
            <small>WEB LIBRARY</small>
            <h2>{page ? uiText('编辑网页') : uiText('添加网页')}</h2>
          </div>
          <button aria-label={uiText('关闭')} onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        <label>
          {uiText('网页地址')}
          <input
            autoFocus
            type="url"
            value={draft.url}
            maxLength={4096}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            placeholder="https://example.com"
          />
        </label>
        <label>
          {uiText('名称')}
          <input
            value={draft.title}
            maxLength={300}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder={uiText('为这个网页取个名字')}
          />
        </label>
        <div className="ww-form-columns">
          <label>
            {uiText('分组')}
            <input
              value={draft.group}
              maxLength={100}
              onChange={(event) => setDraft({ ...draft, group: event.target.value })}
              placeholder={uiText('例如：产品研究')}
            />
          </label>
          <label>
            {uiText('标签')}
            <input
              value={draft.tags}
              onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
              placeholder={uiText('用逗号分隔')}
            />
          </label>
        </div>
        <label className="ww-checkbox">
          <input
            type="checkbox"
            checked={draft.favorite}
            onChange={(event) => setDraft({ ...draft, favorite: event.target.checked })}
          />
          {uiText('加入个人收藏')}
        </label>
        {(error || storageError) && <p className="ww-inline-error">{error || storageError}</p>}
        <footer>
          <span>{uiText('草稿保存在本机')}</span>
          <button
            disabled={disabled || !draft.url.trim()}
            className="ww-primary"
            onClick={() => void save()}
          >
            {uiText('保存网页')}
          </button>
        </footer>
      </section>
    </div>
  );
}
