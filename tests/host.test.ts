import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSelection, type Bridge } from '../apps/panel/host.js';
import type { PanelBinding } from '../packages/contracts/index.js';

function fixture() {
  let generation = 0,
    visible = true,
    sent = 0;
  const order: string[] = [];
  const binding: PanelBinding = {
    workspaceId: 'w',
    credential: 'private',
    panelInstanceId: 'p',
    hostSessionRef: 'A',
    messageRouteAvailable: true,
  };
  const bridge: Bridge = {
    call: async () => ({ hostSessionRef: 'A', messageRouteAvailable: true }),
    attach: async () => {
      sent++;
      order.push('attach');
      return { mode: 'context' };
    },
    send: async () => {
      throw Error('attachment must not submit a message');
    },
    supportsImages: () => true,
    supportsAttachments: () => true,
    supportsSend: () => true,
    supportsSendImages: () => true,
    onInitial: () => {},
    connect: async () => {},
    epoch: () => generation,
    visible: () => visible,
  };
  return {
    binding,
    bridge,
    order,
    get sent() {
      return sent;
    },
    switch: () => {
      generation++;
    },
    hide: () => {
      visible = false;
    },
  };
}
test('save completes before prepare, probe and one attachment', async () => {
  const f = fixture();
  const snapshot = await attachSelection(
    f.bridge,
    f.binding,
    async () => {
      f.order.push('save');
    },
    async () => {
      f.order.push('prepare');
      return {
        content: [{ type: 'image', mimeType: 'image/png', data: 'bytes' }],
        snapshotId: 's',
        objects: [],
      };
    },
  );
  assert.equal(snapshot.selection.snapshotId, 's');
  assert.deepEqual(f.order, ['save', 'prepare', 'attach']);
  assert.equal(f.sent, 1);
});
for (const phase of ['save', 'prepare', 'probe']) {
  test(`switch A to B during ${phase} never invokes host attachment`, async () => {
    const f = fixture();
    if (phase === 'probe')
      f.bridge.call = async () => {
        f.switch();
        return { hostSessionRef: 'B', messageRouteAvailable: true };
      };
    await assert.rejects(
      attachSelection(
        f.bridge,
        f.binding,
        async () => {
          if (phase === 'save') f.switch();
        },
        async () => {
          if (phase === 'prepare') f.switch();
          return { content: [], snapshotId: 's', objects: [] };
        },
      ),
    );
    assert.equal(f.sent, 0);
  });
}
test('unverified host cannot perform any context or draft side effect', async () => {
  const f = fixture();
  f.binding.messageRouteAvailable = false;
  await assert.rejects(
    attachSelection(
      f.bridge,
      f.binding,
      async () => {
        throw Error('must not save');
      },
      async () => {
        throw Error('must not prepare');
      },
    ),
    /引用材料/,
  );
  assert.equal(f.sent, 0);
});
test('hidden panel or unsupported image modality leaves instruction local', async () => {
  const f = fixture();
  f.hide();
  await assert.rejects(
    attachSelection(
      f.bridge,
      f.binding,
      async () => {},
      async () => ({ content: [], snapshotId: 's', objects: [] }),
    ),
  );
  assert.equal(f.sent, 0);
  const g = fixture();
  g.bridge.supportsImages = () => false;
  await assert.rejects(
    attachSelection(
      g.bridge,
      g.binding,
      async () => {},
      async () => ({
        content: [{ type: 'image', mimeType: 'image/png', data: 'x' }],
        snapshotId: 's',
        objects: [],
      }),
    ),
    /图片材料/,
  );
  assert.equal(g.sent, 0);
});
test('unknown send outcome is recorded and never retried automatically', async () => {
  const f = fixture();
  let attempts = 0,
    recorded = false;
  f.bridge.attach = async () => {
    attempts++;
    throw Error('disconnect');
  };
  f.bridge.call = async (name, args) => {
    if (args.action === 'delivery') recorded = true;
    return { hostSessionRef: 'A', messageRouteAvailable: true };
  };
  await assert.rejects(
    attachSelection(
      f.bridge,
      f.binding,
      async () => {},
      async () => ({ content: [], snapshotId: 's', objects: [] }),
    ),
    /结果未知/,
  );
  assert.equal(attempts, 1);
  assert.equal(recorded, true);
});
