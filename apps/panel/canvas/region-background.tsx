import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasGroups } from '../../../packages/contracts/index.js';
type Group = CanvasGroups['items'][number];
type Background = NonNullable<Group['background']>;
export function regionBackgroundStyle(value?: Background): React.CSSProperties {
  return value
    ? {
        backgroundColor: value.color,
        backgroundImage: value.image ? `url("${value.image}")` : undefined,
        backgroundSize: value.fit,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        opacity: value.opacity,
      }
    : {};
}
async function readImage(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw Error('请选择 PNG、JPG 或 WebP 图片。');
  if (file.size > 20 * 1024 * 1024) throw Error('请选择小于 20 MB 的图片。');
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('无法处理图片。');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5, 0.35]) {
      const data = canvas.toDataURL('image/webp', quality);
      if (data.startsWith('data:image/webp;') && data.length <= 262144) return data;
    }
    throw Error('图片内容过于复杂，请选择尺寸更小的图片。');
  } finally {
    bitmap.close();
  }
}
export function RegionBackgroundEditor({
  group,
  close,
  save,
}: {
  group: Group;
  close: () => void;
  save: (value: Background | undefined) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true);
  const [value, setValue] = useState<Background>(
    group.background ?? { color: '#f0f4fa', fit: 'cover', opacity: 1 },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      alive.current = false;
    };
  }, []);
  async function apply(next: Background | undefined) {
    setBusy(true);
    setError('');
    try {
      if (await save(next)) close();
      else setError('背景未保存，请重试。');
    } catch (e) {
      setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="region-background-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header>
        <strong>区域背景 · {group.name}</strong>
        <button disabled={busy} onClick={close} aria-label="关闭">
          ×
        </button>
      </header>
      <div className="region-background-sample">
        <div style={regionBackgroundStyle(value)} />
        <span>背景预览</span>
      </div>
      <fieldset disabled={busy}>
        <label>
          底色
          <input
            aria-label="背景颜色"
            type="color"
            value={value.color}
            onChange={(e) => setValue({ ...value, color: e.target.value })}
          />
          <span>{value.color}</span>
        </label>
        <label className="region-background-upload">
          选择背景图片
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setBusy(true);
              setError('');
              try {
                const image = await readImage(file);
                if (alive.current) setValue((v) => ({ ...v, image }));
              } catch (error) {
                if (alive.current) setError(String(error));
              } finally {
                if (alive.current) setBusy(false);
              }
            }}
          />
        </label>
        {value.image && (
          <label>
            图片显示
            <select
              value={value.fit}
              onChange={(e) => setValue({ ...value, fit: e.target.value as Background['fit'] })}
            >
              <option value="cover">填满区域</option>
              <option value="contain">完整显示</option>
            </select>
            <button onClick={() => setValue({ ...value, image: undefined })}>移除图片</button>
          </label>
        )}
        <label>
          不透明度
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(value.opacity * 100)}
            onChange={(e) => setValue({ ...value, opacity: Number(e.target.value) / 100 })}
          />
          <span>{Math.round(value.opacity * 100)}%</span>
        </label>
      </fieldset>
      <small>图片会压缩并保存在当前工作区，原图不会被修改。</small>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button disabled={busy} onClick={() => void apply(undefined)}>
          恢复默认
        </button>
        <button disabled={busy} onClick={close}>
          取消
        </button>
        <button disabled={busy} onClick={() => void apply(value)}>
          {busy ? '处理中…' : '保存背景'}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
