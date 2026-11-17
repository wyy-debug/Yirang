import { t as uiText } from '../../../../packages/components/ui-language.js';
import { useEffect, useRef, useState } from 'react';
import { flushDraftStorage } from '../draft-storage.js';
import type { DesktopObject } from '../../../../packages/contracts/index.js';
export const nativeDraftKinds = ['text', 'xlsx', 'office', 'charts'] as const;
export function nativeDraftKey(id: string, kind: string) {
  return `ai-desktop:${kind === 'text' ? 'text-file-draft' : kind === 'xlsx' ? 'xlsx-draft' : kind === 'charts' ? 'xlsx-chart-draft' : 'office-draft'}:${id}`;
}
export async function syncNativeDrafts(
  objects: DesktopObject[],
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>,
) {
  flushDraftStorage();
  for (const object of objects.filter((o) => o.kind === 'file')) {
    const entries = nativeDraftKinds.flatMap((kind) => {
      const data = localStorage.getItem(nativeDraftKey(object.id, kind));
      return data ? [{ objectId: object.id, kind, data }] : [];
    });
    if (entries.length) await action('native_drafts_sync', { entries });
  }
}
export function useNativeDraftRecovery(
  objectId: string,
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>,
) {
  const [ready, setReady] = useState(false),
    [blocked, setBlocked] = useState(false),
    [attempt, setAttempt] = useState(0),
    [error, setError] = useState(''),
    actions = useRef(action);
  actions.current = action;
  useEffect(() => {
    let live = true,
      restored = false,
      last = '',
      queue = Promise.resolve();
    setReady(false);
    const sync = () => {
      if (!restored) return;
      let entries;
      try {
        entries = nativeDraftKinds.map((kind) => ({
          objectId,
          kind,
          data: localStorage.getItem(nativeDraftKey(objectId, kind)),
        }));
      } catch {
        return;
      }
      const value = JSON.stringify(entries);
      if (value === last) return;
      last = value;
      queue = queue
        .then(() => actions.current('native_drafts_sync', { entries }))
        .then(() => {
          if (live) setError('');
        })
        .catch((e) => {
          last = '';
          if (live)
            setError(uiText('草稿尚未同步到工作区：{0}；浏览器草稿仍保留。', { '0': String(e) }));
        });
    };
    const lease = async () => {
      const dirty = nativeDraftKinds.some(
          (kind) => !!localStorage.getItem(nativeDraftKey(objectId, kind)),
        ),
        r = await actions.current('native_workbench', {
          operation: 'editor_lease',
          command: 'acquire',
          objectId,
          dirty,
        });
      if (!r.acquired) throw Error(uiText('此文件正在另一个面板中编辑。关闭那里的编辑页后重试。'));
    };
    void lease()
      .then(() => actions.current('native_drafts_list'))
      .then((items: any[]) => {
        if (!live) return;
        for (const item of items.filter(
          (i) => i.objectId === objectId && nativeDraftKinds.includes(i.kind),
        )) {
          const key = nativeDraftKey(objectId, item.kind);
          if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(item.data));
        }
        restored = true;
        setBlocked(false);
        setReady(true);
      })
      .catch((e) => {
        if (live) {
          setError(String(e));
          setBlocked(true);
          setReady(true);
        }
      });
    const timer = setInterval(sync, 1200),
      heartbeat = setInterval(() => {
        if (restored)
          void lease().catch((e) => {
            if (live) {
              setBlocked(true);
              setError(String(e));
            }
          });
      }, 20000);
    return () => {
      for (const kind of nativeDraftKinds) flushDraftStorage(nativeDraftKey(objectId, kind));
      sync();
      live = false;
      clearInterval(timer);
      clearInterval(heartbeat);
      void queue
        .finally(() =>
          actions.current('native_workbench', {
            operation: 'editor_lease',
            command: 'release',
            objectId,
          }),
        )
        .catch(() => {});
    };
  }, [objectId, attempt]);
  return { ready, error, blocked, retry: () => setAttempt((n) => n + 1) };
}
