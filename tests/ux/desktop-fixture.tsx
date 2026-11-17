// Real product components; only the Electron IPC boundary is simulated.
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  AppNotificationBar,
  useLightAppPages,
  LightAppPageDeck,
} from '../../apps/panel/light-apps/light-app-pages';
import { DesktopContextMenu } from '../../apps/panel/ui/desktop-actions';
import { useScreenshotAi } from '../../apps/panel/interaction/use-screenshot-ai';
import { DesktopPreview } from '../../apps/panel/documents/desktop-preview';
import type { DesktopObject } from '../../packages/contracts/index';
import '../../apps/electron/design-tokens.css';
import '../../apps/panel/styles.css';
import '../../apps/panel/workbench-theme.css';
import '../../apps/panel/canvas/canvas-analysis.css';

const lab: any = window;
lab.ux = {
  requests: [],
  pending: [],
  hold: false,
  failClear: false,
  commits: [],
  actions: [],
  notes: Array.from({ length: 100 }, (_, i) => ({
    id: 'notice-' + i,
    instanceId: 'app',
    workspaceId: 'a',
    workspaceName: '测试桌面',
    appName: '测试应用',
    title: '任务 ' + i,
    createdAt: Date.now() - i * 1000,
    read: false,
  })),
};
const state = lab.ux;
const reply = (request: any, result: any, error?: string) =>
  window.postMessage({ type: 'ai-desktop:browser-result', id: request.id, result, error }, '*');
state.release = () => {
  const request = state.pending.shift();
  if (request) reply(request.message, request.snapshot);
};
window.addEventListener('message', (event) => {
  const m = event.data;
  if (m?.type !== 'ai-desktop:browser-request') return;
  if (m.action === 'canvas-capture') {
    state.capture = m.payload;
    reply(m, { mimeType: 'image/png', data: 'fixture' });
    return;
  }
  state.requests.push(m.payload);
  const operation = m.payload.operation;
  if (operation === 'desktop_catalog') {
    const snapshot = {
      instances: [
        {
          id: 'app',
          workspaceId: m.payload.workspaceId,
          name: '测试应用',
          unread: state.notes.length,
        },
      ],
      notifications: structuredClone(state.notes),
    };
    if (state.hold) state.pending.push({ message: m, snapshot });
    else reply(m, snapshot);
  } else if (operation === 'desktop_notifications_clear') {
    if (state.failClear) reply(m, null, '通知存储暂时不可用');
    else {
      state.notes = [];
      reply(m, { cleared: true });
    }
  } else if (operation === 'open')
    reply(m, { url: 'data:text/html,<html lang=zh-CN><body>测试轻应用页面</body></html>' });
  else reply(m, {});
});
function Fixture() {
  const [work, setWork] = React.useState(false);
  const [preview, setPreview] = React.useState(false);
  React.useEffect(() => {
    const respond = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type === 'yirang:work-command')
        window.postMessage(
          {
            type: 'yirang:work-response',
            requestId: m.requestId,
            value: {
              workspaceId: 'a',
              tasks: [],
              goals: [],
              notices: [],
              hostCondition: '保持一壤打开以执行工作',
              capabilities: { maxConcurrent: 3 },
            },
          },
          '*',
        );
    };
    window.addEventListener('message', respond);
    return () => window.removeEventListener('message', respond);
  }, []);
  const [workspace, setWorkspace] = React.useState('a'),
    [menu, setMenu] = React.useState<any>(null);
  const apps = useLightAppPages(workspace);
  const canvas = React.useRef<HTMLElement>(null),
    [notice, setNotice] = React.useState('');
  const previewFile = {
    id: 'report',
    kind: 'text',
    title: '报告.md',
    revision: 2,
    content: { blocks: [{ id: 'text', text: '# 预览测试' }] },
  } as DesktopObject;
  const screenshot = useScreenshotAi({
    workspace: { id: workspace, objects: [previewFile] } as any,
    canvas,
    preview: preview ? previewFile : undefined,
    enabled: true,
    bridge: { supportsSendImages: () => true, epoch: () => 0 } as any,
    flush: async () => {},
    notice: setNotice,
  });
  const commands = [
    { id: 'disabled', label: '打开编辑', disabled: true },
    { id: 'zip', label: '打包导出 ZIP' },
    { id: 'delete', label: '移到回收站' },
  ].map((x) => ({ ...x, run: () => state.actions.push(x.id) }));
  return (
    <main data-active-app={apps.active} style={{ padding: 24, minHeight: 900 }}>
      <div ref={canvas} style={{ position: 'fixed', inset: '0 0 0 155px', pointerEvents: 'none' }} />
      <button onClick={screenshot.begin}>截图问 AI</button>
      <button onClick={() => setPreview(true)}>预览测试文件</button>
      {preview && (
        <DesktopPreview
          object={previewFile}
          action={async () => {}}
          close={() => setPreview(false)}
          edit={() => {}}
        />
      )}
      <output aria-label="截图提示">{notice}</output>
      {screenshot.layer}
      <button onClick={() => setWorkspace((w) => (w === 'a' ? 'b' : 'a'))}>切换桌面</button>
      <output aria-label="当前桌面">{workspace}</output>
      <button onClick={() => window.dispatchEvent(new Event('yirang:apps-changed'))}>
        刷新应用
      </button>
      <button onClick={() => apps.setActive('app')}>打开测试应用</button>
      <div style={{ position: 'relative', height: apps.active ? 680 : 0 }}>
        <LightAppPageDeck
          workspaceId={workspace}
          active={apps.active}
          items={apps.items}
          setActive={apps.setActive}
        />
      </div>
      <AppNotificationBar
        items={apps.notifications}
        error={apps.catalogError}
        clear={apps.clearNotifications}
        open={(item) => state.actions.push(item.id)}
      />
      <button
        style={{ position: 'fixed', right: 4, bottom: 4 }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        所选材料
      </button>
      {menu && <DesktopContextMenu {...menu} items={commands} close={() => setMenu(null)} />}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.Profiler
    id="fixture"
    onRender={(_id, phase, duration) => state.commits.push({ phase, duration })}
  >
    <Fixture />
  </React.Profiler>,
);
