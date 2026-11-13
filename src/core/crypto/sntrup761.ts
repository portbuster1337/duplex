// Streamlined NTRU Prime sntrup761, the post-quantum KEM of SimpleX's double ratchet, ported from the
// public domain reference implementation (supercop-20201130, as in simplexmq's cbits/sntrup761.c).
// The arithmetic gives the same results as the reference; JavaScript does not promise constant time.
import { sha512 } from '@noble/hashes/sha2.js';
import { randomBytes as cryptoRandom, type Bytes } from '../util/bytes';

export const SNTRUP761_PUBLICKEY_SIZE = 1158;
export const SNTRUP761_SECRETKEY_SIZE = 1763;
export const SNTRUP761_CIPHERTEXT_SIZE = 1039;
export const SNTRUP761_SIZE = 32;

const p = 761;
const q = 4591;
const w = 286;
const q12 = (q - 1) / 2;
const Rounded_bytes = 1007;
const Rq_bytes = 1158;
const Small_bytes = (p + 3) >> 2;
const Inputs_bytes = Small_bytes;
const SecretKeys_bytes = 2 * Small_bytes;
const PublicKeys_bytes = Rq_bytes;
const Ciphertexts_bytes = Rounded_bytes;
const Confirm_bytes = 32;
const Hash_bytes = 32;

/** a source of random bytes, called in the same order as in the reference (for test vectors) */
export type RandomFn = (n: number) => Bytes;

const mod = (x: number, m: number) => ((x % m) + m) % m;
const F3_freeze = (x: number) => mod(x + 1, 3) - 1;
const Fq_freeze = (x: number) => mod(x + q12, q) - q12;

function Fq_recip(a1: number): number {
  let ai = a1;
  for (let i = 1; i < q - 2; i++) ai = Fq_freeze(a1 * ai);
  return ai;
}

// ---- encoding (supercop Encode.c / Decode.c)

function Encode(out: number[], R: ArrayLike<number>, M: ArrayLike<number>, len: number): void {
  if (len === 1) {
    let r = R[0];
    let m = M[0];
    while (m > 1) {
      out.push(r & 0xff);
      r >>>= 8;
      m = (m + 255) >>> 8;
    }
  }
  if (len > 1) {
    const half = (len + 1) >> 1;
    const R2 = new Uint32Array(half);
    const M2 = new Uint32Array(half);
    let i = 0;
    for (; i < len - 1; i += 2) {
      const m0 = M[i];
      let r = R[i] + R[i + 1] * m0;
      let m = M[i + 1] * m0;
      while (m >= 16384) {
        out.push(r & 0xff);
        r >>>= 8;
        m = (m + 255) >>> 8;
      }
      R2[i >> 1] = r;
      M2[i >> 1] = m;
    }
    if (i < len) {
      R2[i >> 1] = R[i];
      M2[i >> 1] = M[i];
    }
    Encode(out, R2, M2, half);
  }
}

