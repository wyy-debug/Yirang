import React from 'react';
/** A bounded lexical hint for code blocks; source is always rendered as text nodes. */
export function codeTokens(source: string, language: string) {
  if (
    source.length > 30000 ||
    !/(js|jsx|ts|tsx|javascript|typescript|json|py|python|css|html|xml|svg|sql|sh|bash|c|cpp|cs|java|go|rs|rust)$/i.test(
      language.trim(),
    )
  )
    return source;
  const expression =
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(?:const|let|var|function|return|if|else|for|while|class|extends|import|from|export|default|async|await|new|throw|try|catch|def|in|is|not|and|or|with|as|lambda|True|False|None|true|false|null|undefined|public|private|static|void|int|float|string|SELECT|FROM|WHERE|JOIN|ORDER|BY)\b|\b\d+(?:\.\d+)?\b/g;
  const parts: React.ReactNode[] = [];
  let offset = 0,
    match: RegExpExecArray | null;
  while ((match = expression.exec(source)) && parts.length < 4000) {
    if (match.index > offset) parts.push(source.slice(offset, match.index));
    parts.push(
      <span
        key={match.index}
        className={
          match[1]
            ? 'code-token-comment'
            : match[2]
              ? 'code-token-string'
              : /^\d/.test(match[0])
                ? 'code-token-number'
                : 'code-token-keyword'
        }
      >
        {match[0]}
      </span>,
    );
    offset = expression.lastIndex;
  }
  if (offset < source.length) parts.push(source.slice(offset));
  return parts;
}
