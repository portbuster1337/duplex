// Byte helpers shared by all protocol layers.

export type Bytes = Uint8Array;

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });
const tdLossy = new TextDecoder('utf-8');

export function utf8(s: string): Bytes {
  return te.encode(s);
}

export function fromUtf8(b: Bytes): string {
  return td.decode(b);
}

/** decodes invalid sequences as U+FFFD, like Haskell's safeDecodeUtf8 */
export function fromUtf8Lossy(b: Bytes): string {
  return tdLossy.decode(b);
}

/** Latin-1 (one char per byte), used for ASCII protocol tags. */
export function ascii(s: string): Bytes {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

export function fromAscii(b: Bytes): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function concat(...parts: Bytes[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function compare(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function randomBytes(n: number): Bytes {
  const b = new Uint8Array(n);
  // getRandomValues is limited to 65536 bytes per call
  for (let off = 0; off < n; off += 65536) crypto.getRandomValues(b.subarray(off, Math.min(n, off + 65536)));
  return b;
}

export function wipe(...bs: (Bytes | undefined)[]): void {
  for (const b of bs) b?.fill(0);
}

const HEX = '0123456789abcdef';

export function toHex(b: Bytes): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  return s;
}

export function fromHex(s: string): Bytes {
  if (s.length % 2) throw new Error('bad hex');
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) {
    const v = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) throw new Error('bad hex');
    b[i] = v;
  }
  return b;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64URL = B64 + '-_';
const B64STD = B64 + '+/';
const B64DEC = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
  B64DEC[B64URL.charCodeAt(i)] = i;
  B64DEC[B64STD.charCodeAt(i)] = i;
}

function b64encode(b: Bytes, alphabet: string, pad: boolean): string {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    s += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + (pad ? '==' : '');
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    s += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + (pad ? '=' : '');
  }
  return s;
}

/** base64url with padding, as Haskell's Data.ByteString.Base64.URL.encode (SimpleX strEncode of ByteString) */
export function b64url(b: Bytes): string {
  return b64encode(b, B64URL, true);
}

/** base64url without padding */
export function b64urlNoPad(b: Bytes): string {
  return b64encode(b, B64URL, false);
}

export function b64(b: Bytes): string {
  return b64encode(b, B64STD, true);
}

/** decodes base64 or base64url, with or without padding */
export function fromB64(s: string): Bytes {
  let end = s.length;
  while (end > 0 && s[end - 1] === '=') end--;
  if (end % 4 === 1) throw new Error('bad base64 length');
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < end; i++) {
    const c = s.charCodeAt(i);
    const v = c < 256 ? B64DEC[c] : -1;
    if (v < 0) throw new Error('bad base64 character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

export function isB64UrlChar(c: string): boolean {
  return /[A-Za-z0-9_-]/.test(c);
}
