import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { memo, useEffect, useRef, useState } from 'react';
import { NativeHtmlPreview } from '../documents/native/native-markup-preview.js';
import './html-thumbnail.css';

/** Use layout dimensions so zooming the canvas never changes the page's layout. */
export const HtmlThumbnail = memo(function HtmlThumbnail({ source }: { source: string }) {
  useUiLocale();
  const root = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 320, height: 240 });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      if (width && height)
        setSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = size.width / 1280;
  return (
    <div ref={root} className="paper-html" aria-label={uiText('网页页面预览')}>
      <div
        className="paper-html-viewport"
        style={{
          width: 1280,
          height: Math.max(720, size.height / scale),
          transform: `scale(${scale})`,
        }}
      >
        <NativeHtmlPreview source={source} thumbnail />
      </div>
    </div>
  );
});
