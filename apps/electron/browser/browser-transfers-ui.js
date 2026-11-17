import { bindUiLabel } from '../ui/ui-labels.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
export function registerBrowserTransfers({ frame, status }) {
  const modal = document.createElement('dialog');
  modal.className = 'desktop-settings';
  document.body.append(modal);
  const button = (label, action) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await action();
      } catch (error) {
        notice.textContent = error.message;
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };
  const notice = document.createElement('p');
  async function open() {
    modal.replaceChildren();
    const title = document.createElement('h2');
    bindUiLabel(title, 'textContent', '网页与桌面文件');
    modal.append(
      title,
      button(uiText('关闭'), () => modal.close()),
      notice,
    );
    notice.textContent = '';
    if (!modal.open) modal.showModal();
    const [jobs, files, targets] = await Promise.all([
      window.desktop.browser('transfers'),
      window.desktop.browser('upload-list'),
      window.desktop.browser('upload-targets').catch(() => ({ fields: [] })),
    ]);
    const upload = document.createElement('section'),
      h = document.createElement('h3'),
      select = document.createElement('select'),
      target = document.createElement('select');
    bindUiLabel(h, 'textContent', '从桌面选择文件上传');
    select.append(new Option(uiText('选择已保存的文件'), ''));
    for (const file of files.files)
      select.append(new Option(`${file.title} · v${file.revision}`, file.id));
    target.append(new Option(uiText('选择网页中的上传框'), ''));
    for (const field of targets.fields) target.append(new Option(field.label, field.id));
    upload.append(
      h,
      select,
      target,
      button(uiText('上传'), async () => {
        const file = files.files.find((file) => file.id === select.value);
        if (!file || !target.value) throw Error(uiText('请选择文件和网页上传框'));
        await window.desktop.browser('upload-file', {
          objectId: file.id,
          revision: file.revision,
          targetId: target.value,
          tabId: targets.tabId,
          url: targets.url,
        });
        bindUiLabel(notice, 'textContent', '已填入网页上传框，请在网页确认后续提交');
      }),
    );
    modal.append(upload);
    const downloads = document.createElement('section'),
      label = document.createElement('h3');
    bindUiLabel(label, 'textContent', '下载记录');
    downloads.append(label);
    for (const job of jobs) {
      const row = document.createElement('div'),
        text = document.createElement('p');
      text.textContent = `${job.fileName} · ${job.result ? uiText('已加入桌面') : job.error || uiText('等待收回')}\n${job.url}`;
      row.append(
        text,
        button(uiText('打开文件夹'), () =>
          window.desktop.browser('reveal-download', { id: job.id }),
        ),
      );
      if (job.result)
        row.append(
          button(uiText('定位桌面'), () => {
            frame.contentWindow?.postMessage(
              {
                type: 'ai-desktop:locate-outputs',
                workspaceId: job.workspaceId,
                objectIds: [job.result.id],
              },
              '*',
            );
            modal.close();
          }),
        );
      else
        row.append(
          button(uiText('重试加入桌面'), async () => {
            const result = await window.desktop.browser('retry-download', { id: job.id });
            notice.textContent = result.error || uiText('文件已加入桌面');
          }),
        );
      downloads.append(row);
    }
    if (!jobs.length) downloads.append(uiText('网页下载后会自动加入当前桌面。'));
    modal.append(downloads);
  }
  window.desktop.onEvent(({ type, payload }) => {
    if (type === 'browser-files-open')
      void open().catch((error) => {
        notice.textContent = error.message;
      });
    if (type === 'browser-file-ready')
      bindUiLabel(status, 'textContent', '已加入桌面：{0}', { 0: payload.fileName });
  });
}
