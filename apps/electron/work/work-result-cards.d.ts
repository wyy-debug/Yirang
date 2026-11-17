export type WorkPreviewTarget = { workspaceId: string; objectId: string; revision: number };
export type WorkPreview = { kind: string; [key: string]: unknown };
export type WorkPreviewReader = (target: WorkPreviewTarget) => Promise<WorkPreview>;
export function createWorkPreviewClient(frame: HTMLIFrameElement): WorkPreviewReader;
export function createWorkPreviewLoader(read: WorkPreviewReader): WorkPreviewReader;
export function createWorkResultCard(options: {
  artifact: { objectId: string; title: string; revision: number };
  workspaceId: string;
  load?: WorkPreviewReader;
  open: (target: unknown) => unknown;
  status: (message: string) => void;
}): { element: HTMLButtonElement; dispose: () => void };
