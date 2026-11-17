import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React from 'react';
import type { DesktopObject, MaterialRange } from '../../../packages/contracts/index.js';
import { contentText, kindIcons } from '../../../packages/components/content.js';
import { selectedObject } from '../../../packages/components/selection.js';
export function ContextPreview({
  objects,
  ranges,
  close,
}: {
  objects: DesktopObject[];
  ranges: Record<string, MaterialRange>;
  close: () => void;
}) {
  useUiLocale();
  const materials = objects.map((o) => {
    try {
      if (o.policy?.private)
        return {
          object: o,
          error: uiText('这份材料禁止交给 AI。请先从选区移除，或更改保护设置。'),
        };
      return { object: selectedObject(o, ranges[o.id]), error: '' };
    } catch (e) {
      return { object: o, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return (
    <section className="context-preview" role="dialog" aria-label={uiText('所选材料')}>
      <header className="section-header">
        <button onClick={close}>{uiText('返回桌面')}</button>
        <div>
          <strong>{uiText('所选材料')}</strong>
          <small>{uiText('查看内容与引用范围')}</small>
        </div>
        <span>
          {objects.length} {uiText('份材料')}
        </span>
      </header>
      <div className="context-content">
        <div className="context-disclosure">
          <strong>{uiText('引用时只附加以下内容')}</strong>
          <p>{uiText('返回桌面点击“引用材料”即可附加这些内容。未选择的画布材料不会附加。')}</p>
        </div>
        {!objects.length && (
          <p className="editor-empty">
            {uiText('返回画布框选材料，或在编辑器内选择文字与表格范围。')}
          </p>
        )}
        {materials.map(({ object: o, error }) => (
          <article key={o.id}>
            <header>
              <span>
                {kindIcons[o.kind]} {o.title}
              </span>
              <small>
                {o.selection
                  ? o.selection.type === 'native'
                    ? uiText('原生文件选区')
                    : o.selection.type === 'cells'
                      ? uiText('{0} 行 × {1} 列', {
                          '0': o.selection.rowIds.length,
                          '1': o.selection.columnIds.length,
                        })
                      : uiText('字符 {0}–{1}', { '0': o.selection.start + 1, '1': o.selection.end })
                  : uiText('完整对象')}
              </small>
            </header>
            {error ? (
              <p className="context-error">{error}</p>
            ) : o.kind === 'image' ? (
              <>
                <img src={o.dataUrl} alt={o.title} />
                <pre>{contentText(o.content) || uiText('无附加批注')}</pre>
              </>
            ) : (
              <pre>{o.selectedText ?? contentText(o.content)}</pre>
            )}
            <footer>
              {o.policy?.locked
                ? uiText('AI 只读 · 已确认内容保持不变')
                : uiText('修改仍受版本、草稿和任务范围检查')}
            </footer>
          </article>
        ))}
        <p className="context-end">{uiText('引用不会自动开始任务。')}</p>
      </div>
    </section>
  );
}
