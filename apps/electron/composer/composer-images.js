// Attachments share the host selection so queued messages retain their images.
export function createComposerImages({ input, status, state, changed }) {
  const api = window.desktop,
    host = input.closest('.composer') || input.parentElement;
  let images = [],
    loading = false,
    owner = null;
  const strip = document.createElement('div');
  strip.className = 'composer-images';
  strip.hidden = true;
  input.before(strip);
  const style = document.createElement('style');
  style.textContent =
    '.composer-images{display:flex;gap:8px;overflow:auto;padding:8px}.composer-images[hidden]{display:none}.composer-image{position:relative;flex:none}.composer-image img{width:72px;height:64px;object-fit:cover;border-radius:10px;border:1px solid #e2e7ef}.composer-image button{position:absolute;right:0;top:0;border-radius:50%;background:white;border:1px solid #ddd}.composer-image-picker{border:0;background:transparent;color:#73839b;cursor:pointer;padding:6px;font-size:16px}';
  document.head.append(style);
  const own = (b) => b?.type === 'image' && b?._meta?.['yirang/composer-image'];
  function render() {
    strip.replaceChildren();
    strip.hidden = !images.length;
    for (const b of images) {
      const cell = document.createElement('div');
      cell.className = 'composer-image';
      const img = document.createElement('img');
      img.src = `data:${b.mimeType};base64,${b.data}`;
      img.alt = b._meta['yirang/composer-image'].name;
      img.draggable = false;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '移除图片';
      remove.onclick = () =>
        api
          .composerImages('remove', {
            threadId: state().threadId,
            id: b._meta['yirang/composer-image'].id,
          })
          .catch((e) => (status.textContent = e.message));
      cell.append(img, remove);
      strip.append(cell);
    }
    changed();
  }
  async function add(files) {
    if (loading) return;
    const threadId = state().threadId;
    if (!threadId) {
      status.textContent = '请先新建对话';
      return;
    }
    loading = true;
    render();
    try {
      if (images.length + files.length > 4) throw Error('每条消息最多添加 4 张图片');
      if (files.some((f) => !['image/png', 'image/jpeg', 'image/webp'].includes(f.type)))
        throw Error('请选择 PNG、JPEG 或 WebP 图片');
      if (
        files.reduce((s, f) => s + f.size, 0) +
          images.reduce((s, b) => s + b.data.length * 0.75, 0) >
        8 * 1024 * 1024
      )
        throw Error('图片合计不能超过 8 MB');
      const blocks = await Promise.all(
        files.map(async (f) => {
          const url = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(Error('图片读取失败'));
            reader.readAsDataURL(f);
          });
          return {
            type: 'image',
            mimeType: f.type,
            data: url.slice(url.indexOf(',') + 1),
            _meta: {
              'yirang/composer-image': { id: crypto.randomUUID(), name: f.name || '粘贴图片' },
            },
          };
        }),
      );
      if (threadId !== state().threadId) throw Error('对话已切换，请在目标对话重新添加图片');
      await api.composerImages('add', { threadId, blocks });
      input.focus();
    } catch (e) {
      status.textContent = e.message;
    } finally {
      loading = false;
      render();
    }
  }
  input.addEventListener('paste', (event) => {
    const files = [...event.clipboardData.files];
    if (files.some((f) => f.type.startsWith('image/'))) {
      event.preventDefault();
      void add(files);
    }
  });
  host.addEventListener('dragover', (event) => {
    if ([...event.dataTransfer.types].includes('Files')) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    }
  });
  host.addEventListener('drop', (event) => {
    const files = [...event.dataTransfer.files];
    if (files.length) {
      event.preventDefault();
      event.stopPropagation();
      void add(files);
    }
  });
  api.onEvent(({ type, payload }) => {
    if (type === 'thread-switched') {
      owner = payload.threadId;
      images = [];
      render();
    }
    if (type === 'thread-created') owner = payload.threadId;
    if (type === 'selection') {
      owner = state().threadId;
      images = payload.filter(own);
      render();
    }
  });
  return {
    hasImages: () => images.length > 0,
    busy: () => loading,
    blocks: () => images.map((b) => ({ url: `data:${b.mimeType};base64,${b.data}` })),
  };
}