/** decodes into out, reading from s at pos; returns the next position */
function Decode(out: Uint16Array, outPos: number, s: Bytes, pos: number, M: ArrayLike<number>, len: number): number {
  if (len === 1) {
    if (M[0] === 1) out[outPos] = 0;
    else if (M[0] <= 256) out[outPos] = s[pos] % M[0];
    else out[outPos] = (s[pos] + (s[pos + 1] << 8)) % M[0];
    // the reference reads but does not advance for the last element
    return pos;
  }
  const half = (len + 1) >> 1;
  const R2 = new Uint16Array(half);
  const M2 = new Uint32Array(half);
  const bottomr = new Uint32Array(len >> 1);
  const bottomt = new Uint32Array(len >> 1);
  let i = 0;
  for (; i < len - 1; i += 2) {
    const m = M[i] * M[i + 1];
    if (m > 256 * 16383) {
      bottomt[i >> 1] = 256 * 256;
      bottomr[i >> 1] = s[pos] + 256 * s[pos + 1];
      pos += 2;
      M2[i >> 1] = (((m + 255) >>> 8) + 255) >>> 8;
    } else if (m >= 16384) {
      bottomt[i >> 1] = 256;
      bottomr[i >> 1] = s[pos];
      pos += 1;
      M2[i >> 1] = (m + 255) >>> 8;
    } else {
      bottomt[i >> 1] = 1;
      bottomr[i >> 1] = 0;
      M2[i >> 1] = m;
    }
  }
  if (i < len) M2[i >> 1] = M[i];
  pos = Decode(R2, 0, s, pos, M2, half);
  let o = outPos;
  for (i = 0; i < len - 1; i += 2) {
    const r = bottomr[i >> 1] + bottomt[i >> 1] * R2[i >> 1];
    out[o++] = r % M[i];
    // only needed for invalid inputs
    out[o++] = Math.floor(r / M[i]) % M[i + 1];
  }
  if (i < len) out[o++] = R2[i >> 1];
  return pos;
}

// ---- polynomials

function Weightw_mask(r: Int8Array): number {
  let weight = 0;
  for (let i = 0; i < p; i++) weight += r[i] & 1;
  return weight === w ? 0 : -1;
}

function R3_fromRq(out: Int8Array, r: Int16Array): void {
  for (let i = 0; i < p; i++) out[i] = F3_freeze(r[i]);
}

/** h = f*g in R3 = Z3[x]/(x^p - x - 1) */
function R3_mult(h: Int8Array, f: Int8Array, g: Int8Array): void {
  const fg = new Int32Array(p + p - 1);
  for (let i = 0; i < p; i++) {
    const fi = f[i];
    if (fi === 0) continue;
    for (let j = 0; j < p; j++) fg[i + j] += fi * g[j];
  }
  for (let i = p + p - 2; i >= p; i--) {
    fg[i - p] += fg[i];
    fg[i - p + 1] += fg[i];
  }
  for (let i = 0; i < p; i++) h[i] = F3_freeze(fg[i]);
}

/** returns 0 if the reciprocal exists, else -1 */
function R3_recip(out: Int8Array, inp: Int8Array): number {
  const f = new Int8Array(p + 1);
  const g = new Int8Array(p + 1);
  const v = new Int8Array(p + 1);
  const r = new Int8Array(p + 1);
  r[0] = 1;
  f[0] = 1;
  f[p - 1] = f[p] = -1;
  for (let i = 0; i < p; i++) g[p - 1 - i] = inp[i];
  g[p] = 0;
  let delta = 1;
  for (let loop = 0; loop < 2 * p - 1; loop++) {
    for (let i = p; i > 0; i--) v[i] = v[i - 1];
    v[0] = 0;
    const sign = -g[0] * f[0];
    const swap = -delta < 0 && g[0] !== 0;
    if (swap) {
      delta = -delta;
      for (let i = 0; i < p + 1; i++) {
        let t = f[i];
        f[i] = g[i];
        g[i] = t;
        t = v[i];
        v[i] = r[i];
        r[i] = t;
      }
    }
    delta += 1;
    for (let i = 0; i < p + 1; i++) g[i] = F3_freeze(g[i] + sign * f[i]);
    for (let i = 0; i < p + 1; i++) r[i] = F3_freeze(r[i] + sign * v[i]);
    for (let i = 0; i < p; i++) g[i] = g[i + 1];
    g[p] = 0;
  }
  const sign = f[0];
  for (let i = 0; i < p; i++) out[i] = sign * v[p - 1 - i];
  return delta !== 0 ? -1 : 0;
}

