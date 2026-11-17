import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { t as uiText } from '../platform/native-ui-language.mjs';

export const desktopCodexAuthPath = (home = homedir()) => join(home, '.codex', 'auth.json');

export async function hasDesktopCodexAuth(home = homedir()) {
  const info = await lstat(desktopCodexAuthPath(home)).catch(() => null);
  return !!info?.isFile() && !info.isSymbolicLink();
}

export async function importDesktopCodexAuth(targetHome, home = homedir()) {
  const source = desktopCodexAuthPath(home);
  const target = join(targetHome, 'auth.json');
  if (resolve(source).toLowerCase() === resolve(target).toLowerCase())
    throw Error(uiText('一壤与当前 Codex 使用同一登录目录，无法导入。'));
  if (!await hasDesktopCodexAuth(home))
    throw Error(uiText('未找到当前 Codex 的本地登录文件。'));
  const auth = JSON.parse(await readFile(source, 'utf8'));
  if (auth.auth_mode !== 'chatgpt' || typeof auth.tokens?.access_token !== 'string' ||
      typeof auth.tokens?.refresh_token !== 'string')
    throw Error(uiText('当前 Codex 的登录文件不是可导入的 ChatGPT 登录。'));
  await mkdir(targetHome, { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error(uiText('一壤已有独立登录文件，未覆盖它。'));
    throw error;
  }
  return true;
}
