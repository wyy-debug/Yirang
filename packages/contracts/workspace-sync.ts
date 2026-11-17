import type { DesktopObject, Workspace } from './index.js';

export interface WorkspaceEvent {
  seq: number;
  type: string;
  objectId: string | null;
  revision: number | null;
  actor: string;
  createdAt: string;
}

/** Values describe current saved state; the cursor acknowledges only the delivered event page. */
export interface WorkspaceDelta {
  workspaceId: string;
  after: number;
  cursor: number;
  upsert: DesktopObject[];
  removed: string[];
  name?: string;
  groups?: Workspace['groups'];
  fileTree?: Workspace['fileTree'];
  canvasBoard?: Workspace['canvasBoard'];
  view?: {
    revision: number;
    viewport: Workspace['viewport'];
    objects: { id: string; bounds: DesktopObject['bounds']; layoutRevision: number }[];
  };
}

export interface WorkspaceChanges {
  cursor: number;
  events: WorkspaceEvent[];
  hasMore: boolean;
  delta?: WorkspaceDelta;
  workspace?: Workspace;
  reset?: boolean;
}
