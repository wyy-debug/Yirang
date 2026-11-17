import { createHash } from 'node:crypto';
import { lstat, readdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { WORKFLOW_TOOL_SNAPSHOT, WORKFLOW_TOOL_SNAPSHOT_AT } from './workflow-tool-snapshot.js';
import { nativeBridge } from '../../mcp-adapter/native-bridge.js';

export type WorkflowCatalogSkill = { id: string; name: string; description: string; path: string };
export type WorkflowCatalogTool = {
  name: string;
  description: string;
  server: string;
  available?: boolean;
  inputSchema?: any;
  authStatus?: string;
};
export type WorkflowCatalog = {
  skills: WorkflowCatalogSkill[];
  tools: WorkflowCatalogTool[];
  capturedAt: string;
  source: string;
};

const MAX_DIRECTORIES = 2000;
const MAX_ENTRIES_PER_DIRECTORY = 256;
const MAX_SKILLS = 1000;
const MAX_FRONTMATTER_BYTES = 65536;
type ScanBudget = { directories: number; files: number };

// Catalog entries are descriptive data. Do not execute their contents or treat a
// cached tool as available, authorized, or an instruction to invoke it.
async function plainDirectory(path: string) {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function directoryBelow(root: string, parts: string[]) {
  let current = root;
  if (!(await plainDirectory(current))) return null;
  for (const part of parts) {
    current = join(current, part);
    if (!(await plainDirectory(current))) return null;
  }
  return current;
}

async function entries(path: string, budget: ScanBudget) {
  if (budget.directories >= MAX_DIRECTORIES) return [];
  budget.directories++;
  try {
    // Each traversal stays in the two fixed catalog roots and refuses junctions
    // and symlinks. No plugin configuration or credential files are read.
    if (!(await plainDirectory(path))) return [];
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES_PER_DIRECTORY);
  } catch {
    return [];
  }
}

function scalar(value: string) {
  const input = value.trim();
  if (input.startsWith('"') && input.endsWith('"')) {
    try {
      return String(JSON.parse(input));
    } catch {
      return input.slice(1, -1);
    }
  }
  if (input.startsWith("'") && input.endsWith("'")) return input.slice(1, -1).replace(/''/g, "'");
  return input.replace(/\s+#.*$/, '').trim();
}

function frontmatter(text: string) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return null;
  const fields: Record<string, string> = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index++) {
    const field = /^(name|description):[ \t]*(.*)$/.exec(lines[index]);
    if (!field) continue;
    const key = field[1],
      value = field[2].trim();
    if (/^[>|][-+]?\s*$/.test(value) || value === '') {
      const continuation: string[] = [];
      while (
        index + 1 < lines.length &&
        (/^[ \t]+\S/.test(lines[index + 1]) || !lines[index + 1].trim())
      ) {
        continuation.push(lines[++index].trim());
      }
      fields[key] = continuation.join(' ').trim();
    } else fields[key] = scalar(value);
  }
  return fields;
}

async function readSkill(
  path: string,
  base: string,
  budget: ScanBudget,
): Promise<WorkflowCatalogSkill | null> {
  if (budget.files >= MAX_SKILLS) return null;
  budget.files++;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(Math.min(info.size, MAX_FRONTMATTER_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const metadata = frontmatter(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!metadata) return null;
    const localPath = relative(base, path).split(sep).join('/');
    const id = createHash('sha256')
      .update(process.platform === 'win32' ? localPath.toLowerCase() : localPath)
      .digest('hex')
      .slice(0, 24);
    return {
      id: `skill-${id}`,
      name: (metadata.name || basename(join(path, '..'))).replace(/\s+/g, ' ').trim().slice(0, 160),
      description: (metadata.description || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
      path,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function scanSkills(
  directory: string,
  base: string,
  budget: ScanBudget,
  result: WorkflowCatalogSkill[],
  depth = 0,
): Promise<void> {
  if (depth > 5 || result.length >= MAX_SKILLS || budget.files >= MAX_SKILLS) return;
  const items = await entries(directory, budget);
  const skillFile = items.find(
    (entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md',
  );
  if (skillFile) {
    const skill = await readSkill(join(directory, skillFile.name), base, budget);
    if (skill) result.push(skill);
    // Supporting files may contain other Markdown, executables and private
    // material. A skill root is a leaf for this metadata-only scanner.
    return;
  }
  for (const item of items) {
    if (
      !item.isDirectory() ||
      ['node_modules', '.git', 'references', 'scripts', 'assets', 'examples', 'templates'].includes(
        item.name,
      )
    )
      continue;
    await scanSkills(join(directory, item.name), base, budget, result, depth + 1);
    if (result.length >= MAX_SKILLS || budget.directories >= MAX_DIRECTORIES) break;
  }
}

function compareVersions(a: string, b: string) {
  const av = a.split(/[.+-]/).slice(0, 3).map(Number),
    bv = b.split(/[.+-]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = (bv[index] || 0) - (av[index] || 0);
    if (delta) return delta;
  }
  const prereleaseA = a.includes('-'),
    prereleaseB = b.includes('-');
  if (prereleaseA !== prereleaseB) return prereleaseA ? 1 : -1;
  return b.localeCompare(a, undefined, { numeric: true });
}

export async function workflowCatalog(): Promise<WorkflowCatalog> {
  if (process.env.AI_DESKTOP_BRIDGE_URL) return nativeBridge('inventory', { refresh: true });
  const base = join(homedir(), '.codex');
  const skills: WorkflowCatalogSkill[] = [];
  const budget: ScanBudget = { directories: 0, files: 0 };
  const userSkills = await directoryBelow(base, ['skills']);
  if (userSkills) await scanSkills(userSkills, base, budget, skills);
  const cache = await directoryBelow(base, ['plugins', 'cache']);
  if (cache) {
    for (const market of await entries(cache, budget)) {
      if (!market.isDirectory()) continue;
      const marketplace = join(cache, market.name);
      for (const plugin of await entries(marketplace, budget)) {
        if (!plugin.isDirectory()) continue;
        const pluginRoot = join(marketplace, plugin.name);
        const versions = (await entries(pluginRoot, budget))
          .filter(
            (entry) =>
              entry.isDirectory() && /^\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(entry.name),
          )
          .sort((a, b) => compareVersions(a.name, b.name));
        const newest = versions[0];
        if (!newest) continue;
        const pluginSkills = await directoryBelow(pluginRoot, [newest.name, 'skills']);
        if (pluginSkills) await scanSkills(pluginSkills, base, budget, skills);
        if (skills.length >= MAX_SKILLS || budget.directories >= MAX_DIRECTORIES) break;
      }
      if (skills.length >= MAX_SKILLS || budget.directories >= MAX_DIRECTORIES) break;
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return {
    skills,
    tools: WORKFLOW_TOOL_SNAPSHOT.map((tool) => ({ ...tool })),
    capturedAt: new Date().toISOString(),
    source: `本机 Skill 元数据（用户目录和插件缓存的最新版本）；MCP 工具为 ${WORKFLOW_TOOL_SNAPSHOT_AT} 的名称与说明快照，实际可用性和权限以原对话为准。`,
  };
}
