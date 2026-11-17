import { t as uiText } from '../../../packages/components/ui-language.js';
export function registerAppSettings({ frame, status }) {
  const requests = new Map();
  let notice = null;
  window.addEventListener('message', (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.data?.type !== 'ai-desktop:maintenance-result'
    )
      return;
    const item = requests.get(event.data.id);
    if (!item) return;
    requests.delete(event.data.id);
    clearTimeout(item.timer);
    event.data.error ? item.reject(Error(event.data.error)) : item.resolve(event.data.result);
  });
  const prepare = () =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID(),
        timer = setTimeout(() => {
          requests.delete(id);
          reject(Error(uiText('备份尚未完成，请稍后重试')));
        }, 180000);
      requests.set(id, { resolve, reject, timer });
      frame.contentWindow?.postMessage({ type: 'ai-desktop:maintenance', id }, '*');
    });
  window.desktop.onEvent(({ type, payload }) => {
    if (type !== 'app-management') return;
    const text =
      payload.phase === 'error'
        ? payload.message
        : payload.phase === 'ready'
          ? payload.note || uiText('已安装 {0}，正在重新打开…', { 0: payload.version })
          : `${{ downloading: uiText('下载中'), unpacking: uiText('解压中'), installing: uiText('安装中') }[payload.phase] || uiText('处理中')}${payload.total ? ` · ${Math.round((payload.done / payload.total) * 100)}%` : ''}`;
    if (notice?.isConnected) notice.textContent = text;
    status.textContent = text;
  });
  window.addEventListener('desktop-settings-open', (event) => {
    const { sections, row, button } = event.detail;
    const localNotice = document.createElement('p'),
      information = document.createElement('p'),
      selected = document.createElement('p');
    notice = localNotice;
    localNotice.setAttribute('role', 'status');
    information.textContent = uiText('正在读取…');
    const brand = document.createElement('div'),
      mark = document.createElement('img'),
      identity = document.createElement('div'),
      name = document.createElement('strong');
    brand.className = 'settings-brand';
    mark.src = '../panel/assets/yirang.png';
    mark.width = 48;
    mark.height = 48;
    mark.alt = '';
    name.textContent = '一壤 · Yirang';
    identity.append(name, information);
    brand.append(mark, identity);
    sections.about.append(brand);
    const apply = button(uiText('安装并重新打开'), async () => {
      localNotice.textContent = uiText('正在保存工作区并备份…');
      const backup = await prepare();
      await window.desktop.app('apply', { backupId: backup.id });
    });
    apply.disabled = true;
    const choose = async (action) => {
      const result = await window.desktop.app(action);
      if (result) {
        selected.textContent = uiText('待安装版本：{0}', { 0: result.version });
        apply.disabled = false;
        pending.hidden = false;
      }
    };
    const download = button(uiText('下载安装包'), () => choose('download'));
    download.hidden = true;
    row('about', '应用更新', '更新前会自动保存当前工作区并创建备份。', [
      button(uiText('检查更新'), async () => {
        localNotice.textContent = uiText('正在检查更新…');
        const release = await window.desktop.app('check');
        localNotice.textContent = uiText(
          release.current ? '已是最新版本：{0}' : '最新发布版本：{0}',
          { 0: release.name },
        );
        download.hidden = !release.downloadable;
      }),
      download,
    ]);
    const pending = document.createElement('div');
    pending.className = 'settings-update-pending';
    pending.hidden = true;
    pending.append(selected, apply);
    sections.about.append(pending, localNotice);
    const offline = document.createElement('details'),
      offlineTitle = document.createElement('summary'),
      offlineActions = document.createElement('div');
    offlineTitle.textContent = uiText('手动安装');
    offlineActions.className = 'settings-actions';
    offlineActions.append(
      button(uiText('选择安装包（ZIP）'), () => choose('select-zip')),
      button(uiText('选择程序文件夹'), () => choose('select-folder')),
    );
    offline.append(offlineTitle, offlineActions);
    sections.about.append(offline);
    row('about', '更新日志', '查看每个版本的更新内容。', [
      button(uiText('查看更新日志'), () => window.desktop.app('releases')),
    ]);
    const rollback = button(uiText('回退到上一版本'), async () => {
      localNotice.textContent = uiText('正在保存工作区并备份…');
      notice = rollbackNotice;
      rollbackNotice.textContent = uiText('正在保存工作区并备份…');
      const backup = await prepare();
      await window.desktop.app('rollback', { backupId: backup.id });
    });
    rollback.disabled = true;
    const rollbackNotice = document.createElement('p');
    rollbackNotice.setAttribute('role', 'status');
    const recovery = row('diagnostics', '回退版本', '更新后遇到问题时，可以回到之前安装的版本。', [
      rollback,
    ]);
    const installPath = document.createElement('p');
    installPath.className = 'settings-diagnostic-path';
    row('diagnostics', '诊断报告', '导出一份用于排查问题的报告，不包含你的对话和文件内容。', [
      button(uiText('导出诊断报告'), async () => {
        const result = await window.desktop.app('diagnostics');
        if (result)
          rollbackNotice.textContent = uiText('已导出到：{0}（不包含对话和文件内容）', {
            0: result.path,
          });
      }),
    ]);
    sections.diagnostics.append(rollbackNotice);
    const startup = document.createElement('details'),
      startupTitle = document.createElement('summary'),
      startupRows = document.createElement('dl');
    startup.className = 'settings-technical-detail';
    startupTitle.textContent = uiText('启动耗时');
    startup.append(startupTitle, installPath, startupRows);
    sections.diagnostics.append(startup);
    startup.addEventListener('toggle', () => {
      if (!startup.open) return;
      void window.desktop
        .startup()
        .then((data) => {
          startupRows.replaceChildren();
          for (const [key, label] of [
            ['app-ready', '应用就绪'],
            ['shell-painted', '窗口显示'],
            ['desktop-connected', '桌面连接'],
            ['chat-painted', '对话加载'],
            ['startup-complete', '启动完成'],
          ]) {
            const value = data.milestones[key],
              term = document.createElement('dt'),
              detail = document.createElement('dd');
            term.textContent = uiText(label);
            detail.textContent = Number.isFinite(value)
              ? uiText('{0} 秒', { 0: (value / 1000).toFixed(2) })
              : uiText('尚未完成');
            startupRows.append(term, detail);
          }
        })
        .catch((error) => {
          rollbackNotice.textContent = error.message;
        });
    });
    void window.desktop
      .app('info')
      .then((info) => {
        information.textContent = uiText('版本 {0}', { 0: info.version });
        installPath.textContent = uiText('安装位置：{0}', { 0: info.installation });
        rollback.disabled = !info.current?.previous;
        if (info.selected) {
          selected.textContent = uiText('待安装版本：{0}', { 0: info.selected.version });
          apply.disabled = false;
          pending.hidden = false;
        }
      })
      .catch((error) => {
        localNotice.textContent = error.message;
      });
    const documentInfo = document.createElement('p');
    documentInfo.setAttribute('role', 'status');
    row('extensions', '文档预览与文字识别', '查看 Office 排版预览和图片文字识别是否可用。', [
      button(uiText('检查是否可用'), async () => {
        const result = await window.desktop.browser('document-capabilities');
        documentInfo.textContent = uiText('排版预览：{0}\n文字识别语言：{1}', {
          0: result.office || uiText('不可用（未安装 LibreOffice）'),
          1:
            result.languages?.map((item) => item.name || item.tag).join(', ') ||
            result.ocrError ||
            uiText('没有可用的识别语言'),
        });
      }),
    ]);
    sections.extensions.append(documentInfo);
    const office = document.createElement('details'),
      officeTitle = document.createElement('summary'),
      officeActions = document.createElement('div');
    officeTitle.textContent = uiText('配置 LibreOffice');
    officeActions.className = 'settings-actions';
    officeActions.append(
      button(uiText('选择 LibreOffice 程序'), async () => {
        const result = await window.desktop.browser('document-choose-office');
        if (result) documentInfo.textContent = uiText('已选择：{0}', { 0: result.path });
      }),
      button(uiText('下载 LibreOffice'), () =>
        window.desktop.openLink('https://www.libreoffice.org/download/download-libreoffice/'),
      ),
    );
    office.append(officeTitle, officeActions);
    sections.extensions.append(office);
  });
}
