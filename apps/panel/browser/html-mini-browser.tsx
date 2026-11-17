import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/icons.js';
import { htmlBrowserDocument } from './html-browser-document.js';
import './html-mini-browser.css';
import { scheduleRenderFrame, cancelRenderFrame } from '../ui/render-frame.js';

/** Keep one iframe alive when expanding: moving its mount avoids a React remount. */
export const HtmlMiniBrowser = memo(function HtmlMiniBrowser({
  source,
  fileName,
}: {
  source: string;
  fileName: string;
}) {
  useUiLocale();
  const anchor = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLIFrameElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const [mount] = useState(() => document.createElement('div')),
    [channel] = useState(() => crypto.randomUUID());
  const [active, setActive] = useState(false),
    [expanded, setExpanded] = useState(false),
    [reload, setReload] = useState(0),
    [zoom, setZoom] = useState('fit'),
    [size, setSize] = useState({ width: 320, height: 240 });
  const [notice, setNotice] = useState(''),
    [pageTitle, setPageTitle] = useState(''),
    [loading, setLoading] = useState(true);
  const documentSource = useMemo(
    () => htmlBrowserDocument(source, channel),
    [source, channel, getUiLocale()],
  );
  useLayoutEffect(() => {
    mount.className = 'html-mini-mount';
    anchor.current?.append(mount);
    return () => mount.remove();
  }, [mount]);
  useLayoutEffect(() => {
    // moveBefore preserves iframe browsing state where supported by Chromium.
    const parent = expanded ? document.body : anchor.current;
    if (!parent) return;
    mount.classList.toggle('is-expanded', expanded);
    if (mount.parentNode !== parent) {
      const preserve = parent as HTMLElement & {
        moveBefore?: (node: Node, before: Node | null) => void;
      };
      if (preserve.moveBefore) preserve.moveBefore(mount, null);
      else parent.append(mount);
    }
  }, [expanded, mount]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const key = {};
    let live = true;
    const measure = () =>
      scheduleRenderFrame(key, () => {
        const width = node.clientWidth,
          height = node.clientHeight;
        return () => {
          if (live && width && height)
            setSize((previous) =>
              previous.width === width && previous.height === height ? previous : { width, height },
            );
        };
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      live = false;
      observer.disconnect();
      cancelRenderFrame(key);
    };
  }, []);
  useEffect(() => {
    const read = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== 'desktop-html-browser' ||
        event.data.channel !== channel
      )
        return;
      const value = String(event.data.message ?? '').slice(0, 400);
      if (event.data.kind === 'title') setPageTitle(value);
      else if (event.data.kind === 'escape') {
        setExpanded(false);
        setActive(false);
      } else if (event.data.kind === 'error' || event.data.kind === 'resource') setNotice(value);
    };
    window.addEventListener('message', read);
    return () => window.removeEventListener('message', read);
  }, [channel]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setExpanded(false);
      }
    };
    document.addEventListener('keydown', close, true);
    return () => document.removeEventListener('keydown', close, true);
  }, [expanded]);
  const scale = zoom === 'fit' ? Math.min(1, size.width / 960) : Number(zoom),
    pageWidth = Math.max(220, size.width / scale),
    pageHeight = Math.max(120, size.height / scale);
  const refresh = () => {
    setNotice('');
    setLoading(true);
    setPageTitle('');
    setReload((value) => value + 1);
  };
  return (
    <>
      <div className="html-mini-anchor" ref={anchor}>
        {expanded && (
          <button className="html-mini-return nodrag nopan" onClick={() => setExpanded(false)}>
            {uiText('网页已展开 · 收回小窗')}
          </button>
        )}
      </div>
      {createPortal(
        <section
          className={`html-mini-browser ${active || expanded ? 'is-browsing' : ''}`}
          aria-label={uiText('{0} 浏览器小窗', { '0': fileName })}
        >
          <header
            className="html-mini-toolbar drag-handle"
            onDoubleClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
          >
            <Icon name="browser" size={13} />
            <span
              className="html-mini-address"
              title={uiText('{0}{1} · 拖动标题栏移动窗口', {
                '0': pageTitle ? `${pageTitle}\n` : '',
                '1': fileName,
              })}
            >
              {fileName}
            </span>
            <div
              className="html-mini-controls nodrag nopan"
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <button title={uiText('刷新网页')} aria-label={uiText('刷新网页')} onClick={refresh}>
                <Icon name="history" size={12} />
              </button>
              <select
                aria-label={uiText('网页缩放')}
                title={uiText('网页缩放')}
                value={zoom}
                onChange={(event) => setZoom(event.target.value)}
              >
                <option value="fit">{uiText('适应')}</option>
                <option value="0.5">50%</option>
                <option value="0.75">75%</option>
                <option value="1">100%</option>
                <option value="1.25">125%</option>
              </select>
              {!expanded && (
                <button
                  title={active ? uiText('退出网页操作，移动窗口') : uiText('操作网页')}
                  aria-label={active ? uiText('退出网页操作') : uiText('操作网页')}
                  aria-pressed={active}
                  onClick={() => setActive((value) => !value)}
                >
                  <Icon name={active ? 'hand' : 'pointer'} size={12} />
                </button>
              )}
              <button
                title={expanded ? uiText('收回小窗') : uiText('展开浏览器')}
                aria-label={expanded ? uiText('收回小窗') : uiText('展开浏览器')}
                aria-pressed={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                <Icon name={expanded ? 'close' : 'expand'} size={13} />
              </button>
            </div>
          </header>
          <div
            ref={viewport}
            className="html-mini-viewport nodrag nopan nowheel"
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              if (!active && !expanded) {
                event.stopPropagation();
                setActive(true);
              }
            }}
          >
            <iframe
              key={reload}
              ref={frame}
              title={uiText('{0} 网页', { '0': fileName })}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={documentSource}
              tabIndex={active || expanded ? 0 : -1}
              style={{ width: pageWidth, height: pageHeight, transform: `scale(${scale})` }}
              onLoad={() => setLoading(false)}
            />
            {!active && !expanded && (
              <button
                className="html-mini-activate"
                aria-label={uiText('在小窗中浏览 {0}', { '0': fileName })}
                onClick={(event) => {
                  event.stopPropagation();
                  setActive(true);
                }}
              >
                <span>{uiText('点击浏览网页')}</span>
              </button>
            )}
          </div>
          {(loading || notice) && (
            <div className="html-mini-status nodrag nopan" role="status" title={notice}>
              {notice ? uiText('网页提示：{0}', { '0': notice }) : uiText('正在载入网页…')}
              {notice && (
                <button aria-label={uiText('收起网页提示')} onClick={() => setNotice('')}>
                  ×
                </button>
              )}
            </div>
          )}
        </section>,
        mount,
      )}
    </>
  );
});
