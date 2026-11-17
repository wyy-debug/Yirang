import type { DesktopObject, Code } from '../contracts/index.js';
export const NATIVE_FILE_LIMIT = 50 * 1024 * 1024;
export function isNativeTextFile(fileName: string) {
  return (
    /\.(txt|md|markdown|csv|tsv|log|py|pyi|js|jsx|mjs|cjs|ts|tsx|json|jsonl|html|htm|css|scss|less|xml|svg|yaml|yml|toml|ini|cfg|conf|sql|sh|ps1|bat|cmd|c|h|cc|cpp|hpp|cs|java|rs|go|rb|php|vue|svelte)$/i.test(
      fileName,
    ) || /^(Dockerfile|Makefile|\.gitignore|\.gitattributes|\.editorconfig)$/i.test(fileName)
  );
}
export function localCodeRuntime(object: DesktopObject): 'python' | 'javascript' | null {
  if (object.kind === 'code') {
    const language = (object.content as Code).language;
    return language === 'python' || language === 'javascript' ? language : null;
  }
  if (object.kind === 'file') {
    const extension = nativeFormat((object.content as { fileName: string }).fileName).extension;
    return extension === 'py' ? 'python' : extension === 'js' ? 'javascript' : null;
  }
  return null;
}
const formats: Record<string, { label: string; mime: string }> = {
  xlsx: {
    label: 'Excel 工作簿',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  xlsm: { label: 'Excel 宏工作簿', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12' },
  xls: { label: 'Excel 工作簿', mime: 'application/vnd.ms-excel' },
  docx: {
    label: 'Word 文档',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  doc: { label: 'Word 文档', mime: 'application/msword' },
  pptx: {
    label: 'PowerPoint 演示文稿',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  ppt: { label: 'PowerPoint 演示文稿', mime: 'application/vnd.ms-powerpoint' },
  pdf: { label: 'PDF 文档', mime: 'application/pdf' },
  csv: { label: 'CSV 文件', mime: 'text/csv' },
  txt: { label: '文本文件', mime: 'text/plain' },
  md: { label: 'Markdown 文件', mime: 'text/markdown' },
  py: { label: 'Python 源文件', mime: 'text/x-python' },
  js: { label: 'JavaScript 源文件', mime: 'text/javascript' },
  ts: { label: 'TypeScript 源文件', mime: 'text/plain' },
  json: { label: 'JSON 文件', mime: 'application/json' },
  html: { label: 'HTML 文件', mime: 'text/html' },
  css: { label: 'CSS 文件', mime: 'text/css' },
  png: { label: 'PNG 图片', mime: 'image/png' },
  jpg: { label: 'JPEG 图片', mime: 'image/jpeg' },
  jpeg: { label: 'JPEG 图片', mime: 'image/jpeg' },
  webp: { label: 'WebP 图片', mime: 'image/webp' },
  gif: { label: 'GIF 图片', mime: 'image/gif' },
  svg: { label: 'SVG 文件', mime: 'image/svg+xml' },
  zip: { label: 'ZIP 压缩文件', mime: 'application/zip' },
};
export function nativeFormat(fileName: string) {
  const extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  return {
    extension,
    ...(formats[extension] ?? { label: '原生文件', mime: 'application/octet-stream' }),
  };
}
