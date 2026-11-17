import { getUiLanguage as getUiLocale } from '../../../../packages/components/ui-language.js';
import { useUiLanguage as useUiLocale } from '../../ui/ui-language.js';
import { t as uiText } from '../../../../packages/components/ui-language.js';
import { htmlPageDocument } from '../../browser/html-page-document.js';
import React, { memo, useEffect, useMemo, useState } from 'react';
import { codeTokens } from '../code-tokens.js';

const PREVIEW_LIMIT = 240_000;

/** Keep source input immediate; parsing only follows a quiet period. */
export function useSettledPreview(source: string, enabled: boolean, composing: boolean) {
  const [settled, setSettled] = useState(source);
  useEffect(() => {
    if (!enabled || composing) return;
    const timer = window.setTimeout(() => setSettled(source), 320);
    return () => window.clearTimeout(timer);
  }, [source, enabled, composing]);
  return { source: settled, pending: settled !== source };
}

const markdownSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 160) || 'section';
function anchorTarget(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {}
  return /^L\d+$/i.test(decoded)
    ? `native-md-line-${decoded.slice(1)}`
    : `native-md-heading-${markdownSlug(decoded)}`;
}
function goToAnchor(event: React.MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const id = event.currentTarget.getAttribute('href')?.slice(1),
    article = event.currentTarget.closest('.native-markdown-preview'),
    target = Array.from(article?.querySelectorAll('[id]') ?? []).find((node) => node.id === id);
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function mappedText(
  text: string,
  key: string,
  positions: number[],
  language?: string,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let start = 0; start < text.length; ) {
    let end = start + 1;
    while (end < text.length && positions[end] === positions[end - 1] + 1) end++;
    nodes.push(
      <span key={`${key}:${start}`} data-source-start={positions[start]}>
        {language === undefined
          ? text.slice(start, end)
          : codeTokens(text.slice(start, end), language)}
      </span>,
    );
    start = end;
  }
  return nodes;
}
function inline(
  source: string,
  key: string,
  depth = 0,
  positions: number[] = [],
): React.ReactNode[] {
  const plain = (from: number, to: number) =>
    mappedText(source.slice(from, to), `${key}:${from}`, positions.slice(from, to));
  if (depth > 5) return plain(0, source.length);
  const expression =
    /(`{1,3})([^`\n]{1,20000})\1|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|!?\[([^\[\]\n]+)\]\(([^()\n]{0,2048})\)| {2}\n/g;
  const nodes: React.ReactNode[] = [];
  let offset = 0,
    match: RegExpExecArray | null;
  while ((match = expression.exec(source)) !== null) {
    if (match.index > offset) nodes.push(...plain(offset, match.index));
    const id = `${key}-${match.index}`;
    const child = (value: string, prefix: number, nested = true) => {
      const at = match!.index + prefix;
      return nested
        ? inline(value, id, depth + 1, positions.slice(at, at + value.length))
        : mappedText(value, id, positions.slice(at, at + value.length));
    };
    if (match[2]) nodes.push(<code key={id}>{child(match[2], match[1].length, false)}</code>);
    else if (match[3] || match[4])
      nodes.push(<strong key={id}>{child(match[3] ?? match[4], 2)}</strong>);
    else if (match[5]) nodes.push(<del key={id}>{child(match[5], 2)}</del>);
    else if (match[6] || match[7]) nodes.push(<em key={id}>{child(match[6] ?? match[7], 1)}</em>);
    else if (match[8])
      nodes.push(
        match[0].startsWith('!') ? (
          <span className="native-markdown-image" key={id} title={match[9]}>
            ▧ {child(match[8], 2)}
          </span>
        ) : match[9].startsWith('#') ? (
          <a
            className="native-markdown-link"
            key={id}
            href={`#${anchorTarget(match[9].slice(1))}`}
            onClick={goToAnchor}
          >
            {child(match[8], 1)}
          </a>
        ) : (
          <span className="native-markdown-link" key={id} title={match[9]}>
            {child(match[8], 1)}
          </span>
        ),
      );
    else nodes.push(<br key={id} />);
    offset = expression.lastIndex;
  }
  if (offset < source.length) nodes.push(...plain(offset, source.length));
  return nodes;
}

