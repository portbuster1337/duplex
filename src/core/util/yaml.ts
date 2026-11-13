// The YAML subset of SimpleX file descriptions (Data.Yaml / libyaml output): block mappings and
// sequences with plain, single- and double-quoted scalars. No anchors, aliases, tags, flow collections
// (except empty ones) or multi-line scalars, which file descriptions do not use.
export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'YamlError';
  }
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

interface Parser {
  lines: Line[];
  i: number;
}

/** removes a comment: '#' at the start or after a space, outside quotes */
function stripComment(s: string): string {
  let q: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else q = undefined;
      } else if (q === '"' && c === '\\') i++;
    } else if (c === "'" || c === '"') {
      if (i === 0 || /[\s:\-[{,]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

export function parseYaml(src: string): YamlValue {
  const lines: Line[] = [];
  src.split(/\r?\n/).forEach((raw, no) => {
    const lead = raw.match(/^[ \t]*/)![0];
    if (lead.includes('\t') && raw.trim()) throw new YamlError(`tab in indentation at line ${no + 1}`);
    const text = stripComment(raw).trimEnd();
    const t = text.trimStart();
    if (!t || t === '---' || t === '...') return;
    if (/^[&*!|>%@`]/.test(t)) throw new YamlError(`unsupported YAML at line ${no + 1}`);
    lines.push({ indent: text.length - t.length, text: t, no });
  });
  if (!lines.length) throw new YamlError('empty document');
  const p: Parser = { lines, i: 0 };
  const v = parseNode(p, lines[0].indent);
  if (p.i < lines.length) throw new YamlError(`unexpected content at line ${lines[p.i].no + 1}`);
  return v;
}

const isSeqItem = (t: string): boolean => t === '-' || t.startsWith('- ');

function parseNode(p: Parser, indent: number): YamlValue {
  const l = p.lines[p.i];
  if (isSeqItem(l.text)) return parseSeq(p, indent);
  if (splitKey(l.text)) return parseMap(p, indent);
  p.i++;
  return scalar(l.text, l.no);
}

function parseSeq(p: Parser, indent: number): YamlValue[] {
  const out: YamlValue[] = [];
  while (p.i < p.lines.length) {
    const l = p.lines[p.i];
    if (l.indent !== indent || !isSeqItem(l.text)) {
      if (l.indent > indent) throw new YamlError(`bad indentation at line ${l.no + 1}`);
      break;
    }
    const rest = l.text === '-' ? '' : l.text.slice(1).trimStart();
    if (!rest) {
      p.i++;
      const next = p.lines[p.i];
      out.push(next && next.indent > indent ? parseNode(p, next.indent) : '');
    } else {
      // the item starts on the dash line: it continues as a node at the column after "- "
      const col = indent + (l.text.length - rest.length);
      p.lines[p.i] = { indent: col, text: rest, no: l.no };
      out.push(parseNode(p, col));
    }
  }
  return out;
}

function parseMap(p: Parser, indent: number): { [key: string]: YamlValue } {
  const out: { [key: string]: YamlValue } = {};
  while (p.i < p.lines.length) {
    const l = p.lines[p.i];
    if (l.indent !== indent) {
      if (l.indent > indent) throw new YamlError(`bad indentation at line ${l.no + 1}`);
      break;
    }
    if (isSeqItem(l.text)) break;
    const kv = splitKey(l.text);
    if (!kv) throw new YamlError(`expected a key at line ${l.no + 1}`);
    const [k, v] = kv;
    if (Object.prototype.hasOwnProperty.call(out, k)) throw new YamlError(`duplicate key ${k} at line ${l.no + 1}`);
    p.i++;
    if (v) out[k] = scalar(v, l.no);
    else {
      // a nested block: deeper, or a sequence at the same indentation as the key
      const next = p.lines[p.i];
      out[k] = next && (next.indent > indent || (next.indent === indent && isSeqItem(next.text))) ? parseNode(p, next.indent) : '';
    }
  }
  return out;
}

/** [key, value] of a "key: value" or "key:" line */
function splitKey(t: string): [string, string] | undefined {
  let keyEnd: number;
  let key: string;
  if (t[0] === "'" || t[0] === '"') {
    const end = quotedEnd(t);
    if (end < 0 || t[end + 1] !== ':') return undefined;
    key = scalar(t.slice(0, end + 1), -1) as string;
    keyEnd = end + 1;
  } else {
    const m = t.match(/:(\s|$)/);
    if (!m || m.index === undefined || m.index === 0) return undefined;
    keyEnd = m.index;
    key = t.slice(0, keyEnd).trimEnd();
    if (/^[[{]/.test(key)) return undefined;
  }
  const rest = t.slice(keyEnd + 1);
  if (rest && !/^\s/.test(rest)) return undefined;
  return [key, rest.trim()];
}

/** the index of the closing quote of a quoted scalar starting at 0 */
function quotedEnd(t: string): number {
  const q = t[0];
  for (let i = 1; i < t.length; i++) {
    if (q === '"' && t[i] === '\\') i++;
    else if (t[i] === q) {
      if (q === "'" && t[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

const ESCAPES: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0' };

function scalar(t: string, no: number): YamlValue {
  const at = no >= 0 ? ` at line ${no + 1}` : '';
  if (t === '[]') return [];
  if (t === '{}') return {};
  if (t[0] === '[' || t[0] === '{') throw new YamlError(`flow collections are not supported${at}`);
  // anchors, aliases, tags, block scalars and reserved indicators cannot start a plain scalar
  if (/^[&*!|>%@`,\]}]/.test(t)) throw new YamlError(`unsupported YAML${at}`);
  if (t[0] === "'" || t[0] === '"') {
    const end = quotedEnd(t);
    if (end !== t.length - 1) throw new YamlError(`bad quoted string${at}`);
    const body = t.slice(1, -1);
    if (t[0] === "'") return body.replace(/''/g, "'");
    return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
      if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
      const r = ESCAPES[e];
      if (r === undefined) throw new YamlError(`bad escape \\${e}${at}`);
      return r;
    });
  }
  return t;
}

// ---- writing

/** the strings that Data.Yaml quotes because it would read them back as other values (isSpecialString) */
const SPECIAL_STRINGS = new Set('y Y yes Yes YES n N no No NO true True TRUE false False FALSE on On ON off Off OFF null Null NULL ~ *'.split(' '));
/** textToScientific of Data.Yaml: hexadecimal, octal and decimal numbers */
const NUMERIC = /^(0x[0-9a-fA-F]+|0o[0-7]+|[+-]?[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?)$/;

/**
 * a scalar as YAML: plain when Data.Yaml and libyaml would write it plain in a block (so that
 * descriptions are the same as those of the apps), otherwise single-quoted, or double-quoted with
 * control characters
 */
export function yamlScalar(s: string): string {
  const startsBadly =
    /^[#,[\]{}&*!|>'"%@`]/.test(s) || // indicators
    /^[-?:](\s|$)/.test(s) || // "- ", "? ", ": " and these characters alone
    /^(---|\.\.\.)/.test(s); // document markers
  const plain = s.length > 0 && !SPECIAL_STRINGS.has(s) && !NUMERIC.test(s) && !startsBadly && !/^\s|\s$/.test(s) && !/:(\s|$)|\s#|[\x00-\x1f\x7f]/.test(s);
  if (plain) return s;
  if (/[\x00-\x1f\x7f]/.test(s)) return JSON.stringify(s);
  return `'${s.replace(/'/g, "''")}'`;
}