/** h = f*g in Rq = Zq[x]/(x^p - x - 1), g small */
function Rq_mult_small(h: Int16Array, f: Int16Array, g: Int8Array): void {
  const fg = new Float64Array(p + p - 1);
  for (let j = 0; j < p; j++) {
    const gj = g[j];
    if (gj === 0) continue;
    for (let i = 0; i < p; i++) fg[i + j] += f[i] * gj;
  }
  for (let i = p + p - 2; i >= p; i--) {
    fg[i - p] += fg[i];
    fg[i - p + 1] += fg[i];
  }
  for (let i = 0; i < p; i++) h[i] = Fq_freeze(fg[i]);
}

function Rq_mult3(h: Int16Array, f: Int16Array): void {
  for (let i = 0; i < p; i++) h[i] = Fq_freeze(3 * f[i]);
}

/** out = 1/(3*in) in Rq; returns 0 if it exists, else -1 */
function Rq_recip3(out: Int16Array, inp: Int8Array): number {
  const f = new Int32Array(p + 1);
  const g = new Int32Array(p + 1);
  const v = new Int32Array(p + 1);
  const r = new Int32Array(p + 1);
  r[0] = Fq_recip(3);
  f[0] = 1;
  f[p - 1] = f[p] = -1;
  for (let i = 0; i < p; i++) g[p - 1 - i] = inp[i];
  g[p] = 0;
  let delta = 1;
  for (let loop = 0; loop < 2 * p - 1; loop++) {
    for (let i = p; i > 0; i--) v[i] = v[i - 1];
    v[0] = 0;
    const swap = -delta < 0 && g[0] !== 0;
    if (swap) {
      delta = -delta;
      for (let i = 0; i < p + 1; i++) {
        let t = f[i];
        f[i] = g[i];
        g[i] = t;
        t = v[i];
        v[i] = r[i];
        r[i] = t;
      }
    }
    delta += 1;
    const f0 = f[0];
    const g0 = g[0];
    for (let i = 0; i < p + 1; i++) g[i] = Fq_freeze(f0 * g[i] - g0 * f[i]);
    for (let i = 0; i < p + 1; i++) r[i] = Fq_freeze(f0 * r[i] - g0 * v[i]);
    for (let i = 0; i < p; i++) g[i] = g[i + 1];
    g[p] = 0;
  }
  const scale = Fq_recip(f[0]);
  for (let i = 0; i < p; i++) out[i] = Fq_freeze(scale * v[p - 1 - i]);
  return delta !== 0 ? -1 : 0;
}

function Round(out: Int16Array, a: Int16Array): void {
  for (let i = 0; i < p; i++) out[i] = a[i] - F3_freeze(a[i]);
}

function Short_fromlist(out: Int8Array, inp: Uint32Array): void {
  const L = new Uint32Array(p);
  for (let i = 0; i < w; i++) L[i] = (inp[i] & 0xfffffffe) >>> 0;
  for (let i = w; i < p; i++) L[i] = ((inp[i] & 0xfffffffd) | 1) >>> 0;
  L.sort();
  for (let i = 0; i < p; i++) out[i] = (L[i] & 3) - 1;
}

/** SHA-512 of b || input, first 32 bytes */
function Hash_prefix(b: number, input: Bytes): Bytes {
  const x = new Uint8Array(input.length + 1);
  x[0] = b;
  x.set(input, 1);
  return sha512(x).slice(0, 32);
}

function urandom32(random: RandomFn): number {
  const c = random(4);
  return (c[0] | (c[1] << 8) | (c[2] << 16) | (c[3] << 24)) >>> 0;
}

function Short_random(out: Int8Array, random: RandomFn): void {
  const L = new Uint32Array(p);
  for (let i = 0; i < p; i++) L[i] = urandom32(random);
  Short_fromlist(out, L);
}

function Small_random(out: Int8Array, random: RandomFn): void {
  for (let i = 0; i < p; i++) out[i] = (((urandom32(random) & 0x3fffffff) * 3) >>> 30) - 1;
}

// ---- Streamlined NTRU Prime core

