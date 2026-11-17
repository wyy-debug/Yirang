import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadTools, carriedHistory } from '../apps/electron/work/work-thread-reuse.mjs';

test('the tools a thread started with are read from its session header', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'thread-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const withTools = join(dir, 'a.jsonl'),
    without = join(dir, 'b.jsonl'),
    broken = join(dir, 'c.jsonl');
  writeFileSync(
    withTools,
    JSON.stringify({
      type: 'session_meta',
      payload: { dynamic_tools: [{ name: 'organize_work' }, { name: 'report_status' }] },
    }) + '\n{"type":"event_msg"}\n',
  );
  writeFileSync(without, JSON.stringify({ type: 'session_meta', payload: {} }) + '\n');
  writeFileSync(broken, 'not json\n');
  assert.deepEqual(await threadTools(withTools), ['organize_work', 'report_status']);
  assert.deepEqual(await threadTools(without), []);
  assert.equal(await threadTools(broken), null);
  assert.equal(await threadTools(join(dir, 'missing.jsonl')).catch(() => null), null);
  assert.equal(await threadTools(undefined), null);
});

test('an earlier execution carries its words, newest first within the budget', () => {
  const turn = (user: string, ai: string) => ({
    items: [
      {
        type: 'userMessage',
        content: [
          { type: 'text', text: user },
          { type: 'text', text: '{"type":"yirang.turn-context"}' },
        ],
      },
      { type: 'agentMessage', text: ai },
    ],
  });
  // readChatHistory returns newest first.
  const turns = [turn('改成蓝色', '已改成蓝色'), turn('画一张架构图', '已画好 3 个模块')];
  const text = carriedHistory(turns);
  assert.ok(text.indexOf('画一张架构图') < text.indexOf('改成蓝色'), 'reads in time order');
  assert.doesNotMatch(text, /yirang\.turn-context/, 'internal context is not carried');
  assert.match(carriedHistory(turns, 20), /已改成蓝色/, 'the newest turn survives a tight budget');
  assert.doesNotMatch(carriedHistory(turns, 20), /架构图/);
  assert.equal(carriedHistory([]), '');
});
