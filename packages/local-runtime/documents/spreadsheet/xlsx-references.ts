import { cellPosition, columnLabel, type StructureEdit } from '../../../contracts/xlsx.js';
import { fail } from '../../../contracts/index.js';

export type AxisEdit = Extract<StructureEdit, { at: number }>;
export const rowAxis = (op: AxisEdit) => op.kind.endsWith('rows');
export function shiftIndex(value: number, op: AxisEdit) {
  if (value < op.at) return value;
  if (op.kind.startsWith('insert')) return value + op.count;
  return value < op.at + op.count ? null : value - op.count;
}
export function shiftInterval(first: number, last: number, op: AxisEdit): [number, number] | null {
  const reversed = first > last,
    lo = Math.min(first, last),
    hi = Math.max(first, last);
  let a: number, b: number;
  if (op.kind.startsWith('insert')) {
    a = lo >= op.at ? lo + op.count : lo;
    b = hi >= op.at ? hi + op.count : hi;
  } else {
    const end = op.at + op.count - 1;
    if (lo >= op.at && hi <= end) return null;
    a = lo < op.at ? lo : lo > end ? lo - op.count : op.at;
    b = hi > end ? hi - op.count : hi < op.at ? hi : op.at - 1;
  }
  return reversed ? [b, a] : [a, b];
}
const cell = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})$/;
function endpoint(value: string) {
  const match = cell.exec(value);
  if (!match) return null;
  const position = cellPosition(match[2] + match[4]);
  return position ? { ...position, colAbs: match[1], rowAbs: match[3] } : null;
}
/** Structural edits move absolute references as well as relative ones. */
export function shiftReference(reference: string, op: AxisEdit) {
  const parts = reference.split(/\s*:\s*/),
    a = endpoint(parts[0]),
    b = endpoint(parts[1] ?? parts[0]),
    rows = rowAxis(op);
  if (a && b) {
    const range = shiftInterval(rows ? a.row : a.column, rows ? b.row : b.column, op);
    if (!range) return '#REF!';
    const limit = rows ? 1048576 : 16384;
    if (range.some((n) => n < 1 || n > limit)) return '#REF!';
    const render = (point: NonNullable<ReturnType<typeof endpoint>>, n: number) =>
      `${point.colAbs}${columnLabel(rows ? point.column : n)}${point.rowAbs}${rows ? n : point.row}`;
    return render(a, range[0]) + (parts.length === 2 ? ':' + render(b, range[1]) : '');
  }
  if (parts.length !== 2) return reference;
  const columns = parts.every((value) => /^\$?[A-Za-z]{1,3}$/.test(value)),
    wholeRows = parts.every((value) => /^\$?[1-9]\d{0,6}$/.test(value));
  if ((!columns && !wholeRows) || (columns && rows) || (wholeRows && !rows)) return reference;
  const values = parts.map((value) =>
    columns ? cellPosition(value.replace('$', '') + '1')?.column : Number(value.replace('$', '')),
  );
  if (values.some((n) => !n || n > (columns ? 16384 : 1048576))) return reference;
  const range = shiftInterval(values[0]!, values[1]!, op);
  if (!range || range.some((n) => n < 1 || n > (columns ? 16384 : 1048576))) return '#REF!';
  return range
    .map((n, i) => (parts[i].startsWith('$') ? '$' : '') + (columns ? columnLabel(n) : n))
    .join(':');
}
const qualifier = /^(?:'((?:[^']|'')+)'|([\p{L}\p{N}_.$\[\]:]+))!/u;
const reference =
  /^(?:\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?:\s*:\s*\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})?|\$?[A-Za-z]{1,3}\s*:\s*\$?[A-Za-z]{1,3}|\$?[1-9]\d{0,6}\s*:\s*\$?[1-9]\d{0,6})/;
const identifier = /[\p{L}\p{N}_.$]/u;
const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'!`;

