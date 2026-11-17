import { resolve, join } from 'node:path';

// Yirang owns one Codex CLI history across its workspaces. Never inherit the
// parent Codex desktop's CODEX_HOME by accident.
export function resolveYirangCodexHome(profile, env = process.env) {
  return resolve(env.AI_DESKTOP_CODEX_HOME || join(profile, 'codex-cli-home'));
}

export function removeInheritedCodexSession(env) {
  for (const name of Object.keys(env))
    if (/^CODEX_/i.test(name)) delete env[name];
}
