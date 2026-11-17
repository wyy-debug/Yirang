export function fileChatPosition(anchor, width, height, viewport) {
  const gap = 16,
    margin = 12,
    w = Math.max(0, Math.min(width, viewport.width - margin * 2)),
    h = Math.max(0, Math.min(height, viewport.height - margin * 2));
  const preferred =
    anchor.right + gap + w <= viewport.width - margin ? anchor.right + gap : anchor.left - gap - w;
  return {
    left: Math.max(margin, Math.min(preferred, viewport.width - w - margin)),
    top: Math.max(margin, Math.min(anchor.y - 48, viewport.height - h - margin)),
    width: w,
    height: h,
  };
}
