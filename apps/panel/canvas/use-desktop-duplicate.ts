import { t as uiText } from '../../../packages/components/ui-language.js';
import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import { PanelActionError } from '../host.js';
import { nativeDraftKey, nativeDraftKinds } from '../documents/native/native-drafts.js';
import { writeDraftNow, flushDraftStorage } from '../documents/draft-storage.js';

type Request = {
  requestId: string;
  objectId: string;
  expectedRevision: number;
  operation: 'duplicate';
  resultId?: string;
};
type Options = {
  workspace: Workspace | null;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  hasDraft: (id: string) => boolean;
  created: (id: string) => void;
};

/** Unknown responses keep their receipt; keyboard repeats never create a second copy. */
export function useDesktopDuplicate(options: Options) {
  const current = useRef(options);
  current.current = options;
  const request = useRef<Request | null>(null),
    running = useRef(false),
    alive = useRef(true),
    epoch = useRef(0);
  const [pending, setPending] = useState<Request | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    request.current = null;
    setPending(null);
    setError('');
    if (!options.workspace) return;
    try {
      const saved = JSON.parse(
        localStorage.getItem(`ai-desktop:duplicate:${options.workspace.id}`) ?? 'null',
      );
      if (
        saved?.operation === 'duplicate' &&
        typeof saved.requestId === 'string' &&
        typeof saved.objectId === 'string' &&
        Number.isInteger(saved.expectedRevision) &&
        saved.expectedRevision > 0 &&
        (!saved.resultId || typeof saved.resultId === 'string')
      ) {
        request.current = saved;
        setPending(saved);
      }
    } catch {
      setError(uiText('复制记录暂时无法读取，请恢复浏览器存储后重试。'));
    }
  }, [options.workspace?.id]);
  const copy = async (objectId?: string) => {
    if (running.current || !current.current.workspace) return;
    const scope = current.current,
      workspaceId = scope.workspace!.id,
      at = epoch.current,
      key = `ai-desktop:duplicate:${workspaceId}`;
    const valid = () =>
      alive.current && epoch.current === at && current.current.workspace?.id === workspaceId;
    if (request.current && objectId && request.current.objectId !== objectId) {
      setError(uiText('上一份复制的响应尚未确认，请先继续原请求。'));
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    let dispatched = false;
    try {
      let operation = request.current;
      if (!operation) {
        const object = scope.workspace!.objects.find(
          (item) => item.id === objectId && !item.archived,
        );
        if (!object) throw new PanelActionError('NOT_FOUND', uiText('请选择仍在桌面上的材料。'));
        if (scope.hasDraft(object.id))
          throw new PanelActionError(
            'DRAFT_ACTIVE',
            uiText('请先保存或处理草稿，再复制这份材料。'),
          );
        for (const kind of nativeDraftKinds) {
          const draft = nativeDraftKey(object.id, kind);
          flushDraftStorage(draft);
          if (localStorage.getItem(draft))
            throw new PanelActionError(
              'DRAFT_ACTIVE',
              uiText('存在原生文件草稿，请打开并保存后再复制。'),
            );
        }
        operation = {
          requestId: crypto.randomUUID(),
          objectId: object.id,
          expectedRevision: object.revision,
          operation: 'duplicate',
        };
        writeDraftNow(key, JSON.stringify(operation));
        request.current = operation;
        setPending(operation);
      }
      let id = operation.resultId;
      if (!id) {
        dispatched = true;
        const { resultId: _, ...payload } = operation;
        const result = await scope.action('object_manage', payload);
        id = result.id;
        operation = { ...operation, resultId: id };
        writeDraftNow(key, JSON.stringify(operation));
        if (!valid()) return;
        request.current = operation;
        setPending(operation);
      }
      if (!valid()) return;
      await scope.updated();
      if (!valid()) return;
      scope.created(id!);
      writeDraftNow(key, null);
      request.current = null;
      setPending(null);
    } catch (cause) {
      if (!valid()) return;
      if (
        cause instanceof PanelActionError &&
        !['LOCAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(cause.code) &&
        dispatched &&
        !request.current?.resultId
      ) {
        try {
          writeDraftNow(key, null);
          request.current = null;
          setPending(null);
        } catch (storageError) {
          setError(
            uiText('请求已拒绝，但本地记录清理失败，请恢复浏览器存储后继续原请求。{0}', {
              '0': storageError instanceof Error ? storageError.message : String(storageError),
            }),
          );
          return;
        }
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return {
    busy,
    pending,
    error,
    copy,
    dismiss: () => {
      if (!running.current && !request.current) setError('');
    },
  };
}