function KeyGen(h: Int16Array, f: Int8Array, ginv: Int8Array, random: RandomFn): boolean {
  const g = new Int8Array(p);
  let ok = false;
  for (let i = 0; i < 10; i++) {
    Small_random(g, random);
    if (R3_recip(ginv, g) === 0) {
      ok = true;
      break;
    }
  }
  if (!ok) return false;
  Short_random(f, random);
  const finv = new Int16Array(p);
  Rq_recip3(finv, f);
  Rq_mult_small(h, finv, g);
  return true;
}

function Encrypt(c: Int16Array, r: Int8Array, h: Int16Array): void {
  const hr = new Int16Array(p);
  Rq_mult_small(hr, h, r);
  Round(c, hr);
}

function Decrypt(r: Int8Array, c: Int16Array, f: Int8Array, ginv: Int8Array): void {
  const cf = new Int16Array(p);
  const cf3 = new Int16Array(p);
  const e = new Int8Array(p);
  const ev = new Int8Array(p);
  Rq_mult_small(cf, c, f);
  Rq_mult3(cf3, cf);
  R3_fromRq(e, cf3);
  R3_mult(ev, e, ginv);
  const mask = Weightw_mask(ev);
  for (let i = 0; i < w; i++) r[i] = ((ev[i] ^ 1) & ~mask) ^ 1;
  for (let i = w; i < p; i++) r[i] = ev[i] & ~mask;
}

function Small_encode(f: Int8Array): Bytes {
  const s = new Uint8Array(Small_bytes);
  let k = 0;
  for (let i = 0; i < p >> 2; i++) {
    s[i] = (f[k] + 1) | ((f[k + 1] + 1) << 2) | ((f[k + 2] + 1) << 4) | ((f[k + 3] + 1) << 6);
    k += 4;
  }
  s[p >> 2] = f[k] + 1;
  return s;
}

function Small_decode(f: Int8Array, s: Bytes): void {
  let k = 0;
  for (let i = 0; i < p >> 2; i++) {
    let x = s[i];
    for (let j = 0; j < 4; j++) {
      f[k++] = (x & 3) - 1;
      x >>= 2;
    }
  }
  f[k] = (s[p >> 2] & 3) - 1;
}

const Q_M = new Uint16Array(p).fill(q);
const R_M = new Uint16Array(p).fill((q + 2) / 3);

function Rq_encode(r: Int16Array): Bytes {
  const R = new Uint16Array(p);
  for (let i = 0; i < p; i++) R[i] = r[i] + q12;
  const out: number[] = [];
  Encode(out, R, Q_M, p);
  return Uint8Array.from(out);
}

function Rq_decode(r: Int16Array, s: Bytes): void {
  const R = new Uint16Array(p);
  Decode(R, 0, s, 0, Q_M, p);
  for (let i = 0; i < p; i++) r[i] = R[i] - q12;
}

function Rounded_encode(r: Int16Array): Bytes {
  const R = new Uint16Array(p);
  for (let i = 0; i < p; i++) R[i] = ((r[i] + q12) * 10923) >>> 15;
  const out: number[] = [];
  Encode(out, R, R_M, p);
  return Uint8Array.from(out);
}

function Rounded_decode(r: Int16Array, s: Bytes): void {
  const R = new Uint16Array(p);
  Decode(R, 0, s, 0, R_M, p);
  for (let i = 0; i < p; i++) r[i] = R[i] * 3 - q12;
}

function ZEncrypt(r: Int8Array, pk: Bytes): Bytes {
  const h = new Int16Array(p);
  const c = new Int16Array(p);
  Rq_decode(h, pk);
  Encrypt(c, r, h);
  return Rounded_encode(c);
}

function ZDecrypt(r: Int8Array, C: Bytes, sk: Bytes): void {
  const f = new Int8Array(p);
  const v = new Int8Array(p);
  const c = new Int16Array(p);
  Small_decode(f, sk.subarray(0, Small_bytes));
  Small_decode(v, sk.subarray(Small_bytes, 2 * Small_bytes));
  Rounded_decode(c, C);
  Decrypt(r, c, f, v);
}

