import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Codex records the tools a thread was started with in the first line of its
// session file, and thread/resume cannot add any. Reading that line tells us
// whether an old execution conversation can still report progress.
export async function threadTools(path) {
  if (!path) return null;
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) });
  try {
    for await (const line of lines) {
      const meta = JSON.parse(line);
      if (meta.type !== 'session_meta') return null;
      return (meta.payload?.dynamic_tools || []).map((tool) => tool.name);
    }
  } catch {
    return null;
  } finally {
    lines.close();
  }
  return null;
}

// When a work moves to a new execution conversation, the earlier one still
// holds what the agent already did. Carry its words over, newest kept first,
// so the new run starts from where the old one stopped instead of from zero.
export function carriedHistory(turns, budget = 8000) {
  const lines = [];
  let used = 0;
  for (const turn of turns) {
    const said = [];
    for (const item of turn.items || []) {
      const text =
        item.type === 'agentMessage'
          ? item.text
          : item.type === 'userMessage'
            ? (item.content || [])
                .filter((c) => c.type === 'text' && !c.text.trimStart().startsWith('{'))
                .map((c) => c.text)
                .join('\n')
            : '';
      if (text?.trim())
        said.push(`${item.type === 'agentMessage' ? 'AI' : '要求'}：${text.trim()}`);
    }
    const block = said.join('\n');
    if (!block) continue;
    if (used + block.length > budget) {
      if (!lines.length) lines.push(block.slice(-budget));
      break;
    }
    lines.push(block);
    used += block.length;
  }
  return lines.reverse().join('\n\n');
}
