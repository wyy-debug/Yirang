import { useEffect, useState } from 'react';
import type { WorkspaceEvent } from '../../../packages/contracts/workspace-sync.js';

const eventName = 'ai-desktop:workspace-data-changed';
type Scope = 'trash' | 'tasks' | 'runs' | 'artifacts' | 'components' | 'search' | 'activity';
type Change = { workspaceId: string; events?: WorkspaceEvent[] };
const objectChanged = (type: string) =>
  type.startsWith('object.') &&
  !['object.read', 'object.exported', 'object.referenced'].includes(type);
function relevant(scope: Scope, type: string) {
  if (type === 'workspace.restored') return true;
  switch (scope) {
    case 'trash':
    case 'components':
    case 'search':
      return objectChanged(type);
    case 'tasks':
      return objectChanged(type) || /^(worktask|task|native_file|local_run)\./.test(type);
    case 'runs':
      return /^(local_run|selection|native_file)\./.test(type) || objectChanged(type);
    case 'artifacts':
      return type.startsWith('artifact.');
    case 'activity':
      return (
        /^(worktask|task|native_file|local_run)\./.test(type) ||
        type === 'object.read' ||
        objectChanged(type)
      );
  }
}

/** Publish only accepted sync events; transport/status renders do not invalidate lists. */
export function notifyWorkspaceChange(workspaceId: string, events?: WorkspaceEvent[]) {
  if (events && !events.length) return;
  window.dispatchEvent(new CustomEvent<Change>(eventName, { detail: { workspaceId, events } }));
}
export function useWorkspaceRefresh(workspaceId: string | undefined, scope: Scope) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const receive = (event: Event) => {
      const change = (event as CustomEvent<Change>).detail;
      if (
        change.workspaceId === workspaceId &&
        (!change.events || change.events.some((item) => relevant(scope, item.type)))
      )
        setRevision((value) => value + 1);
    };
    window.addEventListener(eventName, receive);
    return () => window.removeEventListener(eventName, receive);
  }, [workspaceId, scope]);
  return revision;
}

/** Keep equal responses referentially stable during background synchronization. */
export function retainEqual<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
