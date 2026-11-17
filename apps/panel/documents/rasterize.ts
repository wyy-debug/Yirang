import { t as uiText } from '../../../packages/components/ui-language.js';
export async function rasterizeSvg(source: string, width: number, height: number): Promise<string> {
  if (width * height > 16000000)
    throw new Error(uiText('图像超过 1600 万像素，无法在当前导出范围内处理。'));
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(uiText('浏览器无法生成 PNG，请使用 SVG 导出。')));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  await loaded;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(uiText('当前宿主不支持图像导出，请使用 SVG。'));
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/png').split(',')[1];
}
