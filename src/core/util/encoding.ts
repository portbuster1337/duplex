// SMP binary encoding (Simplex.Messaging.Encoding): length-prefixed strings, big-endian integers,
// '0'/'1' maybes, 'T'/'F' booleans, 1-byte-count lists.
import { ascii, concat, fromAscii, fromUtf8, utf8, type Bytes } from './bytes';

export class ParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ParseError';
  }
}

export class Encoder {
  private parts: Bytes[] = [];
  private len = 0;

  raw(b: Bytes): this {
    this.parts.push(b);
    this.len += b.length;
    return this;
  }

  byte(n: number): this {
    return this.raw(Uint8Array.of(n & 0xff));
  }

  /** single ASCII character, e.g. a protocol tag */
  char(c: string): this {
    return this.byte(c.charCodeAt(0));
  }

  /** ASCII string without length prefix */
  str(s: string): this {
    return this.raw(ascii(s));
  }

  word16(n: number): this {
    return this.raw(Uint8Array.of((n >> 8) & 0xff, n & 0xff));
  }

  word32(n: number): this {
    return this.raw(Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff));
  }

  int64(n: number | bigint): this {
    let v = BigInt.asUintN(64, BigInt(n));
    const b = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return this.raw(b);
  }

  /** ByteString encoding: 1-byte length + bytes (max 255) */
  bytes(b: Bytes): this {
    if (b.length > 255) throw new Error(`string too long for 1-byte length: ${b.length}`);
    return this.byte(b.length).raw(b);
  }

  text(s: string): this {
    return this.bytes(utf8(s));
  }

  /** Large: 2-byte length + bytes */
  large(b: Bytes): this {
    if (b.length > 65535) throw new Error('string too long for 2-byte length');
    return this.word16(b.length).raw(b);
  }

  bool(v: boolean): this {
    return this.char(v ? 'T' : 'F');
  }

  maybe<T>(v: T | undefined | null, f: (e: this, v: T) => unknown): this {
    if (v === undefined || v === null) return this.char('0');
    this.char('1');
    f(this, v);
    return this;
  }

  list<T>(xs: readonly T[], f: (e: this, v: T) => unknown): this {
    if (xs.length > 255) throw new Error('list too long');
    this.byte(xs.length);
    for (const x of xs) f(this, x);
    return this;
  }

  get length(): number {
    return this.len;
  }

  finish(): Bytes {
    return this.parts.length === 1 ? this.parts[0] : concat(...this.parts);
  }
}

export function enc(f: (e: Encoder) => unknown): Bytes {
  const e = new Encoder();
  f(e);
  return e.finish();
}

export class Decoder {
  pos = 0;
  constructor(readonly buf: Bytes) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  atEnd(): boolean {
    return this.pos >= this.buf.length;
  }

  end(): void {
    if (this.pos !== this.buf.length) throw new ParseError(`unexpected trailing ${this.buf.length - this.pos} bytes`);
  }

  take(n: number): Bytes {
    if (n < 0 || this.pos + n > this.buf.length) throw new ParseError(`not enough input: need ${n}, have ${this.remaining}`);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  /** the rest of input (Tail) */
  rest(): Bytes {
    const b = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return b;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new ParseError('not enough input');
    return this.buf[this.pos++];
  }

  peek(): number {
    if (this.pos >= this.buf.length) throw new ParseError('not enough input');
    return this.buf[this.pos];
  }

  char(): string {
    return String.fromCharCode(this.byte());
  }

  expectChar(c: string): void {
    const got = this.char();
    if (got !== c) throw new ParseError(`expected '${c}', got '${got}'`);
  }

  space(): void {
    this.expectChar(' ');
  }

  word16(): number {
    const b = this.take(2);
    return (b[0] << 8) | b[1];
  }

  word32(): number {
    const b = this.take(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }

  int64(): bigint {
    const b = this.take(8);
    let v = 0n;
    for (const x of b) v = (v << 8n) | BigInt(x);
    return BigInt.asIntN(64, v);
  }

  /** int64 as a JS number (throws if not safe) */
  int64n(): number {
    const v = this.int64();
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new ParseError('int64 out of range');
    return Number(v);
  }

  bytes(): Bytes {
    return this.take(this.byte());
  }

  text(): string {
    try {
      return fromUtf8(this.bytes());
    } catch {
      throw new ParseError('invalid UTF-8');
    }
  }

  large(): Bytes {
    return this.take(this.word16());
  }

  bool(): boolean {
    const c = this.char();
    if (c === 'T') return true;
    if (c === 'F') return false;
    throw new ParseError('invalid Bool');
  }

  maybe<T>(f: (d: this) => T): T | undefined {
    const c = this.char();
    if (c === '0') return undefined;
    if (c === '1') return f(this);
    throw new ParseError('invalid Maybe tag');
  }

  list<T>(f: (d: this) => T): T[] {
    const n = this.byte();
    const xs: T[] = [];
    for (let i = 0; i < n; i++) xs.push(f(this));
    return xs;
  }

  nonEmpty<T>(f: (d: this) => T): T[] {
    const xs = this.list(f);
    if (xs.length === 0) throw new ParseError('empty list');
    return xs;
  }

  /** bytes up to (not including) the first occurrence of `c`, or to the end */
  takeTill(c: string): Bytes {
    const code = c.charCodeAt(0);
    let i = this.pos;
    while (i < this.buf.length && this.buf[i] !== code) i++;
    const b = this.buf.subarray(this.pos, i);
    this.pos = i;
    return b;
  }

  /** ASCII word up to a space (consumes the space if present), like messageTagP */
  tag(): string {
    const t = fromAscii(this.takeTill(' '));
    if (!this.atEnd()) this.pos++;
    return t;
  }

  /** try a parser, restoring position on failure */
  optional<T>(f: (d: this) => T): T | undefined {
    const p = this.pos;
    try {
      return f(this);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.pos = p;
      return undefined;
    }
  }
}

export function parse<T>(b: Bytes, f: (d: Decoder) => T, all = true): T {
  const d = new Decoder(b);
  const v = f(d);
  if (all) d.end();
  return v;
}

/** Simplex.Messaging.Crypto.pad: 2-byte length + message + '#' padding */
export function pad(msg: Bytes, paddedLen: number): Bytes {
  const len = msg.length;
  const padLen = paddedLen - len - 2;
  if (len > 65533 || padLen < 0) throw new Error(`message too large to pad: ${len} > ${paddedLen - 2}`);
  const out = new Uint8Array(paddedLen);
  out[0] = len >> 8;
  out[1] = len & 0xff;
  out.set(msg, 2);
  out.fill(0x23, 2 + len);
  return out;
}

export function unPad(padded: Bytes): Bytes {
  if (padded.length < 2) throw new ParseError('padded message too short');
  const len = (padded[0] << 8) | padded[1];
  if (padded.length - 2 < len) throw new ParseError('invalid padded message length');
  return padded.subarray(2, 2 + len);
}

export function canPad(len: number, paddedLen: number): boolean {
  return len <= 65533 && paddedLen - len - 2 >= 0;
}
