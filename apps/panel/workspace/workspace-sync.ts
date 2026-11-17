import type { DesktopObject, Workspace } from '../../../packages/contracts/index.js';
import type { WorkspaceDelta } from '../../../packages/contracts/workspace-sync.js';

function sameBounds(a: DesktopObject['bounds'], b: DesktopObject['bounds']) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Keep references for unchanged content so canvas cards and editors can remain mounted and idle. */
function mergeObject(previous: DesktopObject | undefined, incoming: DesktopObject): DesktopObject {
  if (!previous) return incoming;
  const content = previous.revision >= incoming.revision ? previous : incoming;
  const layout = previous.layoutRevision >= incoming.layoutRevision ? previous : incoming;
  const policy =
    (previous.policy?.revision ?? 0) >= (incoming.policy?.revision ?? 0)
      ? previous.policy
      : incoming.policy;
  if (
    content === previous &&
    layout === previous &&
    policy === previous.policy &&
    previous.title === incoming.title &&
    previous.kind === incoming.kind &&
    previous.sourceFileName === incoming.sourceFileName &&
    previous.archived === incoming.archived &&
    JSON.stringify(previous.generation) === JSON.stringify(incoming.generation)
  )
    return previous;
  return {
    ...incoming,
    content: content.content,
    revision: content.revision,
    updatedAt: content.updatedAt,
    lastActor: content.lastActor,
    dataUrl: content.dataUrl,
    bounds: layout.bounds,
    layoutRevision: layout.layoutRevision,
    policy,
  };
}

export function mergeWorkspaceDelta(current: Workspace, delta: WorkspaceDelta): Workspace {
  // A reload or workspace switch may have overtaken this request. Poll again from its actual cursor.
  if (
    current.id !== delta.workspaceId ||
    current.cursor !== delta.after ||
    delta.cursor < delta.after
  )
    return current;
  let objects = current.objects;
  if (delta.upsert.length || delta.removed.length) {
    const removed = new Set(delta.removed),
      incoming = new Map(delta.upsert.map((o) => [o.id, o]));
    const next: DesktopObject[] = [];
    let changed = false;
    for (const previous of objects) {
      if (removed.has(previous.id)) {
        changed = true;
        incoming.delete(previous.id);
        continue;
      }
      const value = incoming.get(previous.id);
      incoming.delete(previous.id);
      const object = value ? mergeObject(previous, value) : previous;
      next.push(object);
      changed ||= object !== previous;
    }
    for (const object of incoming.values()) {
      if (!removed.has(object.id)) {
        next.push(object);
        changed = true;
      }
    }
    if (changed) objects = next;
  }
  let viewport = current.viewport,
    viewRevision = current.viewRevision;
  if (delta.view && delta.view.revision >= viewRevision) {
    const view = delta.view,
      layouts = new Map(view.objects.map((o) => [o.id, o]));
    let changed = false;
    const next = objects.map((object) => {
      const layout = layouts.get(object.id);
      if (
        !layout ||
        layout.layoutRevision < object.layoutRevision ||
        (layout.layoutRevision === object.layoutRevision &&
          sameBounds(layout.bounds, object.bounds))
      )
        return object;
      changed = true;
      return { ...object, bounds: layout.bounds, layoutRevision: layout.layoutRevision };
    });
    if (changed) objects = next;
    if (view.revision > viewRevision) {
      viewport = view.viewport;
      viewRevision = view.revision;
    }
  }
  const name = delta.name ?? current.name;
  const groups =
    delta.groups && delta.groups.revision > current.groups.revision ? delta.groups : current.groups;
  const fileTree =
    delta.fileTree && delta.fileTree.revision > (current.fileTree?.revision ?? -1)
      ? delta.fileTree
      : current.fileTree;
  const canvasBoard =
    delta.canvasBoard && delta.canvasBoard.revision > (current.canvasBoard?.revision ?? -1)
      ? delta.canvasBoard
      : current.canvasBoard;
  if (
    current.cursor === delta.cursor &&
    objects === current.objects &&
    name === current.name &&
    groups === current.groups &&
    fileTree === current.fileTree &&
    canvasBoard === current.canvasBoard &&
    viewRevision === current.viewRevision
  )
    return current;
  return {
    ...current,
    cursor: delta.cursor,
    objects,
    name,
    groups,
    fileTree,
    canvasBoard,
    viewport,
    viewRevision,
  };
}
