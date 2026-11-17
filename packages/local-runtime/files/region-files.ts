import { existsSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fail, type CanvasGroups, type DesktopObject } from '../../contracts/index.js';
import { FileContent } from '../../contracts/index.js';
import { withinDirectory, type GeneratedFileLinks } from './generated-file-links.js';

type Region = CanvasGroups['items'][number];
type RegionFiles = {
  workspaceId: string;
  regions: Region[];
  objects: DesktopObject[];
  folder: (parts?: string[]) => string;
  hasPendingWrite: (objectId: string) => boolean;
  links: Pick<GeneratedFileLinks, 'link' | 'inspect' | 'bind' | 'materialize'>;
};

/** Resolve the region hierarchy before touching files. Folder validation belongs to the host. */
function regionParts(region: Region, regions: Region[]): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: Region | undefined = region;
  while (current) {
    if (seen.has(current.id)) fail('INVALID_PATH', '区域层级无效。');
    seen.add(current.id);
    parts.unshift(current.name);
    current = regions.find((item) => item.id === current!.parentId);
  }
  return parts;
}

function alignFile(object: DesktopObject, directory: string, root: string, api: RegionFiles) {
  const { workspaceId, links } = api;
  const file = FileContent.parse(object.content);
  const link = links.link(workspaceId, object.id);
  const destination = join(directory, file.fileName);
  if (link && link.path.toLowerCase() === destination.toLowerCase()) return;
  if (api.hasPendingWrite(object.id)) fail('FILE_SYNC_PENDING', '区域内文件正在保存，请稍后打开。');

  // Only move workspace-owned files. Linked external sources are materialized as copies.
  if (!link || !withinDirectory(root, link.path)) {
    links.materialize(workspaceId, object.id, directory, file.fileName, file.assetHash);
    return;
  }
  const disk = links.inspect(workspaceId, object.id);
  if (disk.diskHash !== file.assetHash)
    fail('FILE_SYNC_CONFLICT', '文件与磁盘尚未同步，请处理文件同步后打开区域。');
  if (existsSync(destination)) fail('NAME_CONFLICT', `区域目录已存在同名文件：${file.fileName}`);
  renameSync(link.path, destination);
  try {
    links.bind(workspaceId, object.id, destination, file.assetHash);
  } catch (error) {
    // Preserve the original disk location if updating its object binding fails.
    renameSync(destination, link.path);
    throw error;
  }
}

/** Align a region's native files with its folder, then return that folder for system opening. */
export function materializeRegionFolder(regionId: string, api: RegionFiles): { path: string } {
  const region = api.regions.find((item) => item.id === regionId && item.bounds);
  if (!region) fail('NOT_FOUND', '区域不存在。');
  const path = api.folder(regionParts(region, api.regions));
  const root = api.folder();
  const align = (current: Region, directory: string) => {
    for (const object of api.objects) {
      if (object.kind === 'file' && current.objectIds.includes(object.id))
        alignFile(object, directory, root, api);
    }
    for (const child of api.regions.filter((item) => item.parentId === current.id)) {
      const parts = relative(root, directory).split(/[\\/]/).filter(Boolean);
      align(child, api.folder([...parts, child.name]));
    }
  };
  align(region, path);
  return { path };
}
