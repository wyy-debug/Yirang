import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { useDeferredValue, useRef, useState } from 'react';
function inline(text: string): React.ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') && part.endsWith('`') ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : part.startsWith('*') && part.endsWith('*') ? (
        <em key={i}>{part.slice(1, -1)}</em>
      ) : (
        part
      ),
    );
}
export const MarkdownPreview = React.memo(function MarkdownPreview({ text }: { text: string }) {
  useUiLocale();
  const blocks: React.ReactNode[] = [];
  let code = null as string[] | null;
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('```')) {
      if (code) {
        blocks.push(<pre key={i}>{code.join('\n')}</pre>);
        code = null;
      } else code = [];
      return;
    }
    if (code) {
      code.push(line);
      return;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const H = `h${heading[1].length}` as 'h1' | 'h2' | 'h3';
      blocks.push(<H key={i}>{inline(heading[2])}</H>);
    } else if (/^[-*]\s+/.test(line))
      blocks.push(
        <div className="md-list-line" key={i}>
          <span>•</span>
          <div>{inline(line.slice(2))}</div>
        </div>,
      );
    else if (/^\d+\.\s+/.test(line)) {
      const [, n, body] = /^(\d+)\.\s+(.*)$/.exec(line)!;
      blocks.push(
        <div className="md-list-line" key={i}>
          <span>{n}.</span>
          <div>{inline(body)}</div>
        </div>,
      );
    } else if (line.startsWith('> '))
      blocks.push(<blockquote key={i}>{inline(line.slice(2))}</blockquote>);
    else if (/^---+$/.test(line)) blocks.push(<hr key={i} />);
    else blocks.push(line ? <p key={i}>{inline(line)}</p> : <div className="md-gap" key={i} />);
  });
  if (code) blocks.push(<pre key="unfinished-code">{code.join('\n')}</pre>);
  return <article className="markdown-preview">{blocks}</article>;
});
export function TextEditor({
  value,
  change,
  selectRange,
  save,
  blur,
}: {
  value: string;
  change: (s: string) => void;
  selectRange: (start: number, end: number, source: string) => void;
  save?: () => void;
  blur?: () => void;
}) {
  useUiLocale();
  const previewValue = useDeferredValue(value);
  const [mode, setMode] = useState<'source' | 'split' | 'preview'>('source');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  function format(prefix: string, suffix = '', line = false) {
    const node = input.current;
    if (!node) return;
    const start = line ? value.lastIndexOf('\n', node.selectionStart - 1) + 1 : node.selectionStart,
      end = node.selectionEnd;
    const chosen = value.slice(start, end),
      replacement = line
        ? chosen
            .split('\n')
            .map((l) => prefix + l)
            .join('\n')
        : prefix + (chosen || uiText('文字')) + suffix;
    change(value.slice(0, start) + replacement + value.slice(end));
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(start + prefix.length, start + replacement.length - suffix.length);
    });
  }
  return (
    <div
      className="text-editor"
      onKeyDown={(e) => {
        if (
          save &&
          !e.nativeEvent.isComposing &&
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === 's'
        ) {
          e.preventDefault();
          e.stopPropagation();
          save();
        }
      }}
    >
      <div className="text-format-tools">
        <div>
          <button
            disabled={mode === 'preview'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format('# ', '', true)}
          >
            {uiText('标题')}
          </button>
          <button
            disabled={mode === 'preview'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format('**', '**')}
          >
            <b>B</b>
          </button>
          <button
            disabled={mode === 'preview'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format('*', '*')}
          >
            <i>I</i>
          </button>
          <button
            disabled={mode === 'preview'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format('- ', '', true)}
          >
            {uiText('列表')}
          </button>
          <button
            disabled={mode === 'preview'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format('> ', '', true)}
          >
            {uiText('引用')}
          </button>
          <button
            disabled={mode === 'preview'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format('`', '`')}
          >
            {uiText('代码')}
          </button>
        </div>
        <div>
          {(['source', 'split', 'preview'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {m === 'source' ? 'Markdown' : m === 'split' ? uiText('并排') : uiText('预览')}
            </button>
          ))}
        </div>
      </div>
      <div className="range-toolbar">
        <span>
          {selection
            ? uiText('已选择 {0} 个字符', { '0': selection.end - selection.start })
            : uiText('{0} 字符 · 标题、列表、强调与代码', { '0': value.length })}
        </span>
        <button
          disabled={!selection || mode === 'preview'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => selection && selectRange(selection.start, selection.end, value)}
        >
          {uiText('使用文字片段')}
        </button>
      </div>
      <div className={`text-editor-body mode-${mode}`}>
        {mode !== 'preview' && (
          <textarea
            ref={input}
            aria-label={uiText('完全态文字编辑')}
            value={value}
            onChange={(e) => change(e.target.value)}
            onBlur={blur}
            maxLength={50000}
            spellCheck={false}
            onSelect={(e) => {
              const t = e.currentTarget;
              setSelection(
                t.selectionEnd > t.selectionStart
                  ? { start: t.selectionStart, end: t.selectionEnd }
                  : null,
              );
            }}
          />
        )}
        {mode !== 'source' && <MarkdownPreview text={previewValue} />}
      </div>
    </div>
  );
}
