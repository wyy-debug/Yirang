import { mkdirSync } from 'node:fs';
import { fail, FileContent, type DesktopObject } from '../../contracts/index.js';
import type { GeneratedFileLinks } from './generated-file-links.js';

type SystemOpenFiles = {
  workspaceId: string;
  directory: () => string;
  pendingWrite: (objectId: string) => { error?: string } | undefined;
  links: Pick<GeneratedFileLinks, 'link' | 'materialize' | 'inspect' | 'flush'>;
};

/** Prepare a native path after the host has checked workspace, revision and edit ownership. */
export function prepareSystemOpen(object: DesktopObject, api: SystemOpenFiles) {
  const { workspaceId, links } = api;
  const file = FileContent.parse(object.content);
  if (!links.link(workspaceId, object.id)) {
    const directory = api.directory();
    mkdirSync(directory, { recursive: true });
    links.materialize(workspaceId, object.id, directory, file.fileName, file.assetHash);
  }

  const pending = api.pendingWrite(object.id);
  if (pending) {
    if (pending.error) fail('FILE_SYNC_CONFLICT', `${pending.error}。请先在文件同步中处理。`);
    links.flush(workspaceId);
    return { pending: true as const };
  }

  const disk = links.inspect(workspaceId, object.id);
  const link = links.link(workspaceId, object.id)!;
  if (disk.missing) fail('FILE_MISSING', '原文件已移动或删除，请在文件同步中重新关联。');
  if (disk.desktopHash !== disk.diskHash && disk.desktopHash !== link.diskHash)
    fail('FILE_SYNC_CONFLICT', '桌面与磁盘内容尚未同步，请先在文件同步中处理。');
  return { pending: false as const, path: disk.path, fileName: file.fileName, objectId: object.id };
}
