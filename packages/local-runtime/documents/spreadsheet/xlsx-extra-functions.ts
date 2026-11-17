/** Scalar criteria functions absent from the bundled parser; keep range sizes bounded. */
export function criteriaFunctions(Errors: any, limited: () => boolean) {
  const range = (arg: any): any[][] =>
    Array.isArray(arg?.value)
      ? arg.value.map((row: any) => (Array.isArray(row) ? row : [row]))
      : [[arg?.value ?? null]];
  function match(value: any, criterion: any) {
    const wanted = criterion?.value ?? null;
    if (wanted instanceof Error) throw wanted;
    if (typeof wanted !== 'string')
      return value === wanted || (wanted === null && (value === null || value === ''));
    const parts = /^(<=|>=|<>|=|<|>)(.*)$/.exec(wanted),
      op = parts?.[1] ?? '=',
      raw = parts?.[2] ?? wanted;
    const numeric = raw.trim() !== '' && Number.isFinite(Number(raw)),
      target = numeric ? Number(raw) : raw.toLocaleLowerCase();
    const actual =
      numeric && value !== null && value !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : String(value ?? '').toLocaleLowerCase();
    let equal = actual === target;
    if (!numeric && /[?*~]/.test(raw)) {
      // Glob matching uses a bounded loop instead of a backtracking regular expression.
      const tokens: { kind: 'literal' | 'any' | 'star'; value?: string }[] = [];
      if (raw.length > 2048) throw Errors.VALUE;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '~' && i + 1 < raw.length)
          tokens.push({ kind: 'literal', value: raw[++i].toLocaleLowerCase() });
        else
          tokens.push(
            c === '*'
              ? { kind: 'star' }
              : c === '?'
                ? { kind: 'any' }
                : { kind: 'literal', value: c.toLocaleLowerCase() },
          );
      }
      const input = String(value ?? '').toLocaleLowerCase();
      let i = 0,
        j = 0,
        star = -1,
        retry = 0;
      while (i < input.length) {
        if (limited()) throw Errors.VALUE;
        const token = tokens[j];
        if (token?.kind === 'any' || (token?.kind === 'literal' && token.value === input[i])) {
          i++;
          j++;
        } else if (token?.kind === 'star') {
          star = j++;
          retry = i;
        } else if (star >= 0) {
          j = star + 1;
          i = ++retry;
        } else break;
      }
      while (tokens[j]?.kind === 'star') j++;
      equal = i === input.length && j === tokens.length;
    }
    if (op === '=') return equal;
    if (op === '<>') return !equal;
    if (typeof actual !== typeof target) return false;
    return op === '>'
      ? actual > target
      : op === '<'
        ? actual < target
        : op === '>='
          ? actual >= target
          : actual <= target;
  }
  function evaluate(mode: 'sum' | 'count' | 'average', args: any[]) {
    const totals = mode === 'count' ? null : range(args.shift());
    if (!args.length || args.length % 2 || args.length > 40) throw Errors.VALUE;
    const pairs = [];
    for (let i = 0; i < args.length; i += 2)
      pairs.push({ values: range(args[i]), criterion: args[i + 1] });
    const rows = totals ?? pairs[0].values,
      width = rows[0]?.length ?? 0;
    if (
      rows.length * width > 25000 ||
      pairs.some(
        (p) => p.values.length !== rows.length || p.values.some((row) => row.length !== width),
      )
    )
      throw Errors.VALUE;
    let sum = 0,
      count = 0;
    for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < width; c++) {
        if (limited()) throw Errors.VALUE;
        if (!pairs.every((p) => match(p.values[r][c], p.criterion))) continue;
        const value = totals?.[r][c];
        if (value instanceof Error) throw value;
        if (mode === 'count') count++;
        else if (typeof value === 'number') {
          sum += value;
          count++;
        }
      }
    return mode === 'count' ? count : mode === 'sum' ? sum : count ? sum / count : Errors.DIV0;
  }
  const scalar = (arg: any) => {
    const value = arg?.value ?? null;
    if (value instanceof Error) throw value;
    return value;
  };
  const vector = (arg: any) => {
    const rows = range(arg);
    if ((rows.length > 1 && rows.some((row) => row.length > 1)) || rows.flat().length > 25000)
      throw Errors.VALUE;
    return rows.flat();
  };
  function lookup(wanted: any, values: any[], matchMode: number, searchMode: number) {
    if (![0, -1, 1, 2].includes(matchMode) || ![1, -1].includes(searchMode)) throw Errors.VALUE;
    const compare = (value: any) => (typeof value === 'string' ? value.toLocaleLowerCase() : value);
    const target = compare(wanted);
    let candidate = -1;
    for (let step = 0; step < values.length; step++) {
      if (limited()) throw Errors.VALUE;
      const index = searchMode === 1 ? step : values.length - step - 1,
        value = values[index];
      if (value instanceof Error) throw value;
      const actual = compare(value);
      if (
        matchMode === 2
          ? match(value, { value: typeof wanted === 'string' ? '=' + wanted : wanted })
          : actual === target
      )
        return index;
      if (
        (matchMode === -1 || matchMode === 1) &&
        typeof actual === typeof target &&
        actual !== null &&
        target !== null
      ) {
        const eligible = matchMode === -1 ? actual < target : actual > target;
        if (
          eligible &&
          (candidate < 0 ||
            (matchMode === -1
              ? actual > compare(values[candidate])
              : actual < compare(values[candidate])))
        )
          candidate = index;
      }
    }
    return candidate;
  }
  return {
    XLOOKUP: (wanted: any, keys: any, values: any, missing?: any, mode?: any, search?: any) => {
      const source = vector(keys),
        result = vector(values);
      if (source.length !== result.length) throw Errors.VALUE;
      const index = lookup(
        scalar(wanted),
        source,
        Number(scalar(mode) ?? 0),
        Number(scalar(search) ?? 1),
      );
      return index < 0
        ? missing === undefined
          ? Errors.NA
          : scalar(missing)
        : (result[index] ?? 0);
    },
    XMATCH: (wanted: any, keys: any, mode?: any, search?: any) => {
      const index = lookup(
        scalar(wanted),
        vector(keys),
        Number(scalar(mode) ?? 0),
        Number(scalar(search) ?? 1),
      );
      return index < 0 ? Errors.NA : index + 1;
    },
    TEXTJOIN: (delimiter: any, ignore: any, ...args: any[]) => {
      const joiner = String(scalar(delimiter) ?? ''),
        skip = scalar(ignore),
        parts = [];
      if (![true, false, 0, 1].includes(skip)) throw Errors.VALUE;
      let length = 0,
        count = 0;
      for (const arg of args)
        for (const row of range(arg))
          for (const item of row) {
            if (++count > 25000 || limited()) throw Errors.VALUE;
            if (item instanceof Error) throw item;
            if (skip && (item === null || item === '')) continue;
            const text = typeof item === 'boolean' ? (item ? 'TRUE' : 'FALSE') : String(item ?? '');
            length += text.length + (parts.length ? joiner.length : 0);
            if (length > 32767) throw Errors.VALUE;
            parts.push(text);
          }
      return parts.join(joiner);
    },
    TIME: (hour: any, minute: any, second: any) => {
      const parts = [hour, minute, second].map((arg) => {
        if (arg?.value instanceof Error) throw arg.value;
        const value = Number(arg?.value ?? 0);
        if (!Number.isFinite(value)) throw Errors.VALUE;
        return Math.trunc(value);
      });
      if (parts.some((v) => v > 32767 || v < 0)) throw Errors.NUM;
      return ((parts[0] * 3600 + parts[1] * 60 + parts[2]) % 86400) / 86400;
    },
    SUMIFS: (...args: any[]) => evaluate('sum', args),
    COUNTIFS: (...args: any[]) => evaluate('count', args),
    AVERAGEIFS: (...args: any[]) => evaluate('average', args),
  };
}
