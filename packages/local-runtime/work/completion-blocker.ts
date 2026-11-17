// A narrow legacy-text safeguard. Structured delivery checks remain primary;
// a worker asking for its missing input cannot certify successful delivery.
export function completionBlocker(resultText?: string): string | undefined {
  const text = resultText?.trim();
  if (!text) return undefined;
  if (/(?:没有看到|未收到|缺少|找不到).{0,24}(?:文件|材料|具体内容)/.test(text) &&
      /请.{0,30}(?:提供|上传|把文件|说明|补充)/.test(text)) return '执行仍缺少输入材料';
  if (/(?:当前|仍|现在).{0,20}(?:只读|没有写入权限)/.test(text) &&
      /(?:不能|无法).{0,20}(?:保存|修改|生成|写入)/.test(text)) return '执行受权限限制，尚未交付';
  return undefined;
}
