import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import React, { useEffect, useRef, useState } from 'react';
import type { OfficePage } from '../../../../packages/contracts/office.js';

// Office geometry is in 96-dpi pixels; text sizes are in points. Lay out the
// whole slide at its original size, then scale geometry and text together.
export function SlideThumbnail({ page }: { page: OfficePage }) {
  useUiLocale();
  const host = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth,
        height = node.clientHeight;
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  const width = Math.max(1, page.width),
    height = Math.max(1, page.height);
  const scale = Math.min(size.width / width, size.height / height);
  return (
    <div ref={host} className="paper-slides">
      <div className="paper-slide-frame" style={{ width: width * scale, height: height * scale }}>
        <div
          className="paper-slide"
          style={{
            width,
            height,
            transform: `scale(${scale})`,
            background: page.background ?? '#fff',
          }}
        >
          {page.shapes.map((shape) => (
            <div
              key={shape.id}
              className="paper-slide-shape"
              style={{
                boxSizing: 'border-box',
                overflow: 'hidden',
                padding: shape.padding?.map((v) => v + 'px').join(' '),
                ...(shape.cell
                  ? {
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent:
                        shape.verticalAlign === 'center'
                          ? 'center'
                          : shape.verticalAlign === 'end'
                            ? 'flex-end'
                            : 'flex-start',
                      borderTop: shape.borderTop,
                      borderRight: shape.borderRight,
                      borderBottom: shape.borderBottom,
                      borderLeft: shape.borderLeft,
                    }
                  : {}),
                left: shape.x,
                top: shape.y,
                width: shape.width,
                height: shape.height,
                transform: `rotate(${shape.rotation ?? 0}deg)`,
                background: shape.fill && shape.fill !== 'none' ? shape.fill : undefined,
                border:
                  shape.stroke && shape.stroke !== 'none'
                    ? `${shape.strokeWidth ?? 1}px solid ${shape.stroke}`
                    : undefined,
              }}
            >
              {shape.image ? (
                <img src={shape.image} alt={shape.name} draggable={false} />
              ) : (
                page.paragraphs
                  .filter((p) => p.shapeId === shape.id)
                  .map((p) => (
                    <p
                      key={p.id}
                      style={{
                        textAlign: (p.align === 'both'
                          ? 'justify'
                          : p.align) as React.CSSProperties['textAlign'],
                        marginTop: (p.before * 4) / 3,
                        marginBottom: (p.after * 4) / 3,
                      }}
                    >
                      {p.runs.map((r) => (
                        <span
                          key={r.id}
                          style={{
                            fontSize: ((r.fontSize ?? 18) * 4) / 3,
                            fontFamily: r.fontFamily,
                            fontWeight: r.bold ? 700 : 400,
                            fontStyle: r.italic ? 'italic' : undefined,
                            textDecoration: r.underline ? 'underline' : undefined,
                            color: r.color,
                          }}
                        >
                          {r.text}
                        </span>
                      ))}
                    </p>
                  ))
              )}
            </div>
          ))}
          {!page.shapes.length && <span className="paper-placeholder">{uiText('空白幻灯片')}</span>}
        </div>
      </div>
      <span className="paper-page-count">
        {page.page + 1} / {page.pages}
      </span>
    </div>
  );
}
