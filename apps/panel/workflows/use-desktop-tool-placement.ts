import { t as uiText } from '../../../packages/components/ui-language.js';
import { useEffect, useRef, useState } from 'react';
import type { DesktopObject } from '../../../packages/contracts/index.js';
import type { DesktopToolSource } from '../../../packages/contracts/desktop-tools.js';
import { writeDraftNow } from '../documents/draft-storage.js';

type Pending = { request: Record<string, unknown>; objectId?: string; legacyKey?: string };
type Options = {
  workspaceId?: string;
  blocked: () => boolean;
  busy: (value: boolean) => void;
  action: (name: string, payload?: Record<string, unknown>) => Promise<any>;
  updated: () => Promise<void>;
  placed: (id: string) => void;
};
export function useDesktopToolPlacement(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<{
      workspaceId?: string;
      pending: Pending | null;
      error: string;
    }>({ pending: null, error: '' }),
    stateRef = useRef(state),
    active = useRef(false);
  stateRef.current = state;
  const key = (id: string) => `ai-desktop:tool-placement:${id}`;
  useEffect(() => {
    const id = options.workspaceId;
    let pending: Pending | null = null,
      error = '';
    if (id)
      try {
        const raw = JSON.parse(localStorage.getItem(key(id)) ?? 'null');
        if (raw) {
          if (
            !raw.request ||
            !['desktop', 'template'].includes(raw.request.operation) ||
            typeof raw.request.requestId !== 'string'
          )
            throw Error(uiText('待确认添加记录无法读取，请保留本地记录。'));
          pending = raw;
        } else {
          const legacyKey = `ai-desktop:workflow-template:${id}`,
            legacy = JSON.parse(localStorage.getItem(legacyKey) ?? 'null');
          if (legacy?.operation === 'template' && typeof legacy.requestId === 'string') {
            const { objectId, ...request } = legacy;
            pending = { request, objectId, legacyKey };
          }
        }
      } catch (problem) {
        error = problem instanceof Error ? problem.message : String(problem);
      }
    stateRef.current = { workspaceId: id, pending, error };
    setState(stateRef.current);
  }, [options.workspaceId]);
  function commit(workspaceId: string, pending: Pending | null, error = '') {
    writeDraftNow(key(workspaceId), pending ? JSON.stringify(pending) : null);
    if (latest.current.workspaceId === workspaceId) {
      stateRef.current = { workspaceId, pending, error };
      setState(stateRef.current);
    }
  }
  async function execute(pending: Pending) {
    const ctx = latest.current,
      id = ctx.workspaceId;
    if (!id || active.current || ctx.blocked()) return;
    active.current = true;
    ctx.busy(true);
    try {
      commit(id, pending);
      let current = pending;
      if (!current.objectId) {
        const result = await ctx.action('workflow_component', current.request);
        current = { ...current, objectId: result.object.id };
        commit(id, current);
      }
      if (latest.current.workspaceId !== id) return;
      await ctx.updated();
      if (latest.current.workspaceId !== id) return;
      ctx.placed(current.objectId!);
      if (current.legacyKey) writeDraftNow(current.legacyKey, null);
      commit(id, null);
    } catch (problem) {
      if (latest.current.workspaceId === id) {
        stateRef.current = {
          ...stateRef.current,
          error: uiText('{0}；添加请求已保留，可继续收回结果。', {
            '0': problem instanceof Error ? problem.message : String(problem),
          }),
        };
        setState(stateRef.current);
      }
    } finally {
      active.current = false;
      ctx.busy(false);
    }
  }
  async function place(source: DesktopToolSource, bounds: DesktopObject['bounds']) {
    if (source.kind === 'flow') return;
    if (
      stateRef.current.pending ||
      stateRef.current.error ||
      stateRef.current.workspaceId !== latest.current.workspaceId
    )
      return;
    await execute({
      request: { operation: 'desktop', requestId: crypto.randomUUID(), source, bounds },
    });
  }
  return {
    place,
    resume: () => {
      if (stateRef.current.pending) void execute(stateRef.current.pending);
    },
    pending: !!state.pending,
    error: state.error,
  };
}
