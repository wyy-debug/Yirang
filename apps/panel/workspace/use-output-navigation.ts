import { t as uiText } from '../../../packages/components/ui-language.js';
import { useEffect, useRef } from 'react';
import type { Workspace } from '../../../packages/contracts/index.js';
import type { Rect } from '../../../packages/components/canvas-spatial.js';
import { isIntegratedDesktop } from './workspace-mode.js';
const pendingKey = 'desktop:pending-output-location';
type Target = {
  workspaceId: string;
  objectIds: string[];
  openObject?: boolean;
  previewObject?: boolean;
  target?: unknown;
  commentId?: string;
  expectedRevisions?: Record<string, number>;
};
type Options = {
  workspace: Workspace | null;
  view: Rect;
  visible: boolean;
  reload: () => Promise<void>;
  navigate: () => Promise<boolean>;
  switchWorkspace: (id: string) => Promise<void>;
  locate: (ids: string[]) => void;
  preview?: (ids: string[]) => void;
  readPreview?: (id: string, revision: number) => Promise<unknown>;
  open?: (id: string, commentId?: string) => void;
  notice: (message: string) => void;
};
export function useOutputNavigation(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const working = useRef(false);
  const answer = (error?: string) =>
    window.parent.postMessage({ type: 'ai-desktop:output-location-result', error }, '*');
  async function locate(target: Target) {
    if (working.current) return;
    working.current = true;
    try {
      if (!(await latest.current.navigate())) {
        answer(uiText('请先保存当前编辑，再定位产出。'));
        return;
      }
      if (latest.current.workspace?.id !== target.workspaceId) {
        sessionStorage.setItem(pendingKey, JSON.stringify(target));
        await latest.current.switchWorkspace(target.workspaceId);
        return;
      }
      await latest.current.reload();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (latest.current.workspace?.id !== target.workspaceId)
        throw Error('工作区已切换，请重新搜索');
      const objects =
        latest.current.workspace?.objects.filter(
          (object) => target.objectIds.includes(object.id) && !object.archived,
        ) ?? [];
      if (!objects.length) throw Error(uiText('这些文件已移到回收站或不在当前桌面。'));
      if (
        target.expectedRevisions &&
        objects.some(
          (object) =>
            object.policy?.private || target.expectedRevisions![object.id] !== object.revision,
        )
      )
        throw Error('材料已更新或设为私有，请重新搜索');
      latest.current.locate(objects.map((object) => object.id));
      if (target.previewObject) latest.current.preview?.(objects.map((object) => object.id));
      else if (target.openObject) {
        sessionStorage.setItem(
          `native-focus:${objects[0].id}`,
          JSON.stringify(target.target ?? {}),
        );
        latest.current.open?.(objects[0].id, target.commentId);
      }
      answer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      latest.current.notice(message);
      answer(message);
    } finally {
      working.current = false;
    }
  }
  useEffect(() => {
    if (!isIntegratedDesktop) return;
    const timer = setTimeout(
      () =>
        window.parent.postMessage(
          {
            type: 'ai-desktop:canvas-context',
            context: options.workspace
              ? { workspaceId: options.workspace.id, view: options.view }
              : null,
          },
          '*',
        ),
      100,
    );
    return () => clearTimeout(timer);
  }, [
    options.workspace?.id,
    options.view.x,
    options.view.y,
    options.view.width,
    options.view.height,
    options.visible,
  ]);
  useEffect(() => {
    if (!isIntegratedDesktop) return;
    function receive(event: MessageEvent) {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (
        data?.type === 'ai-desktop:work-preview' &&
        typeof data.id === 'string' &&
        typeof data.objectId === 'string' &&
        Number.isInteger(data.revision) &&
        data.revision > 0
      ) {
        const respond = (result: Record<string, unknown>) =>
          window.parent.postMessage(
            { type: 'ai-desktop:work-preview-result', id: data.id, ...result },
            '*',
          );
        const object = latest.current.workspace?.objects.find((o) => o.id === data.objectId);
        if (
          data.workspaceId !== latest.current.workspace?.id ||
          !object ||
          object.archived ||
          object.revision !== data.revision ||
          !latest.current.readPreview
        ) {
          respond({ error: uiText('预览暂不可用') });
          return;
        }
        void latest.current
          .readPreview(data.objectId, data.revision)
          .then((preview) => {
            const current = latest.current.workspace?.objects.find((o) => o.id === data.objectId);
            if (
              latest.current.workspace?.id !== data.workspaceId ||
              !current ||
              current.archived ||
              current.revision !== data.revision
            ) {
              respond({ error: uiText('文件已变化，请重新打开') });
              return;
            }
            respond({ preview });
          })
          .catch(() => respond({ error: uiText('预览暂不可用') }));
        return;
      }
      if (
        data?.type !== 'ai-desktop:locate-outputs' ||
        typeof data.workspaceId !== 'string' ||
        !Array.isArray(data.objectIds) ||
        data.objectIds.length > 114 ||
        data.objectIds.some((id: unknown) => typeof id !== 'string')
      )
        return;
      const target = {
        workspaceId: data.workspaceId,
        objectIds: data.objectIds,
        openObject: data.openObject === true,
        previewObject: data.previewObject === true,
        target: data.target,
        commentId: typeof data.commentId === 'string' ? data.commentId : undefined,
        expectedRevisions: data.expectedRevisions,
      };
      if (data.type === 'ai-desktop:locate-outputs') void locate(target);
    }
    function searchShortcut(event: KeyboardEvent) {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'f' &&
        !event.isComposing
      ) {
        event.preventDefault();
        window.parent.postMessage({ type: 'ai-desktop:open-search' }, '*');
      }
    }
    window.addEventListener('message', receive);
    window.addEventListener('keydown', searchShortcut);
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('keydown', searchShortcut);
    };
  }, []);
  useEffect(() => {
    if (!options.workspace) return;
    try {
      const target = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (target?.workspaceId === options.workspace.id) {
        sessionStorage.removeItem(pendingKey);
        void locate(target);
      }
    } catch {}
  }, [options.workspace?.id]);
}