function HashConfirm(rEnc: Bytes, cache: Bytes): Bytes {
  const x = new Uint8Array(Hash_bytes * 2);
  x.set(Hash_prefix(3, rEnc), 0);
  x.set(cache, Hash_bytes);
  return Hash_prefix(2, x);
}

function HashSession(b: number, y: Bytes, z: Bytes): Bytes {
  const x = new Uint8Array(Hash_bytes + Ciphertexts_bytes + Confirm_bytes);
  x.set(Hash_prefix(3, y), 0);
  x.set(z.subarray(0, Ciphertexts_bytes + Confirm_bytes), Hash_bytes);
  return Hash_prefix(b, x);
}

function Hide(r: Int8Array, pk: Bytes, cache: Bytes): { c: Bytes; rEnc: Bytes } {
  const rEnc = Small_encode(r);
  const c = new Uint8Array(Ciphertexts_bytes + Confirm_bytes);
  c.set(ZEncrypt(r, pk), 0);
  c.set(HashConfirm(rEnc, cache), Ciphertexts_bytes);
  return { c, rEnc };
}

const defaultRandom: RandomFn = (n) => cryptoRandom(n);

export interface KemKeyPair {
  pub: Bytes;
  priv: Bytes;
}

export function sntrup761Keypair(random: RandomFn = defaultRandom): KemKeyPair {
  const h = new Int16Array(p);
  const f = new Int8Array(p);
  const v = new Int8Array(p);
  if (!KeyGen(h, f, v, random)) throw new Error('sntrup761: key generation failed');
  const pk = Rq_encode(h);
  const sk = new Uint8Array(SNTRUP761_SECRETKEY_SIZE);
  sk.set(Small_encode(f), 0);
  sk.set(Small_encode(v), Small_bytes);
  sk.set(pk, SecretKeys_bytes);
  sk.set(random(Inputs_bytes), SecretKeys_bytes + PublicKeys_bytes);
  sk.set(Hash_prefix(4, pk), SecretKeys_bytes + PublicKeys_bytes + Inputs_bytes);
  return { pub: pk, priv: sk };
}

/** encapsulation: a ciphertext for the public key and the shared secret */
export function sntrup761Enc(pk: Bytes, random: RandomFn = defaultRandom): { ct: Bytes; ss: Bytes } {
  if (pk.length !== SNTRUP761_PUBLICKEY_SIZE) throw new Error('sntrup761: bad public key size');
  const cache = Hash_prefix(4, pk);
  const r = new Int8Array(p);
  Short_random(r, random);
  const { c, rEnc } = Hide(r, pk, cache);
  return { ct: c, ss: HashSession(1, rEnc, c) };
}

/** decapsulation; an invalid ciphertext gives a pseudo-random secret (implicit rejection) */
export function sntrup761Dec(ct: Bytes, sk: Bytes): Bytes {
  if (ct.length !== SNTRUP761_CIPHERTEXT_SIZE || sk.length !== SNTRUP761_SECRETKEY_SIZE) throw new Error('sntrup761: bad size');
  const pk = sk.subarray(SecretKeys_bytes, SecretKeys_bytes + PublicKeys_bytes);
  const rho = sk.subarray(SecretKeys_bytes + PublicKeys_bytes, SecretKeys_bytes + PublicKeys_bytes + Inputs_bytes);
  const cache = sk.subarray(SecretKeys_bytes + PublicKeys_bytes + Inputs_bytes);
  const r = new Int8Array(p);
  ZDecrypt(r, ct, sk);
  const { c: cnew, rEnc } = Hide(r, pk, cache);
  let diff = 0;
  for (let i = 0; i < Ciphertexts_bytes + Confirm_bytes; i++) diff |= ct[i] ^ cnew[i];
  const same = diff === 0;
  const y = same ? rEnc : rho.slice();
  return HashSession(same ? 1 : 0, y, ct);
}