/** Token-aware A1 rewrite: strings, external workbooks and structured tokens are untouched. */
export function rewriteFormula(formula: string, owner: string, target: string, op: StructureEdit) {
  if (op.kind === 'add_sheet') return formula;
  let output = '',
    i = 0;
  while (i < formula.length) {
    if (formula[i] === '"') {
      const start = i++;
      while (i < formula.length) {
        if (formula[i++] === '"') {
          if (formula[i] === '"') {
            i++;
            continue;
          }
          break;
        }
      }
      output += formula.slice(start, i);
      continue;
    }
    if (i && identifier.test(formula[i - 1])) {
      output += formula[i++];
      continue;
    }
    if (
      /^(?:'(?:[^']|'')+'|[\p{L}\p{N}_.$]+):(?:'(?:[^']|'')+'|[\p{L}\p{N}_.$]+)!/u.test(
        formula.slice(i),
      )
    )
      fail('XLSX_STRUCTURE_UNSUPPORTED', '此工作簿含三维工作表引用，暂不能调整结构。');
    const qualified = qualifier.exec(formula.slice(i)),
      sheet = qualified ? (qualified[1]?.replace(/''/g, "'") ?? qualified[2]) : owner,
      external = !!qualified && /[\[\]]/.test(sheet);
    if (qualified && !external && sheet.includes(':'))
      fail('XLSX_STRUCTURE_UNSUPPORTED', '此工作簿含三维工作表引用，暂不能调整结构。');
    let prefix = qualified?.[0] ?? '';
    const at = i + prefix.length,
      match = reference.exec(formula.slice(at)),
      same = sheet.toLowerCase() === target.toLowerCase();
    if (qualified && same && op.kind === 'rename_sheet') prefix = quoteSheet(op.name);
    if (
      match &&
      !identifier.test(formula[at + match[0].length] ?? '') &&
      !['(', '[', '!'].includes(formula[at + match[0].length] ?? '')
    ) {
      const remainder = formula.slice(at + match[0].length);
      if (/^\s*:/.test(remainder) && qualifier.test(remainder.replace(/^\s*:\s*/, '')))
        fail(
          'XLSX_STRUCTURE_UNSUPPORTED',
          '范围两端分别带工作表名称的引用暂不能调整，请先使用 Sheet!A1:B2 形式。',
        );
      if (formula[at + match[0].length] === '#' && !external)
        fail('XLSX_STRUCTURE_UNSUPPORTED', '此工作簿含溢出引用，暂不能调整结构。');
      if (!qualified && !owner && 'at' in op)
        fail(
          'XLSX_STRUCTURE_UNSUPPORTED',
          '此工作簿含没有明确所属工作表的相对命名引用，暂不能调整行列。',
        );
      const adjusted =
        same && !external && op.kind === 'delete_sheet'
          ? '#REF!'
          : same && !external && 'at' in op
            ? shiftReference(match[0], op)
            : match[0];
      output += adjusted === '#REF!' ? adjusted : prefix + adjusted;
      i = at + match[0].length;
      continue;
    }
    if (qualified) {
      if (same && !external && op.kind === 'delete_sheet') {
        const named = /^[\p{L}_\\][\p{L}\p{N}_.\\]*/u.exec(formula.slice(at));
        output += '#REF!';
        i = at + (named?.[0].length ?? 0);
      } else {
        output += prefix;
        i = at;
      }
      continue;
    }
    if (formula[i] === '[') {
      const start = i++;
      let depth = 1;
      while (i < formula.length && depth) {
        if (formula[i] === '[') depth++;
        if (formula[i] === ']') depth--;
        i++;
      }
      output += formula.slice(start, i);
      continue;
    }
    output += formula[i++];
  }
  return output;
}

/** Relative translation for copying cells; quoted strings and function names stay untouched. */
export function translateFormula(formula: string, dr: number, dc: number) {
  if (/[\[\]]/.test(formula))
    fail('XLSX_STRUCTURE_UNSUPPORTED', '填充或排序暂不支持外部及结构化公式引用。');
  let output = '',
    i = 0;
  while (i < formula.length) {
    if (formula[i] === '"' || formula[i] === "'") {
      const quote = formula[i],
        start = i++;
      while (i < formula.length) {
        if (formula[i++] === quote) {
          if (formula[i] === quote) {
            i++;
            continue;
          }
          break;
        }
      }
      output += formula.slice(start, i);
      continue;
    }
    const whole = /^(\$?)([A-Za-z]{1,3}|[1-9]\d{0,6})\s*:\s*(\$?)([A-Za-z]{1,3}|[1-9]\d{0,6})/.exec(
      formula.slice(i),
    );
    if (
      whole &&
      (!i || !identifier.test(formula[i - 1])) &&
      !identifier.test(formula[i + whole[0].length] ?? '') &&
      !['!', '('].includes(formula[i + whole[0].length] ?? '')
    ) {
      const columns = /^[A-Za-z]+$/.test(whole[2]);
      if (columns === /^[A-Za-z]+$/.test(whole[4])) {
        const number = (v: string) => (columns ? cellPosition(v + '1')?.column : Number(v)),
          first = number(whole[2]),
          last = number(whole[4]);
        if (first && last) {
          const x = first + (whole[1] ? 0 : columns ? dc : dr),
            y = last + (whole[3] ? 0 : columns ? dc : dr),
            limit = columns ? 16384 : 1048576;
          output +=
            x < 1 || y < 1 || x > limit || y > limit
              ? '#REF!'
              : whole[1] +
                (columns ? columnLabel(x) : x) +
                ':' +
                whole[3] +
                (columns ? columnLabel(y) : y);
          i += whole[0].length;
          continue;
        }
      }
    }
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})/.exec(formula.slice(i));
    if (
      m &&
      (!i || !identifier.test(formula[i - 1])) &&
      !identifier.test(formula[i + m[0].length] ?? '') &&
      !['(', '!'].includes(formula[i + m[0].length] ?? '')
    ) {
      const p = cellPosition(m[2] + m[4]);
      if (p) {
        const row = p.row + (m[3] ? 0 : dr),
          col = p.column + (m[1] ? 0 : dc);
        output +=
          row < 1 || row > 1048576 || col < 1 || col > 16384
            ? '#REF!'
            : m[1] + columnLabel(col) + m[3] + row;
        i += m[0].length;
        continue;
      }
    }
    output += formula[i++];
  }
  return output;
}
