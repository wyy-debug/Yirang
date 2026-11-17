import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { memo, useEffect, useRef, useState } from 'react';
import { useSettledPreview } from './native-markup-preview.js';
type Props = {
  text: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  wrap: boolean;
  currentLine: number;
  readOnly: boolean;
  composing: boolean;
  placeholder: string;
  change: (value: string) => void;
  locate: () => void;
  composition: (value: boolean) => void;
  keyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
};
export const NativeSourceArea = memo(function NativeSourceArea({
  text,
  textareaRef,
  wrap,
  currentLine,
  readOnly,
  composing,
  placeholder,
  change,
  locate,
  composition,
  keyDown,
}: Props) {
  useUiLocale();
  const [scroll, setScroll] = useState(0),
    [rows, setRows] = useState(1),
    frame = useRef<number | null>(null),
    settled = useSettledPreview(text, true, composing);
  useEffect(() => {
    let count = 1,
      index = settled.source.indexOf('\n');
    while (index >= 0) {
      count++;
      index = settled.source.indexOf('\n', index + 1);
    }
    setRows(count);
  }, [settled.source]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const first = Math.max(0, Math.floor((scroll - 18) / 22)),
    visible = Math.min(Math.max(rows, currentLine) - first, 100);
  function sync() {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setScroll(textareaRef.current?.scrollTop ?? 0);
    });
  }
  return (
    <div className={`native-source-area ${wrap ? 'is-wrapped' : ''}`}>
      {!wrap && (
        <div className="native-source-gutter" aria-hidden="true">
          {Array.from({ length: Math.max(0, visible) }, (_, n) => {
            const row = first + n;
            return (
              <span
                className={row + 1 === currentLine ? 'current' : ''}
                key={row}
                style={{ top: 18 + row * 22 - scroll }}
              >
                {row + 1}
              </span>
            );
          })}
        </div>
      )}
      {!wrap && (
        <div
          className="native-source-current"
          aria-hidden="true"
          style={{ top: 18 + (currentLine - 1) * 22 - scroll }}
        />
      )}
      <textarea
        ref={textareaRef}
        aria-label={uiText('文件文本内容')}
        spellCheck={false}
        wrap={wrap ? 'soft' : 'off'}
        value={text}
        readOnly={readOnly}
        onChange={(e) => change(e.target.value)}
        onCompositionStart={() => composition(true)}
        onCompositionEnd={() => composition(false)}
        onSelect={locate}
        onScroll={sync}
        onKeyDown={keyDown}
        placeholder={placeholder}
      />
    </div>
  );
});
