import { z } from 'zod';
import { Id } from './index.js';

export const WEB_SOURCE_LIMIT = 256 * 1024;
export const WebSourceRole = z.enum(['html', 'css', 'js']);
export type WebSourceRole = z.infer<typeof WebSourceRole>;
export const WebProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('ai-desktop-web-project'),
    name: z.string().trim().min(1).max(80),
    files: z.object({ html: Id, css: Id, js: Id }).strict(),
  })
  .strict()
  .refine(
    (project) => new Set(Object.values(project.files)).size === 3,
    'HTML、CSS 和 JS 必须关联不同的原生文件。',
  );
export type WebProject = z.infer<typeof WebProjectSchema>;
export const webSourceRoles: WebSourceRole[] = ['html', 'css', 'js'];
export function isWebProjectName(name: string) {
  return /\.web-project\.json$/i.test(name);
}
export function isWebSourceName(name: string, role: WebSourceRole) {
  return (role === 'html' ? /\.html?$/i : role === 'css' ? /\.css$/i : /\.js$/i).test(name);
}
export const defaultWebSources = {
  html: `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>我的网页</title></head>
<body>
  <main class="welcome">
    <span class="eyebrow">A LITTLE SPACE FOR YOUR IDEAS</span>
    <h1>从一个想法开始。</h1>
    <p>在左侧编辑 HTML、CSS 和 JavaScript。你的网页和源文件，都留在工作桌面。</p>
    <button id="hello">点亮这个想法 <span id="count">0</span></button>
    <small>点击工作台上的「运行 JS」，再试试这个按钮。</small>
  </main>
</body>
</html>`,
  css: `* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f6fa; color: #202735; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.welcome { width: min(600px, 90vw); padding: 48px; border: 1px solid #fff; border-radius: 28px; background: #fff; box-shadow: 0 24px 80px #24315312; }
.eyebrow { font-size: 10px; letter-spacing: .16em; color: #64748b; }
h1 { margin: 24px 0 18px; font-size: clamp(28px, 5vw, 40px); letter-spacing: -.04em; }
p { color: #687386; line-height: 1.85; }
button { margin-top: 20px; padding: 13px 20px; border: 0; border-radius: 12px; background: #2563eb; color: #fff; font: inherit; cursor: pointer; }
#count { margin-left: 10px; padding: 2px 7px; border-radius: 6px; background: #ffffff30; }
small { display: block; margin-top: 22px; color: #8792a3; line-height: 1.7; }
@media (max-width: 480px) { .welcome { padding: 28px; } }`,
  js: `let count = 0;
document.querySelector("#hello")?.addEventListener("click", () => {
  count += 1;
  document.querySelector("#count").textContent = String(count);
  console.log("想法已点亮", count);
});
console.info("网页脚本已准备好。");`,
};