function markdown(
  source: string,
  depth = 0,
  lineOffset = 0,
  headingCounts = new Map<string, number>(),
  sourcePositions?: number[],
): React.ReactNode[] {
  if (depth > 12) return [<p key="depth-limit">{source.slice(0, 4000)}</p>];
  const headingId = (value: string) => {
    const slug = markdownSlug(value),
      count = headingCounts.get(slug) ?? 0;
    headingCounts.set(slug, count + 1);
    return `native-md-heading-${slug}${count ? `-${count}` : ''}`;
  };
  const lines = source
      .slice(0, PREVIEW_LIMIT)
      .replace(/\r\n?|\n/g, '\n')
      .split('\n'),
    nodes: React.ReactNode[] = [];
  const positions =
    sourcePositions ?? Array.from({ length: source.replace(/\r\n?/g, '\n').length }, (_, i) => i);
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length + 1;
  }
  const render = (value: string, key: string, row: number, column = 0) =>
    inline(
      value,
      key,
      0,
      positions.slice(starts[row] + column, starts[row] + column + value.length),
    );
  const tableCells = (line: string, row: number) => {
    const found: { text: string; map: number[] }[] = [];
    let start = 0;
    for (let i = 0; i <= line.length; i++)
      if (i === line.length || (line[i] === '|' && line[i - 1] !== '\\')) {
        const raw = line.slice(start, i),
          lead = raw.length - raw.trimStart().length,
          trimmed = raw.trim();
        if (!((start === 0 && !trimmed) || (i === line.length && !trimmed))) {
          const map: number[] = [];
          let text = '';
          for (let n = 0; n < trimmed.length; n++) {
            if (trimmed[n] === '\\' && trimmed[n + 1] === '|') n++;
            text += trimmed[n];
            map.push(positions[starts[row] + start + lead + n]);
          }
          found.push({ text, map });
        }
        start = i + 1;
      }
    return found;
  };
  const isBlock = (line: string) =>
    /^\s*$|^\s*(`{3,}|~{3,})|^ {0,3}#{1,6}\s|^\s*>|^\s*([-+*]|\d+[.)])\s|^\s*([-*_])(?:\s*\1){2,}\s*$/.test(
      line,
    );
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, '|'));
  const listMatch = (value: string) => value.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/),
    indent = (value: string) => value.replace(/\t/g, '    ').length;
  function listBlock(start: number, level: number): { node: React.ReactNode; end: number } {
    const first = listMatch(lines[start])!,
      base = indent(first[1]),
      ordered = /^\d/.test(first[2]),
      items: React.ReactNode[] = [];
    let i = start;
    while (i < lines.length && items.length < 2000) {
      const item = listMatch(lines[i]);
      if (!item || indent(item[1]) !== base || /^\d/.test(item[2]) !== ordered) break;
      const row = i,
        checked = item[3].match(/^\[([ xX])\]\s+(.*)$/),
        children: React.ReactNode[] = [];
      i++;
      while (i < lines.length) {
        const nested = listMatch(lines[i]);
        if (nested) {
          if (indent(nested[1]) <= base) break;
          if (level < 12) {
            const child = listBlock(i, level + 1);
            children.push(child.node);
            i = child.end;
            continue;
          }
          break;
        }
        if (!lines[i].trim()) {
          const following = listMatch(lines[i + 1] ?? '');
          if (following && indent(following[1]) > base) {
            i++;
            continue;
          }
          break;
        }
        const spaces = lines[i].match(/^\s*/)?.[0] ?? '';
        if (indent(spaces) <= base) break;
        children.push(
          <span className="native-markdown-continuation" key={`continuation-${i}`}>
            {render(
              lines[i].trimStart(),
              `line-${i}`,
              i,
              lines[i].length - lines[i].trimStart().length,
            )}
          </span>,
        );
        i++;
      }
      items.push(
        <li
          key={row}
          id={`native-md-line-${lineOffset + row + 1}`}
          className={checked ? 'native-markdown-task' : undefined}
        >
          {checked && <input type="checkbox" checked={checked[1] !== ' '} readOnly tabIndex={-1} />}
          <span>
            {render(
              checked ? checked[2] : item[3],
              `list-${row}`,
              row,
              lines[row].length -
                item[3].length +
                (checked ? item[3].length - checked[2].length : 0),
            )}
          </span>
          {children}
        </li>,
      );
    }
    return {
      node: ordered ? (
        <ol key={`list-${start}`} start={Number.parseInt(first[2], 10)}>
          {items}
        </ol>
      ) : (
        <ul key={`list-${start}`}>{items}</ul>
      ),
      end: i,
    };
  }
  for (let i = 0; i < lines.length && nodes.length < 5000; ) {
    const line = lines[i],
      key = `md-${i}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const code: string[] = [];
      i++;
      const codeStart = i;
      while (
        i < lines.length &&
        !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])
      )
        code.push(lines[i++]);
      i++;
      nodes.push(
        <div className="native-markdown-code" key={key}>
          {fence[2].trim() && <small>{fence[2].trim()}</small>}
          <pre>
            <code>
              {mappedText(
                code.join('\n'),
                key,
                positions.slice(starts[codeStart], starts[codeStart] + code.join('\n').length),
                fence[2].trim(),
              )}
            </code>
          </pre>
        </div>,
      );
      continue;
    }
    if (i + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1]) && line.trim()) {
      const level = lines[i + 1].trim().startsWith('=') ? 1 : 2;
      nodes.push(
        React.createElement(`h${level}`, { key, id: headingId(line) }, render(line, key, i)),
      );
      i += 2;
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (heading) {
      const id = headingId(heading[2]);
      nodes.push(
        React.createElement(
          `h${heading[1].length}`,
          { key, id },
          <>
            <a
              className="native-markdown-anchor"
              href={`#${id}`}
              onClick={goToAnchor}
              aria-label={uiText('定位此标题')}
            >
              #
            </a>
            {render(heading[2], key, i, line.indexOf(heading[2], heading[1].length))}
          </>,
        ),
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      nodes.push(<hr key={key} />);
      i++;
      continue;
    }
    if (
      i + 1 < lines.length &&
      line.includes('|') &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const headings = tableCells(line, i),
        alignment = cells(lines[i + 1]).map((cell) =>
          cell.startsWith(':') && cell.endsWith(':')
            ? 'center'
            : cell.endsWith(':')
              ? 'right'
              : 'left',
        ),
        rows: ReturnType<typeof tableCells>[] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && rows.length < 500) {
        rows.push(tableCells(lines[i], i));
        i++;
      }
      nodes.push(
        <div className="native-markdown-table" key={key}>
          <table>
            <thead>
              <tr>
                {headings.map((cell, n) => (
                  <th key={n} style={{ textAlign: alignment[n] as 'left' | 'right' | 'center' }}>
                    {inline(cell.text, `${key}-h${n}`, 0, cell.map)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {headings.map((_, c) => (
                    <td key={c} style={{ textAlign: alignment[c] as 'left' | 'right' | 'center' }}>
                      {inline(row[c]?.text ?? '', `${key}-${r}-${c}`, 0, row[c]?.map ?? [])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoteStart = i,
        quote: string[] = [],
        quoteMap: number[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        const value = lines[i].replace(/^\s*> ?/, ''),
          skip = lines[i].length - value.length;
        if (quote.length) quoteMap.push(positions[starts[i] - 1]);
        quote.push(value);
        for (let n = starts[i] + skip; n < starts[i] + lines[i].length; n++)
          quoteMap.push(positions[n]);
        i++;
      }
      nodes.push(
        <blockquote key={key}>
          {markdown(quote.join('\n'), depth + 1, lineOffset + quoteStart, headingCounts, quoteMap)}
        </blockquote>,
      );
      continue;
    }
    if (listMatch(line)) {
      const block = listBlock(i, 0);
      nodes.push(block.node);
      i = Math.max(i + 1, block.end);
      continue;
    }
    const paragraphStart = i,
      paragraph = [line];
    i++;
    while (
      i < lines.length &&
      !isBlock(lines[i]) &&
      !(i + 1 < lines.length && lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]))
    )
      paragraph.push(lines[i++]);
    nodes.push(
      <p key={key} id={`native-md-line-${lineOffset + Number(key.slice(3)) + 1}`}>
        {render(paragraph.join('\n'), key, paragraphStart)}
      </p>,
    );
  }
  return nodes;
}

export const NativeMarkdownPreview = memo(function NativeMarkdownPreview({
  source,
}: {
  source: string;
}) {
  useUiLocale();
  const rendered = useMemo(() => markdown(source), [source, getUiLocale()]);
  return (
    <article className="native-markdown-preview" aria-label={uiText('Markdown 预览')}>
      {source.length > PREVIEW_LIMIT && (
        <p className="native-preview-note">
          {uiText('预览展示前 24 万字符；源码与保存保留完整内容。')}
        </p>
      )}
      {rendered.length ? (
        rendered
      ) : (
        <p className="native-preview-empty">{uiText('在源码中开始书写，预览会显示在这里。')}</p>
      )}
    </article>
  );
});

export const NativeHtmlPreview = memo(function NativeHtmlPreview({
  source,
  thumbnail = false,
}: {
  source: string;
  thumbnail?: boolean;
}) {
  useUiLocale();
  const content = useMemo(() => htmlPageDocument(source), [source, getUiLocale()]);
  return (
    <iframe
      className="native-html-preview"
      title={uiText('网页预览')}
      sandbox=""
      referrerPolicy="no-referrer"
      tabIndex={thumbnail ? -1 : undefined}
      aria-hidden={thumbnail || undefined}
      srcDoc={content}
    />
  );
});
