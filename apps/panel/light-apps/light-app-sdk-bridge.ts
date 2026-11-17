import { useEffect, RefObject } from 'react';
import { browserCommand } from '../browser/electron-browser-bridge.js';
export function useAppSdkBridge(
  ref: RefObject<HTMLIFrameElement | null>,
  workspaceId: string,
  instanceId: string,
) {
  useEffect(() => {
    if (!instanceId) return;
    let live = true,
      busy = false;
    const dialogs = new Set<HTMLDialogElement>();
    const call = (operation: string, payload: any = {}) =>
      browserCommand<any>(
        'light-apps',
        { workspaceId, operation, payload: { instanceId, ...payload } },
        120000,
      );
    const confirm = (text: string) =>
      new Promise<boolean>((resolve) => {
        const d = document.createElement('dialog');
        dialogs.add(d);
        d.className = 'app-material-picker';
        const p = document.createElement('p');
        p.textContent = text;
        const yes = document.createElement('button'),
          no = document.createElement('button');
        yes.textContent = '允许本次';
        no.textContent = '取消';
        yes.onclick = () => {
          d.returnValue = 'yes';
          d.close();
        };
        no.onclick = () => d.close();
        d.append(p, yes, no);
        d.onclose = () => {
          dialogs.delete(d);
          d.remove();
          resolve(d.returnValue === 'yes');
        };
        document.body.append(d);
        d.showModal();
      });
    const pick = (items: any[]) =>
      new Promise<string[]>((resolve) => {
        const dialog = document.createElement('dialog');
        dialogs.add(dialog);
        dialog.className = 'app-material-picker';
        const title = document.createElement('h3');
        title.textContent = '选择提供给此应用的桌面材料';
        dialog.append(title);
        const selected = new Set<string>();
        for (const item of items) {
          const label = document.createElement('label'),
            check = document.createElement('input');
          check.type = 'checkbox';
          check.onchange = () => {
            check.checked ? selected.add(item.id) : selected.delete(item.id);
          };
          label.append(check, document.createTextNode(item.title));
          dialog.append(label);
        }
        const done = document.createElement('button'),
          cancel = document.createElement('button');
        done.textContent = '引用所选';
        cancel.textContent = '取消';
        done.onclick = () => {
          dialog.returnValue = 'ok';
          dialog.close();
        };
        cancel.onclick = () => dialog.close();
        dialog.append(done, cancel);
        dialog.onclose = () => {
          dialogs.delete(dialog);
          dialog.remove();
          resolve(dialog.returnValue === 'ok' ? [...selected] : []);
        };
        document.body.append(dialog);
        dialog.showModal();
      });
    const listener = async (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      const m = event.data;
      if (m?.type === 'yirang:page-error') {
        const text = String(m.message || '页面错误').slice(0, 4000);
        ref.current?.setAttribute('data-app-error', text);
        window.dispatchEvent(
          new CustomEvent('yirang:app-page-error', { detail: { instanceId, message: text } }),
        );
        return;
      }
      if (m?.type !== 'yirang:sdk' || typeof m.id !== 'string' || m.id.length > 100) return;
      const source = event.source as Window;
      const answer = (result: any, error?: string) => {
        if (live && source === ref.current?.contentWindow)
          source.postMessage({ type: 'yirang:sdk-result', id: m.id, result, error }, '*');
      };
      if (busy) {
        answer(null, '请先完成上一个宿主操作');
        return;
      }
      busy = true;
      try {
        let result;
        const prompts: Record<string, string> = {
          ask_ai: '此应用请求把任务交给 AI，并开启该实例的动作权限。是否继续？',
          outputs_import: '此应用请求将登记产出导入桌面或更新原对象。是否继续？',
          output_open: '此应用请求使用系统默认程序打开产出文件。是否继续？',
        };
        if (prompts[m.operation] && !(await confirm(prompts[m.operation])))
          throw Error('用户已取消');
        switch (m.operation) {
          case 'files_pick':
            result = await call('files_pick');
            break;
          case 'materials_pick': {
            const list = await call('materials_list'),
              ids = await pick(list.objects);
            result = ids.length
              ? await call('materials_read', { objectIds: ids })
              : { objects: [] };
            break;
          }
          case 'outputs_import':
            result = await call('outputs_import', {
              runId: m.payload?.runId,
              path: m.payload?.path,
            });
            break;
          case 'output_open':
            result = await call('output_open', { runId: m.payload?.runId, path: m.payload?.path });
            break;
          case 'ai_run':
            result = await call('ai_run', {
              capability: m.payload?.capability,
              input: m.payload?.input,
              materials: m.payload?.materials,
              requestId: m.payload?.requestId,
            });
            break;
          case 'examples_propose':
            result = await call('examples_propose', {
              runId: m.payload?.runId,
              output: m.payload?.output,
            });
            break;
          case 'ask_ai':
            result = await browserCommand('light-app-ai-task', {
              workspaceId,
              instanceId,
              task: m.payload?.task,
            });
            break;
          case 'report_error':
            window.dispatchEvent(
              new CustomEvent('yirang:app-page-error', {
                detail: { instanceId, message: String(m.payload?.message || '').slice(0, 4000) },
              }),
            );
            result = { recorded: true };
            break;
          default:
            throw Error('应用未开放此宿主能力');
        }
        answer(result);
      } catch (e: any) {
        answer(null, e.message);
      } finally {
        busy = false;
      }
    };
    window.addEventListener('message', listener);
    return () => {
      live = false;
      window.removeEventListener('message', listener);
      for (const d of dialogs) d.close();
    };
  }, [workspaceId, instanceId, ref]);
}
