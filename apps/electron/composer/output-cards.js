import { bindUiLabel } from '../ui/ui-labels.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import { localImage } from '../conversation/chat-markdown.js';
export function createOutputCards({ messages, frame, surface, status }) {
  const cards = new Map(),
    retrying = new Set();
  function place(record) {
    const { card, batch } = record;
    // A batch belongs to its CLI turn, never to whichever message happens to be last.
    const anchors = [...messages.children].filter(
      (node) => !node.classList.contains('output-batch') && node.dataset.turnId === batch.turnId,
    );
    const anchor = batch.turnId ? anchors.at(-1) : null;
    if (!anchor) {
      card.remove();
      return;
    }
    let after = anchor;
    while (
      after.nextElementSibling?.classList.contains('output-batch') &&
      after.nextElementSibling !== card &&
      after.nextElementSibling.dataset.turnId === batch.turnId
    )
      after = after.nextElementSibling;
    if (after.nextElementSibling !== card) after.after(card);
  }
  function reflow() {
    for (const record of cards.values()) place(record);
  }
  function button(label, action, className = '') {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.className = className;
    node.onclick = action;
    return node;
  }
  return {
    reset() {
      for (const { card } of cards.values()) card.remove();
      cards.clear();
    },
    reflow,
    update(batch) {
      const files = [
          ...new Map(
            (batch.files || [])
              .filter((file) => file.objectId && file.hash)
              .map((file) => [file.objectId, file]),
          ).values(),
        ],
        issues = batch.issues || [];
      // The chat already shows running progress. No result and no issue need no extra card.
      if (!files.length && !issues.length) {
        cards.get(batch.id)?.card.remove();
        cards.delete(batch.id);
        return;
      }
      let record = cards.get(batch.id);
      const signature = JSON.stringify([
        batch.turnId,
        batch.state,
        batch.title,
        batch.directory,
        batch.workspaceId,
        batch.sources,
        files,
        issues,
      ]);
      if (record?.signature === signature) {
        place(record);
        return;
      }
      if (!record) {
        const card = document.createElement('section');
        card.className = 'message output-batch output-compact';
        record = { card, batch, signature: null };
        cards.set(batch.id, record);
      }
      const { card } = record,
        expanded = new Set(
          [...card.querySelectorAll('details[open]')].map((node) => node.dataset.outputDetail),
        );
      record.batch = batch;
      record.signature = signature;
      card.dataset.turnId = batch.turnId || '';
      card.replaceChildren();
      const details = (key, label, parent = card) => {
        const node = document.createElement('details'),
          summary = document.createElement('summary');
        node.dataset.outputDetail = key;
        node.open = expanded.has(key);
        summary.textContent = label;
        node.append(summary);
        parent.append(node);
        return node;
      };
      const locate = (ids) =>
        frame.contentWindow?.postMessage(
          { type: 'ai-desktop:locate-outputs', workspaceId: batch.workspaceId, objectIds: ids },
          '*',
        );
      const reveal = (objectId) =>
        void window.desktop.outputs('reveal', batch.id, objectId).catch((error) => {
          status.textContent = error.message;
        });
      const updated = files.filter((file) => file.result === 'updated').length,
        created = files.length - updated;
      const header = document.createElement('strong');
      header.textContent = files.length
        ? [
            created ? uiText('新增 ') + created + uiText(' 个文件') : '',
            updated ? uiText('更新 ') + updated + uiText(' 个文件') : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : uiText('文件收回未完成');
      card.append(header);
      const list = document.createElement('div');
      list.className = 'output-file-list';
      card.append(list);
      let more;
      files.forEach((file, index) => {
        if (index === 3)
          more = details('more', uiText('另有 ') + (files.length - 3) + uiText(' 个文件'), list);
        const row = document.createElement('div');
        row.className = 'output-file-row';
        const name = file.path.split(/[\\/]/).pop() || file.path,
          extension = name.split('.').at(-1)?.toUpperCase() || 'FILE';
        const link = button('', () => locate([file.objectId]), 'output-file');
        link.title = uiText('定位桌面：') + file.path;
        const icon = document.createElement('span');
        icon.className =
          'output-file-type ' +
          (['XLSX', 'XLS', 'CSV'].includes(extension)
            ? 'sheet'
            : ['PNG', 'JPG', 'SVG', 'WEBP'].includes(extension)
              ? 'image'
              : 'document');
        icon.textContent = extension.slice(0, 4);
        link.append(icon);
        const caption = document.createElement('span');
        caption.className = 'output-file-caption';
        const label = document.createElement('span');
        label.textContent = name;
        const info = document.createElement('small');
        info.textContent =
          (file.result === 'updated' ? uiText('已更新桌面原文件') : uiText('已放到桌面')) +
          ' · v' +
          (file.revision ?? 1);
        caption.append(label, info);
        link.append(caption);
        row.append(link);
        (more || list).append(row);
      });
      if (files.length && batch.sources?.length) {
        const related = [
          ...new Set([...files.map((file) => file.objectId), ...batch.sources.map((source) => source.id)]),
        ];
        if (related.length > 1) {
          const actions = document.createElement('div');
          actions.className = 'output-actions';
          actions.append(button(uiText('定位来源与产出'), () => locate(related), 'output-locate'));
          card.append(actions);
        }
      }
      if (issues.length) {
        const issueDetails = details('issues', issues.length + uiText(' 项未收回 · 查看原因'));
        issueDetails.className = 'output-issues';
        for (const issue of issues) {
          const line = document.createElement('p');
          line.textContent = [issue.path, issue.message].filter(Boolean).join('：');
          issueDetails.append(line);
        }
        const hint = document.createElement('p');
        hint.className = 'output-recovery-hint';
        hint.textContent =
          batch.state === 'running'
            ? uiText('请等待当前任务完成后再处理。')
            : uiText('重试只收回已有文件，不会重新运行 AI 任务。');
        issueDetails.append(hint);
        if (batch.state !== 'running') {
          const retry = button(
            uiText('重试收回'),
            async () => {
              if (retrying.has(batch.id)) return;
              retrying.add(batch.id);
              retry.disabled = true;
              try {
                await window.desktop.outputs('retry', batch.id);
              } catch (error) {
                status.textContent = error.message;
              } finally {
                retrying.delete(batch.id);
                const current = cards.get(batch.id)?.card.querySelector('.output-retry');
                if (current) current.disabled = false;
              }
            },
            'output-retry',
          );
          retry.disabled = retrying.has(batch.id);
          issueDetails.append(retry);
        }
      }
      const meta = details('metadata', uiText('文件详情'));
      meta.className = 'output-metadata';
      if (batch.title) {
        const title = document.createElement('p');
        title.textContent = uiText('对应请求：') + batch.title;
        meta.append(title);
      }
      if (batch.state === 'interrupted') {
        const note = document.createElement('p');
        bindUiLabel(note, 'textContent', '此回合已中断；上方显示已收回的文件。');
        meta.append(note);
      }
      if (batch.sources?.length)
        meta.append(
          button(
            uiText('来源：') + batch.sources.map((source) => source.title).join('、'),
            () => locate(batch.sources.map((source) => source.id)),
            'output-sources',
          ),
        );
      const actions = document.createElement('div');
      actions.className = 'output-actions';
      if (files.length > 1)
        actions.append(
          button(
            uiText('定位全部'),
            () => locate(files.map((file) => file.objectId)),
            'output-locate',
          ),
        );
      if (batch.directory) actions.append(button(uiText('打开文件夹'), () => reveal()));
      meta.append(actions);
      for (const file of files) {
        const line = document.createElement('p');
        line.className = 'output-file-detail';
        line.textContent =
          file.path +
          (Number.isFinite(file.size) ? ' · ' + Math.ceil(file.size / 1024) + ' KB' : '');
        if (file.directory)
          line.append(button(uiText('打开所在文件夹'), () => reveal(file.objectId)));
        meta.append(line);
      }
      if (batch.directory) {
        meta.title = batch.directory;
      }
      const images = files.filter(
        (file) =>
          file.directory &&
          /\.(png|jpe?g|webp|gif)$/i.test(file.path) &&
          file.size <= 10 * 1024 * 1024,
      );
      if (images.length) {
        const previews = details('previews', uiText('图片预览（') + images.length + '）', meta);
        let loaded = false;
        const load = () => {
          if (!previews.open || loaded) return;
          loaded = true;
          for (const file of images) {
            const preview = button('', () => locate([file.objectId]), 'output-image-preview'),
              image = document.createElement('img');
            image.alt = file.path;
            image.loading = 'lazy';
            image.onload = () => surface.contentChanged();
            localImage(image, file.directory + '/' + file.path.split(/[\\/]/).pop());
            preview.append(image);
            previews.append(preview);
          }
        };
        previews.addEventListener('toggle', load);
        if (previews.open) load();
      }
      place(record);
      frame.contentWindow?.postMessage(
        {
          type: 'ai-desktop:outputs-changed',
          workspaceId: batch.workspaceId,
          objectIds: files.map((file) => file.objectId),
        },
        '*',
      );
      if (card.isConnected) surface.contentChanged();
    },
  };
}
