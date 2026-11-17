import { getUiLanguage as getUiLocale } from '../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../ui/ui-language.js';
import { t as uiText } from '../../../packages/components/ui-language.js';
import React, { memo, useMemo, useState } from 'react';
import { TEXT_FILE_LIMIT } from '../../../packages/contracts/native-text.js';
import './svg-image-preview.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
// Use the browser's SVG image renderer, not an allowlisted editable shape tree.
// Image context keeps styles, markers and filters without executing SVG scripts
// or inserting file-controlled markup into the application document.
export const SvgImagePreview = memo(function SvgImagePreview({
  source,
  title,
  zoom = 1,
  expanded = false,
}: {
  source: string;
  title: string;
  zoom?: number;
  expanded?: boolean;
}) {
  useUiLocale();
  const [failed, setFailed] = useState('');
  const result = useMemo(() => {
    if (!source.trim()) return { error: uiText('空白 SVG 文件'), url: '' };
    if (source.length > TEXT_FILE_LIMIT)
      return { error: uiText('SVG 较大，请打开原文件查看'), url: '' };
    const document = new DOMParser().parseFromString(source, 'image/svg+xml'),
      root = document.documentElement;
    if (
      document.querySelector('parsererror') ||
      root.localName !== 'svg' ||
      (root.namespaceURI && root.namespaceURI !== SVG_NS)
    )
      return { error: uiText('SVG 内容无法解析，请打开源码检查 XML 格式'), url: '' };
    if (!root.hasAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS);
    // Serialize decoded XML so an old UTF-16 declaration cannot mislabel UTF-8.
    return {
      error: '',
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`,
    };
  }, [source, getUiLocale()]);
  const error =
    result.error ||
    (failed === result.url && result.url ? uiText('SVG 图像载入失败，可切换源码查看内容') : '');
  return (
    <div className={`svg-image-preview ${expanded ? 'is-expanded' : ''}`}>
      {error ? (
        <div className="svg-image-error" role="status">
          {error}
        </div>
      ) : (
        <div
          className="svg-image-stage"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
        >
          <img
            key={result.url}
            src={result.url}
            alt={title}
            draggable={false}
            decoding="async"
            onError={() => setFailed(result.url)}
          />
        </div>
      )}
    </div>
  );
});
