import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnActivity } from '../apps/electron/conversation/turn-activity.js';
import { chatProviderMismatch } from '../apps/electron/conversation/provider-mismatch.js';

function conversation() {
  const doc = { createElement: () => new Element() };
  class Element {
    ownerDocument = doc;
    dataset = {};
    children = [];
    parentNode = null;
    textContent = '';
    setAttribute() {}
    get lastElementChild() {
      return this.children.at(-1);
    }
    append(...nodes) {
      for (const node of nodes) this.insertBefore(node, null);
    }
    insertBefore(node, next) {
      node.remove();
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, node);
      node.parentNode = this;
    }
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    }
  }
  const messages = doc.createElement();
  return { messages, activity: createTurnActivity(messages) };
}

test('chat keeps command results in order and updates the live row in place', () => {
  const { messages, activity } = conversation();
  const command = { id: 'command-1', type: 'commandExecution', status: 'inProgress' };
  activity.showPending(true, 'turn');
  const placeholder = messages.lastElementChild;
  activity.record('turn', command, true);
  activity.showPending(true, 'turn');
  const row = messages.lastElementChild;
  assert.deepEqual(messages.children, [row]);
  assert.equal(row.children[1].textContent, '正在运行命令');
  assert.equal(row.dataset.running, 'true');
  assert.equal(activity.record('turn', command, true), false);

  activity.record('turn', { ...command, status: 'completed', exitCode: 0 });
  activity.showPending(true, 'turn');
  const reply = messages.ownerDocument.createElement();
  activity.append(reply);
  assert.deepEqual(messages.children, [row, reply, placeholder]);
  assert.equal(row.children[1].textContent, '运行了命令');
  activity.showPending(false, 'turn');
  assert.deepEqual(messages.children, [row, reply]);
});

test('ending a turn distinguishes failed commands from missing final results', () => {
  const { messages, activity } = conversation();
  const command = { id: 'command', type: 'commandExecution', status: 'inProgress' };
  activity.record('turn', command, true);
  activity.record('turn', { id: 'tool', type: 'mcpToolCall', status: 'inProgress' }, true);
  activity.finish('turn', [{ ...command, status: 'completed', exitCode: 1 }]);
  assert.deepEqual(
    messages.children.map((row) => [row.children[1].textContent, row.dataset.running]),
    [['命令执行失败', 'false'], ['操作状态未确认', 'false']],
  );
});

test('only the provider mismatch rejection opens provider recovery', () => {
  assert.deepEqual(
    chatProviderMismatch(new Error(
      "Error invoking remote method 'desktop:send': Error: This chat uses openai, but your current provider is yirang_gateway. Switch to openai to continue.",
    )),
    { original: 'openai', current: 'yirang_gateway' },
  );
  assert.equal(chatProviderMismatch(new Error('Codex connection closed')), null);
});
